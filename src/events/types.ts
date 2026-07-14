// baton 内部事件模型：词汇对齐 ACP v2（state_update / 按 messageId 的消息 upsert + chunk 追加 /
// tool_call_update upsert），wire 协议不必是 ACP——adapter 负责把各家原生协议归一到这里。
// baton 自有扩展事件用 _baton_ 前缀，遵守 ACP 的扩展值约定。见 docs/design.md §5.2。

export const ENVELOPE_VERSION = 1 as const;

export type SessionRunState = "running" | "idle" | "requires_action";

// (string & {}) 让联合保持开放：未知值不破坏解析（ACP v2 的 forward-compat 约定）
export type StopReason = "end_turn" | "max_tokens" | "refusal" | "cancelled" | (string & {});

export interface TextBlock {
  type: "text";
  text: string;
}

export interface ImageBlock {
  type: "image";
  mimeType: string;
  /** base64 数据与本地路径二选一 */
  data?: string;
  path?: string;
}

export interface DiffChange {
  operation: "add" | "delete" | "modify" | "move" | (string & {});
  path: string;
  oldPath?: string;
}

/**
 * 文件改动内容块（tool_call 的 content 里使用），形状对齐 ACP v2 diff content：
 * changes 供结构化渲染（文件树/统计），patch 是可选的可渲染文本。
 *
 * 契约：patch 若存在必须是标准 unified diff（含 `---`/`+++`/`@@` 头）——渲染层的
 * 行号与 split 视图信任这一点，adapter 负责在自己层内把各家私有格式转成标准 patch，
 * 拼不出合法 patch 时宁可只发 changes（渲染层退化为 op+path 标题行）。
 * 约定 patch 与 changes[0] 对应：adapter 按单文件发块，多文件改动发多个 DiffBlock。
 */
export interface DiffBlock {
  type: "diff";
  changes: DiffChange[];
  patch?: string;
}

export type ContentBlock = TextBlock | ImageBlock | DiffBlock | { type: string; [key: string]: unknown };

// ---- prompt input blocks ----
// 输入与输出刻意不共用开放的 ContentBlock（见 docs/provider-interaction-design.md §4.2）：
// prompt 是 adapter 的入参契约，必须是可显式 admission 的闭合集合——不支持某 block 时
// 报带类型的错误，而不是被 textOf() 之类静默降级；输出侧保持开放联合以容纳 provider 差异。
// 词汇对齐 ACP/MCP content（text/image/audio/resource/resource_link）。

// 以下三个用 type alias 而不是 interface：object literal type 有隐式 index signature，
// 才能让 PromptBlock[] 赋给开放的 ContentBlock[]（user_message payload 持久化输入原文）。
export type AudioBlock = {
  type: "audio";
  mimeType: string;
  /** base64 音频数据 */
  data: string;
};

/** 内容已内联的资源（对齐 MCP embedded resource）：text 与 blob 二选一 */
export type EmbeddedResourceBlock = {
  type: "resource";
  resource: { uri: string; mimeType?: string; text?: string; blob?: string };
};

/** 只带引用、不内联内容的资源链接 */
export type ResourceLinkBlock = {
  type: "resource_link";
  uri: string;
  name: string;
  mimeType?: string;
  description?: string;
};

export type PromptBlock = TextBlock | ImageBlock | AudioBlock | EmbeddedResourceBlock | ResourceLinkBlock;

export type MessageRole = "user" | "agent" | "thought";

// ---- payloads ----

export interface StateUpdate {
  state: SessionRunState;
  /** 仅在 idle 且结束了活跃工作时携带 */
  stopReason?: StopReason;
  /**
   * running 的发起方。缺省 = baton 驱动的 driven turn（用户 submit 经队列串行执行）；
   * "provider" = agent 自发开界的 observed turn（如 Claude Code 后台任务唤醒）——
   * baton 不控制其开始，只划界、记账、投影，不进 turn 队列。
   */
  origin?: "provider";
}

