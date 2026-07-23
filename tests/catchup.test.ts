import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { buildTargetCatchUpContext } from "../src/context/mention.ts";
import type { HarnessTarget } from "../src/harness/target.ts";
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

function turn(target: HarnessTarget, i: number, agentText: string): void {
  const turnId = `t_${target.id}_${i}`;
  const coordinate = { harness: target.harness, harnessTargetId: target.id, turnId };
  h.append({
    source: { type: "baton" },
    kind: "user_message",
    ...coordinate,
    payload: { messageId: `${turnId}_u`, content: [{ type: "text", text: `q${i}` }] },
  });
  h.append({
    source: { type: "baton" },
    kind: "agent_message",
    ...coordinate,
    payload: { messageId: `${turnId}_a`, content: [{ type: "text", text: agentText }] },
  });
  h.append({
    source: { type: "baton" },
    kind: "state_update",
    ...coordinate,
    payload: { state: "idle", stopReason: "end_turn" },
  });
  h.summarizeTurn(turnId);
}

describe("buildTargetCatchUpContext", () => {
  test("fresh native session receives the complete BatonSession history", () => {
    turn({ id: "codex-a", harness: "codex" }, 1, "codex history");
    turn({ id: "example", harness: "example" }, 2, "other history");
    const result = buildTargetCatchUpContext(h, {
      target: { id: "codex-a", harness: "codex" },
      sinceSeq: 0,
      includeTargetTurns: true,
    });
    expect(result?.text).toContain("codex history");
    expect(result?.text).toContain("other history");
    expect(result?.throughSeq).toBe(h.readEvents().at(-1)?.seq);
  });

  test("resumed native session excludes only its own Target, not a sibling using the same Harness", () => {
    turn({ id: "codex-a", harness: "codex" }, 1, "already native");
    const watermark = h.readEvents().at(-1)!.seq;
    turn({ id: "codex-a", harness: "codex" }, 2, "also native");
    turn({ id: "codex-b", harness: "codex" }, 3, "sibling target context");
    turn({ id: "claude", harness: "claude-code" }, 4, "other harness context");
    const result = buildTargetCatchUpContext(h, {
      target: { id: "codex-a", harness: "codex" },
      sinceSeq: watermark,
      includeTargetTurns: false,
    });
    expect(result?.text).toContain("sibling target context");
    expect(result?.text).toContain("other harness context");
    expect(result?.text).not.toContain("already native");
    expect(result?.text).not.toContain("also native");
  });
});
