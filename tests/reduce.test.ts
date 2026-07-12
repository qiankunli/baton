import { describe, expect, test } from "bun:test";

import {
  ENVELOPE_VERSION,
  textOf,
  type AnyEventEnvelope,
  type EventEnvelope,
  type EventKind,
  type EventPayloadMap,
} from "../src/events/types.ts";
import { applyEvent, emptySessionState, reduceEvents } from "../src/store/reduce.ts";

let seq = 0;
function ev<K extends EventKind>(kind: K, payload: EventPayloadMap[K], turnId?: string): EventEnvelope<K> {
  return {
    v: ENVELOPE_VERSION,
    ts: new Date(0).toISOString(),
    seq: ++seq,
    batonSessionId: "bs_test",
    provider: "test",
    kind,
    payload,
    turnId,
  };
}

describe("message upsert semantics", () => {
  test("chunks append in order", () => {
    const state = reduceEvents([
      ev("agent_message_chunk", { messageId: "m1", content: { type: "text", text: "hello " } }),
      ev("agent_message_chunk", { messageId: "m1", content: { type: "text", text: "world" } }),
    ]);
    expect(textOf(state.messages.get("m1")!.content)).toBe("hello world");
  });

  test("whole-message upsert replaces accumulated chunks, later chunks append to it", () => {
    const state = reduceEvents([
      ev("agent_message_chunk", { messageId: "m1", content: { type: "text", text: "draft" } }),
      ev("agent_message", { messageId: "m1", content: [{ type: "text", text: "final" }] }),
      ev("agent_message_chunk", { messageId: "m1", content: { type: "text", text: "+more" } }),
    ]);
    expect(textOf(state.messages.get("m1")!.content)).toBe("final+more");
  });

  test("content null clears, omitted keeps", () => {
    const state = reduceEvents([
      ev("agent_message", { messageId: "m1", content: [{ type: "text", text: "x" }] }),
      ev("agent_message", { messageId: "m1" }), // 省略 content：不变
      ev("agent_message", { messageId: "m2", content: [{ type: "text", text: "y" }] }),
      ev("agent_message", { messageId: "m2", content: null }), // null：清空
    ]);
    expect(textOf(state.messages.get("m1")!.content)).toBe("x");
    expect(state.messages.get("m2")!.content).toEqual([]);
  });

  test("role derived from kind; timeline keeps first-seen order", () => {
    const state = reduceEvents([
      ev("user_message", { messageId: "m1", content: [{ type: "text", text: "q" }] }),
      ev("agent_thought_chunk", { messageId: "m2", content: { type: "text", text: "hmm" } }),
      ev("agent_message_chunk", { messageId: "m3", content: { type: "text", text: "a" } }),
    ]);
    expect(state.messages.get("m1")!.role).toBe("user");
    expect(state.messages.get("m2")!.role).toBe("thought");
    expect(state.messages.get("m2")!.streamStatus).toBe("in_progress");
    expect(state.messages.get("m3")!.role).toBe("agent");
    expect(state.messages.get("m3")!.streamStatus).toBe("in_progress");
    expect(state.timeline.map((t) => t.id)).toEqual(["m1", "m2", "m3"]);
  });

  test("whole thought upsert completes an in-progress block", () => {
    const state = reduceEvents([
      ev("agent_thought_chunk", { messageId: "m1", content: { type: "text", text: "draft" } }),
      ev("agent_thought", { messageId: "m1", content: [{ type: "text", text: "final" }] }),
    ]);
    expect(state.messages.get("m1")!.streamStatus).toBe("completed");
  });
});

describe("tool call upsert semantics", () => {
  test("first update creates; patch: omitted unchanged, null clears, value replaces", () => {
    const state = reduceEvents([
      ev("tool_call_update", { toolCallId: "tc1", title: "Read file", kind: "read", status: "pending" }),
      ev("tool_call_update", { toolCallId: "tc1", status: "completed" }), // title/kind 省略：不变
      ev("tool_call_update", { toolCallId: "tc1", title: null }), // null：清除
    ]);
    const tc = state.toolCalls.get("tc1")!;
    expect(tc.status).toBe("completed");
    expect(tc.provider).toBe("test");
    expect(tc.kind).toBe("read");
    expect(tc.title).toBeUndefined();
  });

  test("content chunks append; update with content replaces accumulated", () => {
    const state = reduceEvents([
      ev("tool_call_update", { toolCallId: "tc1", status: "in_progress" }),
      ev("tool_call_content_chunk", { toolCallId: "tc1", content: { type: "text", text: "a" } }),
      ev("tool_call_content_chunk", { toolCallId: "tc1", content: { type: "text", text: "b" } }),
      ev("tool_call_update", { toolCallId: "tc1", content: [{ type: "text", text: "final" }] }),
    ]);
    expect(textOf(state.toolCalls.get("tc1")!.content)).toBe("final");
  });
});

