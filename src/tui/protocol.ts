// baton 对 chat-tui 的接入层：实现 ChatProtocol，把 BatonSessionRuntime / SessionStore
// 的状态投影成视图快照，把 TUI intents 翻译成 runtime 操作。
// UI 语义（补全、分层 Ctrl+C、浮层交互）都在 chat-tui；这里只有 baton 的业务编排。

import type {
  ChatProtocol,
  ChatViewState,
  Candidate,
  CommandSpec,
  StatusMessage,
  TranscriptBlockContent,
  TranscriptItem,
  QuestionAnswers,
} from "chat-tui";

import { COMMANDS, parseProvider, PROVIDERS, type CommandName, type ProviderName } from "../commands/registry.ts";
import type { BatonConfig } from "../config/config.ts";
import { expandMentions } from "../context/mention.ts";
import { textOf, type DiffBlock, type PermissionRequest, type QuestionRequest } from "../events/types.ts";
import { createProviderAdapter, providerSessionKey } from "../providers/registry.ts";
import { openBatonSession } from "../session/open.ts";
import { BatonSessionRuntime } from "../session/runtime.ts";
import { applyEvent, emptySessionState, type SessionState, type ToolCallState } from "../store/reduce.ts";
import type { SessionHandle, SessionStore } from "../store/store.ts";
import { sessionMentionCandidates } from "./mentions.ts";

// 展示名同时是 theme.ts PROVIDER_COLORS 的着色 key，两处保持一致
const PROVIDER_LABEL: Record<string, string> = { codex: "codex", "claude-code": "claude" };

export const CHAT_COMMANDS: readonly CommandSpec[] = COMMANDS;

