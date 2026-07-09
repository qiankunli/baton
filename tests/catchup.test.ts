import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildCatchUpContext } from "../src/context/mention.ts";
import { SessionStore, type SessionHandle } from "../src/store/store.ts";

let root: string;
let store: SessionStore;
let h: SessionHandle;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baton-catchup-"));
  store = new SessionStore(root);
  h = store.createSession({ cwd: "/tmp" });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function turn(provider: string, i: number, agentText: string): void {
  const turnId = `t_${provider}_${i}`;
  h.append({ kind: "user_message", provider, turnId, payload: { messageId: `${turnId}_u`, content: [{ type: "text", text: `q${i}` }] } });
  h.append({ kind: "agent_message", provider, turnId, payload: { messageId: `${turnId}_a`, content: [{ type: "text", text: agentText }] } });
  h.append({ kind: "state_update", provider, turnId, payload: { state: "idle", stopReason: "end_turn" } });
  h.summarizeTurn(turnId);
}

describe("buildCatchUpContext", () => {
  test("null when no turns from other providers", () => {
    turn("codex", 1, "codex did a thing");
    expect(buildCatchUpContext(h, "codex")).toBeNull();
  });

  test("includes other providers' turns for a newcomer", () => {
    turn("codex", 1, "codex 决定用 pnpm");
    const ctx = buildCatchUpContext(h, "claude-code");
    expect(ctx).toContain("codex");
    expect(ctx).toContain("pnpm");
  });

  test("only turns after my last participation", () => {
    turn("codex", 1, "旧进展");
    turn("claude-code", 1, "claude 参与过了");
    turn("codex", 2, "新进展");
    const ctx = buildCatchUpContext(h, "claude-code");
    expect(ctx).toContain("新进展");
    expect(ctx).not.toContain("旧进展");
  });

  test("null when I am fully caught up", () => {
    turn("codex", 1, "x");
    turn("claude-code", 1, "y");
    expect(buildCatchUpContext(h, "claude-code")).toBeNull();
  });
});
