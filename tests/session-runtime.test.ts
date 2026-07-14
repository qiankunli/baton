import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AdapterCapabilities,
  AgentAdapter,
  EventSink,
  ModelOption,
  OpenOptions,
  PromptInput,
  PromptReceipt,
  ProviderSessionRef,
} from "../src/adapters/types.ts";
import type { AnyEventEnvelope, PermissionRequest, PromptBlock, QuestionRequest } from "../src/events/types.ts";
import { textOf } from "../src/events/types.ts";
import { BatonSessionRuntime, type InteractionHandlers } from "../src/session/runtime.ts";
import { SessionStore, type SessionHandle } from "../src/store/store.ts";

class FakeAdapter implements AgentAdapter {
  readonly capabilities: AdapterCapabilities = { prompt: {} };
  openOptions?: OpenOptions;
  sink?: EventSink;
  model: string | null = null;
  synced: string[] = [];
  prompts: string[] = [];

  constructor(
    readonly provider: string,
    private readonly hooks: { enter?: () => void; leave?: () => void; delayMs?: number } = {},
  ) {}

  async open(opts: OpenOptions, sink: EventSink): Promise<ProviderSessionRef> {
    this.openOptions = opts;
    this.sink = sink;
    return {
      provider: this.provider,
      providerSessionId: `${this.provider}-runtime-ref`,
      resumed: Boolean(opts.resumeSessionId),
    };
  }

  nativeSessionId(_ref: ProviderSessionRef): string {
    return `${this.provider}-native`;
  }

  async syncContext(_ref: ProviderSessionRef, blocks: PromptBlock[]): Promise<void> {
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

  /** submit 立即回执；事件（含终态）异步经 open 绑定的 sink 上报。user_message 由 runtime 落盘 */
  async submit(_ref: ProviderSessionRef, input: PromptInput): Promise<PromptReceipt> {
    this.hooks.enter?.();
    this.prompts.push(textOf(input.blocks));
    void (async () => {
      if (this.hooks.delayMs) await Bun.sleep(this.hooks.delayMs);
      this.sink?.({
        kind: "agent_message",
        provider: this.provider,
        turnId: input.turnId,
        payload: { messageId: `${input.turnId}-agent`, content: [{ type: "text", text: "done" }] },
      });
      this.hooks.leave?.();
      this.sink?.({
        kind: "state_update",
        provider: this.provider,
        turnId: input.turnId,
        payload: { state: "idle", stopReason: "end_turn" },
      });
    })();
    return { accepted: true };
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

  test("publishes the persisted turn summary to event-stream subscribers", async () => {
    const adapter = new FakeAdapter("codex");
    const events: AnyEventEnvelope[] = [];
    // 投影单通道：消费者订阅事件流（append 即广播），不从 submit 的回调取事件
    session.subscribe((event) => events.push(event));
    const runtime = new BatonSessionRuntime({
      session,
      mentionBudgetChars: 4096,
      createAdapter: () => adapter,
    });

    await runtime.submit("codex", [{ type: "text", text: "hello" }]);

    expect(events.filter((event) => event.kind === "_baton_turn_summary")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "agent_message")).toHaveLength(1);
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
      modelPreferences: { codex: "remembered-global-model" },
      createAdapter: () => codex,
    });

    await runtime.submit("codex", [{ type: "text", text: "next" }]);

    expect(codex.openOptions?.resumeSessionId).toBe("thread-old");
    expect(codex.model).toBe("fast");
    expect(codex.synced[0]).toContain("new claude work");
    expect(codex.synced[0]).not.toContain("old codex work");
    expect(session.meta.providerSessions.codex?.providerSessionId).toBe("codex-native");
  });

  test("uses the remembered provider model for a new BatonSession", async () => {
    const codex = new FakeAdapter("codex");
    const runtime = new BatonSessionRuntime({
      session,
      mentionBudgetChars: 4096,
      modelPreferences: { codex: "fast" },
      createAdapter: () => codex,
    });

    await runtime.submit("codex", [{ type: "text", text: "next" }]);

    expect(codex.model).toBe("fast");
    expect(session.meta.providerSessions.codex?.model).toBe("fast");
  });
});

// ---- 交互 resolver 注册表：adapter 的 await 点由统一 respond() 唤醒（permission/question 同路由）----
// 事件留痕（*_request / *_resolved）由 adapter 负责；runtime 只持有 requestId → resolver 通道。

