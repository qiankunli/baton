import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionStore } from "../src/store/store.ts";
import { textOf, type TurnSummary } from "../src/events/types.ts";

let root: string;
let store: SessionStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baton-test-"));
  store = new SessionStore(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("session lifecycle", () => {
  test("create / open / list roundtrip", () => {
    const h = store.createSession({ cwd: "/tmp/proj", title: "demo" });
    expect(h.id.startsWith("bs_")).toBe(true);

    const reopened = store.openSession(h.id);
    expect(reopened.meta.cwd).toBe("/tmp/proj");
    expect(reopened.meta.title).toBe("demo");

    expect(store.listSessions().map((m) => m.batonSessionId)).toContain(h.id);
  });

  test("open unknown session throws", () => {
    expect(() => store.openSession("bs_NOPE")).toThrow(/not found/);
  });

  test("provider session meta persists as a native resume optimization", () => {
    const h = store.createSession({ cwd: "/tmp/proj" });
    h.setProviderSession("codex", {
      provider: "codex",
      providerSessionId: "thread_123",
      resumeCursor: "42",
      model: "gpt-5",
    });
    const reopened = store.openSession(h.id);
    expect(reopened.meta.providerSessions["codex"]!.providerSessionId).toBe("thread_123");
    expect(reopened.meta.providerSessions["codex"]!.resumeCursor).toBe("42");
    expect(reopened.meta.providerSessions["codex"]!.model).toBe("gpt-5");
  });
});

describe("event append / read", () => {
  test("append assigns envelope fields and seq is monotonic across reopen", () => {
    const h = store.createSession({ cwd: "/tmp/proj" });
    const e1 = h.append({ kind: "state_update", payload: { state: "running" }, provider: "codex" });
    const e2 = h.append({
      kind: "agent_message_chunk",
      payload: { messageId: "m1", content: { type: "text", text: "hi" } },
      provider: "codex",
    });
    expect(e1.seq).toBe(1);
    expect(e2.seq).toBe(2);
    expect(e1.batonSessionId).toBe(h.id);
    expect(e1.v).toBe(1);

    // 重开进程（新 handle），seq 从文件续上
    const reopened = store.openSession(h.id);
    const e3 = reopened.append({ kind: "state_update", payload: { state: "idle" }, provider: "codex" });
    expect(e3.seq).toBe(3);
    expect(reopened.readEvents()).toHaveLength(3);
  });

  test("raw is preserved verbatim (细节保真)", () => {
    const h = store.createSession({ cwd: "/tmp/proj" });
    const raw = { method: "item/agentMessage/delta", params: { weird: [1, { deep: true }] } };
    h.append({
      kind: "agent_message_chunk",
      payload: { messageId: "m1", content: { type: "text", text: "x" } },
      provider: "codex",
      raw,
    });
    expect(store.openSession(h.id).readEvents()[0]!.raw).toEqual(raw);
  });

  test("incomplete trailing line is tolerated (崩溃后可恢复)", () => {
    const h = store.createSession({ cwd: "/tmp/proj" });
    h.append({ kind: "state_update", payload: { state: "running" }, provider: "codex" });
    appendFileSync(join(h.dir, "session.jsonl"), '{"v":1,"ts":"2026-'); // 模拟写到一半崩溃
    const reopened = store.openSession(h.id);
    expect(reopened.readEvents()).toHaveLength(1);
    // 追加从完好事件之后继续
    const e = reopened.append({ kind: "state_update", payload: { state: "idle" }, provider: "codex" });
    expect(e.seq).toBe(2);
  });

  test("corrupt middle line throws instead of silently skipping", () => {
    const h = store.createSession({ cwd: "/tmp/proj" });
    h.append({ kind: "state_update", payload: { state: "running" }, provider: "codex" });
    appendFileSync(join(h.dir, "session.jsonl"), "garbage\n");
    h.append({ kind: "state_update", payload: { state: "idle" }, provider: "codex" });
    expect(() => store.openSession(h.id).readEvents()).toThrow(/corrupt/);
  });

  test("loadState reduces the full stream", () => {
    const h = store.createSession({ cwd: "/tmp/proj" });
    h.append({ kind: "state_update", payload: { state: "running" }, provider: "claude-code" });
    h.append({
      kind: "agent_message_chunk",
      payload: { messageId: "m1", content: { type: "text", text: "hello" } },
      provider: "claude-code",
    });
    h.append({ kind: "state_update", payload: { state: "idle", stopReason: "end_turn" }, provider: "claude-code" });
    const state = h.loadState();
    expect(state.runState).toBe("idle");
    expect(textOf(state.messages.get("m1")!.content)).toBe("hello");
  });
});

describe("turn summary", () => {
  function playTurn(h: ReturnType<SessionStore["createSession"]>, turnId: string): void {
    h.append({ kind: "state_update", payload: { state: "running" }, provider: "codex", turnId });
    h.append({
      kind: "user_message",
      payload: { messageId: `${turnId}_u`, content: [{ type: "text", text: "do the thing" }] },
      provider: "codex",
      turnId,
    });
    h.append({
      kind: "tool_call_update",
      payload: { toolCallId: `${turnId}_tc`, title: "Edit file", kind: "edit", status: "completed" },
      provider: "codex",
      turnId,
    });
    h.append({
      kind: "agent_message_chunk",
      payload: { messageId: `${turnId}_a`, content: { type: "text", text: "done" } },
      provider: "codex",
      turnId,
    });
    h.append({ kind: "usage_update", payload: { inputTokens: 100, outputTokens: 20 }, provider: "codex", turnId });
    h.append({ kind: "state_update", payload: { state: "idle", stopReason: "end_turn" }, provider: "codex", turnId });
  }

  test("summarizeTurn derives text, tool calls, usage, stop reason", () => {
    const h = store.createSession({ cwd: "/tmp/proj" });
    playTurn(h, "t_1");
    const s = h.summarizeTurn("t_1");
    expect(s.userText).toBe("do the thing");
    expect(s.agentText).toBe("done");
    expect(s.toolCalls).toEqual([{ toolCallId: "t_1_tc", title: "Edit file", kind: "edit", status: "completed" }]);
    expect(s.usage?.inputTokens).toBe(100);
    expect(s.stopReason).toBe("end_turn");
    // summary 事件落盘且可从状态读回
    expect(h.loadState().turnSummaries).toHaveLength(1);
  });

  test("summary excludes baton-injected context while raw events retain it", () => {
    const h = store.createSession({ cwd: "/tmp/proj" });
    const turnId = "t_sync";
    h.append({
      kind: "user_message",
      provider: "claude-code",
      turnId,
      payload: {
        messageId: "sync-user",
        content: [{ type: "text", text: "<baton-sync>old history</baton-sync>\n\ncontinue" }],
      },
    });
    h.append({
      kind: "state_update",
      provider: "claude-code",
      turnId,
      payload: { state: "idle", stopReason: "end_turn" },
    });

    expect(h.summarizeTurn(turnId).userText).toBe("continue");
    expect(textOf(h.loadState().messages.get("sync-user")!.content)).toContain("old history");
  });

  test("summarizeTurn is idempotent", () => {
    const h = store.createSession({ cwd: "/tmp/proj" });
    playTurn(h, "t_1");
    h.summarizeTurn("t_1");
    h.summarizeTurn("t_1");
    const summaries = h.readEvents().filter((e) => e.kind === "_baton_turn_summary");
    expect(summaries).toHaveLength(1);
  });

  test("summary lines are greppable from raw jsonl", () => {
    const h = store.createSession({ cwd: "/tmp/proj" });
    playTurn(h, "t_1");
    playTurn(h, "t_2");
    h.summarizeTurn("t_1");
    h.summarizeTurn("t_2");
    const lines = readFileSync(join(h.dir, "session.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.includes("_baton_turn_summary"));
    expect(lines).toHaveLength(2);
    const parsed = JSON.parse(lines[0]!) as { payload: TurnSummary };
    expect(parsed.payload.turnId).toBe("t_1");
  });

  test("summarizeTurn on unknown turn throws", () => {
    const h = store.createSession({ cwd: "/tmp/proj" });
    expect(() => h.summarizeTurn("t_missing")).toThrow(/no events/);
  });
});
