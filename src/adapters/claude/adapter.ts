// Claude Code 接入：官方 Agent SDK 进程内直调（TS 宿主不需要 tutti 那样的 sidecar）。
// SDK 以子进程拉起 claude CLI；可执行文件可换成公司包装器（BATON_CLAUDE_BIN），
// 凭证零持有，复用本机登录态。见 docs/design.md §5.1。

import {
  query,
  type Options,
  type PermissionResult,
  type PermissionUpdate,
  type Query,
  type SDKMessage,
} from "@anthropic-ai/claude-agent-sdk";

import { newId } from "../../events/ids.ts";
import type {
  ContentBlock,
  DiffBlock,
  PermissionOption,
  PermissionRequest,
  PlanEntry,
  PromptBlock,
  QuestionPrompt,
  QuestionRequest,
} from "../../events/types.ts";
import { textOf } from "../../events/types.ts";
import type {
  AdapterCapabilities,
  AgentAdapter,
  EventSink,
  ModelOption,
  OpenOptions,
  PromptInput,
  PromptReceipt,
  ProviderSessionRef,
  RequestHandler,
} from "../types.ts";
import { unsupportedPromptBlocks } from "../types.ts";

const APPROVAL_OPTIONS: PermissionOption[] = [
  { optionId: "allow", name: "Allow once", polarity: "allow", lifetime: "once" },
  { optionId: "deny", name: "Deny", polarity: "reject", lifetime: "once" },
];

/**
 * 审批候选。always 项只在 SDK 给出 permission suggestions 时提供：baton 不自造
 * 授权规则，只透传 CLI "don't ask again" 的同款路径（选中后把整组 suggestions
 * 作为 updatedPermissions 返回，规则作用域由 SDK 决定，通常是 session 级）。
 *
 * lifetime 取 `persistent` 而非 `session`：作用域实际由 SDK 定、baton 不确知，
 * 而在审批展示上低报持续性才是危险的一侧（用户以为一次性、实则长期）。悲观取强档，
 * 与 name 的 "don't ask again" 一致（不变量 #2）。
 */
export function claudeApprovalOptions(hasSuggestions: boolean): PermissionOption[] {
  if (!hasSuggestions) return APPROVAL_OPTIONS;
  return [
    APPROVAL_OPTIONS[0] as PermissionOption,
    {
      optionId: "allowAlways",
      name: "Always allow (don't ask again)",
      polarity: "allow",
      lifetime: "persistent",
    },
    APPROVAL_OPTIONS[1] as PermissionOption,
  ];
}

/** Claude 工具名 → 内部 tool kind */
export function claudeToolKind(toolName: string): string {
  switch (toolName) {
    case "Read":
    case "NotebookRead":
      return "read";
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return "edit";
    case "Bash":
    case "BashOutput":
    case "KillShell":
      return "execute";
    case "Grep":
    case "Glob":
      return "search";
    case "WebFetch":
    case "WebSearch":
      return "fetch";
    default:
      return "other";
  }
}

/** 工具调用的一行标题：工具名 + 最有辨识度的入参 */
export function claudeToolTitle(toolName: string, input: Record<string, unknown>): string {
  const detail =
    input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.query ?? input.skill ?? input.description;
  return detail !== undefined ? `${toolName}: ${String(detail)}` : toolName;
}

/** TodoWrite 入参 → 统一 plan entries（最大公约数规范：计划一律走 plan_update） */
export function todoWritePlan(input: Record<string, unknown>): PlanEntry[] {
  const todos = (Array.isArray(input.todos) ? input.todos : []) as Array<Record<string, unknown>>;
  return todos.map((t) => ({
    content: String(t.content ?? ""),
    priority: "medium",
    status: t.status === "in_progress" || t.status === "completed" ? (t.status as string) : "pending",
  }));
}

/** Task 工具族（新版 Claude Code 以 TaskCreate/TaskUpdate 替代 TodoWrite）登记的待落账操作 */
export type TaskToolOp =
  | { op: "create"; subject: string }
  | { op: "update"; taskId: string; subject?: string; status?: string };

/** Task 工具族的任务表条目；表跨 turn 持久（harness 的任务列表本身跨 turn） */
export interface TaskEntry {
  subject: string;
  status: "pending" | "in_progress" | "completed";
}

