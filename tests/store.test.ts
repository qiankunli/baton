import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  SessionStore,
  projectDirName,
  sessionDisplayTitle,
  sessionPreview,
  type SessionMeta,
} from "../src/store/store.ts";
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
  test("preview uses the first visible line and is character-bounded", () => {
    expect(sessionPreview("<baton-sync>hidden</baton-sync>\n\n  Implement resume titles\nsecond line")).toBe(
      "Implement resume titles",
    );
    expect(sessionPreview("/tmp/image-123.png 解释这个报错")).toBe("解释这个报错");
    expect(sessionPreview("/tmp/image-123.png\n修复 resume 标题")).toBe("修复 resume 标题");
    expect(sessionPreview("/tmp/image-123.png")).toBeUndefined();
    expect(sessionPreview("界".repeat(101))).toBe(`${"界".repeat(97)}...`);
  });

  test("preview is persisted once and explicit titles remain authoritative", () => {
    const h = store.createSession({ cwd: "/tmp/proj", title: "My release session" });
    h.setPreviewIfEmpty("First task");
    h.setPreviewIfEmpty("Later task");
    const reopened = store.openSession(h.id);
    expect(reopened.meta.preview).toBe("First task");
    expect(sessionDisplayTitle(reopened.meta)).toBe("My release session");
  });

  test("old generated titles yield to a preview recovered from session history", () => {
    const h = store.createSession({ cwd: "/tmp/proj", title: "chat @ /tmp/proj" });
    h.append({
      kind: "user_message",
      provider: "codex",
      payload: {
        messageId: "m1",
        content: [{ type: "text", text: "<baton-context>old context</baton-context>\nAdd session previews" }],
      },
    });

    const listed = store.listSessions().find((meta) => meta.batonSessionId === h.id)!;
    expect(listed.preview).toBe("Add session previews");
    expect(sessionDisplayTitle(listed)).toBe("Add session previews");
    expect(store.openSession(h.id).meta.preview).toBe("Add session previews");
  });

  test("history backfill skips an attachment-only message", () => {
    const h = store.createSession({ cwd: "/tmp/proj", title: "chat @ /tmp/proj" });
    h.append({
      kind: "user_message",
      provider: "codex",
      payload: { messageId: "m1", content: [{ type: "text", text: "/tmp/image-123.png" }] },
    });
    h.append({
      kind: "user_message",
      provider: "codex",
      payload: { messageId: "m2", content: [{ type: "text", text: "Explain this failure" }] },
    });

    const listed = store.listSessions().find((meta) => meta.batonSessionId === h.id)!;
    expect(sessionDisplayTitle(listed)).toBe("Explain this failure");
  });

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

  test("sessions are grouped by project directory (claude-style)", () => {
    const h = store.createSession({ cwd: "/tmp/proj" });
    expect(h.dir).toBe(join(root, "projects", "-tmp-proj", h.id));

    const other = store.createSession({ cwd: "/tmp/other" });
    expect(store.listSessions({ cwd: "/tmp/proj" }).map((m) => m.batonSessionId)).toEqual([h.id]);
    // 不带 cwd 时跨项目全量列出
    const all = store.listSessions().map((m) => m.batonSessionId);
    expect(all).toContain(h.id);
    expect(all).toContain(other.id);
  });

  test("munged project names may collide; listSessions still filters by exact cwd", () => {
    const a = store.createSession({ cwd: "/tmp/proj" });
    const b = store.createSession({ cwd: "/tmp-proj" });
    expect(projectDirName("/tmp/proj")).toBe(projectDirName("/tmp-proj"));
    expect(store.listSessions({ cwd: "/tmp/proj" }).map((m) => m.batonSessionId)).toEqual([a.id]);
    expect(store.listSessions({ cwd: "/tmp-proj" }).map((m) => m.batonSessionId)).toEqual([b.id]);
  });

  test("legacy flat sessions/ layout migrates into projects/ on first access", () => {
    const legacy = join(root, "sessions", "bs_LEGACY1");
    mkdirSync(legacy, { recursive: true });
    const meta: SessionMeta = {
      batonSessionId: "bs_LEGACY1",
      cwd: "/tmp/proj",
      createdAt: "2026-01-01T00:00:00.000Z",
      providerSessions: {},
    };
    writeFileSync(join(legacy, "meta.json"), JSON.stringify(meta));
    writeFileSync(join(legacy, "session.jsonl"), "");

    const h = store.openSession("bs_LEGACY1");
    expect(h.dir).toBe(join(root, "projects", "-tmp-proj", "bs_LEGACY1"));
    // 旧目录清空后移除
    expect(existsSync(join(root, "sessions"))).toBe(false);
  });

  test("legacy session with corrupt meta stays in place and does not block", () => {
    const legacy = join(root, "sessions", "bs_BROKEN");
    mkdirSync(legacy, { recursive: true });
    writeFileSync(join(legacy, "meta.json"), "not json");

    expect(store.listSessions()).toEqual([]);
    expect(existsSync(join(root, "sessions", "bs_BROKEN"))).toBe(true);
  });

  test("provider session meta persists as a native resume optimization", () => {
    const h = store.createSession({ cwd: "/tmp/proj" });
    h.setProviderSession("codex", {
      provider: "codex",
      providerSessionId: "thread_123",
      resumeCursor: "42",
      model: "gpt-5",
      effort: "high",
    });
    const reopened = store.openSession(h.id);
    expect(reopened.meta.providerSessions["codex"]!.providerSessionId).toBe("thread_123");
    expect(reopened.meta.providerSessions["codex"]!.resumeCursor).toBe("42");
    expect(reopened.meta.providerSessions["codex"]!.model).toBe("gpt-5");
    expect(reopened.meta.providerSessions["codex"]!.effort).toBe("high");
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

  test("session diagnostics are paired with session.jsonl without entering its event stream", () => {
    const h = store.createSession({ cwd: "/tmp/proj" });

    const event = h.append({
      kind: "_baton_error_update",
      provider: "codex",
      turnId: "t_1",
      payload: { message: "provider failed" },
    });
    h.diagnostic({
      level: "error",
      component: "codex.jsonrpc",
      provider: "codex",
      turnId: "t_1",
      message: "mapping failed",
      error: { name: "Error", message: "boom", stack: "stack" },
    });

    expect(h.readEvents()).toEqual([event]);

    const log = JSON.parse(readFileSync(join(h.dir, "session.log"), "utf8").trim());
    expect(log.batonSessionId).toBe(h.id);
    expect(log.component).toBe("codex.jsonrpc");
    expect(log.error.message).toBe("boom");

    expect(readFileSync(join(h.dir, "session.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
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

  test("append after a crash partial repairs the tail (截断残尾 + sidecar 留档)", () => {
    const h = store.createSession({ cwd: "/tmp/proj" });
    h.append({ kind: "state_update", payload: { state: "running" }, provider: "codex" });
    const partial = '{"v":1,"ts":"2026-';
    appendFileSync(join(h.dir, "session.jsonl"), partial); // 模拟写到一半崩溃

    // 纯读路径不产生写副作用：不截断、不生成 sidecar
    const readOnly = store.openSession(h.id);
    expect(readOnly.readEvents()).toHaveLength(1);
    expect(readFileSync(join(h.dir, "session.jsonl"), "utf8").endsWith(partial)).toBe(true);
    expect(readdirSync(h.dir).filter((f) => f.startsWith("session.jsonl.partial-"))).toHaveLength(0);

    // 首次 append 截断残尾：新事件不会拼接在残片后形成中间坏行
    const reopened = store.openSession(h.id);
    const e = reopened.append({ kind: "state_update", payload: { state: "idle" }, provider: "codex" });
    expect(e.seq).toBe(2); // 残行 seq 从未完整落盘，由新事件复用
    const events = store.openSession(h.id).readEvents();
    expect(events).toHaveLength(2);
    expect(events.map((ev) => ev.seq)).toEqual([1, 2]);

    // 残片进 sidecar 留档
    const sidecars = readdirSync(h.dir).filter((f) => f.startsWith("session.jsonl.partial-"));
    expect(sidecars).toHaveLength(1);
    expect(readFileSync(join(h.dir, sidecars[0]!), "utf8")).toBe(partial);
  });

  test("crash partial with no complete line at all truncates to empty", () => {
    const h = store.createSession({ cwd: "/tmp/proj" });
    writeFileSync(join(h.dir, "session.jsonl"), '{"v":1,"ts'); // 首行即残片
    const e = store.openSession(h.id).append({ kind: "state_update", payload: { state: "running" }, provider: "codex" });
    expect(e.seq).toBe(1);
    expect(store.openSession(h.id).readEvents()).toHaveLength(1);
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

describe("forkSession", () => {
  function playTurn(h: ReturnType<SessionStore["createSession"]>, turnId: string): void {
    h.append({ kind: "state_update", payload: { state: "running" }, provider: "codex", turnId });
    h.append({
      kind: "user_message",
      payload: { messageId: `${turnId}_u`, content: [{ type: "text", text: "do the thing" }] },
      provider: "codex",
      turnId,
    });
    h.append({
      kind: "agent_message_chunk",
      payload: { messageId: `${turnId}_a`, content: { type: "text", text: "done" } },
      provider: "codex",
      turnId,
    });
    h.append({ kind: "state_update", payload: { state: "idle", stopReason: "end_turn" }, provider: "codex", turnId });
    h.summarizeTurn(turnId);
  }

  test("copies history with new batonSessionId; seq and object ids preserved (git-branch 语义)", () => {
    const source = store.createSession({ cwd: "/tmp/proj", title: "demo" });
    playTurn(source, "t1");
    const sourceEvents = source.readEvents();

    const child = store.forkSession(source.id);
    expect(child.id).not.toBe(source.id);
    expect(child.meta.cwd).toBe("/tmp/proj");
    expect(child.meta.title).toBeUndefined();
    expect(child.meta.name).toBeUndefined();
    expect(child.meta.description).toBe("fork: do the thing");
    expect(sessionDisplayTitle(child.meta)).toBe("fork: do the thing");
    expect(child.meta.forkedFrom).toEqual({
      batonSessionId: source.id,
      throughSeq: sourceEvents.at(-1)!.seq,
    });

    const childEvents = child.readEvents();
    expect(childEvents).toHaveLength(sourceEvents.length);
    for (let i = 0; i < childEvents.length; i++) {
      expect(childEvents[i]!.batonSessionId).toBe(child.id);
      expect(childEvents[i]!.seq).toBe(sourceEvents[i]!.seq);
    }
    // 对象 ID 不做 remap：同一段逻辑历史
    const userMsg = childEvents.find((e) => e.kind === "user_message");
    expect((userMsg!.payload as { messageId: string }).messageId).toBe("t1_u");
    // child 可独立续写
    const next = child.append({ kind: "state_update", payload: { state: "idle" }, provider: "codex" });
    expect(next.seq).toBe(sourceEvents.at(-1)!.seq + 1);
    // 源不受影响
    expect(source.readEvents()).toHaveLength(sourceEvents.length);
  });

  test("providerSessions keep only provider config (child must not resume source native sessions)", () => {
    const source = store.createSession({ cwd: "/tmp/proj" });
    source.setProviderSession("codex", {
      provider: "codex",
      providerSessionId: "thread_123",
      resumeCursor: "42",
      syncedSeq: 7,
      model: "gpt-5",
      effort: "high",
    });
    source.setProviderSession("claude-code", { provider: "claude-code", providerSessionId: "sess_9" });

    const child = store.forkSession(source.id);
    expect(child.meta.providerSessions["codex"]).toEqual({ provider: "codex", model: "gpt-5", effort: "high" });
    expect(child.meta.providerSessions["claude-code"]).toEqual({ provider: "claude-code" });
  });

  test("throughSeq bounds the copied prefix", () => {
    const source = store.createSession({ cwd: "/tmp/proj" });
    playTurn(source, "t1");
    const boundary = source.readEvents().at(-1)!.seq;
    playTurn(source, "t2");

    const child = store.forkSession(source.id, { throughSeq: boundary });
    const childEvents = child.readEvents();
    expect(childEvents.at(-1)!.seq).toBe(boundary);
    expect(childEvents.some((e) => e.turnId === "t2")).toBe(false);
    expect(child.meta.forkedFrom!.throughSeq).toBe(boundary);
  });

  test("cwd option forks into another project (history follows source, project follows caller)", () => {
    const source = store.createSession({ cwd: "/tmp/proj-a", title: "demo" });
    playTurn(source, "t1");

    const child = store.forkSession(source.id, { cwd: "/tmp/proj-b" });
    expect(child.meta.cwd).toBe("/tmp/proj-b");
    expect(child.meta.forkedFrom!.batonSessionId).toBe(source.id);
    expect(child.readEvents()).toHaveLength(source.readEvents().length);
    // 落盘目录跟着目标 project 走，listSessions({cwd}) 才能按目录扫到
    expect(existsSync(join(root, "projects", projectDirName("/tmp/proj-b"), child.id))).toBe(true);
    expect(store.listSessions({ cwd: "/tmp/proj-b" }).map((m) => m.batonSessionId)).toEqual([child.id]);
    expect(store.listSessions({ cwd: "/tmp/proj-a" }).map((m) => m.batonSessionId)).toEqual([source.id]);
  });

  test("without cwd option the fork stays in the source project", () => {
    const source = store.createSession({ cwd: "/tmp/proj-a" });
    const child = store.forkSession(source.id);
    expect(child.meta.cwd).toBe("/tmp/proj-a");
    expect(store.listSessions({ cwd: "/tmp/proj-a" })).toHaveLength(2);
  });

  test("forking an empty session yields an empty history", () => {
    const source = store.createSession({ cwd: "/tmp/proj" });
    const child = store.forkSession(source.id);
    expect(child.readEvents()).toEqual([]);
    expect(child.meta.forkedFrom!.throughSeq).toBe(0);
  });

  test("forking an unknown session throws", () => {
    expect(() => store.forkSession("bs_NOPE")).toThrow(/not found/);
  });
});
