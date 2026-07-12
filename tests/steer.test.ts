// steer 的 runtime 语义（design §4.3 / 验收矩阵 §7.6）：
// 正确 turn 成功注入且不新开 turn；不可 steer / provider 拒绝 / wire 故障一律显式
// 降级为 follow-up（effective 如实上报），输入永不静默丢失。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AdapterCapabilities,
  AgentAdapter,
  EventSink,
  OpenOptions,
  PromptInput,
  PromptReceipt,
  ProviderSessionRef,
  SteerReceipt,
} from "../src/adapters/types.ts";
import { textOf, type PromptBlock } from "../src/events/types.ts";
import { BatonSessionRuntime } from "../src/session/runtime.ts";
import { SessionStore, type SessionHandle } from "../src/store/store.ts";

/** turn 不自动终结：由测试显式 finish()，制造稳定的"turn 进行中"窗口 */
class SteerableFakeAdapter implements AgentAdapter {
  readonly capabilities: AdapterCapabilities = { prompt: {}, steer: { supported: true } };
  sink?: EventSink;
  prompts: string[] = [];
  steers: Array<{ turnId: string; expectedTurnId: string; text: string }> = [];
  steerResult: SteerReceipt = { effective: "steer" };
  steerError?: Error;
  private activeInput?: PromptInput;

  constructor(readonly provider: string) {}

  async open(_opts: OpenOptions, sink: EventSink): Promise<ProviderSessionRef> {
    this.sink = sink;
    return { provider: this.provider, providerSessionId: `${this.provider}-ref`, resumed: false };
  }

  async submit(_ref: ProviderSessionRef, input: PromptInput): Promise<PromptReceipt> {
    this.activeInput = input;
    this.prompts.push(textOf(input.blocks));
    this.sink?.({
      kind: "user_message",
      provider: this.provider,
      turnId: input.turnId,
      payload: { messageId: input.messageId, content: input.blocks },
    });
    this.sink?.({
      kind: "state_update",
      provider: this.provider,
      turnId: input.turnId,
      payload: { state: "running" },
    });
    return { accepted: true };
  }

  async steer(_ref: ProviderSessionRef, input: PromptInput, expectedTurnId: string): Promise<SteerReceipt> {
    if (this.steerError) throw this.steerError;
    this.steers.push({ turnId: input.turnId, expectedTurnId, text: textOf(input.blocks) });
    if (this.steerResult.effective === "steer") {
      // 契约：成功路径由 adapter 发 delivery:"steer" 的 user_message，绑定被注入的 turn
      this.sink?.({
        kind: "user_message",
        provider: this.provider,
        turnId: input.turnId,
        payload: { messageId: input.messageId, content: input.blocks, delivery: "steer" },
      });
    }
    return this.steerResult;
  }

  /** 终结当前 turn（模拟 provider 的 idle 终态） */
  finish(): void {
    const input = this.activeInput;
    if (!input) return;
    this.activeInput = undefined;
    this.sink?.({
      kind: "agent_message",
      provider: this.provider,
      turnId: input.turnId,
      payload: { messageId: `${input.turnId}-agent`, content: [{ type: "text", text: "done" }] },
    });
    this.sink?.({
      kind: "state_update",
      provider: this.provider,
      turnId: input.turnId,
      payload: { state: "idle", stopReason: "end_turn" },
    });
  }

  async cancel(_ref: ProviderSessionRef): Promise<void> {}
  async close(_ref: ProviderSessionRef): Promise<void> {}
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

function runtimeWith(adapter: AgentAdapter): BatonSessionRuntime {
  return new BatonSessionRuntime({
    session,
    mentionBudgetChars: 4096,
    createAdapter: () => adapter,
  });
}

const text = (t: string): PromptBlock[] => [{ type: "text", text: t }];

/** submit 的 promise 只在 turn 完成后 resolve，中间状态按谓词轮询等待 */
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) await Bun.sleep(1);
  expect(cond()).toBe(true);
}

describe("BatonSessionRuntime.steer", () => {
  test("steers the active turn: no new turn, message lands in the steered turn", async () => {
    const adapter = new SteerableFakeAdapter("codex");
    const runtime = runtimeWith(adapter);

    const turn = runtime.submit("codex", text("build it"));
    await until(() => adapter.prompts.length === 1);
    expect(runtime.canSteer("codex")).toBe(true);

    const outcome = await runtime.steer("codex", text("prefer approach B"));

    expect(outcome.effective).toBe("steer");
    expect(runtime.queueLength).toBe(0);
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
    const runtime = runtimeWith(adapter);

    const first = runtime.submit("codex", text("one"));
    await until(() => adapter.prompts.length === 1);
    const outcome = await runtime.steer("codex", text("two"));

    expect(outcome.effective).toBe("follow_up");
    expect(runtime.queueLength).toBe(1);
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
    const runtime = runtimeWith(adapter);

    runtime.submit("codex", text("one"));
    await until(() => adapter.prompts.length === 1);
    const outcome = await runtime.steer("codex", text("two"));

    expect(outcome.effective).toBe("follow_up");
    expect(runtime.queueLength).toBe(1);
  });

  test("degrades when the provider does not declare the steer capability", async () => {
    const adapter = new PlainFakeAdapter("claude");
    const runtime = runtimeWith(adapter);

    runtime.submit("claude", text("one"));
    await until(() => adapter.prompts.length === 1);
    expect(runtime.canSteer("claude")).toBe(false);

    const outcome = await runtime.steer("claude", text("two"));
    expect(outcome.effective).toBe("follow_up");
    expect(runtime.queueLength).toBe(1);
  });

  test("degrades when idle (no active turn to steer)", async () => {
    const adapter = new SteerableFakeAdapter("codex");
    const runtime = runtimeWith(adapter);

    expect(runtime.canSteer("codex")).toBe(false);
    const outcome = await runtime.steer("codex", text("hello"));
    expect(outcome.effective).toBe("follow_up");

    await until(() => adapter.prompts.length === 1);
    adapter.finish();
    if (outcome.effective === "follow_up") expect(await outcome.outcome).toBe("completed");
    expect(adapter.steers).toHaveLength(0);
    expect(adapter.prompts).toEqual(["hello"]);
  });

  test("degrades when steering a provider other than the active one", async () => {
    const codex = new SteerableFakeAdapter("codex");
    const claude = new SteerableFakeAdapter("claude-code");
    const adapters: Record<string, AgentAdapter> = { codex, claude };
    const runtime = new BatonSessionRuntime({
      session,
      mentionBudgetChars: 4096,
      createAdapter: (provider) => adapters[provider] as AgentAdapter,
    });

    runtime.submit("codex", text("one"));
    await until(() => codex.prompts.length === 1);
    expect(runtime.canSteer("claude")).toBe(false);

    const outcome = await runtime.steer("claude", text("two"));
    expect(outcome.effective).toBe("follow_up");
    expect(claude.steers).toHaveLength(0);
    expect(runtime.queueLength).toBe(1);
  });
});
