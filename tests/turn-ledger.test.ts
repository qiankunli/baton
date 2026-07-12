// TurnLedger 契约测试：终态一律按 baton turn id 查表路由（不看 slot）。
// 回归背景（bug#2）：旧路由先判"active 的 slot 是否命中"，同 provider 的 driven turn
// 运行期间，observed turn 的 idle 会进 driven 分支、被 turnId 守卫拒绝后不再 fallthrough——
// observed turn 永远得不到 summary，跨 provider catch-up 对它永久盲区。
// 另钉住（bug#4）：codex fast-submit 窗口内（codexTurnId 未就位）的 cancel 不得静默丢弃。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudeAdapter } from "../src/adapters/claude/adapter.ts";
import { CodexAdapter } from "../src/adapters/codex/adapter.ts";
import type {
  AdapterCapabilities,
  AgentAdapter,
  EventSink,
  OpenOptions,
  PromptInput,
  PromptReceipt,
  ProviderSessionRef,
} from "../src/adapters/types.ts";
import type { AnyNewEvent } from "../src/events/types.ts";
import { BatonSessionRuntime } from "../src/session/runtime.ts";
import { SessionStore, type SessionHandle } from "../src/store/store.ts";

const approvalHandler = async () => ({ optionId: "deny" });

let root: string;
let store: SessionStore;
let session: SessionHandle;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baton-ledger-"));
  store = new SessionStore(root);
  session = store.createSession({ cwd: "/repo" });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 只做 admission + 报 running 的 fake adapter；后续事件由测试直接经 sink 注入 */
class OverlapAdapter implements AgentAdapter {
  readonly provider = "claude-code";
  readonly capabilities: AdapterCapabilities = { prompt: {} };
  sink?: EventSink;
  driven?: PromptInput;

  async open(_opts: OpenOptions, sink: EventSink): Promise<ProviderSessionRef> {
    this.sink = sink;
    return { provider: this.provider, providerSessionId: "ov1", resumed: false };
  }

  // 新契约：user_message / running 由 runtime 出队时落盘，adapter submit 只做 admission
  async submit(_ref: ProviderSessionRef, input: PromptInput): Promise<PromptReceipt> {
    this.driven = input;
    return { accepted: true };
  }

  async cancel(_ref: ProviderSessionRef): Promise<void> {}
  async close(_ref: ProviderSessionRef): Promise<void> {}
}

function summaryTurnIds(): string[] {
  return session
    .readEvents()
    .filter((ev) => ev.kind === "_baton_turn_summary")
    .map((ev) => (ev.payload as { turnId: string }).turnId);
}

describe("terminal routing by turnId (bug#2 regression)", () => {
  test("observed idle during a same-provider driven turn still closes the observed turn", async () => {
    const adapter = new OverlapAdapter();
    const runtime = new BatonSessionRuntime({ session, mentionBudgetChars: 4096, createAdapter: () => adapter });

    const submitted = runtime.submit("claude", [{ type: "text", text: "go" }]);
    await Bun.sleep(1); // driven turn admission + running 就位

    // 同一 slot 上 observed turn 开界 → 收界，此刻 driven turn 仍在运行
    adapter.sink?.({
      kind: "state_update",
      provider: adapter.provider,
      turnId: "t_obs",
      payload: { state: "running", origin: "provider" },
    });
    adapter.sink?.({
      kind: "agent_message",
      provider: adapter.provider,
      turnId: "t_obs",
      payload: { messageId: "m_obs", content: [{ type: "text", text: "background done" }] },
    });
    adapter.sink?.({
      kind: "state_update",
      provider: adapter.provider,
      turnId: "t_obs",
      payload: { state: "idle", stopReason: "end_turn" },
    });

    // bug#2 钉子：observed turn 立即拿到 summary，不等 driven 收口
    expect(summaryTurnIds()).toEqual(["t_obs"]);

    // driven turn 不受影响，照常收口
    adapter.sink?.({
      kind: "state_update",
      provider: adapter.provider,
      turnId: adapter.driven!.turnId,
      payload: { state: "idle", stopReason: "end_turn" },
    });
    await expect(submitted).resolves.toBe("completed");
    expect(summaryTurnIds().sort()).toEqual(["t_obs", adapter.driven!.turnId].sort());
  });

  test("driven idle does not close a still-running observed turn (reverse ordering)", async () => {
    const adapter = new OverlapAdapter();
    const runtime = new BatonSessionRuntime({ session, mentionBudgetChars: 4096, createAdapter: () => adapter });

    const submitted = runtime.submit("claude", [{ type: "text", text: "go" }]);
    await Bun.sleep(1);

    adapter.sink?.({
      kind: "state_update",
      provider: adapter.provider,
      turnId: "t_obs",
      payload: { state: "running", origin: "provider" },
    });
    // driven 先收口
    adapter.sink?.({
      kind: "state_update",
      provider: adapter.provider,
      turnId: adapter.driven!.turnId,
      payload: { state: "idle", stopReason: "end_turn" },
    });
    await expect(submitted).resolves.toBe("completed");
    expect(summaryTurnIds()).toEqual([adapter.driven!.turnId]); // observed 仍开界，未被误关

    // observed 随后收口，恰好一次
    adapter.sink?.({
      kind: "state_update",
      provider: adapter.provider,
      turnId: "t_obs",
      payload: { state: "idle", stopReason: "end_turn" },
    });
    expect(summaryTurnIds().sort()).toEqual(["t_obs", adapter.driven!.turnId].sort());
  });

  test("an idle without turnId is persisted but drives no lifecycle", async () => {
    const adapter = new OverlapAdapter();
    const runtime = new BatonSessionRuntime({ session, mentionBudgetChars: 4096, createAdapter: () => adapter });

    const submitted = runtime.submit("claude", [{ type: "text", text: "go" }]);
    let done = false;
    void submitted.then(() => {
      done = true;
    });
    await Bun.sleep(1);

    // 无 turnId 的终态：留痕，但不能终结 driven turn
    adapter.sink?.({ kind: "state_update", provider: adapter.provider, payload: { state: "idle" } });
    await Bun.sleep(1);
    expect(done).toBe(false);
    expect(summaryTurnIds()).toEqual([]);
    expect(
      session.readEvents().filter((ev) => ev.kind === "state_update" && ev.turnId === undefined),
    ).toHaveLength(1); // 已持久化

    // 带 turnId 的正确终态仍能收口
    adapter.sink?.({
      kind: "state_update",
      provider: adapter.provider,
      turnId: adapter.driven!.turnId,
      payload: { state: "idle", stopReason: "end_turn" },
    });
    await expect(submitted).resolves.toBe("completed");
  });
});