/**
 * 整消息 upsert，按 messageId 键控。三态 patch 语义：
 * content 省略=不变；null 或 []=清空；具体数组=整体替换（含此前 chunk 累积的内容）。
 */
export interface MessageUpsert {
  messageId: string;
  content?: ContentBlock[] | null;
}

/**
 * 用户输入的实际（effective）投递方式：steer = 中途注入了当前 turn 的安全边界。
 * 开放联合 forward-compat；缺省视为 prompt（旧事件兼容）。requested delivery 不落盘——
 * steer 被拒降级成 follow-up 时，落盘的是降级后的事实（design §3.7：不能仍标成 steer）。
 */
export type SubmitDelivery = "prompt" | "steer" | "follow_up" | (string & {});

/** user_message 专属 upsert：比通用 MessageUpsert 多 delivery 标记 */
export interface UserMessageUpsert extends MessageUpsert {
  delivery?: SubmitDelivery;
}

/** chunk 永远是追加语义；role 由事件 kind 决定（user_/agent_/agent_thought_ 前缀） */
export interface MessageChunk {
  messageId: string;
  content: ContentBlock;
}

/**
 * 工具终态词汇。declined 是一等成员而非 failed 的别名：它表示"被用户/策略拒绝、
 * 操作没有执行"，展示待遇（⊘/warning 色）与后续动作（重发并授权）都不同于执行出错。
 * adapter 边界负责把 provider 词汇翻译到这里，且必须白名单式映射——只有明确的成功值
 * 才映射 completed，未知终态悲观归 failed；乐观兜底曾把 codex 的 declined 渲染成绿勾。
 */
export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed" | "declined" | (string & {});

export type ToolKind =
  | "read"
  | "edit"
  | "delete"
  | "move"
  | "search"
  | "execute"
  | "think"
  | "fetch"
  | "other"
  | (string & {});

/**
 * 工具调用 upsert：首个未见过的 toolCallId 即创建（无独立 create 事件，对齐 ACP v2）。
 * 三态 patch：字段省略=不变；null=清除；具体值=替换。数组字段整体替换。
 */
export interface ToolCallUpdate {
  toolCallId: string;
  title?: string | null;
  kind?: ToolKind | null;
  status?: ToolCallStatus | null;
  content?: ContentBlock[] | null;
  locations?: string[] | null;
  rawInput?: unknown;
  rawOutput?: unknown;
}

/** 向工具调用追加单个 content 项（流式），不重发整个数组 */
export interface ToolCallContentChunk {
  toolCallId: string;
  content: ContentBlock;
}

export interface PlanEntry {
  content: string;
  priority: "high" | "medium" | "low" | (string & {});
  status: "pending" | "in_progress" | "completed" | (string & {});
}

/** 每次 plan_update 整体替换该 planId 的 entries */
export interface PlanUpdate {
  planId: string;
  entries: PlanEntry[];
}

export interface PermissionOption {
  optionId: string;
  name: string;
  kind: "allow_once" | "allow_always" | "reject_once" | "reject_always" | (string & {});
}

export interface PermissionRequest {
  requestId: string;
  /** 审批提示文案本身；不修改任何 tool call 的展示标题（ACP v2 的教训） */
  title: string;
  description?: string;
  toolCallId?: string;
  options: PermissionOption[];
}

export interface PermissionResolved {
  requestId: string;
  outcome: "selected" | "cancelled" | (string & {});
  optionId?: string;
}

/**
 * 自动审批（auto-review）回执：reviewer 替用户对某操作作出的决策，供诚实留痕（见
 * docs/approval-lifecycle.md §3）。与 permission_request/resolved 的交互待决流正交——
 * auto-review 开启时审批卡不触发，baton 只观测这条回执。归一自 codex
 * `item/autoApprovalReview/*`（**UNSTABLE**）：字段全部按可选容忍，原始形状保留在 envelope.raw。
 *
 * 一等审计对象：按自己的 `reviewId` 归档（kernel.md §6）。`reviewId` 让"无 target 的
 * review"也能留痕、同一操作上的多次决策各自成条、不再靠被审 `toolCallId` 覆盖。回执只在
 * reviewer 决策**终态**（codex `/completed`）铸造，`toolCallId` 是可选的被审目标。
 */
