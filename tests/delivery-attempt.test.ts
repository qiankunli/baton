import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AdapterCapabilities,
  EventSink,
  HarnessAdapter,
  HarnessSessionRef,
  OpenOptions,
  PromptInput,
  PromptReceipt,
} from "../src/harness/adapter.ts";
import {
  reduceDeliveryAttempts,
  type HarnessDeliveryAttemptUpdate,
} from "../src/controller/attempt.ts";
import { Controller } from "../src/controller/index.ts";
import { createHarnessLaunchSnapshot } from "../src/harness/target.ts";
import { openBatonSession } from "../src/session/open.ts";
import { SessionStore, type SessionHandle } from "../src/store/store.ts";
import { resolveTestTarget } from "./harness-target.ts";

class DeliveryAdapter implements HarnessAdapter {
  readonly harness = "codex";
  readonly capabilities: AdapterCapabilities = { prompt: {} };
  sink?: EventSink;
  submission?: PromptInput;

  constructor(private readonly mode: "complete" | "reject" | "hold") {}

  async open(_opts: OpenOptions, sink: EventSink): Promise<HarnessSessionRef> {
    this.sink = sink;
    return { harness: this.harness, harnessSessionId: "hs-native", resumed: false };
  }

  async submit(
    _ref: HarnessSessionRef,
    input: PromptInput,
  ): Promise<PromptReceipt> {
    this.submission = input;
    if (this.mode === "reject") throw new Error("admission rejected");
    // 刻意同步上报终态，覆盖 idle 早于 submit Promise continuation 的竞态。
    if (this.mode === "complete") this.finish(input.turnId, "end_turn");
    return { accepted: true };
  }

  finish(turnId: string, stopReason: string): void {
    this.sink?.({
      kind: "state_update",
      turnId,
      payload: { state: "idle", stopReason },
    });
  }

  async cancel(_ref: HarnessSessionRef): Promise<void> {}
  async close(_ref: HarnessSessionRef): Promise<void> {}
}

let root: string;
let store: SessionStore;
let session: SessionHandle;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baton-delivery-attempt-"));
  store = new SessionStore(root);
  session = store.createSession({ cwd: "/repo" });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function controllerWith(
  adapter: HarnessAdapter,
  cancelGraceMs = 10_000,
  handle: SessionHandle = session,
): Controller {
  return new Controller({
    session: handle,
    mentionBudgetChars: 4096,
    resolveTarget: resolveTestTarget,
    createAdapter: () => adapter,
    cancelGraceMs,
  });
}

function updates(handle: SessionHandle): HarnessDeliveryAttemptUpdate[] {
  return handle
    .readEvents()
    .filter((event) => event.kind === "_baton_delivery_attempt_update")
    .map((event) => event.payload as HarnessDeliveryAttemptUpdate);
}

async function until(predicate: () => boolean, timeoutMs = 500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("condition not reached");
    await Bun.sleep(1);
  }
}