/** tool_use 入参 → Task 操作；非 Task 写操作（含只读的 TaskList/TaskGet）返回 null */
export function taskToolOp(toolName: string, input: Record<string, unknown>): TaskToolOp | null {
  if (toolName === "TaskCreate") {
    return { op: "create", subject: String(input.subject ?? input.description ?? "") };
  }
  if (toolName === "TaskUpdate") {
    // 真实 harness 的入参是 snake_case `task_id`（早期按 camelCase 假设实现，导致
    // update 全被丢弃、plan 永远停在 pending）；两种拼法都接受，防协议再漂移。
    const rawId = input.task_id ?? input.taskId;
    if (rawId === undefined) return null;
    return {
      op: "update",
      taskId: String(rawId),
      ...(typeof input.subject === "string" ? { subject: input.subject } : {}),
      ...(typeof input.status === "string" ? { status: input.status } : {}),
    };
  }
  return null;
}

/**
 * Task 操作在 tool_result 成功后才落账：TaskCreate 的 taskId 只出现在结果文本
 * （"Task #1 created successfully: ..."）里，TaskUpdate 也可能失败；入参阶段只登记不改表。
 */
export function applyTaskOp(
  tasks: Map<string, TaskEntry>,
  op: TaskToolOp,
  resultText: string,
  fallbackId: string,
): void {
  if (op.op === "create") {
    const id = /task #([\w-]+)/i.exec(resultText)?.[1];
    tasks.set(id ?? fallbackId, { subject: op.subject, status: "pending" });
    return;
  }
  if (op.status === "deleted") {
    tasks.delete(op.taskId);
    return;
  }
  // upsert：resume 场景下任务可能建于 baton 观察不到的历史，缺 subject 时以 id 兜底
  const prev = tasks.get(op.taskId);
  tasks.set(op.taskId, {
    subject: op.subject ?? prev?.subject ?? `Task #${op.taskId}`,
    status:
      op.status === "in_progress" || op.status === "completed" || op.status === "pending"
        ? op.status
        : (prev?.status ?? "pending"),
  });
}

/** 任务表整表投影成 plan entries（Map 迭代序 = 创建序） */
export function taskPlanEntries(tasks: Map<string, TaskEntry>): PlanEntry[] {
  return [...tasks.values()].map((t) => ({ content: t.subject, priority: "medium", status: t.status }));
}

/**
 * 编辑类工具入参 → 意图 diff（只有 op+path，不合成 patch）；非编辑类返回 null。
 * 不从 old_string/new_string 拼 patch：拼出来的不是合法 unified diff（无 +++/@@，
 * 多行内容直接破格式），而渲染层信任 patch 的合法性（行号/split 视图都建立在其上）。
 * 真 patch 在工具完成时由 claudeResultDiff 从 tool_use_result.structuredPatch 回填。
 */
export function claudeToolDiff(toolName: string, input: Record<string, unknown>): DiffBlock | null {
  const path = String(input.file_path ?? input.notebook_path ?? "");
  if (!path) return null;
  switch (toolName) {
    case "Write":
      // 入参阶段猜 add（多数 Write 是新建）；覆盖写会被 claudeResultDiff 按结果修正为 modify
      return { type: "diff", changes: [{ operation: "add", path }] };
    case "Edit":
    case "MultiEdit":
    case "NotebookEdit":
      return { type: "diff", changes: [{ operation: "modify", path }] };
    default:
      return null;
  }
}

interface StructuredHunk {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  lines: string[];
}

/** patch 收录的 hunk 行上限：大文件 Write 的全量内容会撑爆 session.jsonl 事件行，展示层也只看头部 */
const MAX_PATCH_LINES = 400;

/**
 * Edit/Write/MultiEdit 的 tool_use_result → 带真 patch 的 diff 内容块。
 * tool_use_result 是 Claude Code 无文档的私有形状（SDK 类型就是 unknown），只允许
 * 在本函数出现：解析成功产出标准 unified diff 进 DiffBlock；任何字段不合形状即
 * 返回 null，降级为入参阶段的 changes-only 展示，不让私有格式漂移打崩事件流。
 */