describe("state / permission / plan / usage", () => {
  test("state transitions and stop reason", () => {
    const state = reduceEvents([
      ev("state_update", { state: "running" }),
      ev("state_update", { state: "idle", stopReason: "end_turn" }),
    ]);
    expect(state.runState).toBe("idle");
    expect(state.lastStopReason).toBe("end_turn");
  });

  test("permission request pends until resolved", () => {
    const req = {
      requestId: "ar1",
      title: "Run this script?",
      options: [{ optionId: "allow", name: "Allow once", kind: "allow_once" as const }],
    };
    const pending = reduceEvents([ev("permission_request", req)]);
    expect(pending.pendingPermissions.has("ar1")).toBe(true);
    const resolved = reduceEvents([
      ev("permission_request", req),
      ev("permission_resolved", { requestId: "ar1", outcome: "selected", optionId: "allow" }),
    ]);
    expect(resolved.pendingPermissions.size).toBe(0);
  });

  test("question request pends until resolved", () => {
    const request = {
      requestId: "qr1",
      questions: [{ questionId: "q1", header: "Mode", question: "Which mode?" }],
    };
    const pending = reduceEvents([ev("question_request", request)]);
    expect(pending.pendingQuestions.has("qr1")).toBe(true);
    const resolved = reduceEvents([
      ev("question_request", request),
      ev("question_resolved", { requestId: "qr1", outcome: "answered", answers: { q1: ["fast"] } }),
    ]);
    expect(resolved.pendingQuestions.size).toBe(0);
  });

  test("plan update replaces entries per planId", () => {
    const state = reduceEvents([
      ev("plan_update", { planId: "pl1", entries: [{ content: "step1", priority: "high", status: "pending" }] }),
      ev("plan_update", { planId: "pl1", entries: [{ content: "step1", priority: "high", status: "completed" }] }),
    ]);
    expect(state.plans.get("pl1")!.entries[0]!.status).toBe("completed");
    expect(state.timeline.filter((t) => t.type === "plan")).toHaveLength(1);
  });

  test("usage accumulates as deltas", () => {
    const state = reduceEvents([
      ev("usage_update", { inputTokens: 100, outputTokens: 10 }),
      ev("usage_update", { inputTokens: 50, outputTokens: 5, isEstimated: true }),
    ]);
    expect(state.usage.inputTokens).toBe(150);
    expect(state.usage.outputTokens).toBe(15);
    expect(state.usage.hasEstimated).toBe(true);
  });

  test("unknown event kinds are ignored, not fatal", () => {
    const unknown = ev("state_update", { state: "running" });
    (unknown as { kind: string }).kind = "_future_thing";
    const state = reduceEvents([unknown as unknown as AnyEventEnvelope]);
    expect(state.lastSeq).toBe(unknown.seq);
  });

  test("replay is idempotent: reduce(events) twice gives same result", () => {
    const events = [
      ev("state_update", { state: "running" }),
      ev("agent_message_chunk", { messageId: "m1", content: { type: "text", text: "a" } }),
      ev("tool_call_update", { toolCallId: "tc1", title: "t", status: "completed" }),
      ev("state_update", { state: "idle", stopReason: "end_turn" }),
    ];
    const a = reduceEvents(events);
    const b = reduceEvents(events);
    expect(textOf(b.messages.get("m1")!.content)).toBe(textOf(a.messages.get("m1")!.content));
    expect(b.timeline).toEqual(a.timeline);
    expect(b.runState).toBe(a.runState);
  });
});

describe("emptySessionState", () => {
  test("starts idle with empty collections", () => {
    const s = emptySessionState();
    expect(s.runState).toBe("idle");
    expect(s.messages.size).toBe(0);
    expect(s.lastSeq).toBe(0);
  });
});

