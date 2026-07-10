import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildSessionContext, expandMentions, parseMentions } from "../src/context/mention.ts";
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

function sessionWithTurns(turnTexts: Array<{ user: string; agent: string }>): SessionHandle {
  const h = store.createSession({ cwd: "/tmp", title: "demo" });
  turnTexts.forEach((t, i) => {
    const turnId = `t_${i}`;
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