export function claudeResultDiff(result: unknown): DiffBlock | null {
  if (typeof result !== "object" || result === null) return null;
  const r = result as Record<string, unknown>;
  const path = typeof r.filePath === "string" ? r.filePath : "";
  const rawHunks = Array.isArray(r.structuredPatch) ? r.structuredPatch : [];
  if (!path || rawHunks.length === 0) return null;
  const hunks: StructuredHunk[] = [];
  for (const raw of rawHunks) {
    const h = raw as Record<string, unknown>;
    if (
      typeof h.oldStart !== "number" ||
      typeof h.oldLines !== "number" ||
      typeof h.newStart !== "number" ||
      typeof h.newLines !== "number" ||
      !Array.isArray(h.lines) ||
      !h.lines.every((line) => typeof line === "string")
    ) {
      return null;
    }
    hunks.push(h as unknown as StructuredHunk);
  }
  // Write 新建文件的结果带 type:"create"；Edit / 覆盖写没有该值 → modify
  const operation = r.type === "create" ? "add" : "modify";
  const header = operation === "add" ? `--- /dev/null\n+++ ${path}` : `--- ${path}\n+++ ${path}`;
  const body: string[] = [];
  let budget = MAX_PATCH_LINES;
  for (const hunk of hunks) {
    if (budget <= 0) break;
    const lines = hunk.lines.slice(0, budget);
    budget -= lines.length;
    if (lines.length === hunk.lines.length) {
      body.push(`@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`, ...lines);
    } else {
      // 截断后按实际收录行数重写 hunk 头：patch 保持合法（低估改动量，展示层可接受）
      const oldCount = lines.filter((line) => !line.startsWith("+")).length;
      const newCount = lines.filter((line) => !line.startsWith("-")).length;
      body.push(`@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@`, ...lines);
    }
  }
  return { type: "diff", changes: [{ operation, path }], patch: `${header}\n${body.join("\n")}` };
}

function claudeToolResultBlocks(result: unknown): ContentBlock[] {
  if (typeof result === "string") return result ? [{ type: "text", text: result }] : [];
  if (!Array.isArray(result)) return [];
  return result.flatMap((raw) => {
    const block = raw as Record<string, unknown>;
    return block.type === "text" && typeof block.text === "string"
      ? [{ type: "text", text: block.text }]
      : [];
  });
}

/**
 * 一条 runQuery 消费循环所属的 turn 状态。终态标记、cancel 标记与流式 messageId
 * 必须绑定在 turn 对象上而不是共享 runtime 上：上一 turn 的消息流在 result 消息之后
 * 才真正 close，其"流耗尽兜底 finishTurn"与 finally 清理可能落在下一 turn 已经开始
 * 之后（steer 排队时毫秒级衔接）——读写共享字段会把新 turn 误终结成空回答。
 */
interface ClaudeTurn {
  turnId: string;
  /** 保证任何退出路径（result 消息 / 流异常 / 流结束无 result）只发一次终态（design §4.1） */
  finalized: boolean;
  /** 用户主动中断时，SDK 会以 error result 结束消息流；该错误应归一成 cancelled。 */
  cancelRequested: boolean;
  /** 当前正在流式输出的 assistant 消息的内部 messageId（chunk 与最终 upsert 共用） */
  streamMessageId?: string;
}

/**
 * result 之后同一条消息流上再出现的活动消息，属于 provider 自发回合（observed turn）：
 * 后台任务（Agent tool 等）完成时 harness 会在无用户输入的情况下重新唤起模型，
 * 新回合的消息继续从同一条 SDK 流上到达。这里判定"该为它开一个新 turn 了"。
 * system/result 不开界：前者是瞬时相位（不构成回合），后者无活动时只是迟到终态。
 */
export function startsObservedTurn(msgType: string, current: { finalized: boolean }): boolean {
  return current.finalized && (msgType === "stream_event" || msgType === "assistant" || msgType === "user");
}

