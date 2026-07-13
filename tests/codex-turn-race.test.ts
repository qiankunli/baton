// 与 claude-turn-race.test.ts 同族：codex 的 turn/start 响应在老版本 app-server 上会
// 阻塞到 turn 结束才回，其携带的终态/错误可能落在下一 turn 已 admission 之后。
// 终态必须绑定所属 turn——不能误杀新 turn，也不能盖上共享 rt.turnId（已是新 turn 的 id）。
import { expect, test } from "bun:test";

import { CodexAdapter } from "../src/adapters/codex/adapter.ts";
import { JsonRpcPeer } from "../src/adapters/codex/jsonrpc.ts";
import type { PromptInput, ProviderSessionRef } from "../src/adapters/types.ts";
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

// ---- 协议级用例：不走内部 seam，消息从真实 JsonRpcPeer 的 wire 进入 ----
// 出站请求（含 id）被捕获，入站响应/通知由测试按任意顺序 feed，
// 精确复现"响应与通知无顺序保证"的乱序排列。

interface WireEvent {
  kind: string;
  turnId?: string;
  payload: unknown;
}

function wireHarness() {
  const adapter = new CodexAdapter({ approvalHandler });
  const events: WireEvent[] = [];
  const outbound: Array<{ id: number | string; method: string }> = [];
  const peer = new JsonRpcPeer((line) => {
    const msg = JSON.parse(line) as { id?: number | string; method?: string };
    if (msg.id !== undefined && msg.method !== undefined) outbound.push({ id: msg.id, method: msg.method });
  });
  const rt = {
    peer,
    threadId: "th1",
    turnId: undefined as string | undefined,
    activeTurn: undefined as TurnState | undefined,
    codexTurnId: undefined as string | undefined,
    sink: (ev: AnyNewEvent) => events.push(ev as never),
  };
  // open() 会 spawn 真子进程；这里手工重建它对 peer 的通知接线 + threads 注入
  // （threads 注入 seam 同 codex-steer.test.ts）
  peer.onNotification((method, params) =>
    (adapter as unknown as { handleNotification(rt: unknown, method: string, params: unknown): void })
      .handleNotification(rt, method, params),
  );
  (adapter as unknown as { threads: Map<string, unknown> }).threads.set("th1", rt);
  const ref: ProviderSessionRef = { provider: "codex", providerSessionId: "th1" };
  const respond = (id: number | string, result: unknown) =>
    peer.feed(`${JSON.stringify({ jsonrpc: "2.0", id, result })}\n`);
  const notifyIn = (method: string, params: unknown) =>
    peer.feed(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  // 响应 promise 的 .then 链是微任务：feed 响应后必须结清再断言
  const settle = () => new Promise<void>((resolve) => setTimeout(resolve, 0));
  const idlesOf = () =>
    events.filter((ev) => ev.kind === "state_update" && (ev.payload as { state?: string }).state === "idle");
  return { adapter, events, outbound, rt, ref, respond, notifyIn, settle, idlesOf };
}

test("codex wire: turn/completed notification before the blocking turn/start response", async () => {
  const h = wireHarness();
  const prompt = (turnId: string, text: string): PromptInput => ({
    turnId,
    messageId: `m_${turnId}`,
    blocks: [{ type: "text", text }],
  });

  // turn A admission：turn/start 请求上线；老版本 app-server 的响应阻塞在途
  await h.adapter.submit(h.ref, prompt("t_A", "question A"));
  const reqA = h.outbound.find((m) => m.method === "turn/start");
  expect(reqA).toBeDefined();

  // 通知流先到：started → 最终答复 → completed，全部早于 RPC 响应
  h.notifyIn("turn/started", { threadId: "th1", turn: { id: "codex-A" } });
  h.notifyIn("item/completed", {
    threadId: "th1",
    item: { type: "agentMessage", id: "item-A", text: "final answer A" },
  });
  h.notifyIn("turn/completed", { threadId: "th1", turn: { status: "completed" } });

  // 终态由通知先行合成：最终输出不丢、绑定 t_A，恰好一次 idle
  const messages = h.events.filter((ev) => ev.kind === "agent_message");
  expect(messages).toHaveLength(1);
  expect(messages[0]?.turnId).toBe("t_A");
  expect((messages[0]?.payload as { content: Array<{ text: string }> }).content[0]?.text).toBe("final answer A");
  expect(h.idlesOf()).toHaveLength(1);
  expect(h.idlesOf()[0]?.turnId).toBe("t_A");

  // 下一 turn 已 admission，其 fast-submit 响应正常先回
  await h.adapter.submit(h.ref, prompt("t_B", "question B"));
  const reqB = h.outbound.filter((m) => m.method === "turn/start")[1];
  expect(reqB).toBeDefined();
  h.respond(reqB?.id ?? -1, { turn: { id: "codex-B", status: "inProgress" } });
  await h.settle();
  expect(h.rt.codexTurnId).toBe("codex-B");

  // turn A 的阻塞响应此刻才回，携带 A 的 codex id 与重复终态
  h.respond(reqA?.id ?? -1, { turn: { id: "codex-A", status: "completed" } });
  await h.settle();

  // 迟到响应不得覆盖 B 的 codex turn id（steer/cancel 靠它定向），不得误杀/重复终结
  expect(h.rt.codexTurnId).toBe("codex-B");
  expect(h.rt.activeTurn?.turnId).toBe("t_B");
  expect(h.rt.activeTurn?.finalized).toBe(false);
  expect(h.idlesOf()).toHaveLength(1);

  // B 正常终结：终态各归其位
  h.notifyIn("turn/completed", { threadId: "th1", turn: { status: "completed" } });
  const idles = h.idlesOf();
  expect(idles).toHaveLength(2);
  expect(idles[1]?.turnId).toBe("t_B");
});
