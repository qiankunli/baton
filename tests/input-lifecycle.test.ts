// Input 一等抽象（InputRecord）（kernel.md §6 · user-input-lifecycle.md §1/§5）：
// 每条输入身份即其 messageId（m_）+ 显式 status；queued/admitted/accepted_steer 可查，
// recall→recalled、cancel→interrupted（S3：不静默丢、不自动重发）。
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
} from "../src/adapters/types.ts";
import { textOf, type PromptBlock } from "../src/event/types.ts";
import { Controller } from "../src/session/controller.ts";
import { SessionStore, type SessionHandle } from "../src/store/store.ts";

/** turn 停在进行中，直到 finish() 或 cancel()；cancel 模拟 harness 的 cancelled 终态 */
class HoldingAdapter implements HarnessAdapter {
  readonly capabilities: AdapterCapabilities = { prompt: {}, steer: { supported: true } };
  sink?: EventSink;
  prompts: string[] = [];
  private active?: PromptInput;

  constructor(readonly harness: string) {}

  async open(_opts: OpenOptions, sink: EventSink): Promise<HarnessSessionRef> {
    this.sink = sink;
    return { harness: this.harness, harnessSessionId: `${this.harness}-ref`, resumed: false };
  }

  async submit(_ref: HarnessSessionRef, input: PromptInput): Promise<PromptReceipt> {
    this.active = input;
    this.prompts.push(textOf(input.blocks));
    return { accepted: true };
  }

  async steer(_ref: HarnessSessionRef, input: PromptInput): Promise<SteerReceipt> {
    this.sink?.({
      kind: "user_message",
      harness: this.harness,
      turnId: input.turnId,
      payload: { messageId: input.messageId, content: input.blocks, delivery: "steer" },
    });
    return { effective: "steer" };
  }

  finish(stopReason: string): void {
    const input = this.active;
    if (!input) return;
    this.active = undefined;
    this.sink?.({
      kind: "state_update",
      harness: this.harness,
      turnId: input.turnId,
      payload: { state: "idle", stopReason },
    });
  }

  async cancel(_ref: HarnessSessionRef): Promise<void> {
    this.finish("cancelled");
  }
  async close(_ref: HarnessSessionRef): Promise<void> {}
}

let root: string;
let session: SessionHandle;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baton-pending-"));
  session = new SessionStore(root).createSession({ cwd: "/repo" });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

function controllerWith(adapter: HarnessAdapter): Controller {
  return new Controller({ session, mentionBudgetChars: 4096, createAdapter: () => adapter });
}
const text = (t: string): PromptBlock[] => [{ type: "text", text: t }];
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) await Bun.sleep(1);
  expect(cond()).toBe(true);
}

describe("Input lifecycle (InputRecord)", () => {
  test("admitted input is identified by its messageId with admitted status", async () => {
    const adapter = new HoldingAdapter("codex");
    const controller = controllerWith(adapter);
    const turn = controller.submit("codex", text("build it"));
    await until(() => adapter.prompts.length === 1);

    const inputs = controller.inputs;
    expect(inputs).toHaveLength(1);
    expect(inputs[0]?.messageId).toMatch(/^m_/);
    expect(inputs[0]).toMatchObject({ status: "admitted", delivery: "prompt", harness: "codex" });

    adapter.finish("end_turn");
    await turn;
    expect(controller.inputs).toHaveLength(0); // finalized 输入不驻内存
  });

  test("a second input while busy is a queued entity; recall marks it recalled and drops it", async () => {
    const adapter = new HoldingAdapter("codex");
    const controller = controllerWith(adapter);
    const first = controller.submit("codex", text("first"));
    await until(() => adapter.prompts.length === 1);
    const second = controller.submit("codex", text("second"));
    await until(() => controller.queueLength === 1);

    const statuses = controller.inputs.map((i) => i.status).sort();
    expect(statuses).toEqual(["admitted", "queued"]);

    const recalled = controller.recallLatestQueued();
    expect(recalled?.blocks && textOf(recalled.blocks)).toBe("second");
    expect(controller.inputs.map((i) => i.status)).toEqual(["admitted"]); // queued 已移除
    expect(await second).toBe("recalled");

    adapter.finish("end_turn");
    expect(await first).toBe("completed");
  });

  test("accepted steer is a first-class entity attached to the active turn", async () => {
    const adapter = new HoldingAdapter("codex");
    const controller = controllerWith(adapter);
    const turn = controller.submit("codex", text("build it"));
    await until(() => adapter.prompts.length === 1);

    const outcome = await controller.steer("codex", text("prefer B"));
    expect(outcome.effective).toBe("steer");

    const steer = controller.inputs.find((i) => i.delivery === "steer");
    expect(steer?.messageId).toMatch(/^m_/);
    expect(steer?.status).toBe("accepted_steer");

    adapter.finish("end_turn");
    await turn;
  });

  test("Esc after an accepted steer interrupts the turn without silently dropping the steer", async () => {
    const adapter = new HoldingAdapter("codex");
    const controller = controllerWith(adapter);
    const turn = controller.submit("codex", text("build it"));
    await until(() => adapter.prompts.length === 1);
    await controller.steer("codex", text("also do B"));
    expect(controller.inputs.some((i) => i.status === "accepted_steer")).toBe(true);

    await controller.control({ kind: "interrupt" });
    expect(await turn).toBe("completed");

    // 无悬挂输入实体，且 steer 文本仍在事件历史里（不静默丢；不自动重发 → 只有一条 steer prompt）
    expect(controller.inputs).toHaveLength(0);
    const state = session.loadState();
    const userTexts = [...state.messages.values()]
      .filter((m) => m.role === "user")
      .map((m) => textOf(m.content));
    expect(userTexts).toContain("also do B");
    expect(userTexts.filter((t) => t === "also do B")).toHaveLength(1);
  });
});