interface ClaudeRuntime {
  cwd: string;
  env?: Record<string, string>;
  /** open 时绑定的事件出口；session 生命周期内所有事件（含跨 turn）都走它 */
  sink: EventSink;
  /** SDK 的 session_id，首个 turn 的 init 消息里拿到；resume 靠它 */
  claudeSessionId?: string;
  activeQuery?: Query;
  /** 当前被接受、尚未逻辑终结的 turn */
  activeTurn?: ClaudeTurn;
  /** 用户在 baton 中选择的模型；只在下一次 query 创建时生效。 */
  model?: string;
  models?: ModelOption[];
  /** 已归一成 plan_update 的 tool_use id：其 tool_result 也要跳过，避免时间线出现重复工具卡 */
  suppressedToolIds: Set<string>;
  /** Task 工具族归一的任务表（跨 turn 持久）：每次成功落账后整表投影成 plan_update */
  tasks: Map<string, TaskEntry>;
  /** tool_use 已登记、等待 tool_result 落账的 Task 操作（key: tool_use_id） */
  pendingTaskOps: Map<string, TaskToolOp>;
}

const CLAUDE_FALLBACK_MODELS: ModelOption[] = [
  { id: "default", label: "Default", description: "Use the Claude Code default model" },
  { id: "sonnet", label: "Sonnet" },
  { id: "opus", label: "Opus" },
  { id: "haiku", label: "Haiku" },
];

function claudeModels(models: Array<{ value: string; displayName: string; description?: string }>): ModelOption[] {
  return [
    CLAUDE_FALLBACK_MODELS[0] as ModelOption,
    ...models.map((model) => ({
      id: model.value,
      label: model.displayName,
      description: model.description,
    })),
  ];
}

export interface ClaudeAdapterOptions {
  requestHandler: RequestHandler;
  /** claude 可执行文件路径；默认 BATON_CLAUDE_BIN 环境变量，再默认交给 SDK 自己找 */
  executablePath?: string;
}

export class ClaudeAdapter implements AgentAdapter {
  readonly provider = "claude-code";
  // 当前 adapter 最终只发送 text（design.md §3.1）；可选能力接口落地并验证后才声明
  // 对应 marker——契约测试钉住"声明支持就必须实现对应接口"。
  readonly capabilities: AdapterCapabilities = { prompt: {} };
  private sessions = new Map<string, ClaudeRuntime>();

  constructor(private options: ClaudeAdapterOptions) {}

  /** SDK 无独立"启动"步骤：session 在首个 submit 时创建，这里登记运行时并绑定事件出口 */
  async open(opts: OpenOptions, sink: EventSink): Promise<ProviderSessionRef> {
    const id = newId("ps");
    this.sessions.set(id, {
      cwd: opts.cwd,
      env: opts.env,
      sink,
      claudeSessionId: opts.resumeSessionId,
      suppressedToolIds: new Set(),
      tasks: new Map(),
      pendingTaskOps: new Map(),
    });
    return { provider: this.provider, providerSessionId: id, resumed: Boolean(opts.resumeSessionId) };
  }

  /** 拿 Claude 原生 session id（宿主存入 meta 以支持将来 resume） */
  nativeSessionId(ref: ProviderSessionRef): string | undefined {
    return this.sessions.get(ref.providerSessionId)?.claudeSessionId;
  }

  async listModels(ref: ProviderSessionRef): Promise<ModelOption[]> {
    const rt = this.mustSession(ref);
    if (rt.activeQuery) {
      try {
        rt.models = claudeModels(await rt.activeQuery.supportedModels());
      } catch {
        // 首个 query 尚未完成 initialize 时允许退回稳定别名，picker 不应阻塞发送链路。
      }
    }
    return rt.models ?? CLAUDE_FALLBACK_MODELS;
  }

  async setModel(ref: ProviderSessionRef, modelId: string | null): Promise<void> {
    const rt = this.mustSession(ref);
    rt.model = !modelId || modelId === "default" ? undefined : modelId;
  }

  currentModel(ref: ProviderSessionRef): string | null {
    return this.mustSession(ref).model ?? null;
  }

