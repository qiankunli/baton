// steer 的 controller 语义（design §4.3 / 验收矩阵 §7.6）：
// 正确 turn 成功注入且不新开 turn；不可 steer / harness 拒绝 / wire 故障一律显式
// 降级为 follow-up（effective 如实上报），输入永不静默丢失。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AdapterCapabilities,
  HarnessAdapter,
  EventSink,
  OpenOptions,
  PromptInput,
  PromptReceipt,
  HarnessSessionRef,
  SteerReceipt,
} from "../src/harness/adapter.ts";
import { textOf, type PromptBlock } from "../src/event/types.ts";
import { Controller } from "../src/controller/index.ts";
import { SessionStore, type SessionHandle } from "../src/store/store.ts";
import { resolveTestTarget } from "./harness-target.ts";

/** turn 不自动终结：由测试显式 finish()，制造稳定的"turn 进行中"窗口 */
class SteerableFakeAdapter implements HarnessAdapter {
  readonly capabilities: AdapterCapabilities = { prompt: {}, steer: { supported: true } };
  sink?: EventSink;
  prompts: string[] = [];
  steers: Array<{ turnId: string; expectedTurnId: string; text: string }> = [];
  steerResult: SteerReceipt = { effective: "steer" };
  steerError?: Error;
  private activeInput?: PromptInput;

  constructor(readonly harness: string) {}

  async open(_opts: OpenOptions, sink: EventSink): Promise<HarnessSessionRef> {
    this.sink = sink;
    return { harness: this.harness, harnessSessionId: `${this.harness}-ref`, resumed: false };
  }

  // 新契约：普通 prompt 的 user_message / running 由 controller 出队时落盘；
  // adapter 只在 steer 成功路径补 delivery:"steer" 的用户消息（见下方 steer()）
  async submit(_ref: HarnessSessionRef, input: PromptInput): Promise<PromptReceipt> {
    this.activeInput = input;
    this.prompts.push(textOf(input.blocks));
    return { accepted: true };
  }

  async steer(_ref: HarnessSessionRef, input: PromptInput, expectedTurnId: string): Promise<SteerReceipt> {
    if (this.steerError) throw this.steerError;
    this.steers.push({ turnId: input.turnId, expectedTurnId, text: textOf(input.blocks) });
    if (this.steerResult.effective === "steer") {
      // 契约：成功路径由 adapter 发 delivery:"steer" 的 user_message，绑定被注入的 turn
      this.sink?.({
        kind: "user_message",
        turnId: input.turnId,
        payload: { messageId: input.messageId, content: input.blocks, delivery: "steer" },
      });
    }
    return this.steerResult;
  }

  /** 终结当前 turn（模拟 harness 的 idle 终态） */
  finish(): void {
    const input = this.activeInput;
    if (!input) return;
    this.activeInput = undefined;
    this.sink?.({
      kind: "agent_message",
      turnId: input.turnId,
      payload: { messageId: `${input.turnId}-agent`, content: [{ type: "text", text: "done" }] },
    });
    this.sink?.({
      kind: "state_update",
      turnId: input.turnId,
      payload: { state: "idle", stopReason: "end_turn" },
    });
  }

  async cancel(_ref: HarnessSessionRef): Promise<void> {}
  async close(_ref: HarnessSessionRef): Promise<void> {}
}

/** 无 steer 能力的最小 adapter：验证 capability 缺失时的降级 */
class PlainFakeAdapter extends SteerableFakeAdapter {
  override readonly capabilities: AdapterCapabilities = { prompt: {} };
  override async steer(): Promise<SteerReceipt> {
    throw new Error("plain adapter must not be steered when capability is undeclared");
  }
}

let root: string;
let session: SessionHandle;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baton-steer-"));
  session = new SessionStore(root).createSession({ cwd: "/repo" });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function controllerWith(adapter: HarnessAdapter): Controller {
  return new Controller({
    session,
    mentionBudgetChars: 4096,
    resolveTarget: resolveTestTarget,
    createAdapter: () => adapter,
  });
}

const text = (t: string): PromptBlock[] => [{ type: "text", text: t }];

/** submit 的 promise 只在 turn 完成后 resolve，中间状态按谓词轮询等待 */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) await Bun.sleep(1);
  expect(cond()).toBe(true);
}

