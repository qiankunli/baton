import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  buildSessionContext,
  expandMentions,
  parseMentions,
  sharedHistoryWatermark,
} from "../src/context/mention.ts";
import { SessionStore, type SessionHandle } from "../src/store/store.ts";

let root: string;
let store: SessionStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baton-mention-"));
  store = new SessionStore(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function sessionWithTurns(
  turnTexts: Array<{ user: string; agent: string }>,
  handle?: SessionHandle,
): SessionHandle {
  const h = handle ?? store.createSession({ cwd: "/tmp", title: "demo" });
  turnTexts.forEach((t, i) => {
    const turnId = `t_${h.id}_${i}`;
    h.append({ kind: "user_message", provider: "codex", turnId, payload: { messageId: `${turnId}_u`, content: [{ type: "text", text: t.user }] } });
    h.append({ kind: "agent_message", provider: "codex", turnId, payload: { messageId: `${turnId}_a`, content: [{ type: "text", text: t.agent }] } });
    h.append({ kind: "state_update", provider: "codex", turnId, payload: { state: "idle", stopReason: "end_turn" } });
    h.summarizeTurn(turnId);
  });
  return h;
}

describe("parseMentions", () => {
  test("extracts and dedupes session mentions", () => {
    const h = sessionWithTurns([]);
    const text = `请参考 @${h.id} 和 @${h.id} 的结论`;
    expect(parseMentions(text)).toEqual([{ batonSessionId: h.id }]);
  });

  test("ignores non-session tokens", () => {
    expect(parseMentions("email me @foo and @bs_short")).toEqual([]);
  });
});

describe("buildSessionContext", () => {
  test("contains title, turns in order, tools", () => {
    const h = sessionWithTurns([
      { user: "问题A", agent: "答案A" },
      { user: "问题B", agent: "答案B" },
    ]);
    const ctx = buildSessionContext(store, h.id);
    expect(ctx).toContain("demo");
    expect(ctx.indexOf("答案A")).toBeLessThan(ctx.indexOf("答案B"));
  });

  test("budget keeps newest turns, notes dropped count", () => {
    const h = sessionWithTurns(
      Array.from({ length: 10 }, (_, i) => ({ user: `q${i} ${"x".repeat(200)}`, agent: `a${i}` })),
    );
    const ctx = buildSessionContext(store, h.id, 600);
    expect(ctx).toContain("a9"); // 最新的在
    expect(ctx).not.toContain("q0 "); // 最旧的被丢
    expect(ctx).toMatch(/\d+ earlier turns omitted for length/);
  });

  test("empty session yields placeholder", () => {
    const h = sessionWithTurns([]);
    expect(buildSessionContext(store, h.id)).toContain("no completed turns in this session yet");
  });
});

describe("expandMentions", () => {
  test("no mentions passes text through", () => {
    const { prompt, mentions } = expandMentions(store, "普通输入");
    expect(prompt).toBe("普通输入");
    expect(mentions).toEqual([]);
  });

  test("wraps context block and keeps original text", () => {
    const h = sessionWithTurns([{ user: "部署到哪", agent: "用 helm 部署到 dev" }]);
    const input = `按 @${h.id} 的结论写脚本`;
    const { prompt, mentions } = expandMentions(store, input);
    expect(mentions).toHaveLength(1);
    expect(prompt).toContain("<baton-context>");
    expect(prompt).toContain("用 helm 部署到 dev");
    expect(prompt.trimEnd().endsWith(input)).toBe(true);
  });
});

describe("sharedHistoryWatermark", () => {
  test("unrelated sessions have no watermark", () => {
    const a = sessionWithTurns([{ user: "qa", agent: "aa" }]);
    const b = sessionWithTurns([{ user: "qb", agent: "ab" }]);
    expect(sharedHistoryWatermark(store, a.id, b.id)).toBeNull();
  });

  test("parent/child watermark is the fork boundary, both directions", () => {
    const parent = sessionWithTurns([{ user: "q0", agent: "a0" }]);
    const child = store.forkSession(parent.id);
    const boundary = child.meta.forkedFrom!.throughSeq;
    expect(sharedHistoryWatermark(store, parent.id, child.id)).toBe(boundary);
    expect(sharedHistoryWatermark(store, child.id, parent.id)).toBe(boundary);
  });

  test("siblings share via common ancestor with the smaller cut", () => {
    const root = sessionWithTurns([{ user: "q0", agent: "a0" }]);
    const early = store.forkSession(root.id); // 先 fork：水位小
    sessionWithTurns([{ user: "q1", agent: "a1" }], root); // root 继续长
    const late = store.forkSession(root.id); // 后 fork：水位大
    const expected = Math.min(early.meta.forkedFrom!.throughSeq, late.meta.forkedFrom!.throughSeq);
    expect(sharedHistoryWatermark(store, early.id, late.id)).toBe(expected);
  });
});

describe("related-session injection", () => {
  test("related mention injects only turns beyond shared history, uncapped", () => {
    const parent = sessionWithTurns([{ user: "旧问题", agent: "旧答案" }]);
    const child = store.forkSession(parent.id);
    sessionWithTurns([{ user: `新问题 ${"x".repeat(300)}`, agent: "新答案" }], child);
    // 预算给到极小：同树注入不受预算截断
    const ctx = buildSessionContext(store, child.id, 100, { fromSessionId: parent.id });
    expect(ctx).toContain("shares history with this session");
    expect(ctx).toContain("新答案");
    expect(ctx).not.toContain("旧答案"); // 共享前缀不重复注入
    expect(ctx).toContain("1 turns of shared history omitted");
  });

  test("related mention with no new turns says so", () => {
    const parent = sessionWithTurns([{ user: "q", agent: "a" }]);
    const child = store.forkSession(parent.id);
    const ctx = buildSessionContext(store, child.id, undefined, { fromSessionId: parent.id });
    expect(ctx).toContain("no new turns beyond the shared history");
  });

  test("unrelated mention still gets budgeted summary", () => {
    const current = sessionWithTurns([{ user: "qa", agent: "aa" }]);
    const other = sessionWithTurns(
      Array.from({ length: 10 }, (_, i) => ({ user: `q${i} ${"x".repeat(200)}`, agent: `a${i}` })),
    );
    const ctx = buildSessionContext(store, other.id, 600, { fromSessionId: current.id });
    expect(ctx).toContain("# Session summary:");
    expect(ctx).toMatch(/\d+ earlier turns omitted for length/);
  });

  test("expandMentions with currentSessionId picks projection per relation", () => {
    const parent = sessionWithTurns([{ user: "q0", agent: "a0" }]);
    const child = store.forkSession(parent.id);
    sessionWithTurns([{ user: "fork 里的新进展", agent: "fork 结论" }], child);
    const stranger = sessionWithTurns([{ user: "无关问题", agent: "无关答案" }]);
    const input = `综合 @${child.id} 和 @${stranger.id}`;
    const { prompt } = expandMentions(store, input, undefined, parent.id);
    expect(prompt).toContain("shares history with this session");
    expect(prompt).toContain("fork 结论");
    expect(prompt).toContain("# Session summary:");
    expect(prompt).toContain("无关答案");
  });
});
