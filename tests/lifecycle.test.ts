// Phase 2 生命周期契约（design §4.1 / 验收矩阵 5、10、11、12）：
// turn 完成由 idle 终态事件驱动；finalize 按 baton turn id 幂等——重复/迟到终态
// 不二次终结、不关闭更新的 turn；cancel 走确认或宽限期合成；transport 失败必须合成终态。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { CodexAdapter } from "../src/adapters/codex/adapter.ts";
import type {
  AdapterCapabilities,
  HarnessAdapter,
  EventSink,
  OpenOptions,
  PromptInput,
  PromptReceipt,
  HarnessSessionRef,
} from "../src/adapters/types.ts";
import type { AnyEventEnvelope, AnyEventDraft, StopReason } from "../src/event/types.ts";
import { Controller, INTERRUPTED_NOTICE_TITLE } from "../src/session/controller.ts";
import { SessionStore, type SessionHandle } from "../src/store/store.ts";

/** 事件完全由测试脚本控制的 adapter：submit 只回执，终态由测试显式注入 */
class ScriptedAdapter implements HarnessAdapter {
  readonly capabilities: AdapterCapabilities = { prompt: {} };
  sink?: EventSink;
  submits: PromptInput[] = [];
  cancels = 0;
  onCancel?: () => void;

  constructor(readonly harness: string = "scripted") {}

  async open(_opts: OpenOptions, sink: EventSink): Promise<HarnessSessionRef> {
    this.sink = sink;
    return { harness: this.harness, harnessSessionId: `${this.harness}-ref` };
  }

  // 新契约：user_message / running 由 controller 出队时落盘，adapter submit 只做 admission
  async submit(_ref: HarnessSessionRef, input: PromptInput): Promise<PromptReceipt> {
    this.submits.push(input);
    return { accepted: true };
  }

  emit(ev: AnyEventDraft): void {
    this.sink?.(ev);
  }

  idle(turnId: string, stopReason: StopReason): void {
    this.emit({
      kind: "state_update",
      harness: this.harness,
      turnId,
      payload: { state: "idle", stopReason },
    });
  }

  async cancel(_ref: HarnessSessionRef): Promise<void> {
    this.cancels++;
    this.onCancel?.();
  }

  async close(_ref: HarnessSessionRef): Promise<void> {}
}

async function until(cond: () => boolean, timeoutMs = 2000): Promise<void> {
  const start = Date.now();
  while (!cond()) {
    if (Date.now() - start > timeoutMs) throw new Error("condition not met in time");
    await Bun.sleep(2);
  }
}

let root: string;
let session: SessionHandle;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baton-lifecycle-"));
  session = new SessionStore(root).createSession({ cwd: "/repo" });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeController(adapter: ScriptedAdapter, cancelGraceMs?: number) {
  return new Controller({
    session,
    mentionBudgetChars: 4096,
    createAdapter: () => adapter,
    cancelGraceMs,
  });
}

function kinds(events: AnyEventEnvelope[]): string[] {
  return events.map((ev) => ev.kind);
}

describe("idempotent turn finalize", () => {
  test("duplicate terminal finalizes once: single summary, second idle is inert", async () => {
    const adapter = new ScriptedAdapter();
    const controller = makeController(adapter);
    const outcome = controller.submit("scripted", [{ type: "text", text: "hi" }]);

    await until(() => adapter.submits.length === 1);
    const turnId = adapter.submits[0]!.turnId;
    adapter.idle(turnId, "end_turn");
    adapter.idle(turnId, "end_turn"); // 物理终态重复到达（reconnect/race）
    expect(await outcome).toBe("completed");

    const events = session.readEvents();
    expect(events.filter((ev) => ev.kind === "_baton_turn_summary")).toHaveLength(1);
    expect(controller.isBusy).toBe(false);
  });

  test("late terminal from a previous turn cannot close the newer active turn", async () => {
    const adapter = new ScriptedAdapter();
    const controller = makeController(adapter);

    const first = controller.submit("scripted", [{ type: "text", text: "one" }]);
    await until(() => adapter.submits.length === 1);
    const turn1 = adapter.submits[0]!.turnId;
    adapter.idle(turn1, "end_turn");
    await first;

    const second = controller.submit("scripted", [{ type: "text", text: "two" }]);
    await until(() => adapter.submits.length === 2);
    const turn2 = adapter.submits[1]!.turnId;

    adapter.idle(turn1, "end_turn"); // 迟到的旧 turn 终态
    const raced = await Promise.race([second.then(() => "done"), Bun.sleep(30).then(() => "pending")]);
    expect(raced).toBe("pending"); // turn2 不能被它关闭

    adapter.idle(turn2, "end_turn");
    expect(await second).toBe("completed");
    expect(session.readEvents().filter((ev) => ev.kind === "_baton_turn_summary")).toHaveLength(2);
  });
});

