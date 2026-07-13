// 对账契约（docs/provider-output-lifecycle.md §5）：turn 停滞时 runtime 主动查
// provider 真实运行态。idle 裁决 → 自愈 finalize；其余 → 保留提示、不动终态。
// 未声明 reconcile 能力的 provider 只走停滞提示（不发起对账）。

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { mapThreadStatus } from "../src/adapters/codex/adapter.ts";
import type {
  AdapterCapabilities,
  AgentAdapter,
  EventSink,
  OpenOptions,
  PromptInput,
  PromptReceipt,
  ProviderSessionRef,
  ReconcileVerdict,
} from "../src/adapters/types.ts";
import type { AnyEventEnvelope, AnyNewEvent } from "../src/events/types.ts";
import { BatonSessionRuntime } from "../src/session/runtime.ts";
import { SessionStore, type SessionHandle } from "../src/store/store.ts";

class ReconcilableAdapter implements AgentAdapter {
  readonly capabilities: AdapterCapabilities;
  sink?: EventSink;
  submits: PromptInput[] = [];
  reconcileCalls = 0;

  constructor(
    private readonly verdict: ReconcileVerdict | (() => Promise<ReconcileVerdict>),
    opts: { declare?: boolean } = {},
    readonly provider: string = "scripted",
  ) {
    this.capabilities = { prompt: {}, ...(opts.declare === false ? {} : { reconcile: { supported: true } }) };
  }

  async open(_o: OpenOptions, sink: EventSink): Promise<ProviderSessionRef> {
    this.sink = sink;
    return { provider: this.provider, providerSessionId: `${this.provider}-ref` };
  }
  async submit(_r: ProviderSessionRef, input: PromptInput): Promise<PromptReceipt> {
    this.submits.push(input);
    return { accepted: true };
  }
  emit(ev: AnyNewEvent): void {
    this.sink?.(ev);
  }
  async cancel(): Promise<void> {}
  async close(): Promise<void> {}

  async reconcile(): Promise<ReconcileVerdict> {
    this.reconcileCalls++;
    return typeof this.verdict === "function" ? this.verdict() : this.verdict;
  }
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
  root = mkdtempSync(join(tmpdir(), "baton-reconcile-"));
  session = new SessionStore(root).createSession({ cwd: "/repo" });
});
afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function makeRuntime(adapter: ReconcilableAdapter) {
  return new BatonSessionRuntime({
    session,
    mentionBudgetChars: 4096,
    createAdapter: () => adapter,
    stallThresholdMs: 30,
    stallPollMs: 10,
  });
}

const hasSummary = () => session.readEvents().some((ev: AnyEventEnvelope) => ev.kind === "_baton_turn_summary");

describe("mapThreadStatus", () => {
  test("codex thread.status wire shapes → verdict", () => {
    expect(mapThreadStatus({ type: "idle" })).toBe("idle");
    expect(mapThreadStatus({ type: "active", activeFlags: [] })).toBe("active");
    expect(mapThreadStatus({ type: "active", activeFlags: ["waitingOnApproval"] })).toBe("waiting_approval");
    expect(mapThreadStatus({ type: "active", activeFlags: ["waitingOnUserInput"] })).toBe("waiting_input");
    expect(mapThreadStatus({ type: "notLoaded" })).toBe("unknown");
    expect(mapThreadStatus({ type: "systemError" })).toBe("unknown");
    expect(mapThreadStatus(undefined)).toBe("unknown");
  });
});

describe("runtime reconcile", () => {
  test("idle verdict self-heals: turn finalizes without a real terminal", async () => {
    const adapter = new ReconcilableAdapter({ state: "idle" });
    const runtime = makeRuntime(adapter);
    const outcome = runtime.submit("scripted", [{ type: "text", text: "hi" }]);
    await until(() => adapter.submits.length === 1);

    // 不注入任何真实终态；对账 idle 应自愈收口
    expect(await outcome).toBe("completed");
    expect(adapter.reconcileCalls).toBeGreaterThanOrEqual(1);
    expect(hasSummary()).toBe(true);
    expect(runtime.isBusy).toBe(false);
    await runtime.close();
  });

  test("active verdict keeps waiting: no finalize, stall notice stays", async () => {
    const adapter = new ReconcilableAdapter({ state: "active" });
    const runtime = makeRuntime(adapter);
    const outcome = runtime.submit("scripted", [{ type: "text", text: "hi" }]);
    await until(() => adapter.submits.length === 1);
    await until(() => adapter.reconcileCalls >= 2); // 每个停滞 tick 都探

    expect(hasSummary()).toBe(false);
    expect(runtime.isBusy).toBe(true);
    expect(session.readEvents().some((ev) => ev.kind === "_baton_stall_notice")).toBe(true);

    adapter.emit({ kind: "state_update", provider: "scripted", turnId: adapter.submits[0]!.turnId, payload: { state: "idle", stopReason: "end_turn" } });
    expect(await outcome).toBe("completed");
    await runtime.close();
  });

  test("probe failure = unknown: does not finalize", async () => {
    const adapter = new ReconcilableAdapter(() => Promise.reject(new Error("boom")));
    const runtime = makeRuntime(adapter);
    const outcome = runtime.submit("scripted", [{ type: "text", text: "hi" }]);
    await until(() => adapter.submits.length === 1);
    await until(() => adapter.reconcileCalls >= 2);

    expect(hasSummary()).toBe(false);
    expect(runtime.isBusy).toBe(true);

    adapter.emit({ kind: "state_update", provider: "scripted", turnId: adapter.submits[0]!.turnId, payload: { state: "idle", stopReason: "end_turn" } });
    await outcome;
    await runtime.close();
  });

  test("no reconcile capability → falls back to stall-only, probe never called", async () => {
    const adapter = new ReconcilableAdapter({ state: "idle" }, { declare: false });
    const runtime = makeRuntime(adapter);
    const outcome = runtime.submit("scripted", [{ type: "text", text: "hi" }]);
    await until(() => adapter.submits.length === 1);
    await until(() => session.readEvents().some((ev) => ev.kind === "_baton_stall_notice"));

    // 能力未声明：runtime 不发起对账，即便 adapter 实现了 reconcile 也不调
    expect(adapter.reconcileCalls).toBe(0);
    expect(hasSummary()).toBe(false);
    expect(runtime.isBusy).toBe(true);

    adapter.emit({ kind: "state_update", provider: "scripted", turnId: adapter.submits[0]!.turnId, payload: { state: "idle", stopReason: "end_turn" } });
    await outcome;
    await runtime.close();
  });
});