describe("Controller.steer", () => {
  test("steers the active turn: no new turn, message lands in the steered turn", async () => {
    const adapter = new SteerableFakeAdapter("codex");
    const controller = controllerWith(adapter);

    const turn = controller.submit("codex", text("build it"));
    await until(() => adapter.prompts.length === 1);
    expect(controller.canSteer("codex")).toBe(true);

    const outcome = await controller.steer("codex", text("prefer approach B"));

    expect(outcome.effective).toBe("steer");
    expect(controller.queueLength).toBe(0);
    expect(adapter.steers).toHaveLength(1);
    // expectedTurnId 与消息归属 turn 都是当前 active 的 baton turn id
    expect(adapter.steers[0]?.expectedTurnId).toBe(adapter.steers[0]?.turnId as string);

    adapter.finish();
    expect(await turn).toBe("completed");

    // steer 消息落盘在被注入的 turn 内，带 effective delivery 标记
    const state = session.loadState();
    const steerMsg = [...state.messages.values()].find((m) => m.delivery === "steer");
    expect(steerMsg).toBeDefined();
    expect(textOf(steerMsg?.content ?? [])).toBe("prefer approach B");
    expect(steerMsg?.turnId).toBe(adapter.steers[0]?.turnId as string);
    expect(state.turnSummaries).toHaveLength(1);
  });

  test("degrades to follow-up when the adapter rejects (stale turn race)", async () => {
    const adapter = new SteerableFakeAdapter("codex");
    adapter.steerResult = { effective: "rejected" };
    const controller = controllerWith(adapter);

    const first = controller.submit("codex", text("one"));
    await until(() => adapter.prompts.length === 1);
    const outcome = await controller.steer("codex", text("two"));

    expect(outcome.effective).toBe("follow_up");
    expect(controller.queueLength).toBe(1);
    adapter.finish(); // 结束 turn one → 降级的 follow-up 开始执行
    await first;
    await until(() => adapter.prompts.length === 2);
    adapter.finish();
    if (outcome.effective === "follow_up") expect(await outcome.outcome).toBe("completed");
    expect(adapter.prompts).toEqual(["one", "two"]);
  });

  test("degrades to follow-up when the adapter throws (wire failure)", async () => {
    const adapter = new SteerableFakeAdapter("codex");
    adapter.steerError = new Error("peer closed");
    const controller = controllerWith(adapter);

    controller.submit("codex", text("one"));
    await until(() => adapter.prompts.length === 1);
    const outcome = await controller.steer("codex", text("two"));

    expect(outcome.effective).toBe("follow_up");
    expect(controller.queueLength).toBe(1);
  });

  test("degrades when the harness does not declare the steer capability", async () => {
    const adapter = new PlainFakeAdapter("claude");
    const controller = controllerWith(adapter);

    controller.submit("claude", text("one"));
    await until(() => adapter.prompts.length === 1);
    expect(controller.canSteer("claude")).toBe(false);

    const outcome = await controller.steer("claude", text("two"));
    expect(outcome.effective).toBe("follow_up");
    expect(controller.queueLength).toBe(1);
  });

  test("degrades when idle (no active turn to steer)", async () => {
    const adapter = new SteerableFakeAdapter("codex");
    const controller = controllerWith(adapter);

    expect(controller.canSteer("codex")).toBe(false);
    const outcome = await controller.steer("codex", text("hello"));
    expect(outcome.effective).toBe("follow_up");

    await until(() => adapter.prompts.length === 1);
    adapter.finish();
    if (outcome.effective === "follow_up") expect(await outcome.outcome).toBe("completed");
    expect(adapter.steers).toHaveLength(0);
    expect(adapter.prompts).toEqual(["hello"]);
  });

  test("degrades when steering a harness other than the active one", async () => {
    const codex = new SteerableFakeAdapter("codex");
    const claude = new SteerableFakeAdapter("claude-code");
    const adapters: Record<string, HarnessAdapter> = { codex, claude };
    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      resolveTarget: resolveTestTarget,
      createAdapter: (target) => adapters[target.harness] as HarnessAdapter,
    });

    controller.submit("codex", text("one"));
    await until(() => codex.prompts.length === 1);
    expect(controller.canSteer("claude")).toBe(false);

    const outcome = await controller.steer("claude", text("two"));
    expect(outcome.effective).toBe("follow_up");
    expect(claude.steers).toHaveLength(0);
    expect(controller.queueLength).toBe(1);
  });
});
