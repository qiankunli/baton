// harness 同步水位（syncedSeq）契约：水位只在注入时前进到本批 throughSeq。
// 回归背景（bug#5）：finalize 曾把水位无条件推到文件尾——driven turn 运行期间
// 其它 harness 落盘的 summary（如并发 observed turn）被越过且永不回补，
// 跨 harness 接力对这段进展永久盲区。
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
import type { PromptBlock } from "../src/events/types.ts";
import { textOf } from "../src/events/types.ts";
import { BatonSessionRuntime } from "../src/session/runtime.ts";
import { SessionStore, type SessionHandle } from "../src/store/store.ts";

/** submit 只记账 + 报 running；终态由测试经 finish() 手动触发（确定性时序） */
class ManualAdapter implements HarnessAdapter {
  readonly capabilities: AdapterCapabilities = { prompt: {} };
  sink?: EventSink;
  prompts: string[] = [];
  private activeTurn?: PromptInput;

  constructor(readonly harness: string) {}

  async open(_opts: OpenOptions, sink: EventSink): Promise<HarnessSessionRef> {
    this.sink = sink;
    return { harness: this.harness, harnessSessionId: `${this.harness}-ref`, resumed: false };
  }

  // 新契约：user_message / running 由 runtime 出队时落盘，adapter submit 只做 admission
  async submit(_ref: HarnessSessionRef, input: PromptInput): Promise<PromptReceipt> {
    this.activeTurn = input;
    this.prompts.push(textOf(input.blocks));
    return { accepted: true };
  }

  finish(): void {
    const turn = this.activeTurn;
    if (!turn) throw new Error("no active turn to finish");
    this.activeTurn = undefined;
    this.sink?.({
      kind: "agent_message",
      harness: this.harness,
      turnId: turn.turnId,
      payload: { messageId: `${turn.turnId}-agent`, content: [{ type: "text", text: "done" }] },
    });
    this.sink?.({
      kind: "state_update",
      harness: this.harness,
      turnId: turn.turnId,
      payload: { state: "idle", stopReason: "end_turn" },
    });
  }

  async cancel(_ref: HarnessSessionRef): Promise<void> {}
  async close(_ref: HarnessSessionRef): Promise<void> {}
}

/** 支持 syncContext 的变体（急切注入形态：resolve 即送达，不占 prompt） */
class SyncableManualAdapter extends ManualAdapter {
  synced: string[] = [];

  async syncContext(_ref: HarnessSessionRef, blocks: PromptBlock[]): Promise<void> {
    this.synced.push(textOf(blocks));
  }
}

/** 声明 capabilities.sync 的变体（codex 形态：catch-up 走 submit 的 syncBlocks side-channel） */
class SyncBlocksManualAdapter extends ManualAdapter {
  override readonly capabilities: AdapterCapabilities = { prompt: {}, sync: { supported: true } };
  syncPayloads: string[] = [];
  failNextSubmit = false;

  override async submit(ref: HarnessSessionRef, input: PromptInput): Promise<PromptReceipt> {
    if (this.failNextSubmit) {
      this.failNextSubmit = false;
      throw new Error("admission down");
    }
    if (input.syncBlocks?.length) this.syncPayloads.push(textOf(input.syncBlocks));
    return super.submit(ref, input);
  }
}

let root: string;
let session: SessionHandle;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baton-watermark-"));
  session = new SessionStore(root).createSession({ cwd: "/repo" });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/** 直接写入一个已收口、带 summary 的 turn（模拟另一 harness 的并发产出） */
function completedTurn(handle: SessionHandle, harness: string, turnId: string, text: string): void {
  handle.append({
    kind: "agent_message",
    harness,
    turnId,
    payload: { messageId: `${turnId}-agent`, content: [{ type: "text", text }] },
  });
  handle.append({ kind: "state_update", harness, turnId, payload: { state: "idle", stopReason: "end_turn" } });
  handle.summarizeTurn(turnId);
}

function lastSummarySeq(handle: SessionHandle): number {
  return (
    handle
      .readEvents()
      .filter((ev) => ev.kind === "_baton_turn_summary")
      .at(-1)?.seq ?? 0
  );
}