  /** submit 只做 admission 并启动后台消费循环；turn 进展与终结全部经事件报告 */
  async submit(ref: ProviderSessionRef, input: PromptInput): Promise<PromptReceipt> {
    const rt = this.mustSession(ref);
    if (rt.activeTurn && !rt.activeTurn.finalized) {
      throw new Error(`claude turn ${rt.activeTurn.turnId} still active; steer/parallel prompt unsupported`);
    }
    const unsupported = unsupportedPromptBlocks(input.blocks, this.capabilities);
    if (unsupported.length) {
      throw new Error(`claude-code adapter does not support prompt block type(s): ${unsupported.join(", ")}`);
    }

    const turn: ClaudeTurn = { turnId: input.turnId, finalized: false, cancelRequested: false };
    rt.activeTurn = turn;
    // user_message / state_update(running) 由 runtime 在出队时落盘（用户输入是 BatonSession
    // 的事实，不等 provider 就绪）；adapter 只报告 provider 执行过程与终态。

    // 后台消费 SDK 消息流；submit 本身立即回执（design §4.1）
    void this.runQuery(rt, input, turn);
    return { accepted: true };
  }

  private async runQuery(rt: ClaudeRuntime, input: PromptInput, turn: ClaudeTurn): Promise<void> {
    // current 指向本条消息流上"正在进行"的 turn：先是 submit 的 driven turn，
    // result 之后若流上再来活动消息，则铸造 observed turn 接棒（可多次）。
    // emit 经 current 动态绑定——审批回调、流耗尽兜底都要盖当时所属 turn 的 id。
    let current = turn;
    const emit: EventSink = (ev) => this.emit(rt, ev, current);
    const executable = this.options.executablePath ?? process.env.BATON_CLAUDE_BIN;
    const sdkOptions: Options = {
      cwd: rt.cwd,
      env: { ...(process.env as Record<string, string>), ...rt.env },
      resume: rt.claudeSessionId,
      includePartialMessages: true,
      ...(rt.model ? { model: rt.model } : {}),
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
      canUseTool: (toolName, toolInput, meta) => this.handleCanUseTool(emit, toolName, toolInput, meta),
    };

    let q: Query | undefined;
    try {
      q = query({ prompt: textOf(input.blocks), options: sdkOptions });
      rt.activeQuery = q;
      void q
        .initializationResult()
        .then((result) => {
          rt.models = claudeModels(result.models);
        })
        .catch(() => {});
      for await (const msg of q) {
        if (startsObservedTurn(msg.type, current)) current = this.mintObservedTurn(rt);
        this.handleMessage(rt, emit, msg, current);
      }
      // 流正常耗尽但没有 result 消息（SDK 异常路径）：仍要保证恰好一次终态
      this.finishTurn(rt, emit, current, current.cancelRequested ? "cancelled" : "end_turn");
    } catch (error) {
      if (current.cancelRequested) {
        this.finishTurn(rt, emit, current, "cancelled");
      } else {
        emit({
          kind: "_baton_error_update",
          provider: this.provider,
          payload: { message: error instanceof Error ? error.message : String(error) },
        });
        this.finishTurn(rt, emit, current, "error");
      }
    } finally {
      // 只清自己注册的 query：本 finally 可能在下一 turn 已把 activeQuery 换掉后才跑
      if (rt.activeQuery === q) rt.activeQuery = undefined;
    }
  }

  /**
   * 铸造 observed turn 并以 running(origin:"provider") 开界（design §5.10）。
   * 刻意不写 rt.activeTurn：observed turn 不占 admission 槽——用户此刻仍可 submit
   * 新 driven turn（走新 query），宿主队列语义不受 provider 自发活动影响。
   */
  private mintObservedTurn(rt: ClaudeRuntime): ClaudeTurn {
    const observed: ClaudeTurn = { turnId: newId("t"), finalized: false, cancelRequested: false };
    this.emit(
      rt,
      { kind: "state_update", provider: this.provider, payload: { state: "running", origin: "provider" } },
      observed,
    );
    return observed;
  }

  /**
   * 每个 turn 只发一次逻辑终态；result 消息、异常、流异常结束都收敛到这里。
   * 只允许终结传入的那个 turn：上一 turn 的流耗尽兜底不能误杀已经开始的下一 turn。
   */
  private finishTurn(rt: ClaudeRuntime, emit: EventSink, turn: ClaudeTurn, stopReason: string, raw?: unknown): void {
    if (turn.finalized) return;
    turn.finalized = true;
    emit({
      kind: "state_update",
      provider: this.provider,
      payload: { state: "idle", stopReason },
      ...(raw !== undefined ? { raw } : {}),
    });
    if (rt.activeTurn === turn) rt.activeTurn = undefined;
  }

