// baton 对 chat-tui 的接入层：实现 ChatProtocol，把 BatonSessionRuntime / SessionStore
// 的状态投影成视图快照，把 TUI intents 翻译成 runtime 操作。
// UI 语义（补全、分层 Ctrl+C、浮层交互）都在 chat-tui；这里只有 baton 的业务编排。

import type {
  ChatProtocol,
  ChatViewState,
  Candidate,
  CommandSpec,
  DiffOp,
  RunStatusItem,
  StatusMessage,
  TranscriptBlockContent,
  TranscriptItem,
  QuestionAnswers,
} from "chat-tui";

import { COMMANDS, parseProvider, type CommandName, type ProviderName } from "../commands/registry.ts";
import type { BatonConfig } from "../config/config.ts";
import { expandMentions } from "../context/mention.ts";
import { textOf, type DiffBlock, type PromptBlock } from "../events/types.ts";
import { createProviderAdapter, providerSessionKey, providerShortName } from "../providers/registry.ts";
import { openBatonSession } from "../session/open.ts";
import { BatonSessionRuntime } from "../session/runtime.ts";
import { applyEvent, isTurnRunning, type SessionState, type ToolCallState } from "../store/reduce.ts";
import type { SessionHandle, SessionStore } from "../store/store.ts";
import { sessionMentionCandidates } from "./mentions.ts";
import { sessionPickerOptions, type SessionPickerMode } from "./session-picker.tsx";

/** provider（id 或 wire key）→ 时间线 author 展示名；归一与着色 key 统一走 registry。 */
function providerAuthor(provider: string | undefined): string | undefined {
  if (!provider) return undefined;
  return providerShortName(provider);
}

export const CHAT_COMMANDS: readonly CommandSpec[] = COMMANDS;

export function userVisibleText(text: string): string {
  return text.replace(/<baton-(context|sync)>[\s\S]*<\/baton-\1>\s*/g, "").trim();
}

/**
 * Run status 文案合成（design §5.9）：运行阶段（compacting…）覆盖默认 thinking；
 * willRetry 错误仅当它是最新事件时显示 retrying——其后一旦有任何事件即视为已恢复，
 * 避免"重试成功后 retrying 挂到 turn 结束"。
 * phase 按 turn 取（并发 turn 各有各的阶段）；turnId 缺省时退化为任一带 phase 的 turn。
 */
export function runStatusLabel(
  state: Pick<SessionState, "activeTurns" | "lastError" | "lastSeq">,
  turnId?: string,
): string {
  const phase =
    turnId !== undefined
      ? state.activeTurns.get(turnId)?.phase
      : [...state.activeTurns.values()].find((turn) => turn.phase)?.phase;
  if (phase) return phase.title ?? `${phase.phase}…`;
  if (state.lastError?.willRetry && state.lastError.seq === state.lastSeq) return "retrying…";
  return "thinking…";
}

export interface ThoughtDisplayBlock {
  title: string;
  content?: string;
}

/** 将 reasoning summary 投影成独立时间线块，并隐藏 Codex 的空正文占位符。 */
export function thoughtDisplayBlocks(text: string): ThoughtDisplayBlock[] {
  return text
    .replace(/\r?\n\r?\n<!--\s*$/, "")
    .split(/\r?\n\r?\n<!-- -->\s*(?:\r?\n)?/g)
    .flatMap((part) => {
      const content = part.trim();
      if (!content) return [];
      const summary = content.match(/^\*\*([^*\n]+)\*\*(?:\r?\n\r?\n([\s\S]*))?$/);
      if (summary) {
        const body = summary[2]?.trim();
        return [{ title: summary[1]!.trim(), ...(body ? { content: body } : {}) }];
      }
      const [title, ...body] = content.split(/\r?\n/);
      const detail = body.join("\n").trim();
      return [{ title: title!.trim(), ...(detail ? { content: detail } : {}) }];
    });
}

interface PendingPicker {
  id: string;
  title: string;
  options: Array<{ name: string; description: string; value: string }>;
  onSelect: (value: string) => void | Promise<void>;
}