export function userVisibleText(text: string): string {
  return text.replace(/<baton-(context|sync)>[\s\S]*<\/baton-\1>\s*/g, "").trim();
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

interface PendingApproval {
  id: string;
  request: PermissionRequest;
  resolve: (d: { optionId: string }) => void;
}

interface PendingQuestion {
  id: string;
  request: QuestionRequest;
  resolve: (d: { answers: Record<string, string[]> }) => void;
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
  private approvals: PendingApproval[] = [];
  private questions: PendingQuestion[] = [];
  private picker: PendingPicker | null = null;
  private nextOverlayId = 1;
  private listeners = new Set<() => void>();
  private view: ChatViewState;

  constructor(
    private readonly store: SessionStore,
    private readonly config: BatonConfig,
    opened: { session: SessionHandle; resumed: boolean; recovered?: boolean },
    private readonly quit: () => void,
  ) {
    this.session = opened.session;
    this.state = opened.resumed ? opened.session.loadState() : emptySessionState();
    this.agent = config.defaultAgent;
    if (opened.recovered) {
      this.status = { text: "Recovered an interrupted turn from a previous baton run", tone: "info" };
    }
    this.runtime = this.createRuntime();
    this.view = this.buildView();
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
    const { prompt } = expandMentions(this.store, text, this.config.mentionBudgetChars);
    if (this.runtime.isBusy || this.runtime.queueLength > 0) {
      this.status = { text: `${target} turn queued`, tone: "info" };
    }
    this.changed();
    const outcome = await this.runtime.submit(target, [{ type: "text", text: prompt }], (envelope) => {
      applyEvent(this.state, envelope);
      this.changed();
    });
    if (outcome === "completed" && this.status?.tone !== "error") {
      this.status = null;
      this.changed();
    }
  }

  async command(name: string, argument: string): Promise<void> {
    switch (name as CommandName) {
      case "exit":
        return this.exit();
      case "new": {
        if (argument) throw new Error("/new takes no arguments");
        return this.switchSession(() => {
          const next = this.store.createSession({
            cwd: this.session.meta.cwd,
            title: `chat @ ${this.session.meta.cwd}`,
          });
          next.acquireLock();
          return { session: next };
        });
      }
      case "sessions": {
        if (argument) throw new Error("/sessions takes no arguments");
        this.openSessionsPicker();
        return;
      }
      case "provider": {
        if (!argument) {
          this.openPicker({
            title: "Select provider",
            options: PROVIDERS.map((p) => ({ name: p, description: `Switch to ${p}`, value: p })),
            onSelect: (value) => this.setAgent(value),
          });
          return;
        }
        const provider = parseProvider(argument);
        if (!provider) throw new Error(`Unknown provider: ${argument} (available: ${PROVIDERS.join(" / ")})`);
        this.agent = provider;
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
    this.session.releaseLock();
    this.quit();
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

  resolveApproval(id: string, optionId: string): void {
    const index = this.approvals.findIndex((approval) => approval.id === id);
    if (index < 0) return;
    const [approval] = this.approvals.splice(index, 1);
    approval!.resolve({ optionId });
    this.changed();
  }

  resolveQuestion(id: string, answers: QuestionAnswers): void {
    const index = this.questions.findIndex((question) => question.id === id);
    if (index < 0) return;
    const [question] = this.questions.splice(index, 1);
    question!.resolve({ answers });
    this.changed();
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

  /** adapter 的审批回调：挂进队列，由 TUI 的审批卡片经 resolveApproval 应答 */
  private approvalHandler = (request: PermissionRequest): Promise<{ optionId: string }> =>
    new Promise((resolve) => {
      this.approvals.push({ id: `ap_${this.nextOverlayId++}`, request, resolve });
      this.changed();
    });

  private questionHandler = (request: QuestionRequest): Promise<{ answers: Record<string, string[]> }> =>
    new Promise((resolve) => {
      this.questions.push({ id: `qu_${this.nextOverlayId++}`, request, resolve });
      this.changed();
    });

  private createRuntime(): BatonSessionRuntime {
    return new BatonSessionRuntime({
      session: this.session,
      mentionBudgetChars: this.config.mentionBudgetChars,
      createAdapter: (name) =>
        createProviderAdapter(name as ProviderName, {
          approvalHandler: this.approvalHandler,
          questionHandler: this.questionHandler,
          config: this.config,
        }),
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
    this.session.releaseLock();
    this.session = next.session;
    this.state = next.session.loadState();
    this.runtime = this.createRuntime();
    this.status = next.recovered
      ? { text: `Opened session ${next.session.id} (recovered an interrupted turn)`, tone: "info" }
      : { text: `Opened session ${next.session.id}`, tone: "info" };
    this.changed();
  }

  private setAgent(value: string): void {
    const provider = parseProvider(value);
    if (provider) {
      this.agent = provider;
      this.changed();
    }
  }

  private async configureModel(target: ProviderName, model: { id: string; label: string }): Promise<void> {
    await this.runtime.setModel(target, model.id);
    this.status = { text: `${target} model: ${model.label} (takes effect next turn)`, tone: "info" };
    this.changed();
  }

  /** /sessions 与启动 resume picker 共用：选中即切到既有会话 */
  private openSessionsPicker(): void {
    this.openPicker({
      title: "Select BatonSession",
      options: this.sessionPickerOptions(),
      onSelect: async (value) => {
        if (value === this.session.id) return;
        await this.switchSession(() =>
          openBatonSession(this.store, { cwd: this.session.meta.cwd, sessionId: value }),
        );
      },
    });
  }

  private sessionPickerOptions(): Array<{ name: string; description: string; value: string }> {
    return this.store.listSessions().map((meta) => ({
      name: `${meta.batonSessionId === this.session.id ? "● " : ""}${meta.title ?? meta.batonSessionId}`,
      description: `${meta.cwd} · ${meta.updatedAt ?? meta.createdAt}`,
      value: meta.batonSessionId,
    }));
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
    const approval = this.approvals[0];
    const question = this.questions[0];
    const selectedModel = this.runtime.currentModel(this.agent) ?? "default";
    const selectedBusy = active === this.agent;
    return {
      transcript: buildTranscript(v),
      busy: active !== undefined,
      runningNotices: active ? [`${active} thinking… (Esc to interrupt)`] : [],
      queued: this.runtime.queuedTurns.map((turn) => ({
        id: String(turn.id),
        text: userVisibleText(textOf(turn.blocks)),
        tag: turn.provider,
      })),
      queuedHint: "↑ edit last queued message",
      picker: this.picker
        ? { id: this.picker.id, title: this.picker.title, options: this.picker.options }
        : null,
      approval: approval
        ? { id: approval.id, title: approval.request.title, options: approval.request.options }
        : null,
      question: question
        ? {
            id: question.id,
            questions: question.request.questions.map((prompt) => ({
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
      footer: `in:${v.usage.inputTokens} out:${v.usage.outputTokens}  turns:${v.turnSummaries.length}  queue:${this.runtime.queueLength}  cwd:${this.session.meta.cwd}`,
      composerTitle: `provider:${this.agent} · model:${selectedModel}${selectedBusy ? " · running" : ""}`,
      composerPlaceholder: `Message ${this.agent} (/ commands, @ mentions, Ctrl+J newline)`,
      header: `baton · session ${this.session.id}\ntype to chat · /provider switch · /sessions open · @bs_xxx reference another session\n`,
      showThoughts: this.config.showThoughts,
    };
  }
}

// baton 的状态类型是开放联合（容忍未知 wire 值），chat-tui 是闭集；
// 未知值回落到与旧 TUI 相同的展示形态（工具 ⋯ / 计划 ☐）。
const TOOL_STATUSES = new Set(["pending", "in_progress", "completed", "failed"]);
const PLAN_STATUSES = new Set(["pending", "in_progress", "completed"]);

function normalizeToolStatus(status: string): "pending" | "in_progress" | "completed" | "failed" {
  return (TOOL_STATUSES.has(status) ? status : "in_progress") as ReturnType<typeof normalizeToolStatus>;
}

function normalizePlanStatus(status: string): "pending" | "in_progress" | "completed" {
  return (PLAN_STATUSES.has(status) ? status : "pending") as ReturnType<typeof normalizePlanStatus>;
}

function commandOf(tc: ToolCallState, fallback: string): string {
  const input = tc.rawInput as Record<string, unknown> | undefined;
  return typeof input?.command === "string" ? input.command : fallback;
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

  const detailLines: string[] = [];
  for (const block of tc.content) {
    if (block.type !== "diff") continue;
    const diff = block as DiffBlock;
    if (diff.patch) {
      content.push({ type: "diff", patch: diff.patch, path: diff.changes[0]?.path });
    } else {
      for (const change of diff.changes) detailLines.push(`± ${change.operation} ${change.path}`);
    }
  }

  if (detailLines.length > 0) content.push({ type: "lines", lines: detailLines });

  // 输出传全量行不预截断；output 类型的展示待遇（弱化色、全量渲染）归 chat-tui
  const outputLines = textOf(tc.content).split("\n").filter(Boolean);
  if (outputLines.length > 0) content.push({ type: "output", lines: outputLines });

  return {
    type: "block",
    id: tc.toolCallId,
    kind: "tool",
    title: tc.kind === "execute" ? (status === "in_progress" ? "Running" : "Ran") : rawTitle,
    status,
    content: content.length > 0 ? content : undefined,
  };
}

/** SessionState → chat-tui 展示形状。provider 内容在这里收敛为通用 command/output/diff/lines，块语义不出 baton。 */
function buildTranscript(state: SessionState): TranscriptItem[] {
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
          msg.streamStatus === "completed" || turnCompleted || state.runState !== "running"
            ? "completed"
            : "in_progress";
        for (const [index, block] of thoughtDisplayBlocks(textOf(msg.content)).entries()) {
          items.push({
            type: "block",
            id: `${entry.id}:${index}`,
            kind: "thought",
            status,
            title: block.title,
            content: block.content ? { type: "text", text: block.content } : undefined,
          });
        }
        continue;
      }
      const author =
        msg.role === "user" ? "you" : (PROVIDER_LABEL[msg.provider ?? ""] ?? msg.provider ?? "agent");
      items.push({
        type: "message",
        id: entry.id,
        role: msg.role === "user" ? "user" : "agent",
        author,
        text: msg.role === "user" ? userVisibleText(textOf(msg.content)) : textOf(msg.content),
        ...(msg.role === "agent"
          ? {
              format: "markdown" as const,
              streaming: msg.streamStatus === "in_progress" && state.runState === "running",
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
