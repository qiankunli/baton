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
  QuestionRequest,
  PlanUpdate,
  SessionConfigOption,
  SessionRunState,
  StopReason,
  SubmitDelivery,
  ToolCallStatus,
  TurnSummary,
  UsageUpdate,
} from "../events/types.ts";

export interface MessageState {
  messageId: string;
  role: MessageRole;
  content: ContentBlock[];
  /** agent/thought chunk 仍在流式追加；完整 upsert 后转 completed。 */
  streamStatus?: "in_progress" | "completed";
  turnId?: string;
  /** 产生该消息的 provider（多 agent 同时间线时用于标注说话人） */
  provider?: string;
  /** 仅 user 消息：effective delivery（steer = 中途注入当前 turn），缺省 = prompt */
  delivery?: SubmitDelivery;
}

export interface ToolCallState {
  toolCallId: string;
  /** 产生该工具活动的 provider；多 provider 时间线展示归属时使用。 */
  provider?: string;
  title?: string;
  kind?: string;
  status: ToolCallStatus;
  content: ContentBlock[];
  locations: string[];
  rawInput?: unknown;
  rawOutput?: unknown;
  turnId?: string;
}

/** TUI 时间线条目：message / tool_call / plan / notice 按首次出现排序 */
export interface TimelineItem {
  type: "message" | "tool_call" | "plan" | "notice";
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

/** 一个仍在运行的 turn 的投影状态（running 开界、本 turn idle 收界） */
export interface ActiveTurnState {
  turnId: string;
  provider?: string;
  /** 缺省 user=driven turn；provider=agent 自发的 observed turn（design §5.10） */
  origin: "user" | "provider";
  startedAt?: number;
  /** per-turn 运行阶段（compacting…）：null phase 或本 turn idle 清除（阶段不跨 turn） */
  phase?: { phase: string; title?: string };
}

export interface SessionState {
  /** 派生值：activeTurns 非空 ⇒ running。保留字段兼容既有消费面，真相源是 activeTurns */
  runState: SessionRunState;
  lastStopReason?: StopReason;
  /**
   * running 且尚未收到本 turn idle 的 turns。driven 与 observed 并发时各占一席，
   * 任何一个收口只清自己——busy/流式/运行行等呈现一律从这里聚合派生。
   */
  activeTurns: Map<string, ActiveTurnState>;
  /** per-turn 终态 stopReason：并发 turn 交错收口时按 turn 取值，不共享单槽 */
  stopReasons: Map<string, StopReason>;
  timeline: TimelineItem[];
  messages: Map<string, MessageState>;
  toolCalls: Map<string, ToolCallState>;
  plans: Map<string, PlanUpdate>;
  pendingPermissions: Map<string, PermissionRequest>;
  pendingQuestions: Map<string, QuestionRequest>;
  usage: UsageTotal;
  /** provider command 完整快照：available_commands_update 整体替换，不做增量合并 */
  availableCommands: AvailableCommand[];
  /** session config 完整快照：config_option_update 整体替换（model 变化可联动其他选项） */
  configOptions: SessionConfigOption[];
  /** 当前 context 占用快照。与 usage（增量累加）语义不同：快照替换 */
  contextUsage?: ContextUsageUpdate;
  /** 最近一次结构化错误；willRetry 时 runState 仍应为 running（由事件源保证） */
  lastError?: ErrorUpdate & { seq: number };
  /**
   * 提示历史（append-only），同时进 timeline（id 为 `n_<seq>`）：打断标记、
   * provider warning 等属于会话流的一部分，要按发生位置内联展示。
   */
  notices: Array<Notice & { seq: number }>;
  turnSummaries: TurnSummary[];
  lastSeq: number;
}

export function emptySessionState(): SessionState {
  return {
    runState: "idle",
    activeTurns: new Map(),
    stopReasons: new Map(),
    timeline: [],
    messages: new Map(),
    toolCalls: new Map(),
    plans: new Map(),
    pendingPermissions: new Map(),
    pendingQuestions: new Map(),
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

function getOrCreateToolCall(state: SessionState, id: string, turnId?: string, provider?: string): ToolCallState {
  let tc = state.toolCalls.get(id);
  if (!tc) {
    tc = { toolCallId: id, provider, status: "pending", content: [], locations: [], turnId };
    state.toolCalls.set(id, tc);
    state.timeline.push({ type: "tool_call", id });
  } else if (!tc.provider) {
    tc.provider = provider;
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
  // EventEnvelope<union> 不随 kind 自动收窄（非判别联合入参），手动断言 user_message
  if (ev.kind === "user_message") {
    const delivery = (ev as EventEnvelope<"user_message">).payload.delivery;
    if (delivery !== undefined) msg.delivery = delivery;
  }
  if (role !== "user") msg.streamStatus = "completed";
}

function applyMessageChunk(
  state: SessionState,
  ev: EventEnvelope<"user_message_chunk" | "agent_message_chunk" | "agent_thought_chunk">,
  role: MessageRole,
): void {
  const p = ev.payload;
  const msg = getOrCreateMessage(state, p.messageId, role, ev.turnId, ev.provider);
  msg.content.push(p.content);
  if (role !== "user") msg.streamStatus = "in_progress";
}

function applyToolCallUpdate(state: SessionState, ev: EventEnvelope<"tool_call_update">): void {
  const p = ev.payload;
  const tc = getOrCreateToolCall(state, p.toolCallId, ev.turnId, ev.provider);
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
      if (p.stopReason !== undefined) {
        state.lastStopReason = p.stopReason;
        if (ev.turnId) state.stopReasons.set(ev.turnId, p.stopReason);
      }
      if (p.state === "idle") {
        if (ev.turnId) {
          // 只收本 turn 的口：并发的 driven/observed turn 互不误清
          state.activeTurns.delete(ev.turnId);
        } else {
          // 向后兼容：旧 jsonl / 旧版 crash recovery 的无 turnId idle 是全局收口语义
          state.activeTurns.clear();
        }
      } else if (ev.turnId) {
        // running（含 requires_action 等非 idle 态）：turn 在场。startedAt/origin
        // 以首个 running 为准，重复 running（reconnect 重放）不重置起点。
        const existing = state.activeTurns.get(ev.turnId);
        state.activeTurns.set(ev.turnId, {
          turnId: ev.turnId,
          provider: ev.provider ?? existing?.provider,
          origin: p.origin ?? existing?.origin ?? "user",
          startedAt: existing?.startedAt ?? (ev.ts ? Date.parse(ev.ts) || undefined : undefined),
          phase: existing?.phase,
        });
      }
      state.runState = state.activeTurns.size > 0 ? "running" : "idle";
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
      const tc = getOrCreateToolCall(state, p.toolCallId, ev.turnId, ev.provider);
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
    case "question_request": {
      const p = ev.payload;
      state.pendingQuestions.set(p.requestId, p);
      break;
    }
    case "question_resolved": {
      state.pendingQuestions.delete(ev.payload.requestId);
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
    case "_baton_run_status": {
      const p = ev.payload;
      // per-turn 运行阶段；无 turnId 或未命中活跃 turn 时丢弃——phase 是短寿命
      // 装饰信息（design §5.9），turn 已收口后的迟到 phase 没有呈现意义。
      const turn = ev.turnId ? state.activeTurns.get(ev.turnId) : undefined;
      if (turn) turn.phase = p.phase === null ? undefined : { phase: p.phase, title: p.title };
      break;
    }
    case "_baton_notice":
      state.notices.push({ ...ev.payload, seq: ev.seq });
      state.timeline.push({ type: "notice", id: `n_${ev.seq}` });
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

/**
 * 该 turn 是否仍在运行。消息级流式/思考态按所属 turn 判定，不看全局——
 * 并发 turn 下"别人 idle"不能把自己的流式状态打断。turnId 缺失（旧数据 /
 * 非 turn 事件）时回退"会话存在任一运行 turn"。
 */
export function isTurnRunning(state: SessionState, turnId: string | undefined): boolean {
  if (turnId === undefined) return state.activeTurns.size > 0;
  return state.activeTurns.has(turnId);
}