export class BatonChatProtocol implements ChatProtocol {
  private session: SessionHandle;
  private state: SessionState;
  private runtime: BatonSessionRuntime;
  private agent: ProviderName;
  private status: StatusMessage | null = null;
  private commandOutput: TranscriptItem | null = null;
  private picker: PendingPicker | null = null;
  private nextOverlayId = 1;
  private listeners = new Set<() => void>();
  private view: ChatViewState;
  private unsubscribeSession: () => void;

  constructor(
    private readonly store: SessionStore,
    private readonly config: BatonConfig,
    opened: { session: SessionHandle; resumed: boolean; recovered?: boolean },
    private readonly quit: (sessionId?: string) => void,
  ) {
    this.session = opened.session;
    this.agent = config.defaultAgent;
    if (opened.recovered) {
      this.status = { text: "Recovered an interrupted turn from a previous baton run", tone: "info" };
    }
    this.runtime = this.createRuntime();
    // 投影单通道：live 与 resume 走同一条 reduce 路径（loadState 补历史 + subscribe 跟增量），
    // 不从 per-turn 回调取事件——provider 自发回合（observed turn）没有对应的 submit 调用。
    this.state = this.session.loadState();
    this.unsubscribeSession = this.subscribeSession(this.session);
    this.view = this.buildView();
  }

  /** 接入事件流增量投影；调用前 state 必须已 loadState 到当前水位 */
  private subscribeSession(session: SessionHandle): () => void {
    return session.subscribe((envelope) => {
      applyEvent(this.state, envelope);
      this.changed();
    });
  }

  // ===== 输出：baton → TUI =====

  getView(): ChatViewState {
    return this.view;
  }

  subscribe(onChange: () => void): () => void {
    this.listeners.add(onChange);
    return () => this.listeners.delete(onChange);
  }

  // ===== 输入：TUI → baton =====

  async submit(text: string): Promise<void> {
    const target = this.agent;
    this.status = null;
    this.commandOutput = null;
    this.session.setPreviewIfEmpty(text);
    const { prompt } = expandMentions(this.store, text, this.config.mentionBudgetChars);
    const blocks: PromptBlock[] = [{ type: "text", text: prompt }];

    // busy 且当前 provider 支持时默认 steer（对齐原生"打字即纠偏"体验）；队列非空时
    // 例外——已有排队的 follow-up 意味着用户在按顺序编排，插队 steer 会打乱预期顺序。
    if (this.runtime.queueLength === 0 && this.runtime.canSteer(target)) {
      const steered = await this.runtime.steer(target, blocks);
      if (steered.effective === "steer") {
        this.status = { text: `steering ${target} — applies at the next safe point`, tone: "info" };
        this.changed();
        return;
      }
      // 降级如实提示（design §3.7：不能把 follow-up 仍标成 steer）
      this.status = { text: `${target} steer rejected; queued as follow-up`, tone: "info" };
      this.changed();
      const outcome = await steered.outcome;
      if (outcome === "completed" && this.status?.tone !== "error") {
        this.status = null;
        this.changed();
      }
      return;
    }

    if (this.runtime.isBusy || this.runtime.queueLength > 0) {
      this.status = { text: `${target} turn queued`, tone: "info" };
    }
    this.changed();
    const outcome = await this.runtime.submit(target, blocks);
    if (outcome === "completed" && this.status?.tone !== "error") {
      this.status = null;
      this.changed();
    }
  }

