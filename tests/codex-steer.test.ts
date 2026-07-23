// codex steer 的 wire 映射（design §4.3）：baton expectedTurnId → codex turn id、
// 成功发 delivery:"steer" 的 user_message 并绑定原 turn、stale/finalized/wire 失败
// 一律 rejected 且不发事件（降级由 runtime 决定）。
import type { RequestHandler } from "../src/adapters/types.ts";
import { expect, test } from "bun:test";

import { CodexAdapter } from "../src/adapters/codex/adapter.ts";
import type { PromptInput, HarnessSessionRef } from "../src/adapters/types.ts";
import type { AnyNewEvent } from "../src/events/types.ts";

const requestHandler: RequestHandler = async (req) =>
  req.kind === "permission"
    ? { kind: "permission", requestId: req.requestId, optionId: "decline" }
    : { kind: "question", requestId: req.requestId, answers: {} };

interface FakeRt {
  threadId: string;
  turnId?: string;
  activeTurn?: { turnId: string; finalized: boolean };
  codexTurnId?: string;
  peer: { request: (method: string, params?: unknown) => Promise<unknown> };
  sink: (ev: AnyNewEvent) => void;
}

function harness(opts: { requestError?: Error } = {}) {
  const adapter = new CodexAdapter({ requestHandler });
  const events: Array<AnyNewEvent & { turnId?: string }> = [];
  const requests: Array<{ method: string; params: unknown }> = [];
  const rt: FakeRt = {
    threadId: "th1",
    turnId: "t_A",
    activeTurn: { turnId: "t_A", finalized: false },
    codexTurnId: "codex-turn-1",
    peer: {
      request: async (method, params) => {
        requests.push({ method, params });
        if (opts.requestError) throw opts.requestError;
        return {};
      },
    },
    sink: (ev) => events.push(ev as never),
  };
  // 私有 threads 表注入 seam：绕开真实子进程（同 codex-turn-race.test.ts 的做法）
  (adapter as unknown as { threads: Map<string, FakeRt> }).threads.set("th1", rt);
  const ref: HarnessSessionRef = { harness: "codex", harnessSessionId: "th1" };
  return { adapter, events, requests, rt, ref };
}

const input: PromptInput = {
  turnId: "t_A",
  messageId: "m_steer",
  blocks: [{ type: "text", text: "prefer approach B" }],
};

test("codex steer: maps to turn/steer with the codex turn id and emits a steer user_message", async () => {
  const { adapter, events, requests, ref } = harness();

  const receipt = await adapter.steer(ref, input, "t_A");

  expect(receipt).toEqual({ effective: "steer" });
  expect(requests).toEqual([
    {
      method: "turn/steer",
      params: {
        threadId: "th1",
        expectedTurnId: "codex-turn-1",
        input: [{ type: "text", text: "prefer approach B" }],
      },
    },
  ]);
  expect(events).toHaveLength(1);
  const msg = events[0] as unknown as { kind: string; turnId?: string; payload: Record<string, unknown> };
  expect(msg.kind).toBe("user_message");
  expect(msg.turnId).toBe("t_A"); // 绑定被注入的 turn，不新开 turn
  expect(msg.payload.delivery).toBe("steer");
  expect(msg.payload.messageId).toBe("m_steer");
});

test("codex steer: stale expectedTurnId is rejected without any wire call or event", async () => {
  const { adapter, events, requests, ref } = harness();

  const receipt = await adapter.steer(ref, { ...input, turnId: "t_B" }, "t_B");

  expect(receipt).toEqual({ effective: "rejected" });
  expect(requests).toHaveLength(0);
  expect(events).toHaveLength(0);
});

test("codex steer: finalized turn is rejected", async () => {
  const { adapter, events, requests, rt, ref } = harness();
  rt.activeTurn = { turnId: "t_A", finalized: true };

  expect(await adapter.steer(ref, input, "t_A")).toEqual({ effective: "rejected" });
  expect(requests).toHaveLength(0);
  expect(events).toHaveLength(0);
});

test("codex steer: missing codex turn id (turn/start response not yet arrived) is rejected", async () => {
  const { adapter, events, requests, rt, ref } = harness();
  rt.codexTurnId = undefined;

  expect(await adapter.steer(ref, input, "t_A")).toEqual({ effective: "rejected" });
  expect(requests).toHaveLength(0);
  expect(events).toHaveLength(0);
});

test("codex steer: wire rejection (stale turn on codex side) maps to rejected, no event", async () => {
  const { adapter, events, ref } = harness({ requestError: new Error("turn already completed") });

  expect(await adapter.steer(ref, input, "t_A")).toEqual({ effective: "rejected" });
  expect(events).toHaveLength(0);
});

test("codex steer: unsupported prompt blocks fail admission before the wire", async () => {
  const { adapter, requests, ref } = harness();

  expect(
    adapter.steer(
      ref,
      { ...input, blocks: [{ type: "image", mimeType: "image/png", data: "aGk=" }] },
      "t_A",
    ),
  ).rejects.toThrow(/image/);
  expect(requests).toHaveLength(0);
});
