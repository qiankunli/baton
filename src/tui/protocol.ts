// baton 对 chat-tui 的接入层：实现 ChatProtocol，把 BatonSessionRuntime / SessionStore
// 的状态投影成视图快照，把 TUI intents 翻译成 runtime 操作。
// UI 语义（补全、分层 Ctrl+C、浮层交互）都在 chat-tui；这里只有 baton 的业务编排。

import type {
  BlockTone,
  ChatProtocol,
  ChatViewState,
  Candidate,
  CommandSpec,
  DiffOp,
  RunStatusItem,
  StatusMessage,
  TranscriptBlockContent,
  TranscriptBlockStatus,
  TranscriptItem,
  QuestionAnswers,
} from "chat-tui";

import {
  COMMANDS,
  parseProvider,
  parseProviderRoute,
  type CommandName,
  type ProviderName,
} from "../commands/registry.ts";
import type { BatonConfig } from "../config/config.ts";
import { loadEffortPreferences, saveEffortPreference } from "../config/effort-preferences.ts";
import { loadModelPreferences, saveModelPreference } from "../config/model-preferences.ts";
import { expandMentions } from "../context/mention.ts";
import {
  textOf,
  type ApprovalReviewUpdate,
  type DiffBlock,
  type EventKind,
  type HookTrustRequest,
  type PermissionOption,
  type PromptBlock,
} from "../events/types.ts";
import {
  createProviderAdapter,
  providerDefinitionFor,
  providerSessionKey,
  providerShortName,
} from "../providers/registry.ts";
import { openBatonSession } from "../session/open.ts";
import { BatonSessionRuntime } from "../session/runtime.ts";
import { applyEvent, isTurnRunning, type SessionState, type ToolCallState } from "../store/reduce.ts";
import { sessionDisplayTitle, type SessionHandle, type SessionStore } from "../store/store.ts";
import { sessionMentionCandidates } from "./mentions.ts";
import { sessionPickerOptions, type SessionPickerMode } from "./session-picker.tsx";
import { setTerminalTabTitle } from "./terminal-title.ts";

// OpenTUI 以 30 FPS 绘制；逐 token 同步发布完整 view 只会让 React 重复重建 transcript，
// 还会挤占 composer 的终端光标刷新。只合并高频、可安全追加的流式事件；请求、终态和
// 完整快照仍立即发布，并顺带冲刷此前积累的 chunk，避免交互卡片被延迟。
const STREAM_VIEW_FRAME_MS = 33;
const COALESCED_STREAM_EVENT_KINDS: ReadonlySet<EventKind> = new Set([
  "agent_message_chunk",
  "agent_thought_chunk",
  "tool_call_content_chunk",
  "usage_update",
]);

/**
 * 双轴 → chat-tui 既有的 `kind` 词表。双轴是 baton 的内部模型，在边界投影回接入方
 * 已消费的形状——中间重构不惊动边界契约（kernel §3）。chat-tui 把 kind 当 description
 * 渲染，所以这里的取值直接是用户看见的字；等 chat-tui 改成消费双轴，再退掉这层。
 *
 * 旧事件流（双轴之前）的 option 只有 kind、没有两轴：原样透传它，不据缺失的轴伪造
 * 取值——replay 必须得到同样的累计结果（§5 三问③）。
 */
function approvalOptionKind(option: PermissionOption): string {
  const legacy = (option as { kind?: unknown }).kind;
  if (!option.polarity && typeof legacy === "string") return legacy;
  const lasting = option.lifetime !== "once";
  return option.polarity === "allow"
    ? lasting
      ? "allow_always"
      : "allow_once"
    : lasting
      ? "reject_always"
      : "reject_once";
}

function hookTrustDescription(request: HookTrustRequest): string {
  return request.hooks
    .map((hook) => {
      const owner = hook.pluginId ?? hook.source;
      const matcher = hook.matcher ? ` · matcher: ${hook.matcher}` : "";
      return `${owner} · ${hook.trustStatus}${matcher}\n${hook.sourcePath}\n${hook.command}`;
    })
    .join("\n\n");
}

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
 * Run status 文案合成（design §5.9）：显式阶段 / retry / 进行中工具依次覆盖默认 thinking；
 * willRetry 错误仅当它是最新事件时显示 retrying——其后一旦有任何事件即视为已恢复，
 * 避免"重试成功后 retrying 挂到 turn 结束"。
 * phase 按 turn 取（并发 turn 各有各的阶段）；turnId 缺省时退化为任一带 phase 的 turn。
 */