  /** 信封补齐：open 绑定的 sink + 所属 turnId。turn 内发射必须显式传 turn；跨 turn 的事件不带 turnId */
  private emit(rt: ClaudeRuntime, ev: Parameters<EventSink>[0], turn?: ClaudeTurn): void {
    rt.sink({
      ...ev,
      provider: this.provider,
      providerSessionId: rt.claudeSessionId,
      turnId: (turn ?? rt.activeTurn)?.turnId,
    });
  }

  async cancel(ref: ProviderSessionRef): Promise<void> {
    const rt = this.sessions.get(ref.providerSessionId);
    if (!rt?.activeQuery) return;
    if (rt.activeTurn) rt.activeTurn.cancelRequested = true;
    // interrupt 与消息流会被 SDK 同时结束；最终 idle/cancelled 由 runQuery 的消费路径收口。
    await rt.activeQuery.interrupt().catch(() => {});
  }

  async close(ref: ProviderSessionRef): Promise<void> {
    const rt = this.sessions.get(ref.providerSessionId);
    if (!rt) return;
    this.sessions.delete(ref.providerSessionId);
    const turn = rt.activeTurn;
    if (turn) turn.cancelRequested = true;
    await rt.activeQuery?.interrupt().catch(() => {});
    // 宿主主动 close 时若仍有活跃 turn，合成终态，不留"已接受未终结"的悬挂状态
    if (turn) this.finishTurn(rt, (ev) => this.emit(rt, ev, turn), turn, "cancelled");
  }

  private mustSession(ref: ProviderSessionRef): ClaudeRuntime {
    const rt = this.sessions.get(ref.providerSessionId);
    if (!rt) throw new Error(`unknown claude session: ${ref.providerSessionId}`);
    return rt;
  }

  private async handleCanUseTool(
    emit: EventSink,
    toolName: string,
    input: Record<string, unknown>,
    meta: { title?: string; suggestions?: PermissionUpdate[] },
  ): Promise<PermissionResult> {
    if (toolName === "AskUserQuestion") return this.handleQuestion(emit, input);
    const suggestions = meta.suggestions ?? [];
    const request: PermissionRequest = {
      kind: "permission",
      requestId: newId("ar"),
      title: meta.title ?? claudeToolTitle(toolName, input),
      options: claudeApprovalOptions(suggestions.length > 0),
    };
    emit({ kind: "permission_request", provider: this.provider, payload: request });
    const response = await this.options.requestHandler(request);
    if (response.kind === "cancelled") {
      // turn 被打断，request 随之收口：留痕 cancelled、拒绝执行（不静默、不当 allow）
      emit({
        kind: "permission_resolved",
        provider: this.provider,
        payload: { requestId: request.requestId, outcome: "cancelled" },
      });
      return { behavior: "deny", message: "turn interrupted before approval" };
    }
    // response 按 requestId 路由回来，kind 必配对 permission；意外不配一律保守拒绝（非 allow 即 deny）
    const optionId = response.kind === "permission" ? response.optionId : "";
    emit({
      kind: "permission_resolved",
      provider: this.provider,
      payload: { requestId: request.requestId, outcome: "selected", optionId },
    });
    if (optionId === "allow") return { behavior: "allow", updatedInput: input };
    if (optionId === "allowAlways") {
      // SDK 契约：把 canUseTool 收到的整组 suggestions 原样作为 updatedPermissions
      // 返回，即 CLI "Yes, don't ask again" 的同款授权路径
      return { behavior: "allow", updatedInput: input, updatedPermissions: suggestions };
    }
    return { behavior: "deny", message: "denied by baton user" };
  }

