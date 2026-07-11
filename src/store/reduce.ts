// 把事件流 reduce 成会话状态：TUI 渲染的唯一来源，崩溃恢复 = 重放 session.jsonl。
// upsert 语义保证重放幂等。见 docs/design.md §5.3。

import type {
  AnyEventEnvelope,
  AvailableCommand,
  ContentBlock,
  ContextUsageUpdate,
  ErrorUpdate,
  EventEnvelope,
  MessageRole,
  Notice,
  PermissionRequest,
  PlanUpdate,
  SessionConfigOption,
  SessionRunState,
  StopReason,
  ToolCallStatus,
  TurnSummary,
  UsageUpdate,
} from "../events/types.ts";

export interface MessageState {
  messageId: string;
  role: MessageRole;
  content: ContentBlock[];
  /** thought chunk 仍在流式追加；完整 upsert 后转 completed。 */
  thoughtStatus?: "in_progress" | "completed";
  turnId?: string;
  /** 产生该消息的 provider（多 agent 同时间线时用于标注说话人） */
  provider?: string;
}

export interface ToolCallState {
  toolCallId: string;
  title?: string;
  kind?: string;
  status: ToolCallStatus;
  content: ContentBlock[];
  locations: string[];
  rawInput?: unknown;
  rawOutput?: unknown;
  turnId?: string;
}

/** TUI 时间线条目：message / tool_call / plan 按首次出现排序 */
export interface TimelineItem {
  type: "message" | "tool_call" | "plan";
  id: string;
}

export interface UsageTotal {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
  hasEstimated: boolean;
}

export interface SessionState {
  runState: SessionRunState;
  lastStopReason?: StopReason;
  timeline: TimelineItem[];
  messages: Map<string, MessageState>;
  toolCalls: Map<string, ToolCallState>;
  plans: Map<string, PlanUpdate>;
  pendingPermissions: Map<string, PermissionRequest>;
  usage: UsageTotal;
  /** provider command 完整快照：available_commands_update 整体替换，不做增量合并 */
  availableCommands: AvailableCommand[];
  /** session config 完整快照：config_option_update 整体替换（model 变化可联动其他选项） */
  configOptions: SessionConfigOption[];
  /** 当前 context 占用快照。与 usage（增量累加）语义不同：快照替换 */
  contextUsage?: ContextUsageUpdate;
  /** 最近一次结构化错误；willRetry 时 runState 仍应为 running（由事件源保证） */
  lastError?: ErrorUpdate & { seq: number };
  /** 提示历史（append-only）；TUI 自行决定展示窗口 */
  notices: Array<Notice & { seq: number }>;
  turnSummaries: TurnSummary[];
  lastSeq: number;
}

export function emptySessionState(): SessionState {
  return {
    runState: "idle",
    timeline: [],
    messages: new Map(),
    toolCalls: new Map(),
    plans: new Map(),
    pendingPermissions: new Map(),
    usage: {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      hasEstimated: false,
    },
    availableCommands: [],
    configOptions: [],
    notices: [],
    turnSummaries: [],
    lastSeq: 0,
  };
}

function roleOfKind(kind: string): MessageRole {
  if (kind.startsWith("user_")) return "user";
  if (kind.startsWith("agent_thought")) return "thought";
  return "agent";
}

function getOrCreateMessage(
  state: SessionState,
  id: string,
  role: MessageRole,
  turnId?: string,
  provider?: string,
): MessageState {
  let msg = state.messages.get(id);
  if (!msg) {
    msg = { messageId: id, role, content: [], turnId, provider };
    state.messages.set(id, msg);
    state.timeline.push({ type: "message", id });
  }
  return msg;
}

function getOrCreateToolCall(state: SessionState, id: string, turnId?: string): ToolCallState {
  let tc = state.toolCalls.get(id);
  if (!tc) {
    tc = { toolCallId: id, status: "pending", content: [], locations: [], turnId };
    state.toolCalls.set(id, tc);
    state.timeline.push({ type: "tool_call", id });
  }
  return tc;
}

function applyMessageUpsert(
  state: SessionState,
  ev: EventEnvelope<"user_message" | "agent_message" | "agent_thought">,
  role: MessageRole,
): void {
  const p = ev.payload;
  const msg = getOrCreateMessage(state, p.messageId, role, ev.turnId, ev.provider);
  // 三态：省略=不变；null/[]=清空；数组=整体替换
  if (p.content !== undefined) {
    msg.content = p.content === null ? [] : [...p.content];
  }
  if (role === "thought") msg.thoughtStatus = "completed";
}