// Phase 1 新事件（design §4.8）：快照 vs 增量、append-only 的语义边界
describe("snapshot vs delta semantics", () => {
  test("available_commands_update replaces the whole snapshot — no merge, stale items gone", () => {
    const state = reduceEvents([
      ev("available_commands_update", {
        commands: [{ name: "review" }, { name: "compact", description: "compact context" }],
      }),
      ev("available_commands_update", { commands: [{ name: "plan" }] }),
    ]);
    expect(state.availableCommands.map((c) => c.name)).toEqual(["plan"]);
  });

  test("config_option_update replaces the whole snapshot", () => {
    const state = reduceEvents([
      ev("config_option_update", {
        options: [
          { id: "model", type: "select", name: "Model", value: "a", options: [{ value: "a", name: "A" }] },
          { id: "thought", type: "boolean", name: "Thoughts", value: true },
        ],
      }),
      ev("config_option_update", {
        options: [{ id: "model", type: "select", name: "Model", value: "b", options: [{ value: "b", name: "B" }] }],
      }),
    ]);
    expect(state.configOptions).toHaveLength(1);
    expect(state.configOptions[0]).toMatchObject({ id: "model", value: "b" });
  });

  test("usage_update accumulates (delta) while context_usage_update replaces (snapshot)", () => {
    // 守住 design §4.8 的关键区分：旧 jsonl 的 usage delta replay 结果不变，
    // context 快照后写覆盖先写。
    const state = reduceEvents([
      ev("usage_update", { inputTokens: 10, outputTokens: 5 }),
      ev("context_usage_update", { contextUsed: 1000, contextSize: 200000 }),
      ev("usage_update", { inputTokens: 3, outputTokens: 2 }),
      ev("context_usage_update", { contextUsed: 1500, contextSize: 200000 }),
    ]);
    expect(state.usage.inputTokens).toBe(13);
    expect(state.usage.outputTokens).toBe(7);
    expect(state.contextUsage).toEqual({ contextUsed: 1500, contextSize: 200000 });
  });

  test("context_usage_update snapshot replaces omitted fields too — no field-level merge", () => {
    const state = reduceEvents([
      ev("context_usage_update", { contextUsed: 1000, cost: { amount: 1.5, currency: "USD" } }),
      ev("context_usage_update", { contextUsed: 1200 }),
    ]);
    expect(state.contextUsage?.cost).toBeUndefined();
  });
});

describe("error and notice events", () => {
  test("_baton_error_update keeps the latest error with its seq", () => {
    const state = reduceEvents([
      ev("_baton_error_update", { message: "rate limited", retryable: true, willRetry: true }),
      ev("_baton_error_update", { code: "auth", message: "token expired", retryable: false }),
    ]);
    expect(state.lastError).toMatchObject({ code: "auth", message: "token expired" });
    expect(state.lastError!.seq).toBe(state.lastSeq);
  });

  test("retrying error does not flip runState by itself", () => {
    const state = reduceEvents([
      ev("state_update", { state: "running" }, "t1"),
      ev("_baton_error_update", { message: "retrying", willRetry: true }, "t1"),
    ]);
    expect(state.runState).toBe("running");
  });

  test("_baton_notice appends in order", () => {
    const state = reduceEvents([
      ev("_baton_notice", { level: "warning", title: "model rerouted" }),
      ev("_baton_notice", { level: "info", title: "auth ok", detail: "refreshed" }),
    ]);
    expect(state.notices.map((n) => n.title)).toEqual(["model rerouted", "auth ok"]);
    expect(state.notices[1]!.seq).toBeGreaterThan(state.notices[0]!.seq);
  });
});

describe("run status events", () => {
  test("phase attaches to its turn, null clears", () => {
    const state = reduceEvents([
      ev("state_update", { state: "running" }, "t1"),
      ev("_baton_run_status", { phase: "compacting", title: "Compacting context…" }, "t1"),
    ]);
    expect(state.activeTurns.get("t1")?.phase).toEqual({ phase: "compacting", title: "Compacting context…" });
    const cleared = reduceEvents([
      ev("state_update", { state: "running" }, "t1"),
      ev("_baton_run_status", { phase: "compacting" }, "t1"),
      ev("_baton_run_status", { phase: null }, "t1"),
    ]);
    expect(cleared.activeTurns.get("t1")?.phase).toBeUndefined();
  });

  test("idle clears the turn (and its phase) as a safety net", () => {
    const state = reduceEvents([
      ev("state_update", { state: "running" }, "t1"),
      ev("_baton_run_status", { phase: "compacting" }, "t1"),
      ev("state_update", { state: "idle", stopReason: "end_turn" }, "t1"),
    ]);
    expect(state.activeTurns.has("t1")).toBe(false);
  });

  test("phase without a matching active turn is dropped (短寿命装饰信息)", () => {
    const state = reduceEvents([ev("_baton_run_status", { phase: "compacting" }, "t_gone")]);
    expect(state.activeTurns.size).toBe(0);
  });
});

