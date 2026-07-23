// harness 自发回合（observed turn）与投影单通道的契约测试（design §5.10）。
// 回归背景：后台任务唤醒的回复曾"只持久化、不投影"——事件落了 session.jsonl，
// 但 TUI 的 SessionState 只从 per-turn 回调更新，唤醒发生在两个 driven turn 之间，
// UI 上什么都没出现（真实事故：bs_01KXA2FP1J… seq 361 idle 之后的 551/556/631）。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ClaudeAdapter, startsObservedTurn } from "../src/adapters/claude/adapter.ts";
import type {
  AdapterCapabilities,
  HarnessAdapter,
  EventSink,
  ModelOption,
  OpenOptions,
  PromptInput,
  PromptReceipt,
  HarnessSessionRef,
} from "../src/adapters/types.ts";
import { DEFAULT_CONFIG } from "../src/config/config.ts";
import type { AnyNewEvent } from "../src/events/types.ts";
import { Controller } from "../src/session/controller.ts";
import { SessionStore, type SessionHandle } from "../src/store/store.ts";
import { BatonChatProtocol } from "../src/tui/protocol.ts";

let root: string;
let store: SessionStore;
let session: SessionHandle;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baton-observed-"));
  store = new SessionStore(root);
  session = store.createSession({ cwd: "/repo" });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

// ---- 不变量：任何 append 进 store 的事件必然到达 UI 投影 ----
// 参数化事件到达时机：无活跃 turn / driven turn 运行中（同 harness）/（异 harness）。
// 投影正确性不允许依赖 controller 的 turn 状态——这正是当年丢消息的机制。

describe("projection invariant: every appended event reaches the view", () => {
  const arrivals: Array<{ name: string; before: AnyNewEvent[] }> = [
    { name: "while idle (between turns)", before: [] },
    {
      name: "while a driven turn of the same harness is running",
      before: [
        { kind: "state_update", harness: "claude-code", turnId: "t_driven", payload: { state: "running" } },
      ],
    },
    {
      name: "while a driven turn of another harness is running",
      before: [{ kind: "state_update", harness: "codex", turnId: "t_other", payload: { state: "running" } }],
    },
  ];

  for (const arrival of arrivals) {
    test(arrival.name, async () => {
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
      for (const ev of arrival.before) session.append(ev);
      session.append({
        kind: "agent_message",
        harness: "claude-code",
        turnId: "t_observed",
        payload: { messageId: "m_wake", content: [{ type: "text", text: "background result" }] },
      });
      expect(
        protocol.getView().transcript.some((item) => item.type === "message" && item.id === "m_wake"),
      ).toBe(true);
      await protocol.exit();
    });
  }
});

describe("observed turn presentation", () => {
  test("busy + background run-status line while an observed turn runs; cleared on idle", async () => {
    const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
    session.append({
      kind: "state_update",
      harness: "claude-code",
      turnId: "t_obs",
      payload: { state: "running", origin: "harness" },
    });
    let view = protocol.getView();
    expect(view.busy).toBe(true);
    expect(view.runStatus).toHaveLength(1);
    const line = view.runStatus?.[0];
    expect(line).toBeDefined();
    expect(line?.id).toBe("run:observed:t_obs");
    expect(line?.author).toBe("claude");
    expect(line?.label).toContain("background");
    // Esc 中断的是 driven turn，observed turn v1 不可打断：不给误导性 hint
    expect(line?.hint).toBeUndefined();

    session.append({
      kind: "state_update",
      harness: "claude-code",
      turnId: "t_obs",
      payload: { state: "idle", stopReason: "end_turn" },
    });
    view = protocol.getView();
    expect(view.busy).toBe(false);
    expect(view.runStatus).toHaveLength(1);
    expect(view.runStatus?.[0]).toMatchObject({
      author: "codex",
      label: "default · idle",
    });
    await protocol.exit();
  });

  test("concurrent observed turns still project a single latest run-status line", async () => {
    const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
    for (const turnId of ["t_obs1", "t_obs2"]) {
      session.append({
        kind: "state_update",
        harness: "claude-code",
        turnId,
        payload: { state: "running", origin: "harness" },
      });
    }
    let view = protocol.getView();
    expect(view.busy).toBe(true);
    expect(view.runStatus).toHaveLength(1);
    expect(view.runStatus?.[0]?.id).toBe("run:observed:t_obs2");

    // 一个收口不影响另一个（单槽时代任何 idle 都会全局清空）
    session.append({
      kind: "state_update",
      harness: "claude-code",
      turnId: "t_obs1",
      payload: { state: "idle", stopReason: "end_turn" },
    });
    view = protocol.getView();
    expect(view.busy).toBe(true);
    expect(view.runStatus).toHaveLength(1);
    expect(view.runStatus?.[0]?.id).toBe("run:observed:t_obs2");
    await protocol.exit();
  });
});