export interface ApprovalReviewUpdate {
  /** 本回执自身的稳定 id（`arv_` 前缀），adapter 在终态铸造；归档与投影的主键 */
  reviewId: string;
  /** 被审操作对应的 tool call / item id（对齐 codex targetItemId）；缺省表示无具体目标（如网络策略审查） */
  toolCallId?: string;
  /** reviewer 终态决策；未知值按 fail-closed 保守呈现（不当成"审核中"） */
  decision: "approved" | "denied" | "aborted" | (string & {});
  /** provider 给出时透传的风险等级 */
  riskLevel?: "low" | "medium" | "high" | "critical" | (string & {});
  /** reviewer 评估的授权等级（非“回退给用户”，不改变委托语义） */
  userAuthorization?: "unknown" | "low" | "medium" | "high" | (string & {});
  /** 决策理由，审计 / 诊断展示用 */
  rationale?: string;
  /** 被审操作类型：command / execve / applyPatch / networkAccess / mcpToolCall 等 */
  actionType?: string;
}

export interface QuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface QuestionPrompt {
  questionId: string;
  header: string;
  question: string;
  options?: QuestionOption[];
  multiSelect?: boolean;
  allowOther?: boolean;
  secret?: boolean;
}

export interface QuestionRequest {
  requestId: string;
  questions: QuestionPrompt[];
}

export interface QuestionResolved {
  requestId: string;
  outcome: "answered" | "cancelled" | (string & {});
  answers?: Record<string, string[]>;
}

/** provider 声明的可用 slash command（形状对齐 ACP available command） */
export interface AvailableCommand {
  name: string;
  description?: string;
  input?: { hint: string };
}

/** 完整快照：每次整体替换当前 provider command 列表，不做增量合并（对齐 ACP） */
export interface AvailableCommandsUpdate {
  commands: AvailableCommand[];
}

export type ConfigValue = string | boolean;

/** session 级配置项（model/mode/thought_level…），category 只影响 UI 摆放，不影响正确性 */
export type SessionConfigOption =
  | {
      id: string;
      type: "select";
      name: string;
      description?: string;
      category?: string;
      value: string;
      options: Array<{ value: string; name: string; description?: string }>;
    }
  | {
      id: string;
      type: "boolean";
      name: string;
      description?: string;
      category?: string;
      value: boolean;
    };

/** 完整快照：model 变化可能联动 reasoning 等选项，整体替换避免 UI 残留旧项 */
export interface ConfigOptionUpdate {
  options: SessionConfigOption[];
}

/**
 * 当前 context 占用/成本快照，对应 ACP v2 的 usage_update。
 * 与 baton 的 `usage_update`（token 增量）刻意分名：已落盘事件的语义不可静默翻转，
 * 旧 session.jsonl 的 delta replay 必须继续得到相同累计结果（design §4.8）。
 */
export interface ContextUsageUpdate {
  contextUsed?: number;
  contextSize?: number;
  cost?: { amount: number; currency: string };
}

/**
 * 结构化错误，不能只塞 stopReason。willRetry=true 表示 provider 仍在重试，
 * 此时 session 不得被切 idle（design §4.9）。
 */
export interface ErrorUpdate {
  code?: string;
  message: string;
  retryable?: boolean;
  willRetry?: boolean;
}

/** 非错误提示（warning/deprecation/auth、配置提醒），不伪装成 agent message 进时间线 */
export interface Notice {
  level: "info" | "warning" | "error" | (string & {});
  title: string;
  detail?: string;
}

