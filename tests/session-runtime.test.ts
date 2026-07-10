import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AgentAdapter,
  EventSink,
  ModelOption,
  PromptOptions,
  ProviderSessionRef,
  StartOptions,
} from "../src/adapters/types.ts";
import type { ContentBlock } from "../src/events/types.ts";
import { textOf } from "../src/events/types.ts";
import { BatonSessionRuntime } from "../src/session/runtime.ts";
import { SessionStore, type SessionHandle } from "../src/store/store.ts";

class FakeAdapter implements AgentAdapter {
  startOptions?: StartOptions;
  model: string | null = null;
  synced: string[] = [];
  prompts: string[] = [];

  constructor(
    readonly provider: string,
    private readonly hooks: { enter?: () => void; leave?: () => void; delayMs?: number } = {},
  ) {}

  async start(opts: StartOptions): Promise<ProviderSessionRef> {
    this.startOptions = opts;
    return {
      provider: this.provider,
      providerSessionId: `${this.provider}-runtime-ref`,
      resumed: Boolean(opts.resumeSessionId),
    };
  }

  nativeSessionId(_ref: ProviderSessionRef): string {
    return `${this.provider}-native`;
  }

  async syncContext(_ref: ProviderSessionRef, blocks: ContentBlock[]): Promise<void> {
    this.synced.push(textOf(blocks));
  }

  async listModels(_ref: ProviderSessionRef): Promise<ModelOption[]> {
    return [{ id: "default", label: "Default" }, { id: "fast", label: "Fast" }];
  }

  async setModel(_ref: ProviderSessionRef, modelId: string | null): Promise<void> {
    this.model = modelId === "default" ? null : modelId;
  }

  currentModel(_ref: ProviderSessionRef): string | null {
    return this.model;
  }

  async prompt(
    _ref: ProviderSessionRef,
    blocks: ContentBlock[],
    sink: EventSink,
    opts: PromptOptions,
  ): Promise<void> {
    this.hooks.enter?.();
    this.prompts.push(textOf(blocks));
    sink({
      kind: "user_message",
      provider: this.provider,
      turnId: opts.turnId,
      payload: { messageId: `${opts.turnId}-user`, content: blocks },
    });
    if (this.hooks.delayMs) await Bun.sleep(this.hooks.delayMs);
    sink({
      kind: "agent_message",
      provider: this.provider,
      turnId: opts.turnId,
      payload: { messageId: `${opts.turnId}-agent`, content: [{ type: "text", text: "done" }] },
    });
    sink({
      kind: "state_update",
      provider: this.provider,
      turnId: opts.turnId,
      payload: { state: "idle", stopReason: "end_turn" },
    });
    this.hooks.leave?.();
  }

  async cancel(_ref: ProviderSessionRef): Promise<void> {}
  async close(_ref: ProviderSessionRef): Promise<void> {}
}

let root: string;
let session: SessionHandle;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baton-runtime-"));
  session = new SessionStore(root).createSession({ cwd: "/repo" });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function completedTurn(handle: SessionHandle, provider: string, turnId: string, text: string): void {
  handle.append({
    kind: "user_message",
    provider,
    turnId,
    payload: { messageId: `${turnId}-user`, content: [{ type: "text", text }] },
  });
  handle.append({
    kind: "agent_message",
    provider,
    turnId,
    payload: { messageId: `${turnId}-agent`, content: [{ type: "text", text: `${text}-done` }] },
  });
  handle.append({
    kind: "state_update",
    provider,
    turnId,
    payload: { state: "idle", stopReason: "end_turn" },
  });
  handle.summarizeTurn(turnId);
}

