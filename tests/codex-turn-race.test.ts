// 与 claude-turn-race.test.ts 同族：codex 的 turn/start 响应在老版本 app-server 上会
// 阻塞到 turn 结束才回，其携带的终态/错误可能落在下一 turn 已 admission 之后。
// 终态必须绑定所属 turn——不能误杀新 turn，也不能盖上共享 rt.turnId（已是新 turn 的 id）。
import { expect, test } from "bun:test";

import { CodexAdapter } from "../src/adapters/codex/adapter.ts";
import type { AnyNewEvent } from "../src/events/types.ts";

const approvalHandler = async () => ({ optionId: "decline" });

interface TurnState {
  turnId: string;
  finalized: boolean;
}

interface Seams {
  finishTurn(rt: unknown, turn: TurnState | undefined, turnStatus: string): void;
  failTurn(rt: unknown, turn: TurnState | undefined, message: string): void;
}

function harness() {
  const adapter = new CodexAdapter({ approvalHandler });
  const events: Array<{ kind: string; turnId?: string; payload: unknown }> = [];
  const rt = {
    threadId: "th1",
    turnId: undefined as string | undefined,
    activeTurn: undefined as TurnState | undefined,
    codexTurnId: undefined as string | undefined,
    sink: (ev: AnyNewEvent) => events.push(ev as never),
  };
  return { seams: adapter as unknown as Seams, events, rt };
}

test("codex: late turn/start terminal status must not close the next turn", () => {
  const { seams, events, rt } = harness();

  // turn A 被 turn/completed 通知正常终结
  const turnA: TurnState = { turnId: "t_A", finalized: false };
  rt.turnId = "t_A";
  rt.activeTurn = turnA;
  seams.finishTurn(rt, turnA, "completed");

  // steer：下一 turn 立即 admission
  const turnB: TurnState = { turnId: "t_B", finalized: false };
  rt.turnId = "t_B";
  rt.activeTurn = turnB;

  // turn A 的 turn/start 响应此刻才回（老版本阻塞语义），携带重复终态
  seams.finishTurn(rt, turnA, "completed");

  expect(turnB.finalized).toBe(false);
  expect(rt.activeTurn).toBe(turnB);
  const idles = events.filter(
    (ev) => ev.kind === "state_update" && (ev.payload as { state?: string }).state === "idle",
  );
  expect(idles).toHaveLength(1);
  expect(idles[0]?.turnId).toBe("t_A");
});

test("codex: late turn/start transport error must not fail the next turn", () => {
  const { seams, events, rt } = harness();

  const turnA: TurnState = { turnId: "t_A", finalized: false };
  rt.turnId = "t_A";
  rt.activeTurn = turnA;
  seams.finishTurn(rt, turnA, "completed");

  const turnB: TurnState = { turnId: "t_B", finalized: false };
  rt.turnId = "t_B";
  rt.activeTurn = turnB;

  // turn A 的请求以 transport 错误收场（peer closed 等），迟到触发
  seams.failTurn(rt, turnA, "request failed: peer closed");

  expect(turnB.finalized).toBe(false);
  expect(rt.activeTurn).toBe(turnB);
  // A 已终结：不再补发 error/idle，B 的时间线不受污染
  expect(events.filter((ev) => ev.kind === "_baton_error_update")).toHaveLength(0);
  expect(
    events.filter((ev) => ev.kind === "state_update" && (ev.payload as { state?: string }).state === "idle"),
  ).toHaveLength(1);
});