  async command(name: string, argument: string): Promise<void> {
    if (name !== "status") this.commandOutput = null;
    const command = name as CommandName;
    switch (command) {
      case "exit":
        return this.exit();
      case "new": {
        if (argument) throw new Error("/new takes no arguments");
        return this.switchSession(() => {
          const next = this.store.createSession({ cwd: this.session.meta.cwd });
          next.acquireLock();
          return { session: next };
        });
      }
      case "sessions": {
        // chat-tui Picker 没有自定义按键，模式经参数选择（启动 picker 则用 Tab 就地切换）
        const mode = argument || "list";
        if (mode !== "list" && mode !== "tree") {
          throw new Error(`/sessions takes 'tree' or 'list' (got: ${argument})`);
        }
        this.openSessionsPicker(mode);
        return;
      }
      case "status": {
        if (argument) throw new Error("/status takes no arguments");
        this.status = null;
        this.commandOutput = this.sessionStatusItem();
        this.changed();
        return;
      }
      case "codex":
      case "claude": {
        if (argument) throw new Error(`/${command} takes no arguments`);
        this.agent = command;
        this.status = null;
        this.changed();
        return;
      }
      case "model": {
        const target = this.agent;
        const models = await this.runtime.listModels(target);
        if (!argument) {
          this.openPicker({
            title: `Select ${target} model`,
            options: models.map((m) => ({ name: m.label, description: m.description ?? m.id, value: m.id })),
            onSelect: async (value) => {
              const model = models.find((candidate) => candidate.id === value);
              if (model) await this.configureModel(target, model);
            },
          });
          return;
        }
        const normalized = argument.toLowerCase();
        const model = models.find(
          (candidate) => candidate.id.toLowerCase() === normalized || candidate.label.toLowerCase() === normalized,
        );
        if (!model) throw new Error(`Unknown ${target} model: ${argument}`);
        return this.configureModel(target, model);
      }
      default:
        throw new Error(`Unknown command: /${name}`);
    }
  }

  cancel(): void {
    void this.runtime.cancelActive();
  }

  /** 优雅退出：先关掉 agent 子进程再退（对应 /exit、双击 Ctrl+C、Ctrl+D） */
  async exit(): Promise<void> {
    this.status = { text: "Exiting…", tone: "info" };
    this.changed();
    await this.runtime.close();
    this.unsubscribeSession();
    this.session.releaseLock();
    this.quit(this.session.id);
  }

  resolvePicker(id: string, value: string | null): void {
    const picker = this.picker;
    if (!picker || picker.id !== id) return;
    this.picker = null;
    this.changed();
    if (value === null) return;
    void (async () => {
      try {
        await picker.onSelect(value);
      } catch (error) {
        this.status = { text: error instanceof Error ? error.message : String(error), tone: "error" };
        this.changed();
      }
    })();
  }

  /**
   * 审批卡片应答 → runtime 的 resolver 注册表（id 即事件流里的 requestId）。
   * 卡片消失不在这里发生：被唤醒的 adapter 发 permission_resolved 落盘，
   * reduced pending 删除后视图自然更新——UI 只消费事件流投影，不维护第二份状态。
   */
  resolveApproval(id: string, optionId: string): void {
    if (!this.runtime.resolvePermission(id, { optionId })) {
      // 无 resolver：请求已被应答，或是崩溃残留（新进程没有等待中的 adapter）
      this.status = { text: "approval request is no longer pending", tone: "info" };
      this.changed();
    }
  }

  resolveQuestion(id: string, answers: QuestionAnswers): void {
    if (!this.runtime.resolveQuestion(id, { answers })) {
      this.status = { text: "question is no longer pending", tone: "info" };
      this.changed();
    }
  }

  recallQueued(): { text: string } | null {
    const recalled = this.runtime.recallLatestQueued();
    if (!recalled) return null;
    const provider = parseProvider(recalled.provider);
    if (provider) this.agent = provider;
    this.status = { text: `Recalled queued message for ${recalled.provider}; edit and resend`, tone: "info" };
    this.changed();
    return { text: userVisibleText(textOf(recalled.blocks)) };
  }

  /** @ 候选源，注入给 ChatShell */
  mentionCandidates = (prefix: string): Candidate[] =>
    sessionMentionCandidates(this.store.listSessions(), prefix, { excludeSessionId: this.session.id });

  // ===== 内部 =====

