import { describe, expect, test } from "bun:test";

import { createBatonSnapshot } from "../src/plugin/baton-snapshot.ts";
import { emptySessionState } from "../src/store/reduce.ts";

describe("BatonSnapshot", () => {
  test("projects and freezes the current session state for Plugin reconcile", () => {
    const state = emptySessionState();
    state.runState = "running";
    state.lastSeq = 12;
    state.activeTurns.set("t_latest", {
      turnId: "t_latest",
      role: "driven",
      state: "running",
      harness: "codex",
      harnessTargetId: "codex",
      startedAt: 1_000,
    });
    state.turnSummaries.push({
      turnId: "t_previous",
      stopReason: "end_turn",
      userText: "previous",
      agentText: "done",
      toolCalls: [],
    });
    state.turnSummaries.push({
      turnId: "t_latest",
      stopReason: "error",
      userText: "latest",
      toolCalls: [{ toolCallId: "tc_1", status: "failed" }],
    });
    state.interactions.set("ix_1", {
      interaction: {
        interactionId: "ix_1",
        requester: { type: "harness", harnessTargetId: "codex" },
        kind: "question",
        questions: [],
      },
      turnId: "t_latest",
    });

    const snapshot = createBatonSnapshot({
      batonSessionId: "bs_test",
      cwd: "/tmp/project",
      state,
      inputs: [{
        messageId: "m_1",
        turnId: "t_queued",
        harnessTargetId: "claude",
        harness: "claude",
        status: "queued",
        delivery: "prompt",
      }],
      harnessTargets: [
        { id: "codex", harness: "codex", label: "Codex" },
        { id: "claude", harness: "claude", label: "Claude Code" },
      ],
    });

    expect(snapshot.session).toEqual({
      batonSessionId: "bs_test",
      cwd: "/tmp/project",
      runState: "running",
      revision: 12,
    });
    expect(snapshot.activeTurns).toEqual([{
      turnId: "t_latest",
      role: "driven",
      state: "running",
      harness: "codex",
      harnessTargetId: "codex",
      startedAt: 1_000,
    }]);
    expect(snapshot.inputs.map((input) => input.turnId)).toEqual(["t_queued"]);
    expect(snapshot.harnessTargets.map((target) => target.id)).toEqual([
      "codex",
      "claude",
    ]);
    expect(snapshot.pendingInteractions).toEqual([{
      interactionId: "ix_1",
      kind: "question",
      requester: { type: "harness", harnessTargetId: "codex" },
      turnId: "t_latest",
    }]);
    expect(snapshot.latestTurn?.turnId).toBe("t_latest");
    expect(Object.isFrozen(snapshot)).toBe(true);
    expect(Object.isFrozen(snapshot.latestTurn?.toolCalls)).toBe(true);
  });
});
