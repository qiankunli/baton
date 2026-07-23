// 空回合与 hook 拦截的显式上报（源于事故 bs_01KXCNW0WVA11NZH2F8FKTCJ5E）：
// codex core 在 UserPromptSubmit/SessionStart hook block 时静默空结束——turn/completed
// status=completed、无任何 item、prompt 不进原生 history、无 error 事件；唯一线索是
// hook/completed 通知。baton 此前丢弃 hook/* 通知并把零产出 completed 当正常 end_turn，
// 用户视角即"消息被吞/卡住"。本组用例钉住：
// 1. blocked hook → _baton_notice 警示（含来源与原因）；
// 2. completed 且零产出 → 空回合警示，且能带上已知的 hook block 原因；
// 3. 有产出的正常 turn 不受影响。
import type { InteractionHandler } from "../src/adapters/types.ts";
import { expect, test } from "bun:test";

import { CodexAdapter } from "../src/adapters/codex/adapter.ts";
import { JsonRpcPeer } from "../src/adapters/codex/jsonrpc.ts";
import type { PromptInput, HarnessSessionRef } from "../src/adapters/types.ts";
import type { AnyEventDraft, Notice } from "../src/event/types.ts";

const interactionHandler: InteractionHandler = async (req) =>
  req.kind === "permission"
    ? { kind: "permission", outcome: "selected", optionId: "decline" }
    : { kind: "question", outcome: "answered", answers: {} };

interface WireEvent {
  kind: string;
  turnId?: string;
  payload: unknown;
}

interface TurnState {
  turnId: string;
  finalized: boolean;
}

// 同 codex-turn-race.test.ts 的 wire harness：出站请求被捕获，入站通知按 wire 形状 feed
function wireHarness() {
  const adapter = new CodexAdapter({ interactionHandler });
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
    sink: (ev: AnyEventDraft) => events.push(ev as never),
  };
  peer.onNotification((method, params) =>
    (adapter as unknown as { handleNotification(rt: unknown, method: string, params: unknown): void })
      .handleNotification(rt, method, params),
  );
  (adapter as unknown as { threads: Map<string, unknown> }).threads.set("th1", rt);
  const ref: HarnessSessionRef = { harness: "codex", harnessSessionId: "th1" };
  const notifyIn = (method: string, params: unknown) =>
    peer.feed(`${JSON.stringify({ jsonrpc: "2.0", method, params })}\n`);
  const noticesOf = () => events.filter((ev) => ev.kind === "_baton_notice");
  return { adapter, events, rt, ref, notifyIn, noticesOf };
}

const prompt = (turnId: string, text: string): PromptInput => ({
  turnId,
  messageId: `m_${turnId}`,
  blocks: [{ type: "text", text }],
});

// hook/completed 的 wire 形状取自 codex 0.144.1 app-server 实测（camelCase 字段）
function blockedHookRun(overrides?: Record<string, unknown>) {
  return {
    id: "user-prompt-submit:7:/Users/x/.codex/hooks.json",
    eventName: "userPromptSubmit",
    handlerType: "command",
    executionMode: "sync",
    scope: "turn",
    sourcePath: "/Users/x/.codex/hooks.json",
    source: "user",
    displayOrder: 7,
    status: "blocked",
    statusMessage: null,
    entries: [{ kind: "feedback", text: "prompt rejected by policy" }],
    ...overrides,
  };
}