  private createRuntime(): BatonSessionRuntime {
    return new BatonSessionRuntime({
      session: this.session,
      mentionBudgetChars: this.config.mentionBudgetChars,
      // 交互回调由 runtime 提供（resolver 注册表）：protocol 不再持有交互状态
      createAdapter: (name, handlers) =>
        createProviderAdapter(name as ProviderName, { ...handlers, config: this.config }),
      providerSessionKey: (name) => providerSessionKey(name as ProviderName),
      onStateChange: () => this.changed(),
    });
  }

  /**
   * open 以回调传入且在 busy 检查之后才执行：目标会话的锁在 openBatonSession 里
   * 获取，若先锁后检查，busy 抛错会把已锁的目标泄漏给当前进程。
   */
  private async switchSession(
    open: () => { session: SessionHandle; recovered?: boolean },
  ): Promise<void> {
    if (this.runtime.isBusy || this.runtime.queueLength > 0) {
      throw new Error("Wait for the current turn to finish before switching BatonSession");
    }
    const next = open();
    await this.runtime.close();
    this.unsubscribeSession();
    this.session.releaseLock();
    this.session = next.session;
    this.commandOutput = null;
    this.runtime = this.createRuntime();
    this.state = next.session.loadState();
    this.unsubscribeSession = this.subscribeSession(next.session);
    this.status = next.recovered
      ? { text: `Opened session ${next.session.id} (recovered an interrupted turn)`, tone: "info" }
      : { text: `Opened session ${next.session.id}`, tone: "info" };
    this.changed();
  }

  private async configureModel(target: ProviderName, model: { id: string; label: string }): Promise<void> {
    await this.runtime.setModel(target, model.id);
    this.status = { text: `${target} model: ${model.label} (takes effect next turn)`, tone: "info" };
    this.changed();
  }

  /** 控制命令输出只进入当前 view，不写 session.jsonl，避免污染可恢复的会话历史。 */
  private sessionStatusItem(): TranscriptItem {
    const meta = this.session.meta;
    const active = this.runtime.activeProvider;
    const selectedModel = this.runtime.currentModel(this.agent) ?? "default";
    const providers = Object.keys(meta.providerSessions).join(", ") || "-";
    const preview = meta.preview ?? meta.title ?? "(empty session)";
    const text = [
      `Session: ${meta.batonSessionId}`,
      `Preview: ${preview}`,
      `Directory: ${meta.cwd}`,
      `Current: ${this.agent} - model ${selectedModel}`,
      `Providers: ${providers}`,
      `Turns: ${this.state.turnSummaries.length} - tokens in ${this.state.usage.inputTokens} / out ${this.state.usage.outputTokens}`,
      `State: ${active ? `running (${active})` : "idle"} - queue ${this.runtime.queueLength}`,
    ].join("\n");
    return { type: "message", id: "_baton_status", role: "agent", author: "baton", text, format: "plain" };
  }

  /** /sessions 会话内切换浮层；行投影与启动 session picker 共用 sessionPickerOptions */
  private openSessionsPicker(mode: SessionPickerMode = "list"): void {
    this.openPicker({
      title: `Select BatonSession${mode === "tree" ? " (tree)" : ""}`,
      options: sessionPickerOptions(this.store.listSessions(), {
        currentSessionId: this.session.id,
        mode,
      }),
      onSelect: async (value) => {
        if (value === this.session.id) return;
        await this.switchSession(() =>
          openBatonSession(this.store, { cwd: this.session.meta.cwd, sessionId: value }),
        );
      },
    });
  }

  private openPicker(picker: Omit<PendingPicker, "id">): void {
    this.picker = { ...picker, id: `pk_${this.nextOverlayId++}` };
    this.changed();
  }

  /** 快照式更新：每次变更整体替换 view 再通知（getView 引用稳定性要求） */
  private changed(): void {
    this.view = this.buildView();
    for (const listener of this.listeners) listener();
  }