// ---- finalized 记录瘦身：幂等判定只留骨架，重负载（PromptBlock[]/闭包）必须释放 ----

describe("finalized turn records are retired (memory retention regression)", () => {
  test("finalize drops the queued prompt and release closure but keeps idempotency", async () => {
    const adapter = new OverlapAdapter();
    const runtime = new BatonSessionRuntime({ session, mentionBudgetChars: 4096, createAdapter: () => adapter });
    const ledger = (
      runtime as unknown as {
        turns: Map<string, { status: string; turn?: unknown; release?: unknown; cancelGraceTimer?: unknown }>;
      }
    ).turns;

    const submitted = runtime.submit("claude", [{ type: "text", text: "go" }]);
    await Bun.sleep(1);
    const turnId = adapter.driven!.turnId;
    expect(ledger.get(turnId)?.turn).toBeDefined(); // active 期间入队原件在场（canSteer 依赖）

    adapter.sink?.({
      kind: "state_update",
      provider: adapter.provider,
      turnId,
      payload: { state: "idle", stopReason: "end_turn" },
    });
    await expect(submitted).resolves.toBe("completed");

    // 骨架保留：迟到终态仍能按 turnId 幂等判定
    const record = ledger.get(turnId);
    expect(record?.status).toBe("finalized");
    // 重负载释放：PromptBlock[] 与 release 闭包不随 finalized 记录线性累积
    expect(record?.turn).toBeUndefined();
    expect(record?.release).toBeUndefined();
    expect(record?.cancelGraceTimer).toBeUndefined();

    // 幂等钉子：重复终态 inert，不产生第二份 summary
    adapter.sink?.({
      kind: "state_update",
      provider: adapter.provider,
      turnId,
      payload: { state: "idle", stopReason: "end_turn" },
    });
    expect(summaryTurnIds()).toEqual([turnId]);
  });
});

// ---- adapter 契约：终态必带 turnId（路由按 turnId 查表的前提） ----