describe("cancel", () => {
  test("harness-confirmed cancel leaves an interrupted notice and advances the queue", async () => {
    const adapter = new ScriptedAdapter();
    const controller = makeController(adapter);
    adapter.onCancel = () => adapter.idle(adapter.submits.at(-1)!.turnId, "cancelled");

    const first = controller.submit("scripted", [{ type: "text", text: "long job" }]);
    const queued = controller.submit("scripted", [{ type: "text", text: "follow-up" }]);
    await until(() => adapter.submits.length === 1);

    await controller.control({ kind: "interrupt" });
    expect(await first).toBe("completed");

    // 排队的 follow-up 在打断后自动开跑；测试手动放行它的终态
    await until(() => adapter.submits.length === 2);
    adapter.idle(adapter.submits[1]!.turnId, "end_turn");
    expect(await queued).toBe("completed");

    const events = session.readEvents();
    const notice = events.find((ev) => ev.kind === "_baton_notice");
    expect(notice?.payload).toMatchObject({ level: "warning", title: INTERRUPTED_NOTICE_TITLE });
    // 时间线顺序：打断标记在被打断 turn 的终态之后、排队 follow-up 的 user_message 之前
    const orderOfKinds = kinds(events);
    expect(orderOfKinds.indexOf("_baton_notice")).toBeGreaterThan(orderOfKinds.indexOf("state_update"));
    const followUpUserMessage = events.filter((ev) => ev.kind === "user_message")[1]!;
    expect(followUpUserMessage.seq).toBeGreaterThan(notice!.seq);
    // 打断的 turn 与 follow-up 各生成一次 summary
    expect(events.filter((ev) => ev.kind === "_baton_turn_summary")).toHaveLength(2);
    expect(adapter.submits).toHaveLength(2);
    // 投影侧可见：timeline 出现 notice 条目
    expect(session.loadState().timeline.some((entry) => entry.type === "notice")).toBe(true);
  });

  test("cancel grace expiry synthesizes error + cancelled terminal and unblocks the queue", async () => {
    const adapter = new ScriptedAdapter();
    const controller = makeController(adapter, 20); // harness 永不确认
    const outcome = controller.submit("scripted", [{ type: "text", text: "stuck" }]);
    await until(() => adapter.submits.length === 1);

    await controller.control({ kind: "interrupt" });
    expect(await outcome).toBe("completed");

    const events = session.readEvents();
    const error = events.find((ev) => ev.kind === "_baton_error_update");
    expect(error?.payload).toMatchObject({ retryable: false });
    expect(String((error?.payload as { message: string }).message)).toContain("grace period expired");
    const idles = events.filter(
      (ev) => ev.kind === "state_update" && (ev.payload as { state: string }).state === "idle",
    );
    expect(idles).toHaveLength(1);
    expect((idles[0]!.payload as { stopReason?: string }).stopReason).toBe("cancelled");
    expect(events.filter((ev) => ev.kind === "_baton_notice")).toHaveLength(1);
    expect(adapter.cancels).toBe(1);
    expect(controller.isBusy).toBe(false);
  });
});

describe("codex transport failure", () => {
  test("app-server dying mid-turn synthesizes error + idle exactly once", async () => {
    // 假 app-server：应答 initialize / thread/start / turn/start 后直接退出进程
    const script = `
      const rl = require("node:readline").createInterface({ input: process.stdin });
      const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\\n");
      rl.on("line", (line) => {
        const msg = JSON.parse(line);
        if (msg.method === "initialize") send({ id: msg.id, result: {} });
        else if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: "th1" } } });
        else if (msg.method === "turn/start") {
          send({ id: msg.id, result: { turn: { id: "turn-1", status: "inProgress" } } });
          setTimeout(() => process.exit(1), 20);
        }
      });
    `;
    const adapter = new CodexAdapter({
      interactionHandler: async (req) => ({ kind: "permission", outcome: "selected", optionId: "decline" }),
      command: ["bun", "-e", script],
    });
    const events: AnyEventDraft[] = [];
    const ref = await adapter.open({ cwd: "/tmp" }, (ev) => events.push(ev));
    await adapter.submit(ref, { turnId: "t_1", messageId: "m_1", blocks: [{ type: "text", text: "go" }] });

    await until(() =>
      events.some((ev) => ev.kind === "state_update" && (ev.payload as { state: string }).state === "idle"),
    );
    const errors = events.filter((ev) => ev.kind === "_baton_error_update");
    expect(errors).toHaveLength(1);
    expect(String((errors[0]!.payload as { message: string }).message)).toContain("exited");
    const idles = events.filter(
      (ev) => ev.kind === "state_update" && (ev.payload as { state: string }).state === "idle",
    );
    expect(idles).toHaveLength(1);
    expect(idles[0]!.turnId).toBe("t_1");
  });
});
