// steer 排队场景回归（真实事故：bs_01KX8D9PZM… seq 3553-3613）：
// 上一 turn 的 SDK 消息流在 result 消息之后才真正 close（观测约 1s），其"流耗尽兜底"
// finishTurn 可能落在下一 turn 已 admission 之后。终态必须绑定各自的 turn——
// 既不能把新 turn 误终结成空回答，也不能把迟到终态盖上新 turn 的 id。
import type { InteractionHandler } from "../src/harness/adapter.ts";
import { expect, test } from "bun:test";

import { ClaudeAdapter } from "../src/harness/claude/adapter.ts";
import type { AnyEventDraft } from "../src/event/types.ts";

const interactionHandler: InteractionHandler = async (req) =>
  req.kind === "permission"
    ? { kind: "permission", outcome: "selected", optionId: "deny" }
    : { kind: "question", outcome: "answered", answers: {} };

interface TurnState {
  turnId: string;
  finalized: boolean;
  cancelRequested: boolean;
}

test("late stream-drain finalize from the previous turn must not close the next turn", async () => {
  const adapter = new ClaudeAdapter({ interactionHandler });
  const events: Array<{ kind: string; turnId?: string; payload: unknown }> = [];
  const ref = await adapter.open({ cwd: "/tmp" }, (ev) => events.push(ev as never));
  const seams = adapter as unknown as {
    sessions: Map<string, { activeTurn?: TurnState }>;
    emit(rt: unknown, ev: AnyEventDraft, turn?: TurnState): void;
    finishTurn(rt: unknown, emit: (ev: AnyEventDraft) => void, turn: TurnState, stopReason: string): void;
  };
  const rt = seams.sessions.get(ref.harnessSessionId);
  if (!rt) throw new Error("runtime not registered by open()");

  // turn A：admission 后被 result 消息正常终结
  const turnA: TurnState = { turnId: "t_A", finalized: false, cancelRequested: false };
  rt.activeTurn = turnA;
  const emitA = (ev: AnyEventDraft) => seams.emit(rt, ev, turnA);
  seams.finishTurn(rt, emitA, turnA, "end_turn");

  // steer：controller 在毫秒级内提交下一 turn（模拟 submit 的 admission 段）
  const turnB: TurnState = { turnId: "t_B", finalized: false, cancelRequested: false };
  rt.activeTurn = turnB;

  // turn A 的消息流此刻才真正耗尽：runQuery A 的流耗尽兜底迟到触发
  seams.finishTurn(rt, emitA, turnA, "end_turn");

  // B 不能被上一 turn 的兜底误终结
  expect(turnB.finalized).toBe(false);
  expect(rt.activeTurn).toBe(turnB);
  // 终态恰好一次，且只属于 A
  const idles = events.filter(
    (ev) => ev.kind === "state_update" && (ev.payload as { state?: string }).state === "idle",
  );
  expect(idles).toHaveLength(1);
  expect(idles[0]?.turnId).toBe("t_A");
});
