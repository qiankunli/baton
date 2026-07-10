import { describe, expect, test } from "bun:test";

import {
  ENVELOPE_VERSION,
  textOf,
  type AnyEventEnvelope,
  type EventEnvelope,
  type EventKind,
  type EventPayloadMap,
} from "../src/events/types.ts";
import { emptySessionState, reduceEvents } from "../src/store/reduce.ts";

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
    expect(state.messages.get("m2")!.thoughtStatus).toBe("in_progress");
    expect(state.messages.get("m3")!.role).toBe("agent");
    expect(state.timeline.map((t) => t.id)).toEqual(["m1", "m2", "m3"]);
  });

  test("whole thought upsert completes an in-progress block", () => {
    const state = reduceEvents([
      ev("agent_thought_chunk", { messageId: "m1", content: { type: "text", text: "draft" } }),
      ev("agent_thought", { messageId: "m1", content: [{ type: "text", text: "final" }] }),
    ]);
    expect(state.messages.get("m1")!.thoughtStatus).toBe("completed");
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