  private buildView(): ChatViewState {
    const v = this.state;
    const active = this.runtime.activeProvider;
    // pending 交互从事件流投影（Map 保插入序，取最早的一个）；id 即 requestId，
    // 应答经 runtime 的 resolver 注册表回到 adapter 的 await 点
    const approval = v.pendingPermissions.values().next().value;
    const question = v.pendingQuestions.values().next().value;
    const selectedModel = this.runtime.currentModel(this.agent) ?? "default";
    const selectedBusy = active === this.agent;
    // Agent Status（贴 composer 顶部）：主行=当前输入目标（provider · model）常驻，
    // 运行相位（语义合成在 baton：phase/retry/thinking）仅 busy 时附加；跳秒由组件按 startedAt 自理。
    // 输入目标 ≠ 正在运行的 provider 时（运行中用 /codex 或 /claude 切换），运行者单独一行——
    // 未来 provider 上报的子 agent 状态也走附加行（best-effort），行形状已就绪。
    const activeTurnId = this.runtime.activeTurnId;
    const runStatus: RunStatusItem[] = [
      selectedBusy
        ? {
            id: `agent:${this.agent}`,
            author: providerAuthor(this.agent),
            label: `${selectedModel} · ${runStatusLabel(v, activeTurnId)}`,
            startedAt: this.runtime.activeStartedAt,
            hint: "Esc to interrupt",
          }
        : { id: `agent:${this.agent}`, author: providerAuthor(this.agent), label: selectedModel },
    ];
    if (active !== undefined && !selectedBusy) {
      runStatus.push({
        id: `run:${active}`,
        author: providerAuthor(active),
        label: runStatusLabel(v, activeTurnId),
        startedAt: this.runtime.activeStartedAt,
        hint: "Esc to interrupt",
      });
    }
    // observed turn（provider 自发回合，如后台任务唤醒）：每个各占一行——driven turn
    // 运行时并发的后台回合同样要呈现，否则 agent 在"静默"状态下说话。无 hint——Esc
    // 中断的是 runtime 队列里的 driven turn，管不到 provider 自己发起的回合
    // （v1 不支持打断 observed turn）。
    const observedRuns = [...v.activeTurns.values()].filter((turn) => turn.origin === "provider");
    for (const run of observedRuns) {
      runStatus.push({
        id: `run:observed:${run.turnId}`,
        author: providerAuthor(run.provider),
        label: `${runStatusLabel(v, run.turnId)} · background`,
        startedAt: run.startedAt,
      });
    }
    const busy = active !== undefined || observedRuns.length > 0;
    // plan 互补显示（design §5.9）：同一时刻只出现在一个地方——进行中归 pin（现在时），
    // 盖棺归 transcript（过去时）。pin 显示期间 transcript 不渲染该 plan 卡（避免同屏两份、
    // 且过去时区域不该有实时改写的块）；全部完成 pin 停发，终态卡在 timeline 原位出现供回看。
    // pin 同时以运行态门控：idle 后未完成的 plan 也归 transcript（搁置即过去时）——
    // 否则 provider 状态更新缺失或中途放弃时 pin 永驻；下一回合开跑即重新上 pin。
    const lastPlan = [...v.plans.values()].at(-1);
    const planEntries = (lastPlan?.entries ?? []).map((entry) => ({
      content: entry.content,
      status: normalizePlanStatus(entry.status),
    }));
    const planActive = busy && planEntries.some((entry) => entry.status !== "completed");
    const pinnedPlanId = planActive ? lastPlan?.planId : undefined;
    return {
      transcript: [...buildTranscript(v, pinnedPlanId), ...(this.commandOutput ? [this.commandOutput] : [])],
      busy,
      runStatus,
      plan: planActive ? planEntries : undefined,
      queued: this.runtime.queuedTurns.map((turn) => ({
        id: String(turn.id),
        text: userVisibleText(textOf(turn.blocks)),
        tag: turn.provider,
      })),
      picker: this.picker
        ? { id: this.picker.id, title: this.picker.title, options: this.picker.options }
        : null,
      approval: approval
        ? { id: approval.requestId, title: approval.title, options: approval.options }
        : null,
      question: question
        ? {
            id: question.requestId,
            questions: question.questions.map((prompt) => ({
              id: prompt.questionId,
              header: prompt.header,
              question: prompt.question,
              options: prompt.options,
              multiSelect: prompt.multiSelect,
              allowOther: prompt.allowOther,
              secret: prompt.secret,
            })),
          }
        : null,
      status: this.status,
      footer: `session:${this.session.id}  in:${v.usage.inputTokens} out:${v.usage.outputTokens}  turns:${v.turnSummaries.length}  queue:${this.runtime.queueLength}${planActive ? `  plan:${planEntries.filter((entry) => entry.status === "completed").length}/${planEntries.length}` : ""}  cwd:${this.session.meta.cwd}`,
      // ↑ 召回提示只在"可召回"时出现：交互发生地是 composer（placeholder 天然只在空输入时可见）
      // busy 且可 steer 时提示 Enter 的实际语义（design §3.2：delivery 对用户可见、可预期）
      composerPlaceholder: `Message ${this.agent} (/ commands, @ mentions, ${
        this.runtime.queueLength > 0
          ? "↑ recall queued"
          : this.runtime.canSteer(this.agent)
            ? "Enter steers current turn"
            : "Ctrl+J newline"
      })`,
      header: `baton · session ${this.session.id}\ntype to chat · /codex or /claude switch · /sessions open · @bs_xxx reference another session\n`,
      showThoughts: this.config.showThoughts,
    };
  }
}