function applyMessageChunk(
  state: SessionState,
  ev: EventEnvelope<"user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk">,
  role: MessageRole,
): void {
  const p = ev.payload;
  const msg = getOrCreateMessage(state, p.messageId, role, ev.turnId, ev.provider);
  msg.content.push(p.content);
  if (role === "thought") msg.thoughtStatus = "in_progress";
}

function applyToolCallUpdate(state: SessionState, ev: EventEnvelope<"tool_call_update">): void {
  const p = ev.payload;
  const tc = getOrCreateToolCall(state, p.toolCallId, ev.turnId);
  if (p.title !== undefined) tc.title = p.title === null ? undefined : p.title;
  if (p.kind !== undefined) tc.kind = p.kind === null ? undefined : p.kind;
  if (p.status !== undefined && p.status !== null) tc.status = p.status;
  if (p.content !== undefined) tc.content = p.content === null ? [] : [...p.content];
  if (p.locations !== undefined) tc.locations = p.locations === null ? [] : [...p.locations];
  if (p.rawInput !== undefined) tc.rawInput = p.rawInput;
  if (p.rawOutput !== undefined) tc.rawOutput = p.rawOutput;
}

export function applyEvent(state: SessionState, ev: AnyEventEnvelope): SessionState {
  state.lastSeq = ev.seq;
  switch (ev.kind) {
    case "state_update": {
      const p = ev.payload;
      state.runState = p.state;
      if (p.stopReason !== undefined) state.lastStopReason = p.stopReason;
      break;
    }
    case "user_message":
    case "agent_message":
    case "agent_thought":
      applyMessageUpsert(state, ev, roleOfKind(ev.kind));
      break;
    case "user_message_chunk":
    case "agent_message_chunk":
    case "agent_thought_chunk":
      applyMessageChunk(state, ev, roleOfKind(ev.kind));
      break;
    case "tool_call_update":
      applyToolCallUpdate(state, ev);
      break;
    case "tool_call_content_chunk": {
      const p = ev.payload;
      const tc = getOrCreateToolCall(state, p.toolCallId, ev.turnId);
      tc.content.push(p.content);
      break;
    }
    case "plan_update": {
      const p = ev.payload;
      if (!state.plans.has(p.planId)) state.timeline.push({ type: "plan", id: p.planId });
      state.plans.set(p.planId, { planId: p.planId, entries: [...p.entries] });
      break;
    }
    case "permission_request": {
      const p = ev.payload;
      state.pendingPermissions.set(p.requestId, p);
      break;
    }
    case "permission_resolved": {
      const p = ev.payload;
      state.pendingPermissions.delete(p.requestId);
      break;
    }
    case "usage_update":
      accumulateUsage(state.usage, ev.payload);
      break;
    case "available_commands_update":
      state.availableCommands = [...ev.payload.commands];
      break;
    case "config_option_update":
      state.configOptions = [...ev.payload.options];
      break;
    case "context_usage_update":
      state.contextUsage = { ...ev.payload };
      break;
    case "_baton_error_update":
      state.lastError = { ...ev.payload, seq: ev.seq };
      break;
    case "_baton_notice":
      state.notices.push({ ...ev.payload, seq: ev.seq });
      break;
    case "_baton_turn_summary":
      state.turnSummaries.push(ev.payload);
      break;
    default: {
      // 未知事件保留在 jsonl 里但不参与 reduce（forward-compat：不因未知 kind 崩溃）
      break;
    }
  }
  return state;
}

function accumulateUsage(total: UsageTotal, u: UsageUpdate): void {
  total.inputTokens += u.inputTokens ?? 0;
  total.outputTokens += u.outputTokens ?? 0;
  total.cacheReadTokens += u.cacheReadTokens ?? 0;
  total.cacheWriteTokens += u.cacheWriteTokens ?? 0;
  total.reasoningTokens += u.reasoningTokens ?? 0;
  if (u.isEstimated) total.hasEstimated = true;
}

export function reduceEvents(events: Iterable<AnyEventEnvelope>): SessionState {
  const state = emptySessionState();
  for (const ev of events) applyEvent(state, ev);
  return state;
}