describe("interaction resolver registry", () => {
  /** 先审批、后提问、再收口的交互式 fake adapter；handlers 由 runtime 经 createAdapter 注入 */
  class InteractiveAdapter implements AgentAdapter {
    readonly provider = "codex";
    readonly capabilities: AdapterCapabilities = { prompt: {} };
    sink?: EventSink;

    constructor(private readonly handlers: InteractionHandlers) {}

    async open(_opts: OpenOptions, sink: EventSink): Promise<ProviderSessionRef> {
      this.sink = sink;
      return { provider: this.provider, providerSessionId: "ia-ref", resumed: false };
    }

    async submit(_ref: ProviderSessionRef, input: PromptInput): Promise<PromptReceipt> {
      const emit = (ev: Parameters<EventSink>[0]) => this.sink?.({ ...ev, turnId: input.turnId });
      emit({ kind: "state_update", provider: this.provider, payload: { state: "running" } });
      void (async () => {
        const request: PermissionRequest = {
          kind: "permission",
          requestId: "ar_1",
          title: "Run command?",
          options: [
            { optionId: "allow", name: "Allow", polarity: "allow" as const, lifetime: "once" as const },
          ],
        };
        emit({ kind: "permission_request", provider: this.provider, payload: request });
        const decision = await this.handlers.requestHandler(request);
        emit({
          kind: "permission_resolved",
          provider: this.provider,
          payload: {
            requestId: "ar_1",
            outcome: "selected",
            optionId: decision.kind === "permission" ? decision.optionId : "",
          },
        });

        const question: QuestionRequest = {
          kind: "question",
          requestId: "qr_1",
          questions: [{ questionId: "q1", header: "Scope", question: "Which scope?" }],
        };
        emit({ kind: "question_request", provider: this.provider, payload: question });
        const answers = await this.handlers.requestHandler(question);
        emit({
          kind: "question_resolved",
          provider: this.provider,
          payload: {
            requestId: "qr_1",
            outcome: "answered",
            answers: answers.kind === "question" ? answers.answers : {},
          },
        });

        emit({ kind: "state_update", provider: this.provider, payload: { state: "idle", stopReason: "end_turn" } });
      })();
      return { accepted: true };
    }

    async cancel(_ref: ProviderSessionRef): Promise<void> {}
    async close(_ref: ProviderSessionRef): Promise<void> {}
  }

  test("resolve wakes the adapter exactly once; unknown/stale ids report false", async () => {
    const runtime = new BatonSessionRuntime({
      session,
      mentionBudgetChars: 4096,
      createAdapter: (_name, handlers) => new InteractiveAdapter(handlers),
    });

    const turn = runtime.submit("codex", [{ type: "text", text: "do it" }]);
    await Bun.sleep(5); // permission_request 已落盘、resolver 已注册

    expect(runtime.respond({ kind: "permission", requestId: "ar_unknown", optionId: "allow" })).toBe(false);
    expect(runtime.respond({ kind: "permission", requestId: "ar_1", optionId: "allow" })).toBe(true);
    expect(runtime.respond({ kind: "permission", requestId: "ar_1", optionId: "allow" })).toBe(false); // resolver 一次性

    await Bun.sleep(5); // question_request 已落盘
    expect(runtime.respond({ kind: "question", requestId: "qr_1", answers: { q1: ["prod"] } })).toBe(true);
    await turn;

    const events = session.readEvents();
    expect(
      events.find((ev) => ev.kind === "permission_resolved")?.payload,
    ).toMatchObject({ requestId: "ar_1", outcome: "selected", optionId: "allow" });
    expect(
      events.find((ev) => ev.kind === "question_resolved")?.payload,
    ).toMatchObject({ requestId: "qr_1", outcome: "answered", answers: { q1: ["prod"] } });
    // 事件流收支平衡：pending 投影最终为空
    const state = session.loadState();
    expect(state.pendingPermissions.size).toBe(0);
    expect(state.pendingQuestions.size).toBe(0);
  });
});

// 委托状态必须对当前活跃 provider 可见（kernel §3 审批闭环），但可见性的来源只能是
// provider 自己报的生效路由——不是 baton 的配置意图。曾经投影层直接读
// config.codexApprovalReviewer，于是跟 claude 对话时 footer 也显示 codex 的委托状态。
describe("runtime.approvalRoute reports the provider's own effective route", () => {
  class RoutableAdapter extends FakeAdapter {
    readonly capabilities: AdapterCapabilities = { prompt: {}, approvalRouting: { supported: true } };
    constructor(
      provider: string,
      private readonly route: "user" | "delegated" | null,
    ) {
      super(provider);
    }
    approvalRoute(): "user" | "delegated" | null {
      return this.route;
    }
  }

  const routeAfterOpen = async (adapter: AgentAdapter, provider: string) => {
    const runtime = new BatonSessionRuntime({ session, mentionBudgetChars: 4096, createAdapter: () => adapter });
    await runtime.submit(provider, [{ type: "text", text: "hi" }]);
    return runtime.approvalRoute(provider);
  };

  test("a delegated route is visible", async () => {
    expect(await routeAfterOpen(new RoutableAdapter("codex", "delegated"), "codex")).toBe("delegated");
  });

  test("a user route is visible and is not delegation", async () => {
    expect(await routeAfterOpen(new RoutableAdapter("codex", "user"), "codex")).toBe("user");
  });

  test("a provider that cannot report stays null — never guessed", async () => {
    expect(await routeAfterOpen(new RoutableAdapter("codex", null), "codex")).toBeNull();
  });

  // 不声明 approvalRouting 的 provider（如 claude）不该被安上别家的委托状态
  test("a provider without the capability stays null (no cross-provider bleed)", async () => {
    expect(await routeAfterOpen(new FakeAdapter("claude-code"), "claude")).toBeNull();
  });
});
