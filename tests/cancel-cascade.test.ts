// cancel-cascade（harness-interaction-design §4.7）：turn 被打断时，仍挂起的 Interaction 必须
// 随之收口——adapter 的 await 解开、Controller 发 interaction.resolved、requires_action 落下，
// 不留悬挂 waiter。参考 codex clear_pending_waiters→Abort、opencode interrupt 的 ensuring(delete)。
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
} from "../src/adapters/types.ts";
import type { PromptBlock } from "../src/event/types.ts";
import { Controller, type InteractionHandlers } from "../src/controller/index.ts";
import { SessionStore, type SessionHandle } from "../src/store/store.ts";
import { resolveTestTarget } from "./harness-target.ts";

/** turn 阻塞在一个审批 Interaction 上，直到 resolve 或（cancel 时）级联取消；cancel() 合成 idle(cancelled) */
class ApprovalHoldingAdapter implements HarnessAdapter {
  readonly harness = "codex";
  readonly capabilities: AdapterCapabilities = { prompt: {} };
  sink?: EventSink;
  private active?: PromptInput;

  constructor(private readonly handlers: InteractionHandlers) {}

  async open(_opts: OpenOptions, sink: EventSink): Promise<HarnessSessionRef> {
    this.sink = sink;
    return { harness: this.harness, harnessSessionId: "hold-ref", resumed: false };
  }

  async submit(_ref: HarnessSessionRef, input: PromptInput): Promise<PromptReceipt> {
    this.active = input;
    void (async () => {
      await this.handlers.interactionHandler({
        kind: "permission",
        title: "Run command?",
        options: [{ optionId: "allow", name: "Allow", polarity: "allow", lifetime: "once" }],
      }, { turnId: input.turnId });
    })();
    return { accepted: true };
  }

  async cancel(_ref: HarnessSessionRef): Promise<void> {
    const input = this.active;
    if (input) {
      this.sink?.({
        kind: "state_update",
        turnId: input.turnId,
        payload: { state: "idle", stopReason: "cancelled" },
      });
    }
  }
  async close(_ref: HarnessSessionRef): Promise<void> {}
}

let root: string;
let session: SessionHandle;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baton-cascade-"));
  session = new SessionStore(root).createSession({ cwd: "/repo" });
});
afterEach(() => rmSync(root, { recursive: true, force: true }));

const text = (t: string): PromptBlock[] => [{ type: "text", text: t }];
async function until(cond: () => boolean): Promise<void> {
  for (let i = 0; i < 500 && !cond(); i++) await Bun.sleep(1);
  expect(cond()).toBe(true);
}

describe("cancel cascades to pending Interactions", () => {
  test("Esc while a permission is pending resolves it cancelled, no dangling requires_action", async () => {
    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      resolveTarget: resolveTestTarget,
      createAdapter: (_target, handlers) => new ApprovalHoldingAdapter(handlers),
    });

    const turn = controller.submit("codex", text("do it"));
    // 阻塞在审批：pending 落盘 → 会话派生 requires_action
    await until(() => [...session.loadState().interactions.values()].some((value) => !value.resolution));
    expect(session.loadState().runState).toBe("requires_action");

    await controller.control({ kind: "interrupt" });
    await Bun.sleep(5); // 让 adapter 的 await 续跑
    expect(await turn).toBe("completed");

    const events = session.readEvents();
    const resolved = events.find((e) => e.kind === "interaction.resolved");
    expect(resolved?.payload.resolution).toEqual({ kind: "cancelled", reason: "turn" });

    const state = session.loadState();
    expect([...state.interactions.values()].every((value) => value.resolution)).toBe(true); // 不再悬挂
    expect(state.runState).toBe("idle"); // requires_action 落下
    // 打断标记仍在（turn 确实被取消）
    expect(events.some((e) => e.kind === "_baton_notice")).toBe(true);
  });
});