// baton 的状态类型是开放联合（容忍未知 wire 值），chat-tui 是闭集；
// 未知值回落到与旧 TUI 相同的展示形态（工具 ⋯ / 计划 ☐）。
const TOOL_STATUSES = new Set(["pending", "in_progress", "completed", "failed", "declined"]);
const PLAN_STATUSES = new Set(["pending", "in_progress", "completed"]);

function normalizeToolStatus(status: string): "pending" | "in_progress" | "completed" | "failed" | "declined" {
  return (TOOL_STATUSES.has(status) ? status : "in_progress") as ReturnType<typeof normalizeToolStatus>;
}

function normalizePlanStatus(status: string): "pending" | "in_progress" | "completed" {
  return (PLAN_STATUSES.has(status) ? status : "pending") as ReturnType<typeof normalizePlanStatus>;
}

function commandOf(tc: ToolCallState, fallback: string): string {
  const input = tc.rawInput as Record<string, unknown> | undefined;
  return typeof input?.command === "string" ? input.command : fallback;
}

const DIFF_OPS = new Set<DiffOp>(["add", "modify", "delete", "move"]);

/** 事件模型的开放 operation → chat-tui 的闭合 DiffOp；未知操作按 modify 处理（最保守的展示待遇） */
function diffOpOf(operation: string): DiffOp {
  if (operation === "update") return "modify";
  if (operation === "rename") return "move";
  return DIFF_OPS.has(operation as DiffOp) ? (operation as DiffOp) : "modify";
}

/** 命令卡标题的时态即事实：declined 的命令没有跑过，不能写 Ran */
function executeTitleOf(status: ReturnType<typeof normalizeToolStatus>): string {
  if (status === "in_progress") return "Running";
  if (status === "declined") return "Declined";
  return "Ran";
}

/** 工具状态 → chat-tui 展示块；命令源码和 diff 保持结构化，避免组件层猜字符串。 */
export function toolTranscriptItem(tc: ToolCallState): Extract<TranscriptItem, { type: "block" }> {
  const status = normalizeToolStatus(tc.status);
  const rawTitle = tc.title ?? tc.toolCallId;
  const content: TranscriptBlockContent[] = [];

  if (tc.kind === "execute") {
    // language 不写死：chat-tui 对 command 缺省按 shell 高亮
    content.push({ type: "command", command: commandOf(tc, rawTitle) });
  }

  for (const block of tc.content) {
    if (block.type !== "diff") continue;
    const diff = block as DiffBlock;
    for (const [index, change] of diff.changes.entries()) {
      content.push({
        type: "diff",
        op: diffOpOf(change.operation),
        path: change.path,
        oldPath: change.oldPath,
        // DiffBlock 契约：patch 归 changes[0]（adapter 按单文件发块）
        patch: index === 0 ? diff.patch : undefined,
      });
    }
  }

  // 输出传全量行不预截断；output 类型的展示待遇（弱化色、全量渲染）归 chat-tui
  const outputLines = textOf(tc.content).split("\n").filter(Boolean);
  if (outputLines.length > 0) content.push({ type: "output", lines: outputLines });

  return {
    type: "block",
    id: tc.toolCallId,
    kind: "tool",
    author: providerAuthor(tc.provider),
    title: tc.kind === "execute" ? executeTitleOf(status) : rawTitle,
    status,
    content: content.length > 0 ? content : undefined,
  };
}

