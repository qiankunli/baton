import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import { appendFileSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CRASH_RECOVERY_NOTICE_TITLE, openBatonSession } from "../src/session/open.ts";
import { SessionStore } from "../src/store/store.ts";

let root: string;
let store: SessionStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baton-open-"));
  store = new SessionStore(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("openBatonSession", () => {
  test("creates a new session by default", () => {
    const result = openBatonSession(store, { cwd: "/repo", title: "chat" });
    expect(result.resumed).toBe(false);
    expect(result.session.meta.cwd).toBe("/repo");
  });

  test("opens an explicit session and keeps its cwd", () => {
    const existing = store.createSession({ cwd: "/original" });
    const result = openBatonSession(store, { cwd: "/ignored", sessionId: existing.id });
    expect(result.resumed).toBe(true);
    expect(result.session.id).toBe(existing.id);
    expect(result.session.meta.cwd).toBe("/original");
  });

  test("continues the most recently active session in the cwd", () => {
    const older = store.createSession({ cwd: "/repo" });
    older.updateMeta({ updatedAt: "2026-01-01T00:00:00.000Z" });
    const newer = store.createSession({ cwd: "/repo" });
    newer.updateMeta({ updatedAt: "2026-01-02T00:00:00.000Z" });
    store.createSession({ cwd: "/other" }).updateMeta({ updatedAt: "2026-01-03T00:00:00.000Z" });

    const result = openBatonSession(store, { cwd: "/repo", continueLast: true });
    expect(result.resumed).toBe(true);
    expect(result.session.id).toBe(newer.id);
  });

  test("continue creates a session when the cwd has no history", () => {
    const result = openBatonSession(store, { cwd: "/empty", continueLast: true });
    expect(result.resumed).toBe(false);
    expect(result.session.meta.cwd).toBe("/empty");
  });

  test("rejects conflicting selectors", () => {
    expect(() =>
      openBatonSession(store, { cwd: "/repo", sessionId: "bs_x", continueLast: true }),
    ).toThrow(/cannot be used together/);
  });
});

describe("crash recovery on open", () => {
  test("normalizes an interrupted turn: idle + notice + summary", () => {
    const h = store.createSession({ cwd: "/repo" });
    h.append({ kind: "state_update", payload: { state: "running" }, provider: "codex", turnId: "t1" });
    h.append({
      kind: "user_message",
      payload: { messageId: "m1", content: [{ type: "text", text: "hi" }] },
      provider: "codex",
      turnId: "t1",
    });
    h.append({
      kind: "agent_message_chunk",
      payload: { messageId: "m2", content: { type: "text", text: "partial" } },
      provider: "codex",
      turnId: "t1",
    });

    const result = openBatonSession(store, { cwd: "/repo", sessionId: h.id });
    expect(result.recovered).toBe(true);
    const state = result.session.loadState();
    expect(state.runState).toBe("idle");
    expect(state.lastStopReason).toBe("cancelled");
    expect(state.notices.some((n) => n.title === CRASH_RECOVERY_NOTICE_TITLE)).toBe(true);
    // 中断 turn 补上 summary：catch-up / @ 引用只读 summary，缺失即永久盲区
    expect(state.turnSummaries.map((s) => s.turnId)).toEqual(["t1"]);
    expect(state.turnSummaries[0]!.stopReason).toBe("cancelled");
  });

  test("concurrent interrupted turns each get idle + notice + summary", () => {
    const h = store.createSession({ cwd: "/repo" });
    // driven turn 运行中 + 同 provider 的 observed turn 也在运行时崩溃
    h.append({ kind: "state_update", payload: { state: "running" }, provider: "codex", turnId: "t_driven" });
    h.append({
      kind: "agent_message_chunk",
      payload: { messageId: "m1", content: { type: "text", text: "partial" } },
      provider: "codex",
      turnId: "t_driven",
    });
    h.append({
      kind: "state_update",
      payload: { state: "running", origin: "provider" },
      provider: "claude-code",
      turnId: "t_obs",
    });
    h.append({
      kind: "agent_message",
      payload: { messageId: "m2", content: [{ type: "text", text: "bg partial" }] },
      provider: "claude-code",
      turnId: "t_obs",
    });

    const result = openBatonSession(store, { cwd: "/repo", sessionId: h.id });
    expect(result.recovered).toBe(true);
    const state = result.session.loadState();
    expect(state.activeTurns.size).toBe(0); // 每个 turn 各自收口，不是只收最后一个
    expect(state.runState).toBe("idle");
    expect(state.stopReasons.get("t_driven")).toBe("cancelled");
    expect(state.stopReasons.get("t_obs")).toBe("cancelled");
    expect(state.notices.filter((n) => n.title === CRASH_RECOVERY_NOTICE_TITLE)).toHaveLength(2);
    expect(state.turnSummaries.map((s) => s.turnId).sort()).toEqual(["t_driven", "t_obs"]);
    for (const summary of state.turnSummaries) expect(summary.stopReason).toBe("cancelled");
    // 恢复合成的终态恒带 turnId（per-turn reducer 的精确收口依赖它）
    const recoveryIdles = result.session
      .readEvents()
      .filter((ev) => ev.kind === "state_update" && (ev.payload as { state?: string }).state === "idle");
    for (const idle of recoveryIdles) expect(idle.turnId).toBeTruthy();
  });

  test("recovery is idempotent: second open changes nothing", () => {
    const h = store.createSession({ cwd: "/repo" });
    h.append({ kind: "state_update", payload: { state: "running" }, provider: "codex", turnId: "t1" });

    openBatonSession(store, { cwd: "/repo", sessionId: h.id });
    const count = store.openSession(h.id).readEvents().length;
    const second = openBatonSession(store, { cwd: "/repo", sessionId: h.id });
    expect(second.recovered).toBe(false);
    expect(second.session.readEvents()).toHaveLength(count);
  });

  test("completed turn missing its summary gets one, without an interruption notice", () => {
    const h = store.createSession({ cwd: "/repo" });
    h.append({ kind: "state_update", payload: { state: "running" }, provider: "codex", turnId: "t1" });
    h.append({
      kind: "agent_message_chunk",
      payload: { messageId: "m1", content: { type: "text", text: "done" } },
      provider: "codex",
      turnId: "t1",
    });
    h.append({ kind: "state_update", payload: { state: "idle", stopReason: "end_turn" }, provider: "codex", turnId: "t1" });

    const result = openBatonSession(store, { cwd: "/repo", sessionId: h.id });
    expect(result.recovered).toBe(true);
    const state = result.session.loadState();
    expect(state.notices).toHaveLength(0);
    expect(state.turnSummaries.map((s) => s.turnId)).toEqual(["t1"]);
    expect(state.turnSummaries[0]!.stopReason).toBe("end_turn");
  });

  test("dangling permission requests are cancelled", () => {
    const h = store.createSession({ cwd: "/repo" });
    h.append({ kind: "state_update", payload: { state: "running" }, provider: "codex", turnId: "t1" });
    h.append({
      kind: "permission_request",
      payload: {
        requestId: "pr1",
        title: "Run rm -rf?",
        options: [{ optionId: "yes", name: "Yes", kind: "allow_once" }],
      },
      provider: "codex",
      turnId: "t1",
    });

    const result = openBatonSession(store, { cwd: "/repo", sessionId: h.id });
    expect(result.recovered).toBe(true);
    expect(result.session.loadState().pendingPermissions.size).toBe(0);
  });

  test("dangling question requests are cancelled", () => {
    const h = store.createSession({ cwd: "/repo" });
    h.append({ kind: "state_update", payload: { state: "running" }, provider: "codex", turnId: "t1" });
    h.append({
      kind: "question_request",
      payload: {
        requestId: "qr1",
        questions: [{ questionId: "mode", header: "Mode", question: "Which mode?" }],
      },
      provider: "codex",
      turnId: "t1",
    });

    const result = openBatonSession(store, { cwd: "/repo", sessionId: h.id });
    expect(result.recovered).toBe(true);
    expect(result.session.loadState().pendingQuestions.size).toBe(0);
  });

  test("clean session is untouched", () => {
    const h = store.createSession({ cwd: "/repo" });
    h.append({ kind: "state_update", payload: { state: "running" }, provider: "codex", turnId: "t1" });
    h.append({ kind: "state_update", payload: { state: "idle", stopReason: "end_turn" }, provider: "codex", turnId: "t1" });
    h.summarizeTurn("t1");
    const count = h.readEvents().length;

    const result = openBatonSession(store, { cwd: "/repo", sessionId: h.id });
    expect(result.recovered).toBe(false);
    expect(result.session.readEvents()).toHaveLength(count);
  });
});

describe("session lock", () => {
  test("open fails while another live process holds the lock", () => {
    const h = store.createSession({ cwd: "/repo" });
    writeFileSync(join(h.dir, "lock"), "1"); // pid 1 一定存活（launchd/init），且 kill 探测返回 EPERM
    expect(() => openBatonSession(store, { cwd: "/repo", sessionId: h.id })).toThrow(/in use/);
  });

  test("stale lock from a dead process is taken over", () => {
    const h = store.createSession({ cwd: "/repo" });
    const dead = spawnSync("true").pid; // 已退出进程的 pid
    writeFileSync(join(h.dir, "lock"), String(dead));
    const result = openBatonSession(store, { cwd: "/repo", sessionId: h.id });
    expect(result.session.id).toBe(h.id);
    expect(readFileSync(join(h.dir, "lock"), "utf8")).toBe(String(process.pid));
  });

  test("re-entrant within the same process", () => {
    const h = store.createSession({ cwd: "/repo" });
    openBatonSession(store, { cwd: "/repo", sessionId: h.id });
    expect(() => openBatonSession(store, { cwd: "/repo", sessionId: h.id })).not.toThrow();
  });

  test("releaseLock only removes our own lock", () => {
    const h = store.createSession({ cwd: "/repo" });
    writeFileSync(join(h.dir, "lock"), "1");
    h.releaseLock();
    expect(readFileSync(join(h.dir, "lock"), "utf8")).toBe("1");
  });
});

describe("lock hardening (codex review)", () => {
  test("corrupt lock content is treated as stale and taken over", () => {
    const h = store.createSession({ cwd: "/repo" });
    writeFileSync(join(h.dir, "lock"), "not-a-pid");
    const result = openBatonSession(store, { cwd: "/repo", sessionId: h.id });
    expect(result.session.id).toBe(h.id);
    expect(readFileSync(join(h.dir, "lock"), "utf8")).toBe(String(process.pid));
  });

  test("recovery failure releases the lock before rethrowing", () => {
    const h = store.createSession({ cwd: "/repo" });
    h.append({ kind: "state_update", payload: { state: "running" }, provider: "codex", turnId: "t1" });
    // 中间行损坏：recovery 的 readEvents 会抛错
    appendFileSync(join(h.dir, "session.jsonl"), "garbage\n");
    h.append({ kind: "state_update", payload: { state: "running" }, provider: "codex", turnId: "t1" });

    expect(() => openBatonSession(store, { cwd: "/repo", sessionId: h.id })).toThrow(/corrupt/);
    // 锁必须已释放：否则本进程存活期间该会话被永久判"在用"
    expect(existsSync(join(h.dir, "lock"))).toBe(false);
  });
});
