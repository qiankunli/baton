// driven turn 的用户事实由 controller 出队即落盘（owner 边界，design §4.1）：
// - user_message/running 不等 harness 冷启动——首启延迟不能绑住 Transcript；
// - 正典 user_message 是原始输入，<baton-sync> prepend 只进 harness transport；
// - preparing（冷启动中）可取消：Esc 立即合成 cancelled 终态 + notice + summary；
// - 启动失败合成 error + idle + summary——不再有"输入消失且无历史"的半状态。
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
import { textOf } from "../src/event/types.ts";
import { Controller } from "../src/controller/index.ts";
import { SessionStore, type SessionHandle } from "../src/store/store.ts";
import { resolveTestTarget } from "./harness-target.ts";

/** open() 被外部 gate 控制的 adapter：制造稳定的"harness 冷启动中"窗口 */
class GatedOpenAdapter implements HarnessAdapter {
  readonly capabilities: AdapterCapabilities = { prompt: {} };
  sink?: EventSink;
  prompts: string[] = [];
  openGate!: () => void;
  openFail!: (error: Error) => void;
  private readonly gate = new Promise<void>((resolve, reject) => {
    this.openGate = resolve;
    this.openFail = reject;
  });

  constructor(readonly harness: string) {}

  async open(_opts: OpenOptions, sink: EventSink): Promise<HarnessSessionRef> {
    this.sink = sink;
    await this.gate;
    return { harness: this.harness, harnessSessionId: `${this.harness}-ref`, resumed: false };
  }

  /** admission 后立即自动完成本 turn（终态经 sink 报告） */
  async submit(_ref: HarnessSessionRef, input: PromptInput): Promise<PromptReceipt> {
    this.prompts.push(textOf(input.blocks));
    queueMicrotask(() => {
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
    });
    return { accepted: true };
  }

  async cancel(_ref: HarnessSessionRef): Promise<void> {}
  async close(_ref: HarnessSessionRef): Promise<void> {}
}

let root: string;
let session: SessionHandle;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baton-intake-"));
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

/** 直接写入一个已收口、带 summary 的 turn（另一 harness 的既有历史） */
function completedTurn(handle: SessionHandle, harness: string, turnId: string, text: string): void {
  handle.append({
    source: { type: "baton" },
    kind: "user_message",
    harness,
    turnId,
    payload: { messageId: `${turnId}-user`, content: [{ type: "text", text }] },
  });
  handle.append({
    source: { type: "baton" },
    kind: "state_update",
    harness,
    turnId,
    payload: { state: "idle", stopReason: "end_turn" },
  });
  handle.summarizeTurn(turnId);
}