describe("Harness Delivery Attempt", () => {
  test("persists prepared → dispatching → accepted → finalized around a successful turn", async () => {
    const adapter = new DeliveryAdapter("complete");
    await controllerWith(adapter).submit("codex", [{ type: "text", text: "ship it" }]);

    const events = session.readEvents();
    const attemptUpdates = updates(session);
    expect(attemptUpdates.map((update) => update.phase)).toEqual([
      "prepared",
      "dispatching",
      "accepted",
      "finalized",
    ]);
    const prepared = attemptUpdates[0] as Extract<
      HarnessDeliveryAttemptUpdate,
      { phase: "prepared" }
    >;
    const finalized = attemptUpdates[3] as Extract<
      HarnessDeliveryAttemptUpdate,
      { phase: "finalized" }
    >;
    const inputEvent = events.find((event) => event.kind === "user_message")!;
    expect(prepared.attemptId).toMatch(/^att_/);
    expect(prepared.inputId).toBe(inputEvent.payload.messageId);
    expect(prepared.launchSnapshot.harnessTargetId).toBe("codex");
    expect(finalized.outcome).toBe("completed");

    const preparedEvent = events.find(
      (event) =>
        event.kind === "_baton_delivery_attempt_update" &&
        (event.payload as HarnessDeliveryAttemptUpdate).phase === "prepared",
    )!;
    expect(preparedEvent.parentEventId).toBe(inputEvent.eventId);
    const state = reduceDeliveryAttempts(events).get(prepared.attemptId)!;
    expect(state.phase).toBe("finalized");
    expect(state.accepted).toBe(true);
    expect(state.outcome).toBe("completed");
  });

  test("a submit rejection finalizes as not_accepted without inventing an accepted receipt", async () => {
    const adapter = new DeliveryAdapter("reject");
    await expect(
      controllerWith(adapter).submit("codex", [{ type: "text", text: "invalid" }]),
    ).rejects.toThrow("admission rejected");

    const attemptUpdates = updates(session);
    expect(attemptUpdates.map((update) => update.phase)).toEqual([
      "prepared",
      "dispatching",
      "finalized",
    ]);
    expect(
      (attemptUpdates.at(-1) as Extract<
        HarnessDeliveryAttemptUpdate,
        { phase: "finalized" }
      >).outcome,
    ).toBe("not_accepted");
    expect(
      session
        .readEvents()
        .find(
          (event) =>
            event.kind === "state_update" &&
            (event.payload as { state: string }).state === "idle",
        )?.source,
    ).toEqual({ type: "baton" });
  });

  test("a Baton-synthesized terminal makes an accepted Attempt uncertain; a late Harness receipt closes it", async () => {
    const adapter = new DeliveryAdapter("hold");
    const controller = controllerWith(adapter, 5);
    const outcome = controller.submit("codex", [{ type: "text", text: "long work" }]);
    await until(() => updates(session).some((update) => update.phase === "accepted"));

    await controller.control({ kind: "interrupt" });
    await outcome;
    let state = reduceDeliveryAttempts(session.readEvents()).values().next().value!;
    expect(state.phase).toBe("uncertain");
    expect(state.accepted).toBe(true);

    adapter.finish(adapter.submission!.turnId, "cancelled");
    state = reduceDeliveryAttempts(session.readEvents()).get(state.attemptId)!;
    expect(state.phase).toBe("finalized");
    expect(state.outcome).toBe("cancelled");
    expect(updates(session).map((update) => update.phase)).toEqual([
      "prepared",
      "dispatching",
      "accepted",
      "uncertain",
      "finalized",
    ]);
  });

  test("open recovery distinguishes never-dispatched, uncertain, and receipted work", () => {
    const launchSnapshot = createHarnessLaunchSnapshot({
      target: { id: "codex", harness: "codex" },
      harnessSessionKey: "codex",
      cwd: "/repo",
    });
    const appendTurn = (turnId: string, attemptId: string, dispatching: boolean) => {
      const intent = session.append({
        kind: "user_message",
        source: { type: "user" },
        harness: "codex",
        harnessTargetId: "codex",
        turnId,
        payload: {
          messageId: `m_${turnId}`,
          content: [{ type: "text", text: turnId }],
        },
      });
      session.append({
        kind: "state_update",
        source: { type: "baton" },
        harness: "codex",
        harnessTargetId: "codex",
        turnId,
        payload: { state: "running" },
      });
      const prepared = session.append({
        kind: "_baton_delivery_attempt_update",
        source: { type: "baton" },
        parentEventId: intent.eventId,
        harness: "codex",
        harnessTargetId: "codex",
        turnId,
        payload: {
          attemptId,
          phase: "prepared",
          inputId: `m_${turnId}`,
          launchSnapshot,
        },
      });
      if (dispatching) {
        session.append({
          kind: "_baton_delivery_attempt_update",
          source: { type: "baton" },
          parentEventId: prepared.eventId,
          harness: "codex",
          harnessTargetId: "codex",
          turnId,
          payload: { attemptId, phase: "dispatching" },
        });
      }
    };
    appendTurn("t_prepared", "att_prepared", false);
    appendTurn("t_dispatching", "att_dispatching", true);
    appendTurn("t_receipted", "att_receipted", true);
    const terminal = session.append({
      kind: "state_update",
      source: { type: "harness", harnessTargetId: "codex" },
      harness: "codex",
      harnessTargetId: "codex",
      harnessSessionId: "native-receipted",
      turnId: "t_receipted",
      payload: { state: "idle", stopReason: "end_turn" },
    });
    // 模拟 terminal 已证明 admission、accepted 已落盘，但 finalized 尚未落盘时崩溃。
    session.append({
      kind: "_baton_delivery_attempt_update",
      source: { type: "baton" },
      parentEventId: terminal.eventId,
      harness: "codex",
      harnessTargetId: "codex",
      harnessSessionId: "native-receipted",
      turnId: "t_receipted",
      payload: { attemptId: "att_receipted", phase: "accepted" },
    });

    const opened = openBatonSession(store, { cwd: "/repo", sessionId: session.id });
    expect(opened.recovered).toBe(true);
    const attempts = reduceDeliveryAttempts(opened.session.readEvents());
    expect(attempts.get("att_prepared")?.phase).toBe("finalized");
    expect(attempts.get("att_prepared")?.outcome).toBe("not_accepted");
    expect(attempts.get("att_dispatching")?.phase).toBe("uncertain");
    expect(attempts.get("att_receipted")?.phase).toBe("finalized");
    expect(attempts.get("att_receipted")?.accepted).toBe(true);
    expect(attempts.get("att_receipted")?.outcome).toBe("completed");
    expect(attempts.get("att_receipted")?.harnessSessionId).toBe("native-receipted");
    expect(opened.session.loadState().activeTurns.size).toBe(0);
    opened.session.releaseLock();
  });

  test("a Controller created after recovery rehydrates an uncertain Attempt for a late Harness receipt", async () => {
    const launchSnapshot = createHarnessLaunchSnapshot({
      target: { id: "codex", harness: "codex" },
      harnessSessionKey: "codex",
      cwd: "/repo",
    });
    const input = session.append({
      kind: "user_message",
      source: { type: "user" },
      harness: "codex",
      harnessTargetId: "codex",
      turnId: "t_old",
      payload: {
        messageId: "m_old",
        content: [{ type: "text", text: "old work" }],
      },
    });
    session.append({
      kind: "state_update",
      source: { type: "baton" },
      harness: "codex",
      harnessTargetId: "codex",
      turnId: "t_old",
      payload: { state: "running" },
    });
    const prepared = session.append({
      kind: "_baton_delivery_attempt_update",
      source: { type: "baton" },
      parentEventId: input.eventId,
      harness: "codex",
      harnessTargetId: "codex",
      turnId: "t_old",
      payload: {
        attemptId: "att_old",
        phase: "prepared",
        inputId: "m_old",
        launchSnapshot,
      },
    });
    session.append({
      kind: "_baton_delivery_attempt_update",
      source: { type: "baton" },
      parentEventId: prepared.eventId,
      harness: "codex",
      harnessTargetId: "codex",
      turnId: "t_old",
      payload: { attemptId: "att_old", phase: "dispatching" },
    });
    session.append({
      kind: "_baton_delivery_attempt_update",
      source: { type: "baton" },
      harness: "codex",
      harnessTargetId: "codex",
      turnId: "t_old",
      payload: { attemptId: "att_old", phase: "accepted" },
    });

    const opened = openBatonSession(store, { cwd: "/repo", sessionId: session.id });
    expect(
      reduceDeliveryAttempts(opened.session.readEvents()).get("att_old")?.phase,
    ).toBe("uncertain");

    const adapter = new DeliveryAdapter("hold");
    const controller = controllerWith(adapter, 10_000, opened.session);
    const current = controller.submit("codex", [
      { type: "text", text: "current work" },
    ]);
    await until(() => adapter.submission !== undefined);
    const currentTurnId = adapter.submission!.turnId;

    adapter.finish("t_old", "end_turn");
    expect(
      reduceDeliveryAttempts(opened.session.readEvents()).get("att_old")?.phase,
    ).toBe("finalized");

    adapter.finish(currentTurnId, "end_turn");
    await current;
    await controller.close();
    opened.session.releaseLock();
  });
});