export function runStatusLabel(
  state: Pick<SessionState, "activeTurns" | "toolCalls" | "lastError" | "lastSeq">,
  turnId?: string,
): string {
  const phase =
    turnId !== undefined
      ? state.activeTurns.get(turnId)?.phase
      : [...state.activeTurns.values()].find((turn) => turn.phase)?.phase;
  if (phase) return phase.title ?? `${phase.phase}…`;
  if (state.lastError?.willRetry && state.lastError.seq === state.lastSeq) return "retrying…";
  const tool = [...state.toolCalls.values()]
    .reverse()
    .find(
      (candidate) =>
        (candidate.status === "pending" || candidate.status === "in_progress") &&
        (turnId === undefined || candidate.turnId === turnId),
    );
  if (tool) {
    const labels: Record<string, string> = {
      read: "reading…",
      edit: "editing…",
      delete: "deleting…",
      move: "moving…",
      search: "searching…",
      execute: "running command…",
      think: "thinking…",
      fetch: "fetching…",
    };
    return labels[tool.kind ?? ""] ?? `${tool.title?.split(":", 1)[0]?.trim() || "using tool"}…`;
  }
  return "thinking…";
}

function contextUsageText(
  context: { model?: string; contextUsed?: number; contextSize?: number } | undefined,
  selectedModel: string,
): string {
  if (!context || (context.model && context.model !== selectedModel)) {
    return "unavailable until the provider reports this model";
  }
  if (!context.contextSize || context.contextSize < 0) return "size unavailable";
  const size = context.contextSize.toLocaleString("en-US");
  if (context.contextUsed === undefined) return `${size} tokens`;
  const percent = Math.round((context.contextUsed / context.contextSize) * 100);
  return `${context.contextUsed.toLocaleString("en-US")} / ${size} tokens (${percent}%)`;
}

