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

export type ContentBlock = TextBlock | ImageBlock | { type: string; [key: string]: unknown };

export type MessageRole = "user" | "agent" | "thought";

// ---- payloads ----

export interface StateUpdate {
  state: SessionRunState;
  /** 仅在 idle 且结束了活跃工作时携带 */
  stopReason?: StopReason;
}

/**
 * 整消息 upsert，按 messageId 键控。三态 patch 语义：
 * content 省略=不变；null 或 []=清空；具体数组=整体替换（含此前 chunk 累积的内容）。
 */
export interface MessageUpsert {
  messageId: string;
  content?: ContentBlock[] | null;
}

/** chunk 永远是追加语义；role 由事件 kind 决定（user_/agent_/agent_thought_ 前缀） */
export interface MessageChunk {
  messageId: string;
  content: ContentBlock;
}

export type ToolCallStatus = "pending" | "in_progress" | "completed" | "failed" | (string & {});

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

/** 语义为增量：reducer 直接累加。adapter 拿到累计快照时须先差分再发。 */
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
  user_message: MessageUpsert;
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
  usage_update: UsageUpdate;
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

export function textOf(blocks: ContentBlock[]): string {
  return blocks
    .filter((b): b is TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
}