describe("adapter contract: terminal state_update carries a turnId", () => {
  test("claude adapter: finish / cancel / host close all bind the owning turn", async () => {
    const adapter = new ClaudeAdapter({ approvalHandler });
    const events: Array<{ kind: string; turnId?: string; payload: Record<string, unknown> }> = [];
    const ref = await adapter.open({ cwd: "/tmp" }, (ev) => events.push(ev as never));
    const seams = adapter as unknown as {
      sessions: Map<string, { activeTurn?: unknown }>;
      emit(rt: unknown, ev: AnyNewEvent, turn?: unknown): void;
      finishTurn(rt: unknown, emit: (ev: AnyNewEvent) => void, turn: unknown, stopReason: string): void;
    };
    const rt = seams.sessions.get(ref.providerSessionId);
    if (!rt) throw new Error("runtime not registered by open()");

    for (const [turnId, stop] of [
      ["t_ok", "end_turn"],
      ["t_cancel", "cancelled"],
    ] as const) {
      const turn = { turnId, finalized: false, cancelRequested: false };
      rt.activeTurn = turn;
      seams.finishTurn(rt, (ev) => seams.emit(rt, ev, turn), turn, stop);
    }
    rt.activeTurn = { turnId: "t_close", finalized: false, cancelRequested: false };
    await adapter.close(ref); // 宿主 close 合成 cancelled 终态

    const idles = events.filter(
      (ev) => ev.kind === "state_update" && (ev.payload as { state?: string }).state === "idle",
    );
    expect(idles.map((ev) => ev.turnId)).toEqual(["t_ok", "t_cancel", "t_close"]);
  });

  test("codex adapter: finish / fail / host close all bind the owning turn", () => {
    const adapter = new CodexAdapter({ approvalHandler: async () => ({ optionId: "decline" }) });
    const events: Array<{ kind: string; turnId?: string; payload: Record<string, unknown> }> = [];
    const rt = {
      child: { kill() {} },
      peer: { request: () => Promise.resolve({}) },
      threadId: "th1",
      turnId: undefined as string | undefined,
      activeTurn: undefined as { turnId: string; finalized: boolean } | undefined,
      codexTurnId: undefined as string | undefined,
      sink: (ev: AnyNewEvent) => events.push(ev as never),
    };
    const seams = adapter as unknown as {
      threads: Map<string, unknown>;
      finishTurn(rt: unknown, turn: unknown, turnStatus: string): void;
      failTurn(rt: unknown, turn: unknown, message: string): void;
    };
    seams.threads.set("th1", rt);

    const turnA = { turnId: "t_ok", finalized: false };
    rt.turnId = "t_ok";
    rt.activeTurn = turnA;
    seams.finishTurn(rt, turnA, "completed");

    const turnB = { turnId: "t_fail", finalized: false };
    rt.turnId = "t_fail";
    rt.activeTurn = turnB;
    seams.failTurn(rt, turnB, "transport died");

    const turnC = { turnId: "t_close", finalized: false };
    rt.turnId = "t_close";
    rt.activeTurn = turnC;
    void adapter.close({ provider: "codex", providerSessionId: "th1" });

    const idles = events.filter(
      (ev) => ev.kind === "state_update" && (ev.payload as { state?: string }).state === "idle",
    );
    expect(idles.map((ev) => ev.turnId)).toEqual(["t_ok", "t_fail", "t_close"]);
  });
});

// ---- bug#4：codex fast-submit 窗口内的 cancel 不得静默丢弃 ----

describe("codex pending cancel (bug#4 regression)", () => {
  function codexHarness() {
    const adapter = new CodexAdapter({ approvalHandler: async () => ({ optionId: "decline" }) });
    const calls: Array<{ method: string; params: unknown }> = [];
    const rt = {
      child: { kill() {} },
      peer: {
        request: (method: string, params: unknown) => {
          calls.push({ method, params });
          return Promise.resolve({});
        },
      },
      threadId: "th1",
      turnId: "t_A",
      activeTurn: { turnId: "t_A", finalized: false },
      codexTurnId: undefined as string | undefined,
      pendingCancel: undefined as boolean | undefined,
      sink: () => {},
    };
    const seams = adapter as unknown as {
      threads: Map<string, unknown>;
      handleNotification(rt: unknown, method: string, params: unknown): void;
      finishTurn(rt: unknown, turn: unknown, turnStatus: string): void;
    };
    seams.threads.set("th1", rt);
    const ref: ProviderSessionRef = { provider: "codex", providerSessionId: "th1" };
    return { adapter, seams, rt, calls, ref };
  }

  test("cancel before codexTurnId is deferred and flushed on turn/started", async () => {
    const { adapter, seams, rt, calls, ref } = codexHarness();

    await adapter.cancel(ref); // codexTurnId 未就位：挂起而不是丢弃
    expect(calls.filter((c) => c.method === "turn/interrupt")).toHaveLength(0);
    expect(rt.pendingCancel).toBe(true);

    seams.handleNotification(rt, "turn/started", { threadId: "th1", turn: { id: "ct_1" } });
    await Bun.sleep(0); // flush fire-and-forget
    expect(calls.filter((c) => c.method === "turn/interrupt")).toEqual([
      { method: "turn/interrupt", params: { threadId: "th1", turnId: "ct_1" } },
    ]);
    expect(rt.pendingCancel).toBe(false);
  });

  test("pending cancel dies with the turn: no interrupt after finishTurn", async () => {
    const { adapter, seams, rt, calls, ref } = codexHarness();

    await adapter.cancel(ref);
    seams.finishTurn(rt, rt.activeTurn, "completed"); // turn 已终结，取消意图随之失效
    seams.handleNotification(rt, "turn/started", { threadId: "th1", turn: { id: "ct_next" } });
    await Bun.sleep(0);
    expect(calls.filter((c) => c.method === "turn/interrupt")).toHaveLength(0);
  });

  test("cancel on an already finalized turn is a no-op", async () => {
    const { adapter, rt, calls, ref } = codexHarness();
    rt.activeTurn.finalized = true;
    await adapter.cancel(ref);
    expect(rt.pendingCancel).toBeUndefined();
    expect(calls).toHaveLength(0);
  });
});
