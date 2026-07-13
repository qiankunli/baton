// 停滞观测契约（docs/provider-output-lifecycle.md §5）：活跃 turn 长时间无事件时
// 发一次 `_baton_stall_notice`（可见），活动恢复补 cleared 撤除——但**绝不 finalize**：
// stall 是可自愈观测态，收口仍只由真实终态 / reconcile / 用户 cancel 触发（§4.1）。

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
} from "../src/adapters/types.ts";
import type { AnyEventEnvelope, AnyNewEvent } from "../src/events/types.ts";
import { BatonSessionRuntime } from "../src/session/runtime.ts";
import { applyEvent, emptySessionState } from "../src/store/reduce.ts";
import { SessionStore, type SessionHandle } from "../src/store/store.ts";

class ScriptedAdapter implements AgentAdapter {
  readonly capabilities: AdapterCapabilities = { prompt: {} };
  sink?: EventSink;
  submits: PromptInput[] = [];

  constructor(readonly provider: string = "scripted") {}

  async open(_opts: OpenOptions, sink: EventSink): Promise<ProviderSessionRef> {
    this.sink = sink;
    return { provider: this.provider, providerSessionId: `${this.provider}-ref` };
  }

  async submit(_ref: ProviderSessionRef, input: PromptInput): Promise<PromptReceipt> {
    this.submits.push(input);
    return { accepted: true };
  }

  emit(ev: AnyNewEvent): void {
    this.sink?.(ev);
  }

  async cancel(_ref: ProviderSessionRef): Promise<void> {}
  async close(_ref: ProviderSessionRef): Promise<void> {}
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
  root = mkdtempSync(join(tmpdir(), "baton-stall-"));
  session = new SessionStore(root).createSession({ cwd: "/repo" });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeRuntime(adapter: ScriptedAdapter) {
  return new BatonSessionRuntime({
    session,
    mentionBudgetChars: 4096,
    createAdapter: () => adapter,
    stallThresholdMs: 30,
    stallPollMs: 10,
  });
}

function stallNotices(events: AnyEventEnvelope[]) {
  return events.filter((ev) => ev.kind === "_baton_stall_notice");
}

describe("stall observation", () => {
  test("silent active turn emits one stall notice, but never finalizes", async () => {
    const adapter = new ScriptedAdapter();
    const runtime = makeRuntime(adapter);
    const outcome = runtime.submit("scripted", [{ type: "text", text: "hi" }]);
    await until(() => adapter.submits.length === 1);

    // 不注入任何事件，等待超过 threshold + 一次 poll
    await until(() => stallNotices(session.readEvents()).length >= 1);

    const notices = stallNotices(session.readEvents());
    expect(notices).toHaveLength(1); // 去重：只发一次
    expect((notices[0]!.payload as { cleared?: boolean }).cleared).toBeFalsy();
    expect((notices[0]!.payload as { stalledMs: number }).stalledMs).toBeGreaterThanOrEqual(30);

    // 绝不 finalize：turn 仍活跃，无 idle、无 turn summary
    expect(runtime.isBusy).toBe(true);
    expect(session.readEvents().some((ev) => ev.kind === "_baton_turn_summary")).toBe(false);

    // 收口仍走真实终态
    adapter.emit({ kind: "state_update", provider: "scripted", turnId: adapter.submits[0]!.turnId, payload: { state: "idle", stopReason: "end_turn" } });
    expect(await outcome).toBe("completed");
    await runtime.close();
  });

  test("activity after stall emits a cleared notice", async () => {
    const adapter = new ScriptedAdapter();
    const runtime = makeRuntime(adapter);
    const outcome = runtime.submit("scripted", [{ type: "text", text: "hi" }]);
    await until(() => adapter.submits.length === 1);
    const turnId = adapter.submits[0]!.turnId;

    await until(() => stallNotices(session.readEvents()).length >= 1);

    // 活动恢复：任何命中该 turn 的事件都刷新进展时钟并补 cleared
    adapter.emit({ kind: "agent_message_chunk", provider: "scripted", turnId, payload: { messageId: "m1", content: { type: "text", text: "back" } } });

    await until(() => stallNotices(session.readEvents()).some((ev) => (ev.payload as { cleared?: boolean }).cleared));
    const cleared = stallNotices(session.readEvents()).find((ev) => (ev.payload as { cleared?: boolean }).cleared);
    expect(cleared).toBeDefined();

    adapter.emit({ kind: "state_update", provider: "scripted", turnId, payload: { state: "idle", stopReason: "end_turn" } });
    await outcome;
    await runtime.close();
  });

  test("reduce marks the active turn stalled, then clears it", () => {
    let state = emptySessionState();
    const env = <K extends string>(kind: K, payload: unknown, turnId?: string, seq = ++mseq) =>
      ({ v: 1, ts: new Date(0).toISOString(), seq, batonSessionId: "bs", provider: "p", kind, payload, turnId }) as unknown as AnyEventEnvelope;

    state = applyEvent(state, env("state_update", { state: "running" }, "t1"));
    state = applyEvent(state, env("_baton_stall_notice", { stalledMs: 999 }, "t1"));
    expect(state.activeTurns.get("t1")?.stalled).toBe(true);

    state = applyEvent(state, env("_baton_stall_notice", { stalledMs: 0, cleared: true }, "t1"));
    expect(state.activeTurns.get("t1")?.stalled).toBe(false);

    // idle 收口后，迟到的 stall 事件不复活已结束的 turn
    state = applyEvent(state, env("state_update", { state: "idle", stopReason: "end_turn" }, "t1"));
    state = applyEvent(state, env("_baton_stall_notice", { stalledMs: 999 }, "t1"));
    expect(state.activeTurns.has("t1")).toBe(false);
  });
});

let mseq = 0;