  private async handleQuestion(emit: EventSink, input: Record<string, unknown>): Promise<PermissionResult> {
    const source = Array.isArray(input.questions) ? input.questions : [];
    const questions: QuestionPrompt[] = source.map((value, index) => {
      const question = (value ?? {}) as Record<string, unknown>;
      return {
        questionId: `q${index}`,
        header: String(question.header ?? `Question ${index + 1}`),
        question: String(question.question ?? ""),
        options: Array.isArray(question.options)
          ? question.options.map((option) => {
              const item = (option ?? {}) as Record<string, unknown>;
              return {
                label: String(item.label ?? ""),
                description: String(item.description ?? ""),
                ...(typeof item.preview === "string" ? { preview: item.preview } : {}),
              };
            })
          : undefined,
        multiSelect: question.multiSelect === true,
        // Claude Code adds Other automatically for AskUserQuestion.
        allowOther: true,
      };
    });
    const request: QuestionRequest = { kind: "question", requestId: newId("qr"), questions };
    emit({ kind: "question_request", provider: this.provider, payload: request });
    const response = await this.options.requestHandler(request);
    if (response.kind === "cancelled") {
      emit({
        kind: "question_resolved",
        provider: this.provider,
        payload: { requestId: request.requestId, outcome: "cancelled" },
      });
      return { behavior: "deny", message: "turn interrupted before answer" };
    }
    const decisionAnswers = response.kind === "question" ? response.answers : {};
    emit({
      kind: "question_resolved",
      provider: this.provider,
      payload: { requestId: request.requestId, outcome: "answered", answers: decisionAnswers },
    });
    const answers = Object.fromEntries(
      questions.map((question) => [question.question, (decisionAnswers[question.questionId] ?? []).join(", ")]),
    );
    return { behavior: "allow", updatedInput: { ...input, answers } };
  }