// ---- controller：observed turn 只记账，不碰队列 ----

/** driven turn 正常完成后，再在同一 sink 上补发一段 observed turn（模拟后台唤醒） */
class WakingAdapter implements HarnessAdapter {
  readonly harness = "claude-code";
  readonly capabilities: AdapterCapabilities = { prompt: {} };
  sink?: EventSink;
  /** 只在首个 driven turn 后唤醒一次，避免测试结束后仍有 pending 的异步 append */
  private woken = false;

  async open(_opts: OpenOptions, sink: EventSink): Promise<HarnessSessionRef> {
    this.sink = sink;
    return { harness: this.harness, harnessSessionId: "waking-ref", resumed: false };
  }

  async listModels(_ref: HarnessSessionRef): Promise<ModelOption[]> {
    return [{ id: "default", label: "Default" }];
  }

  async submit(_ref: HarnessSessionRef, input: PromptInput): Promise<PromptReceipt> {
    this.sink?.({
      kind: "user_message",
      harness: this.harness,
      turnId: input.turnId,
      payload: { messageId: input.messageId, content: input.blocks },
    });
    void (async () => {
      this.sink?.({
        kind: "state_update",
        harness: this.harness,
        turnId: input.turnId,
        payload: { state: "idle", stopReason: "end_turn" },
      });
      // driven turn 已收界；稍后 harness 自发开界（后台任务唤醒）
      if (this.woken) return;
      this.woken = true;
      await Bun.sleep(5);
      this.sink?.({
        kind: "state_update",
        harness: this.harness,
        turnId: "t_wake",
        payload: { state: "running", origin: "harness" },
      });
      this.sink?.({
        kind: "agent_message",
        harness: this.harness,
        turnId: "t_wake",
        payload: { messageId: "m_wake", content: [{ type: "text", text: "task finished" }] },
      });
      this.sink?.({
        kind: "state_update",
        harness: this.harness,
        turnId: "t_wake",
        payload: { state: "idle", stopReason: "end_turn" },
      });
    })();
    return { accepted: true };
  }

  async cancel(_ref: HarnessSessionRef): Promise<void> {}
  async close(_ref: HarnessSessionRef): Promise<void> {}
}

describe("controller observed-turn accounting", () => {
  test("summarizes the observed turn and keeps the driven queue unaffected", async () => {
    const adapter = new WakingAdapter();
    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      createAdapter: () => adapter,
    });

    await controller.submit("claude", [{ type: "text", text: "kick off background work" }]);
    await Bun.sleep(20); // 等 observed turn 收界

    const summaries = session
      .readEvents()
      .filter((ev) => ev.kind === "_baton_turn_summary")
      .map((ev) => (ev.payload as { turnId: string }).turnId);
    expect(summaries).toContain("t_wake");
    expect(summaries).toHaveLength(2); // driven + observed，各恰好一次

    // observed turn 不占队列：下一个 driven turn 照常执行
    await controller.submit("claude", [{ type: "text", text: "next" }]);
    expect(controller.queueLength).toBe(0);
  });
});

// ---- adapter：post-final 活动的开界判定与铸造 ----

describe("claude adapter observed-turn minting", () => {
  test("startsObservedTurn: only activity after finalize opens a new turn", () => {
    const live = { finalized: false };
    const done = { finalized: true };
    for (const type of ["stream_event", "assistant", "user"]) {
      expect(startsObservedTurn(type, live)).toBe(false);
      expect(startsObservedTurn(type, done)).toBe(true);
    }
    // system 是瞬时相位、result 是迟到终态：都不构成回合
    expect(startsObservedTurn("system", done)).toBe(false);
    expect(startsObservedTurn("result", done)).toBe(false);
  });

  test("mintObservedTurn opens with running(origin: harness) under a fresh turn id", async () => {
    const adapter = new ClaudeAdapter({ requestHandler: async (req) => ({ kind: "permission", requestId: req.requestId, optionId: "deny" }) });
    const events: Array<{ kind: string; turnId?: string; payload: Record<string, unknown> }> = [];
    const ref = await adapter.open({ cwd: "/tmp" }, (ev) => events.push(ev as never));
    const seams = adapter as unknown as {
      sessions: Map<string, unknown>;
      mintObservedTurn(rt: unknown): { turnId: string; finalized: boolean };
    };
    const rt = seams.sessions.get(ref.harnessSessionId);

    const observed = seams.mintObservedTurn(rt);
    expect(observed.finalized).toBe(false);
    expect(observed.turnId).toMatch(/^t_/);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      kind: "state_update",
      turnId: observed.turnId,
      payload: { state: "running", origin: "harness" },
    });
  });
});