describe("controller-owned user_message at dequeue", () => {
  test("user_message and running are persisted before the harness finishes opening", async () => {
    const adapter = new GatedOpenAdapter("codex");
    const controller = controllerWith(adapter);

    const outcome = controller.submit("codex", [{ type: "text", text: "hello" }]);
    await Bun.sleep(5); // open() 仍被 gate 挡住

    const events = session.readEvents();
    const userMessages = events.filter((ev) => ev.kind === "user_message");
    expect(userMessages).toHaveLength(1);
    expect(userMessages[0]!.source).toEqual({ type: "user" });
    expect(textOf((userMessages[0]!.payload as { content: Array<{ type: string; text: string }> }).content)).toBe(
      "hello",
    );
    const running = events.find(
      (ev) => ev.kind === "state_update" && (ev.payload as { state: string }).state === "running",
    );
    expect(running?.source).toEqual({ type: "baton" });
    // 冷启动阶段对用户可见
    expect(
      events.some((ev) => ev.kind === "_baton_run_status" && (ev.payload as { phase: string | null }).phase === "starting"),
    ).toBe(true);
    expect(adapter.prompts).toHaveLength(0); // 尚未提交给 harness

    adapter.openGate();
    expect(await outcome).toBe("completed");
    // adapter 不再重复发用户消息：正典历史里恰好一条
    const completedEvents = session.readEvents();
    expect(completedEvents.filter((ev) => ev.kind === "user_message")).toHaveLength(1);
    expect(completedEvents.find((ev) => ev.kind === "agent_message")?.source).toEqual({
      type: "harness",
      harnessTargetId: "codex",
    });
    expect(completedEvents.find((ev) => ev.kind === "_baton_turn_summary")?.source).toEqual({
      type: "baton",
    });
  });

  test("canonical user_message keeps the original input; <baton-sync> only reaches the harness prompt", async () => {
    completedTurn(session, "claude-code", "t_prev", "earlier claude work");
    const adapter = new GatedOpenAdapter("codex"); // 无 syncContext ⇒ prepend 注入路径
    adapter.openGate();
    const controller = controllerWith(adapter);

    await controller.submit("codex", [{ type: "text", text: "next step" }]);

    // harness 收到的 prompt 带 sync 块
    expect(adapter.prompts[0]).toContain("<baton-sync>");
    expect(adapter.prompts[0]).toContain("earlier claude work");
    expect(adapter.prompts[0]).toContain("next step");
    // 正典 user_message 是原始输入，且 catch-up 注入不含本 turn 自己的输入（无自回声）
    const userMessage = session
      .readEvents()
      .filter((ev) => ev.kind === "user_message" && ev.harness === "codex")
      .at(-1)!;
    expect(textOf((userMessage.payload as { content: Array<{ type: string; text: string }> }).content)).toBe(
      "next step",
    );
    expect(adapter.prompts[0]!.split("next step")).toHaveLength(2); // prompt 里只出现一次（sync 块内没有）
  });

  test("cancel during preparing synthesizes a cancelled terminal immediately and the binding is reused", async () => {
    const adapter = new GatedOpenAdapter("codex");
    const controller = controllerWith(adapter);

    const first = controller.submit("codex", [{ type: "text", text: "cold start" }]);
    await Bun.sleep(5); // preparing：open() 未完成
    await controller.control({ kind: "interrupt" });

    // Esc 立即生效：cancelled 终态 + 打断 notice + summary，全部不等 open() 完成
    const events = session.readEvents();
    const idles = events.filter(
      (ev) => ev.kind === "state_update" && (ev.payload as { state: string }).state === "idle",
    );
    expect(idles).toHaveLength(1);
    expect((idles[0]!.payload as { stopReason?: string }).stopReason).toBe("cancelled");
    expect(events.filter((ev) => ev.kind === "_baton_notice")).toHaveLength(1);
    expect(events.filter((ev) => ev.kind === "_baton_turn_summary")).toHaveLength(1);

    // 启动随后完成：binding 复用，后续 turn 正常执行；被取消的 turn 从未作为 prompt 提交给
    // harness——但它属于正典历史，fresh native session 经 <baton-sync> 恢复完整逻辑历史时
    // 会带上它（标记 cancelled），这是预期语义而非泄漏
    adapter.openGate();
    expect(await first).toBe("completed");
    expect(await controller.submit("codex", [{ type: "text", text: "warm follow-up" }])).toBe("completed");
    expect(adapter.prompts).toHaveLength(1);
    expect(adapter.prompts[0]).toContain("warm follow-up");
    expect(adapter.prompts[0]).toContain("(cancelled)");
  });

  test("harness startup failure leaves error + idle + summary instead of a vanished input", async () => {
    const adapter = new GatedOpenAdapter("codex");
    const controller = controllerWith(adapter);

    const outcome = controller.submit("codex", [{ type: "text", text: "doomed" }]);
    await Bun.sleep(5);
    adapter.openFail(new Error("spawn blew up"));
    await expect(outcome).rejects.toThrow(/spawn blew up/);

    const events = session.readEvents();
    expect(events.filter((ev) => ev.kind === "user_message")).toHaveLength(1);
    const error = events.find((ev) => ev.kind === "_baton_error_update");
    expect(String((error?.payload as { message: string }).message)).toContain("spawn blew up");
    const idles = events.filter(
      (ev) => ev.kind === "state_update" && (ev.payload as { state: string }).state === "idle",
    );
    expect(idles).toHaveLength(1);
    expect((idles[0]!.payload as { stopReason?: string }).stopReason).toBe("error");
    expect(events.filter((ev) => ev.kind === "_baton_turn_summary")).toHaveLength(1);
    expect(controller.isBusy).toBe(false);
  });
});