test("codex: blocked UserPromptSubmit hook surfaces a notice and explains the empty turn", async () => {
  const h = wireHarness();
  await h.adapter.submit(h.ref, prompt("t_A", "hi"));

  h.notifyIn("turn/started", { threadId: "th1", turn: { id: "codex-A" } });
  h.notifyIn("hook/completed", { threadId: "th1", turnId: "codex-A", run: blockedHookRun() });
  // 事故形态：hook block 后 codex 静默 completed，无任何 item
  h.notifyIn("turn/completed", { threadId: "th1", turn: { status: "completed" } });

  const notices = h.noticesOf();
  expect(notices).toHaveLength(2);

  const blockNotice = notices[0]?.payload as Notice;
  expect(blockNotice.level).toBe("warning");
  expect(blockNotice.title).toContain("userPromptSubmit");
  expect(blockNotice.detail).toContain("/Users/x/.codex/hooks.json");
  expect(blockNotice.detail).toContain("prompt rejected by policy");

  const emptyNotice = notices[1]?.payload as Notice;
  expect(emptyNotice.title).toContain("empty turn");
  // 空回合警示要能归因到 hook block，而不是泛泛报"没输出"
  expect(emptyNotice.detail).toContain("prompt rejected by policy");
  expect(notices[1]?.turnId).toBe("t_A");

  // 终态语义不变：仍是一次 idle / end_turn，警示不改变生命周期
  const idles = h.events.filter(
    (ev) => ev.kind === "state_update" && (ev.payload as { state?: string }).state === "idle",
  );
  expect(idles).toHaveLength(1);
});

test("codex: empty completed turn without hook context still raises a notice", async () => {
  const h = wireHarness();
  await h.adapter.submit(h.ref, prompt("t_A", "hi"));

  h.notifyIn("turn/started", { threadId: "th1", turn: { id: "codex-A" } });
  h.notifyIn("turn/completed", { threadId: "th1", turn: { status: "completed" } });

  const notices = h.noticesOf();
  expect(notices).toHaveLength(1);
  expect((notices[0]?.payload as Notice).title).toContain("empty turn");
  expect((notices[0]?.payload as Notice).level).toBe("warning");
});

test("codex: turns with output and successful hooks emit no notice", async () => {
  const h = wireHarness();
  await h.adapter.submit(h.ref, prompt("t_A", "hi"));

  h.notifyIn("turn/started", { threadId: "th1", turn: { id: "codex-A" } });
  // 正常完成的 hook 不产生警示
  h.notifyIn("hook/completed", {
    threadId: "th1",
    turnId: "codex-A",
    run: blockedHookRun({ status: "completed", entries: [] }),
  });
  h.notifyIn("item/completed", {
    threadId: "th1",
    item: { type: "agentMessage", id: "item-A", text: "PONG" },
  });
  h.notifyIn("turn/completed", { threadId: "th1", turn: { status: "completed" } });

  expect(h.noticesOf()).toHaveLength(0);
  expect(h.events.filter((ev) => ev.kind === "agent_message")).toHaveLength(1);
});

test("codex: interrupted empty turn is not reported as anomalous", async () => {
  const h = wireHarness();
  await h.adapter.submit(h.ref, prompt("t_A", "hi"));

  h.notifyIn("turn/started", { threadId: "th1", turn: { id: "codex-A" } });
  // 用户立即打断：零产出是预期结果，不是"吞消息"
  h.notifyIn("turn/completed", { threadId: "th1", turn: { status: "interrupted" } });

  expect(h.noticesOf()).toHaveLength(0);
});

test("codex: non-prompt hook blocks (stop/preToolUse) are flow control, not notices", async () => {
  const h = wireHarness();
  await h.adapter.submit(h.ref, prompt("t_A", "hi"));

  h.notifyIn("turn/started", { threadId: "th1", turn: { id: "codex-A" } });
  h.notifyIn("hook/completed", {
    threadId: "th1",
    turnId: "codex-A",
    run: blockedHookRun({ eventName: "stop", id: "stop:11:/Users/x/.codex/hooks.json" }),
  });
  h.notifyIn("item/completed", {
    threadId: "th1",
    item: { type: "agentMessage", id: "item-A", text: "continuing" },
  });
  h.notifyIn("turn/completed", { threadId: "th1", turn: { status: "completed" } });

  expect(h.noticesOf()).toHaveLength(0);
});