describe("per-turn run state aggregation", () => {
  test("concurrent turns close independently; runState derives from the set", () => {
    const state = reduceEvents([
      ev("state_update", { state: "running" }, "t_driven"),
      ev("state_update", { state: "running", origin: "provider" }, "t_obs"),
    ]);
    expect([...state.activeTurns.keys()].sort()).toEqual(["t_driven", "t_obs"]);
    expect(state.runState).toBe("running");

    // 一个收口不误清另一个（bug#3 回归钉子）
    applyEvent(state, ev("state_update", { state: "idle", stopReason: "end_turn" }, "t_obs"));
    expect(state.activeTurns.has("t_driven")).toBe(true);
    expect(state.runState).toBe("running");
    expect(state.stopReasons.get("t_obs")).toBe("end_turn");

    applyEvent(state, ev("state_update", { state: "idle", stopReason: "cancelled" }, "t_driven"));
    expect(state.activeTurns.size).toBe(0);
    expect(state.runState).toBe("idle");
    expect(state.stopReasons.get("t_driven")).toBe("cancelled");
  });

  test("requires_action is preserved per turn and surfaces in the aggregate", () => {
    const state = reduceEvents([
      ev("state_update", { state: "running" }, "t_driven"),
      ev("state_update", { state: "requires_action" }, "t_driven"),
    ]);
    // 不折叠成 running：per-turn 保真，会话级上浮（没有用户动作会话无法完整推进）
    expect(state.activeTurns.get("t_driven")?.state).toBe("requires_action");
    expect(state.runState).toBe("requires_action");

    // 并发场景：任一 turn requires_action 即上浮
    applyEvent(state, ev("state_update", { state: "running", origin: "provider" }, "t_obs"));
    expect(state.runState).toBe("requires_action");

    // 用户应答后回到 running（requires_action ↔ running 可来回迁移）
    applyEvent(state, ev("state_update", { state: "running" }, "t_driven"));
    expect(state.activeTurns.get("t_driven")?.state).toBe("running");
    expect(state.runState).toBe("running");
  });

  test("pending blocking request derives requires_action without adapter state_updates", () => {
    const state = reduceEvents([
      ev("state_update", { state: "running" }, "t1"),
      ev("permission_request", { requestId: "ar_1", title: "Bash", options: [] }, "t1"),
    ]);
    // 不变量收在 reducer：adapter 只发 request，不要求配对 state_update(requires_action)
    expect(state.activeTurns.get("t1")?.state).toBe("requires_action");
    expect(state.runState).toBe("requires_action");

    applyEvent(state, ev("permission_resolved", { requestId: "ar_1", outcome: "selected", optionId: "allow" }, "t1"));
    expect(state.activeTurns.get("t1")?.state).toBe("running");
    expect(state.runState).toBe("running");
  });

  test("requires_action holds until the last pending request of the turn resolves", () => {
    const state = reduceEvents([
      ev("state_update", { state: "running" }, "t1"),
      ev("permission_request", { requestId: "ar_1", title: "Bash", options: [] }, "t1"),
      ev("question_request", { requestId: "qr_1", questions: [] }, "t1"),
      ev("permission_resolved", { requestId: "ar_1", outcome: "selected", optionId: "allow" }, "t1"),
    ]);
    // 同 turn 并发多个 blocking request：应答一个不提前撤掉 requires_action
    expect(state.activeTurns.get("t1")?.state).toBe("requires_action");
    expect(state.runState).toBe("requires_action");

    applyEvent(state, ev("question_resolved", { requestId: "qr_1", outcome: "cancelled" }, "t1"));
    expect(state.runState).toBe("running");
  });

  test("replayed running cannot mask a pending request (不变量钉子)", () => {
    const state = reduceEvents([
      ev("state_update", { state: "running" }, "t1"),
      ev("permission_request", { requestId: "ar_1", title: "Bash", options: [] }, "t1"),
      // reconnect 重放 running：pending 在场时必须钉在 requires_action
      ev("state_update", { state: "running" }, "t1"),
    ]);
    expect(state.activeTurns.get("t1")?.state).toBe("requires_action");
    expect(state.runState).toBe("requires_action");
  });

  test("request without a turnId still surfaces session-level requires_action", () => {
    const state = reduceEvents([
      ev("state_update", { state: "running" }, "t1"),
      ev("permission_request", { requestId: "ar_1", title: "login", options: [] }),
    ]);
    // 未能归属到 turn（旧事件缺 turnId）：per-turn 不动，会话级仍要上浮
    expect(state.activeTurns.get("t1")?.state).toBe("running");
    expect(state.runState).toBe("requires_action");
  });

  test("legacy idle without turnId closes everything (旧 jsonl 兼容)", () => {
    const state = reduceEvents([
      ev("state_update", { state: "running" }, "t1"),
      ev("state_update", { state: "running", origin: "provider" }, "t2"),
      ev("state_update", { state: "idle", stopReason: "cancelled" }),
    ]);
    expect(state.activeTurns.size).toBe(0);
    expect(state.runState).toBe("idle");
  });

  test("duplicate running keeps the original startedAt and origin", () => {
    const state = reduceEvents([
      ev("state_update", { state: "running", origin: "provider" }, "t1"),
      ev("state_update", { state: "running" }, "t1"),
    ]);
    expect(state.activeTurns.get("t1")?.origin).toBe("provider");
  });
});