describe("BatonSessionRuntime", () => {
  test("accepts provider IDs outside the initially bundled registry", async () => {
    const adapter = new FakeAdapter("example-provider");
    const runtime = new BatonSessionRuntime({
      session,
      mentionBudgetChars: 4096,
      createAdapter: (provider) => {
        expect(provider).toBe("example");
        return adapter;
      },
    });

    await runtime.submit("example", [{ type: "text", text: "hello" }]);

    expect(adapter.prompts).toEqual(["hello"]);
    expect(session.meta.providerSessions["example-provider"]?.providerSessionId).toBe(
      "example-provider-native",
    );
  });

  test("serializes turns across providers into one BatonSession timeline", async () => {
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const adapters = new Map<string, FakeAdapter>();
    const runtime = new BatonSessionRuntime({
      session,
      mentionBudgetChars: 4096,
      createAdapter: (provider) => {
        const adapter = new FakeAdapter(provider === "claude" ? "claude-code" : provider, {
          delayMs: 10,
          enter: () => {
            active++;
            maxActive = Math.max(maxActive, active);
            order.push(`start:${provider}`);
          },
          leave: () => {
            order.push(`end:${provider}`);
            active--;
          },
        });
        adapters.set(provider, adapter);
        return adapter;
      },
    });

    await Promise.all([
      runtime.submit("codex", [{ type: "text", text: "one" }]),
      runtime.submit("claude", [{ type: "text", text: "two" }]),
    ]);

    expect(maxActive).toBe(1);
    expect(order).toEqual(["start:codex", "end:codex", "start:claude", "end:claude"]);
    expect(session.loadState().turnSummaries).toHaveLength(2);
    expect(adapters.get("codex")?.prompts).toEqual(["one"]);
  });

  test("exposes queued turns and recalls the latest one before it starts", async () => {
    const adapter = new FakeAdapter("codex", { delayMs: 20 });
    const runtime = new BatonSessionRuntime({
      session,
      mentionBudgetChars: 4096,
      createAdapter: () => adapter,
    });

    const active = runtime.submit("codex", [{ type: "text", text: "one" }]);
    const queued = runtime.submit("codex", [{ type: "text", text: "two" }]);
    const latest = runtime.submit("claude", [{ type: "text", text: "three" }]);

    expect(runtime.queuedTurns.map((turn) => textOf(turn.blocks))).toEqual(["two", "three"]);
    const recalled = runtime.recallLatestQueued();
    expect(recalled && textOf(recalled.blocks)).toBe("three");
    expect(runtime.queueLength).toBe(1);
    expect(await latest).toBe("recalled");
    expect(await active).toBe("completed");
    expect(await queued).toBe("completed");
    expect(adapter.prompts).toEqual(["one", "two"]);
  });

  test("rebuilds full BatonSession history for a fresh provider before prompting", async () => {
    completedTurn(session, "codex", "t_old", "existing work");
    const claude = new FakeAdapter("claude-code");
    const runtime = new BatonSessionRuntime({
      session,
      mentionBudgetChars: 4096,
      createAdapter: () => claude,
    });

    await runtime.submit("claude", [{ type: "text", text: "continue" }]);

    expect(claude.synced).toHaveLength(1);
    expect(claude.synced[0]).toContain("BatonSession history");
    expect(claude.synced[0]).toContain("existing work");
    expect(claude.prompts).toEqual(["continue"]);
    expect(session.meta.providerSessions["claude-code"]?.syncedSeq).toBeGreaterThan(0);
  });

  test("resumes native session, restores model, and syncs only other-provider progress", async () => {
    completedTurn(session, "codex", "t_codex", "old codex work");
    const watermark = session.readEvents().at(-1)?.seq ?? 0;
    session.setProviderSession("codex", {
      provider: "codex",
      providerSessionId: "thread-old",
      model: "fast",
      syncedSeq: watermark,
    });
    completedTurn(session, "claude-code", "t_claude", "new claude work");
    const codex = new FakeAdapter("codex");
    const runtime = new BatonSessionRuntime({
      session,
      mentionBudgetChars: 4096,
      createAdapter: () => codex,
    });

    await runtime.submit("codex", [{ type: "text", text: "next" }]);

    expect(codex.startOptions?.resumeSessionId).toBe("thread-old");
    expect(codex.model).toBe("fast");
    expect(codex.synced[0]).toContain("new claude work");
    expect(codex.synced[0]).not.toContain("old codex work");
    expect(session.meta.providerSessions.codex?.providerSessionId).toBe("codex-native");
  });
});