/**
 * SessionState → chat-tui 展示形状。provider 内容在这里收敛为通用 command/output/diff/lines，块语义不出 baton。
 * pinnedPlanId：正被 pin 区承载的 plan——按互补显示规则跳过其 transcript 卡（见 buildView 处注释）。
 */
function buildTranscript(state: SessionState, pinnedPlanId?: string): TranscriptItem[] {
  const items: TranscriptItem[] = [];
  const noticesById = new Map(state.notices.map((notice) => [`n_${notice.seq}`, notice]));
  for (const entry of state.timeline) {
    if (entry.type === "notice") {
      const notice = noticesById.get(entry.id);
      if (!notice) continue;
      // warning/error 用 failed（红色 ✗）：打断标记等要像 Codex 一样醒目；info 用 pending（低调 ○）
      items.push({
        type: "block",
        id: entry.id,
        kind: "notice",
        status: notice.level === "info" ? "pending" : "failed",
        title: notice.detail ? `${notice.title} · ${notice.detail}` : notice.title,
      });
      continue;
    }
    if (entry.type === "message") {
      const msg = state.messages.get(entry.id);
      if (!msg) continue;
      if (msg.role === "thought") {
        const turnCompleted = state.turnSummaries.some((summary) => summary.turnId === msg.turnId);
        const status =
          msg.streamStatus === "completed" || turnCompleted || !isTurnRunning(state, msg.turnId)
            ? "completed"
            : "in_progress";
        for (const [index, block] of thoughtDisplayBlocks(textOf(msg.content)).entries()) {
          items.push({
            type: "block",
            id: `${entry.id}:${index}`,
            kind: "thought",
            status,
            author: providerAuthor(msg.provider),
            title: block.title,
            content: block.content ? { type: "text", text: block.content } : undefined,
          });
        }
        continue;
      }
      const author = msg.role === "user" ? "you" : (providerAuthor(msg.provider) ?? "agent");
      items.push({
        type: "message",
        id: entry.id,
        role: msg.role === "user" ? "user" : "agent",
        author,
        text: msg.role === "user" ? userVisibleText(textOf(msg.content)) : textOf(msg.content),
        ...(msg.role === "agent"
          ? {
              format: "markdown" as const,
              // 流式指示按消息所属 turn 判：并发 turn 下别人收口不打断自己的流
              streaming: msg.streamStatus === "in_progress" && isTurnRunning(state, msg.turnId),
            }
          : { format: "plain" as const }),
      });
      continue;
    }
    if (entry.type === "tool_call") {
      const tc = state.toolCalls.get(entry.id);
      if (!tc) continue;
      items.push(toolTranscriptItem(tc));
      continue;
    }
    const plan = state.plans.get(entry.id);
    if (!plan) continue;
    if (plan.planId === pinnedPlanId) continue; // 进行中归 pin，transcript 只在盖棺后展示终态卡
    const entries = plan.entries.map((e) => ({ content: e.content, status: normalizePlanStatus(e.status) }));
    const status =
      entries.length > 0 && entries.every((entry) => entry.status === "completed")
        ? "completed"
        : entries.some((entry) => entry.status === "in_progress" || entry.status === "completed")
          ? "in_progress"
          : "pending";
    items.push({
      type: "block",
      id: entry.id,
      kind: "plan",
      title: "Plan",
      status,
      content: { type: "plan", entries },
    });
  }
  return items;
}