  private handleMessage(rt: ClaudeRuntime, emit: EventSink, msg: SDKMessage, turn: ClaudeTurn): void {
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") rt.claudeSessionId = msg.session_id;
        else if (msg.subtype === "status") {
          // SDK 的 status 原生就是 phase-or-null 形状（'compacting' | 'requesting' | null）。
          // 只有 compacting 值得成为可见阶段；requesting 是普通运行态，与 null 一样
          // 归一成"无阶段"（回落默认 thinking），未来未知 status 同样安全降级。
          emit({
            kind: "_baton_run_status",
            provider: this.provider,
            payload:
              msg.status === "compacting"
                ? { phase: "compacting", title: "Compacting context…" }
                : { phase: null },
            raw: msg,
          });
        }
        break;
      case "stream_event": {
        // 子 agent（parent_tool_use_id 非空）的流式输出不进主时间线，内容随 tool result 汇总
        if (msg.parent_tool_use_id) break;
        const event = msg.event as { type: string; delta?: { type: string; text?: string; thinking?: string } };
        if (event.type === "message_start") {
          turn.streamMessageId = newId("m");
        } else if (event.type === "content_block_delta" && event.delta) {
          const messageId = turn.streamMessageId ?? (turn.streamMessageId = newId("m"));
          if (event.delta.type === "text_delta" && event.delta.text) {
            emit({
              kind: "agent_message_chunk",
              provider: this.provider,
              payload: { messageId, content: { type: "text", text: event.delta.text } },
              raw: msg,
            });
          } else if (event.delta.type === "thinking_delta" && event.delta.thinking) {
            emit({
              kind: "agent_thought_chunk",
              provider: this.provider,
              payload: { messageId: `${messageId}_thought`, content: { type: "text", text: event.delta.thinking } },
              raw: msg,
            });
          }
        }
        break;
      }
      case "assistant": {
        const blocks = (msg.message.content ?? []) as unknown as Array<Record<string, unknown>>;
        const texts = blocks
          .filter((b) => b.type === "text")
          .map((b) => String(b.text ?? ""))
          .join("");
        if (texts && !msg.parent_tool_use_id) {
          // 全文 upsert 覆盖 chunk 累积（同一 messageId），之后开新消息
          const messageId = turn.streamMessageId ?? newId("m");
          turn.streamMessageId = undefined;
          emit({
            kind: "agent_message",
            provider: this.provider,
            payload: { messageId, content: [{ type: "text", text: texts }] },
            raw: msg,
          });
        }
        for (const b of blocks) {
          if (b.type !== "tool_use") continue;
          const toolName = String(b.name);
          const input = (b.input ?? {}) as Record<string, unknown>;
          // TodoWrite 归一成 plan_update（计划不是工具调用，是头等中间过程）
          if (toolName === "TodoWrite") {
            rt.suppressedToolIds.add(String(b.id));
            emit({
              kind: "plan_update",
              provider: this.provider,
              // planId 用 per-turn（对齐 codex 的 pl_<turnId>）：卡片锚定在当前 turn 的位置，本 turn 内
              // 的 todo 更新原地 mark。per-session 会一直改写 session 首次出现的旧卡，进度在 scrollback 里不可见
              payload: { planId: `pl_${turn.turnId}`, entries: todoWritePlan(input) },
              raw: msg,
            });
            continue;
          }
          // Task 工具族（TodoWrite 的替代品）同样归一成 plan_update；但 TaskCreate 的
          // taskId 只在结果文本里、TaskUpdate 也可能失败，这里只登记，落账在 tool_result
          const taskOp = taskToolOp(toolName, input);
          if (taskOp) {
            rt.suppressedToolIds.add(String(b.id));
            rt.pendingTaskOps.set(String(b.id), taskOp);
            continue;
          }
          const diff = claudeToolDiff(toolName, input);
          emit({
            kind: "tool_call_update",
            provider: this.provider,
            payload: {
              toolCallId: String(b.id),
              title: claudeToolTitle(toolName, input),
              kind: claudeToolKind(toolName),
              status: "in_progress",
              content: diff ? [diff] : undefined,
              rawInput: input,
            },
            raw: msg,
          });
        }
        break;
      }
      case "user": {
        const content = msg.message.content;
        if (!Array.isArray(content)) break;
        const blocks = content as unknown as Array<Record<string, unknown>>;
        // tool_use_result 是消息级字段：仅当消息里恰有一个 tool_result 时归属无歧义
        const toolResultCount = blocks.filter((b) => b.type === "tool_result").length;
        const resultDiff = toolResultCount === 1 ? claudeResultDiff(msg.tool_use_result) : null;
        for (const b of blocks) {
          if (b.type !== "tool_result") continue;
          // Task 操作落账：成功结果先应用到任务表，再整表投影成 plan_update（整体替换语义）
          const taskOp = rt.pendingTaskOps.get(String(b.tool_use_id));
          if (taskOp) {
            rt.pendingTaskOps.delete(String(b.tool_use_id));
            if (!b.is_error) {
              const text = claudeToolResultBlocks(b.content)
                .map((block) => (block.type === "text" ? block.text : ""))
                .join("");
              applyTaskOp(rt.tasks, taskOp, text, String(b.tool_use_id));
              emit({
                kind: "plan_update",
                provider: this.provider,
                // planId per-turn，与 TodoWrite 一致：卡片锚定当前 turn，本 turn 内原地 mark
                payload: { planId: `pl_${turn.turnId}`, entries: taskPlanEntries(rt.tasks) },
                raw: msg,
              });
            }
          }
          // 已归一成 plan_update 的调用不再出工具卡（首见 upsert 会凭空造出一张）
          if (rt.suppressedToolIds.has(String(b.tool_use_id))) continue;
          emit({
            kind: "tool_call_update",
            provider: this.provider,
            payload: {
              toolCallId: String(b.tool_use_id),
              status: b.is_error ? "failed" : "completed",
              rawOutput: b.content,
              // 真 patch 回填：整体替换入参阶段的意图 diff（changes-only）
              content: resultDiff ? [resultDiff] : undefined,
            },
            raw: msg,
          });
          // diff 即输出：编辑类结果的文本（"The file ... has been updated..." + 片段）
          // 与 patch 完全重复，有 resultDiff 时不再追加文本块
          if (resultDiff) continue;
          for (const output of claudeToolResultBlocks(b.content)) {
            emit({
              kind: "tool_call_content_chunk",
              provider: this.provider,
              payload: { toolCallId: String(b.tool_use_id), content: output },
              raw: msg,
            });
          }
        }
        break;
      }
      case "result": {
        const usage = msg.usage;
        if (usage) {
          emit({
            kind: "usage_update",
            provider: this.provider,
            payload: {
              inputTokens: usage.input_tokens ?? 0,
              outputTokens: usage.output_tokens ?? 0,
              cacheReadTokens: usage.cache_read_input_tokens ?? 0,
              cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
            },
            raw: msg,
          });
        }
        this.finishTurn(rt, emit, turn, msg.subtype === "success" ? "end_turn" : msg.subtype, msg);
        break;
      }
      default:
        break; // 其余系统消息 M2 不消费
    }
  }
}