function contextUsageStatusText(
  context: { model?: string; contextUsed?: number; contextSize?: number } | undefined,
  selectedModel: string,
): string | undefined {
  if (
    !context ||
    (context.model && context.model !== selectedModel) ||
    context.contextUsed === undefined ||
    !context.contextSize ||
    context.contextSize < 0
  ) {
    return undefined;
  }
  const percent = Math.round((context.contextUsed / context.contextSize) * 100);
  return `context ${context.contextUsed.toLocaleString("en-US")}/${context.contextSize.toLocaleString("en-US")} (${percent}%)`;
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
  private streamViewTimer: ReturnType<typeof setTimeout> | undefined;
  // 输入历史（shell 式 ↑/↓ 回溯）：会话级，从事件流的 user 消息种入、提交时追加。
  // 事件流是真相源——不另存磁盘文件；resume/切换会话后 loadState 重建 state 即可重新种入。
  private history: string[] = [];
  private historyCursor: number | null = null; // null = 未浏览（正在编辑草稿）
  private historyStash: string | null = null; // 进入浏览前暂存的草稿，越过最新时恢复
  private lastHistoryText: string | null = null; // 上次召回的条目，判定用户是否改动过
  private readonly modelPreferences: Record<string, string>;
  private readonly effortPreferences: Record<string, string>;

  constructor(
    private readonly store: SessionStore,
    private readonly config: BatonConfig,
    opened: { session: SessionHandle; resumed: boolean; recovered?: boolean },
    private readonly quit: (sessionId?: string) => void,
  ) {
    this.session = opened.session;
    this.syncTerminalTitle();
    this.agent = config.defaultAgent;
    this.modelPreferences = loadModelPreferences(store.rootDir);
    this.effortPreferences = loadEffortPreferences(store.rootDir);
    if (opened.recovered) {
      this.status = { text: "Recovered an interrupted turn from a previous baton run", tone: "info" };
    }
    this.runtime = this.createRuntime();
    // 投影单通道：live 与 resume 走同一条 reduce 路径（loadState 补历史 + subscribe 跟增量），
    // 不从 per-turn 回调取事件——provider 自发回合（observed turn）没有对应的 submit 调用。
    this.state = this.session.loadState();
    this.seedHistoryFromState();
    this.unsubscribeSession = this.subscribeSession(this.session);
    this.view = this.buildView();
  }

  /** 接入事件流增量投影；调用前 state 必须已 loadState 到当前水位 */
  private subscribeSession(session: SessionHandle): () => void {
    return session.subscribe((envelope) => {
      applyEvent(this.state, envelope);
      if (COALESCED_STREAM_EVENT_KINDS.has(envelope.kind)) this.scheduleStreamViewChanged();
      else this.changed();
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
    const route = parseProviderRoute(text);
    if (route?.kind === "ambiguous") {
      this.status = null;
      this.commandOutput = this.batonTranscriptItem(
        "_baton_provider_route_error",
        `Error: provider prefix "/${route.token}" is ambiguous; matches ${route.providers.join(", ")}. Use a longer provider name or alias.`,
      );
      this.changed();
      return;
    }
    if (route?.kind === "matched") {
      this.agent = route.provider;
      this.status = null;
      this.commandOutput = null;
      this.changed();
      if (!route.message) return;
      return this.submitMessage(route.message);
    }
    return this.submitMessage(text);
  }

  private async submitMessage(text: string): Promise<void> {
    // 用户实际提交的内容进历史；一次新提交结束当前的 ↑ 浏览会话。
    this.recordHistory(text);
    this.resetHistoryNav();
    const target = this.agent;
    this.status = null;
    this.commandOutput = null;
    const previousTitle = sessionDisplayTitle(this.session.meta);
    if (this.session.meta.forkedFrom) this.session.setTitleIfEmpty(text);
    else this.session.setPreviewIfEmpty(text);
    if (sessionDisplayTitle(this.session.meta) !== previousTitle) this.syncTerminalTitle();
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
    const provider = parseProvider(name);
    if (provider) {
      this.agent = provider;
      this.status = null;
      this.changed();
      if (argument) await this.submitMessage(argument);
      return;
    }
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
      case "compact": {
        if (argument) throw new Error("/compact takes no arguments");
        const target = this.agent;
        this.status = null;
        await this.runtime.compactContext(target);
        this.status = { text: `${target} context compacted`, tone: "info" };
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
      case "effort": {
        const target = this.agent;
        const efforts = await this.runtime.listEfforts(target);
        if (!argument) {
          this.openPicker({
            title: `Select ${target} effort`,
            options: efforts.map((effort) => ({
              name: effort.label,
              description: effort.description ?? effort.id,
              value: effort.id,
            })),
            onSelect: async (value) => {
              const effort = efforts.find((candidate) => candidate.id === value);
              if (effort) await this.configureEffort(target, effort);
            },
          });
          return;
        }
        const normalized = argument.toLowerCase();
        const effort = efforts.find(
          (candidate) => candidate.id.toLowerCase() === normalized || candidate.label.toLowerCase() === normalized,
        );
        if (!effort) throw new Error(`Unknown ${target} effort: ${argument}`);
        return this.configureEffort(target, effort);
      }
      default:
        throw new Error(`Unknown command: /${name}`);
    }
  }

  cancel(): void {
    void this.runtime.control({ kind: "interrupt" });
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
   * 卡片消失不在这里发生：被唤醒的 adapter 发对应 *_resolved 落盘，
   * reduced pending 删除后视图自然更新——UI 只消费事件流投影，不维护第二份状态。
   */
  resolveApproval(id: string, optionId: string): void {
    const response = this.state.pendingHookTrusts.has(id)
      ? ({ kind: "hook_trust", requestId: id, decision: optionId === "trust" ? "trust" : "skip" } as const)
      : ({ kind: "permission", requestId: id, optionId } as const);
    if (!this.runtime.respond(response)) {
      // 无 resolver：请求已被应答，或是崩溃残留（新进程没有等待中的 adapter）
      this.status = { text: "approval request is no longer pending", tone: "info" };
      this.changed();
    }
  }

  resolveQuestion(id: string, answers: QuestionAnswers): void {
    if (!this.runtime.respond({ kind: "question", requestId: id, answers })) {
      this.status = { text: "question is no longer pending", tone: "info" };
      this.changed();
    }
  }

  recallQueued(): { text: string } | null {
    const recalled = this.runtime.recallLatestQueued();
    if (!recalled) return null;
    // 召回队列是另一种取回动作，结束进行中的历史浏览，避免游标错位。
    this.resetHistoryNav();
    const provider = parseProvider(recalled.provider);
    if (provider) this.agent = provider;
    this.status = { text: `Recalled queued message for ${recalled.provider}; edit and resend`, tone: "info" };
    this.changed();
    return { text: userVisibleText(textOf(recalled.blocks)) };
  }

  /**
   * ↑ 历史回溯（shell 式）。current 为输入框当前内容：首次进入浏览时暂存为草稿并跳到
   * 最新一条；连续浏览时若 current 已偏离上次召回的条目，说明用户改过 → 返回 null 让
   * TUI 放行为普通光标移动。已到最旧则停住（返回 null）。
   */
  historyPrev(current: string): { text: string } | null {
    if (this.history.length === 0) return null;
    if (this.historyCursor === null) {
      this.historyStash = current;
      this.historyCursor = this.history.length - 1;
    } else {
      if (this.lastHistoryText !== null && current !== this.lastHistoryText) return null;
      if (this.historyCursor === 0) return null;
      this.historyCursor -= 1;
    }
    const text = this.history[this.historyCursor]!;
    this.lastHistoryText = text;
    return { text };
  }

  /** ↓ 历史前进，与 historyPrev 对称；越过最新条目时恢复进入浏览前暂存的草稿并退出浏览。 */
  historyNext(current: string): { text: string } | null {
    if (this.historyCursor === null) return null;
    if (this.lastHistoryText !== null && current !== this.lastHistoryText) return null;
    if (this.historyCursor + 1 >= this.history.length) {
      const stash = this.historyStash ?? "";
      this.resetHistoryNav();
      return { text: stash };
    }
    this.historyCursor += 1;
    const text = this.history[this.historyCursor]!;
    this.lastHistoryText = text;
    return { text };
  }

  /** 追加一条输入历史（相邻去重、跳过空白）；提交与从事件流种入共用。 */
  private recordHistory(text: string): void {
    const trimmed = text.trim();
    if (!trimmed) return;
    if (this.history[this.history.length - 1] === trimmed) return;
    this.history.push(trimmed);
  }

  private resetHistoryNav(): void {
    this.historyCursor = null;
    this.historyStash = null;
    this.lastHistoryText = null;
  }

  /** 从当前 state 的 user 消息重建输入历史（resume / 切换会话后重新种入 ↑ 回溯来源）。 */
  private seedHistoryFromState(): void {
    this.history = [];
    for (const entry of this.state.timeline) {
      if (entry.type !== "message") continue;
      const msg = this.state.messages.get(entry.id);
      if (!msg || msg.role !== "user") continue;
      this.recordHistory(userVisibleText(textOf(msg.content)));
    }
    this.resetHistoryNav();
  }

  /** @ 候选源，注入给 ChatShell */
  mentionCandidates = (prefix: string): Candidate[] =>
    sessionMentionCandidates(this.store.listSessions(), prefix, { excludeSessionId: this.session.id });

  // ===== 内部 =====

  private createRuntime(): BatonSessionRuntime {
    return new BatonSessionRuntime({
      session: this.session,
      mentionBudgetChars: this.config.mentionBudgetChars,
      modelPreferences: this.modelPreferences,
      effortPreferences: this.effortPreferences,
      // 交互回调由 runtime 提供（resolver 注册表）：protocol 不再持有交互状态
      createAdapter: (name, handlers) =>
        createProviderAdapter(name as ProviderName, {
          ...handlers,
          config: this.config,
          rootDir: this.store.rootDir,
        }),
      providerSessionKey: (name) => providerSessionKey(name as ProviderName),
      onStateChange: () => this.changed(),
    });
  }

  private syncTerminalTitle(): void {
    setTerminalTabTitle(sessionDisplayTitle(this.session.meta));
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
    this.syncTerminalTitle();
    this.commandOutput = null;
    this.runtime = this.createRuntime();
    this.state = next.session.loadState();
    this.seedHistoryFromState();
    this.unsubscribeSession = this.subscribeSession(next.session);
    this.status = next.recovered
      ? { text: `Opened session ${next.session.id} (recovered an interrupted turn)`, tone: "info" }
      : { text: `Opened session ${next.session.id}`, tone: "info" };
    this.changed();
  }

  private async configureModel(target: ProviderName, model: { id: string; label: string }): Promise<void> {
    await this.runtime.setModel(target, model.id);
    saveModelPreference(this.store.rootDir, target, model.id);
    if (model.id === "default") delete this.modelPreferences[target];
    else this.modelPreferences[target] = model.id;
    this.status = { text: `${target} model: ${model.label} (takes effect next turn)`, tone: "info" };
    this.changed();
  }

  private async configureEffort(target: ProviderName, effort: { id: string; label: string }): Promise<void> {
    await this.runtime.setEffort(target, effort.id);
    saveEffortPreference(this.store.rootDir, target, effort.id);
    if (effort.id === "default") delete this.effortPreferences[target];
    else this.effortPreferences[target] = effort.id;
    this.status = { text: `${target} effort: ${effort.label} (takes effect next turn)`, tone: "info" };
    this.changed();
  }

  /** 控制命令输出只进入当前 view，不写 session.jsonl，避免污染可恢复的会话历史。 */
  private sessionStatusItem(): TranscriptItem {
    const meta = this.session.meta;
    const active = this.runtime.activeProvider;
    const selectedModel = this.runtime.currentModel(this.agent) ?? "default";
    const selectedEffort = this.runtime.currentEffort(this.agent) ?? "default";
    // perProvider 的键是信封 provider（= sessionKey），不是 canonical id：
    // claude 两者不同（"claude" vs "claude-code"），曾用 id 查导致 context 永远 unavailable
    const providerKey = providerDefinitionFor(this.agent)?.sessionKey ?? this.agent;
    const context = this.state.perProvider.get(providerKey)?.contextUsage;
    const contextText = contextUsageText(context, selectedModel);
    const providers = Object.keys(meta.providerSessions).join(", ") || "-";
    const text = [
      `Session: ${meta.batonSessionId}`,
      `Name: ${sessionDisplayTitle(meta)}`,
      ...(meta.description ? [`Description: ${meta.description}`] : []),
      `Directory: ${meta.cwd}`,
      `Current: ${this.agent} - model ${selectedModel} - effort ${selectedEffort}`,
      `Context: ${contextText}`,
      `Providers: ${providers}`,
      `Turns: ${this.state.turnSummaries.length} - tokens in ${this.state.usage.inputTokens} / out ${this.state.usage.outputTokens}`,
      `State: ${active ? `running (${active})` : "idle"} - queue ${this.runtime.queueLength}`,
    ].join("\n");
    return this.batonTranscriptItem("_baton_status", text);
  }

  /** baton 自身也是 transcript author；这类 UI 反馈不写入 provider 会话历史。 */
  private batonTranscriptItem(id: string, text: string): TranscriptItem {
    return { type: "message", id, role: "agent", author: "baton", text, format: "plain" };
  }

  /** /sessions 会话内切换浮层；行投影与启动 session picker 共用 sessionPickerOptions */
  private openSessionsPicker(mode: SessionPickerMode = "list"): void {
    this.openPicker({
      title: `Select BatonSession${mode === "tree" ? " (tree)" : ""}`,
      options: sessionPickerOptions(this.store.listSessions({ cwd: this.session.meta.cwd }), {
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

  /** 高频流式事件按 renderer 帧合并；state 已同步 reduce，这里只延迟昂贵的完整 view 投影。 */
  private scheduleStreamViewChanged(): void {
    if (this.streamViewTimer !== undefined) return;
    this.streamViewTimer = setTimeout(() => {
      this.streamViewTimer = undefined;
      this.changed();
    }, STREAM_VIEW_FRAME_MS);
  }

  /** 快照式更新：每次变更整体替换 view 再通知（getView 引用稳定性要求） */
  private changed(): void {
    if (this.streamViewTimer !== undefined) {
      clearTimeout(this.streamViewTimer);
      this.streamViewTimer = undefined;
    }
    this.view = this.buildView();
    for (const listener of this.listeners) listener();
  }

  private buildView(): ChatViewState {
    const v = this.state;
    const active = this.runtime.activeProvider;
    // pending 交互从事件流投影（Map 保插入序，取最早的一个）；id 即 requestId，
    // 应答经 runtime 的 resolver 注册表回到 adapter 的 await 点
    const permission = v.pendingPermissions.values().next().value;
    const hookTrust = v.pendingHookTrusts.values().next().value;
    const question = v.pendingQuestions.values().next().value;
    const observedRuns = [...v.activeTurns.values()].filter((turn) => turn.origin === "provider");
    const observedRun = observedRuns.at(-1);
    // baton 当前只呈现一个 agent 的状态：driven turn 优先，其次是 provider 自发的
    // background turn，完全空闲时才回落到当前输入目标。状态本体与附加信息可拆成两行，
    // 但仍是同一个 agent；多运行者并发尚未进入产品范围。
    const activeTurnId = this.runtime.activeTurnId;
    const statusProvider = active ?? observedRun?.provider ?? this.agent;
    const statusProviderDefinition = providerDefinitionFor(statusProvider);
    const statusProviderId = statusProviderDefinition?.id;
    const statusModel = statusProviderId ? (this.runtime.currentModel(statusProviderId) ?? "default") : "default";
    const statusProviderKey = statusProviderDefinition?.sessionKey ?? statusProvider;
    const contextStatus = contextUsageStatusText(v.perProvider.get(statusProviderKey)?.contextUsage, statusModel);
    // 审批路由问 adapter 要（provider 自己报的生效值），不读 config——config 是意图，
    // 且投影层不得按 provider 分支（不变量 #3）。曾经这里硬编码 codexApprovalReviewer，
    // 于是跟 claude 对话时 footer 照样显示 codex 的委托状态。
    const approvalStatus =
      statusProviderId && this.runtime.approvalRoute(statusProviderId) === "delegated"
        ? "approvals:auto-review"
        : undefined;
    const statusDetails = [contextStatus, approvalStatus].filter((detail): detail is string => detail !== undefined);
    const splitStatus = (item: RunStatusItem): RunStatusItem[] => {
      if (statusDetails.length === 0) return [item];
      const { startedAt, hint, ...primary } = item;
      return [
        primary,
        {
          id: `${item.id}:details`,
          label: statusDetails.join(" · "),
          ...(startedAt !== undefined ? { startedAt } : {}),
          ...(hint ? { hint } : {}),
        },
      ];
    };
    const runStatus: RunStatusItem[] = active
      ? splitStatus({
          id: `run:${active}`,
          author: providerAuthor(active),
          label: `${statusModel} · ${runStatusLabel(v, activeTurnId)}`,
          startedAt: this.runtime.activeStartedAt,
          hint: "Esc to interrupt",
        })
      : observedRun
        ? splitStatus({
            id: `run:observed:${observedRun.turnId}`,
            author: providerAuthor(statusProvider),
            label: `${statusModel} · ${runStatusLabel(v, observedRun.turnId)} · background`,
            startedAt: observedRun.startedAt,
          })
        : splitStatus({
            id: `agent:${this.agent}`,
            author: providerAuthor(this.agent),
            label: `${statusModel} · idle`,
          });
    const busy = active !== undefined || observedRuns.length > 0;
    // plan 互补显示（design §5.9）：同一时刻只出现在一个地方——进行中归 pin（现在时），
    // 盖棺归 transcript（过去时）。pin 显示期间 transcript 不渲染该 plan 卡（避免同屏两份、
    // 且过去时区域不该有实时改写的块）；全部完成 pin 停发，终态卡在 timeline 原位出现供回看。
    // pin 还绑定当前输入目标 provider：切换 agent 即表示放弃上一家的现在时，
    // 上一家未完成的 plan 回到 transcript；切回且该 provider 仍在运行时可恢复 pin。
    // 同时以同 provider 的运行态门控：idle 后未完成的 plan 也归 transcript，
    // 避免别家 provider 的回合让已搁置的 plan 重新上 pin。
    const selectedProvider = providerDefinitionFor(this.agent)?.sessionKey ?? this.agent;
    const lastPlanId = v.perProvider.get(selectedProvider)?.lastPlanId;
    const lastPlan = lastPlanId ? v.plans.get(lastPlanId) : undefined;
    const planEntries = (lastPlan?.entries ?? []).map((entry) => ({
      content: entry.content,
      status: normalizePlanStatus(entry.status),
    }));
    const providerRunning = [...v.activeTurns.values()].some((turn) => turn.provider === selectedProvider);
    const planActive = providerRunning && planEntries.some((entry) => entry.status !== "completed");
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
      approval: permission
        ? {
            id: permission.requestId,
            title: permission.title,
            description: permission.description,
            options: permission.options.map((option) => ({
              optionId: option.optionId,
              name: option.name,
              kind: approvalOptionKind(option),
            })),
          }
        : hookTrust
          ? {
              id: hookTrust.requestId,
              title: `Trust ${hookTrust.hooks.length} ${hookTrust.providerName} hook${hookTrust.hooks.length === 1 ? "" : "s"}?`,
              description: hookTrustDescription(hookTrust),
              options: [
                {
                  optionId: "trust",
                  name: "Trust current definitions (ask again if changed)",
                  kind: "allow_always",
                },
                { optionId: "skip", name: "Continue without Codex hooks", kind: "reject_once" },
              ],
            }
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
      footer: `session: ${this.session.id}  in:${v.usage.inputTokens} out:${v.usage.outputTokens}  turns:${v.turnSummaries.length}  queue:${this.runtime.queueLength}${planActive ? `  plan:${planEntries.filter((entry) => entry.status === "completed").length}/${planEntries.length}` : ""}  cwd:${this.session.meta.cwd}`,
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
 * auto-review 决策 → chat-tui 展示双轴（kernel.md §6 展示轴）。decision 已在 adapter 边界收口为
 * 闭合三态（§2 不变量 #2），所以这里是对**闭集的穷尽查表**而非条件链——新增 decision 成员时
 * TS 直接报表不完整，比三元链更难漏：
 * - outcome（status）= 本次 review 的结局：approved 审到底了 / denied 被拒 / aborted 未决异常；
 * - tone = 是否需留痕：仅 approved 带 warning——委托代批**放行**的操作要留审计痕。
 * 双轴的意义正在这条：approved 不再被遮成一个 warning 而丢掉"它审完了"，✓ 与警示色各说各的。
 */
const REVIEW_DISPLAY: Record<
  ApprovalReviewUpdate["decision"],
  { status: TranscriptBlockStatus; tone?: BlockTone }
> = {
  approved: { status: "completed", tone: "warning" },
  denied: { status: "declined" },
  aborted: { status: "failed" },
};

function approvalReviewTranscriptItem(review: ApprovalReviewUpdate): TranscriptItem {
  const facts = [
    review.riskLevel ? `risk: ${review.riskLevel}` : undefined,
    review.userAuthorization ? `authorization: ${review.userAuthorization}` : undefined,
  ].filter(Boolean);
  const suffix = facts.length > 0 ? ` (${facts.join(", ")})` : "";
  return {
    type: "block",
    id: `approval-review:${review.reviewId}`,
    kind: "notice",
    ...REVIEW_DISPLAY[review.decision],
    title: `Automatic approval review ${review.decision}${suffix}`,
    content: review.rationale ? { type: "text", text: review.rationale } : undefined,
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
    if (entry.type === "approval_review") {
      // 回执是 timeline 一等公民（自带位置），不再作为工具卡的附属查找。
      const review = state.approvalReviews.get(entry.id);
      if (review) items.push(approvalReviewTranscriptItem(review));
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