describe("watermark advances only at injection (bug#5 regression)", () => {
  test("finalize does not push syncedSeq past concurrent progress; next injection backfills it", async () => {
    const adapter = new SyncableManualAdapter("codex");
    const runtime = new BatonSessionRuntime({ session, mentionBudgetChars: 4096, createAdapter: () => adapter });

    // turn 1：无历史可注入
    const first = runtime.submit("codex", [{ type: "text", text: "one" }]);
    await Bun.sleep(1);
    // driven turn 运行期间，另一 harness 的进展落盘（并发 observed turn 的等价形态）
    completedTurn(session, "claude-code", "t_claude", "claude progress landed mid-turn");
    adapter.finish();
    await first;

    // 收口不推水位：不越过尚未注入的 claude summary
    const tailSeq = session.readEvents().at(-1)!.seq;
    expect(session.meta.harnessSessions["codex"]?.syncedSeq ?? 0).toBeLessThan(tailSeq);

    // turn 2：注入补上并发期间的 claude 进展，且不复读自己的 turn
    const second = runtime.submit("codex", [{ type: "text", text: "two" }]);
    await Bun.sleep(1);
    expect(adapter.synced).toHaveLength(1);
    expect(adapter.synced[0]).toContain("claude progress landed mid-turn");
    expect(adapter.synced[0]).not.toContain("one");
    // 水位推进到注入时点的 summary 尾 seq（含自己的 turn-1 summary：亲历即已同步）
    const throughSeq = lastSummarySeq(session);
    expect(session.meta.harnessSessions["codex"]?.syncedSeq).toBe(throughSeq);
    adapter.finish();
    await second;

    // turn 3：没有新的他方进展（只有自己 turn-2 的 summary）→ 不再注入
    const third = runtime.submit("codex", [{ type: "text", text: "three" }]);
    await Bun.sleep(1);
    expect(adapter.synced).toHaveLength(1); // 同一 summary 不二次注入
    adapter.finish();
    await third;
  });

  test("prepend-style adapter (no syncContext) advances the watermark after admission", async () => {
    completedTurn(session, "claude-code", "t_claude", "earlier claude work");
    const injectionTail = lastSummarySeq(session);

    const adapter = new ManualAdapter("codex");
    const runtime = new BatonSessionRuntime({ session, mentionBudgetChars: 4096, createAdapter: () => adapter });

    const first = runtime.submit("codex", [{ type: "text", text: "hello" }]);
    await Bun.sleep(1);
    // sync 块随 prompt 前置注入
    expect(adapter.prompts[0]).toContain("<baton-sync>");
    expect(adapter.prompts[0]).toContain("earlier claude work");
    // admission 通过即推进水位到注入时点（修复前 prepend 分支不更新，靠 finalize 推尾掩盖）
    expect(session.meta.harnessSessions["codex"]?.syncedSeq).toBe(injectionTail);
    adapter.finish();
    await first;

    // finalize 后水位仍停在注入时点，不被推到文件尾
    expect(session.meta.harnessSessions["codex"]?.syncedSeq).toBe(injectionTail);

    // 第二轮：无新的他方进展 → 不重复注入
    const second = runtime.submit("codex", [{ type: "text", text: "again" }]);
    await Bun.sleep(1);
    expect(adapter.prompts[1]).not.toContain("baton-sync");
    adapter.finish();
    await second;
  });

  test("sync-capable adapter receives syncBlocks side-channel; watermark advances after admission", async () => {
    completedTurn(session, "claude-code", "t_claude", "earlier claude work");

    const adapter = new SyncBlocksManualAdapter("codex");
    const runtime = new BatonSessionRuntime({ session, mentionBudgetChars: 4096, createAdapter: () => adapter });

    // 第一次 submit admission 失败：sync 视为未送达，水位不动
    adapter.failNextSubmit = true;
    await expect(runtime.submit("codex", [{ type: "text", text: "hello" }])).rejects.toThrow("admission down");
    expect(session.meta.harnessSessions["codex"]?.syncedSeq ?? 0).toBe(0);

    // 重试：sync 走 side-channel（不混入 prompt 正文），admission 通过后水位推进到
    // 本次注入时点的 summary 尾（含失败 turn 自己的 summary：亲历即已同步）
    const injectionTail = lastSummarySeq(session);
    const second = runtime.submit("codex", [{ type: "text", text: "hello again" }]);
    await Bun.sleep(1);
    expect(adapter.prompts[0]).toBe("hello again");
    expect(adapter.syncPayloads[0]).toContain("<baton-sync>");
    expect(adapter.syncPayloads[0]).toContain("earlier claude work");
    expect(session.meta.harnessSessions["codex"]?.syncedSeq).toBe(injectionTail);
    adapter.finish();
    await second;

    // 第三轮：无新的他方进展 → 不重复注入
    const third = runtime.submit("codex", [{ type: "text", text: "again" }]);
    await Bun.sleep(1);
    expect(adapter.syncPayloads).toHaveLength(1);
    adapter.finish();
    await third;
  });
});