/**
 * 短寿命运行阶段快照（compacting…），见 docs/design.md §5.2 归一表"运行阶段"行。
 * phase 开放字符串（forward-compat）；null = 阶段结束，投影层回落默认 thinking。
 * 刻意不塞 state_update：那是驱动 busy/idle finalize 的生命周期语义（§5.9）。
 */
export interface RunStatusUpdate {
  phase: string | null;
  /** 可展示文案（如 "Compacting context…"）；缺省由投影层按 phase 兜底 */
  title?: string;
}

/** 语义为增量：reducer 直接累加。adapter 拿到累计快照时须先差分再发。快照语义见 ContextUsageUpdate。 */
export interface UsageUpdate {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  isEstimated?: boolean;
}

export interface TurnSummaryToolCall {
  toolCallId: string;
  title?: string;
  kind?: string;
  status?: string;
}

/**
 * turn 结束时落盘的汇总事件：人可 grep、@ 引用的紧凑投影数据源、reduce 的 checkpoint。
 * 见 docs/design.md §5.3。
 */
export interface TurnSummary {
  turnId: string;
  stopReason?: StopReason;
  userText?: string;
  agentText?: string;
  toolCalls: TurnSummaryToolCall[];
  usage?: UsageUpdate;
  startedAt?: string;
  endedAt?: string;
}

export type EventPayloadMap = {
  state_update: StateUpdate;
  user_message: UserMessageUpsert;
  user_message_chunk: MessageChunk;
  agent_message: MessageUpsert;
  agent_message_chunk: MessageChunk;
  agent_thought: MessageUpsert;
  agent_thought_chunk: MessageChunk;
  tool_call_update: ToolCallUpdate;
  tool_call_content_chunk: ToolCallContentChunk;
  plan_update: PlanUpdate;
  permission_request: PermissionRequest;
  permission_resolved: PermissionResolved;
  approval_review_update: ApprovalReviewUpdate;
  question_request: QuestionRequest;
  question_resolved: QuestionResolved;
  usage_update: UsageUpdate;
  available_commands_update: AvailableCommandsUpdate;
  config_option_update: ConfigOptionUpdate;
  context_usage_update: ContextUsageUpdate;
  _baton_error_update: ErrorUpdate;
  _baton_notice: Notice;
  _baton_run_status: RunStatusUpdate;
  _baton_turn_summary: TurnSummary;
};

export type EventKind = keyof EventPayloadMap;

/** session.jsonl 每行一条。payload 供渲染/检索/摘要，raw 保真原始 wire 消息。 */
export interface EventEnvelope<K extends EventKind = EventKind> {
  v: typeof ENVELOPE_VERSION;
  /** ISO 8601 */
  ts: string;
  /** session 内单调递增，reduce 定序靠它（不靠 ID、不靠 ts） */
  seq: number;
  batonSessionId: string;
  provider: string;
  providerSessionId?: string;
  turnId?: string;
  kind: K;
  payload: EventPayloadMap[K];
  raw?: unknown;
  /** 子 agent 归属（Claude Task 子会话 / Codex 子 agent），挂回父会话 */
  parentSessionId?: string;
  agentId?: string;
  agentType?: string;
}

/** 按 kind 分发的判别联合：switch(ev.kind) 时 payload 能正确收窄 */
export type AnyEventEnvelope = { [K in EventKind]: EventEnvelope<K> }[EventKind];

/** NewEvent 的判别联合版本，事件 sink 的入参类型 */
export type AnyNewEvent = { [K in EventKind]: NewEvent<K> }[EventKind];

/** append 时由 Store 补齐 v/ts/seq/batonSessionId */
export type NewEvent<K extends EventKind = EventKind> = Omit<
  EventEnvelope<K>,
  "v" | "ts" | "seq" | "batonSessionId"
>;

export function textOf(blocks: ReadonlyArray<ContentBlock | PromptBlock>): string {
  return blocks
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}
