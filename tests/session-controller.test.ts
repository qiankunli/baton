import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AdapterCapabilities,
  HarnessAdapter,
  EffortOption,
  EventSink,
  ModelOption,
  OpenOptions,
  PromptInput,
  PromptReceipt,
  HarnessSessionRef,
} from "../src/adapters/types.ts";
import type { AnyEventEnvelope, PermissionRequest, PromptBlock, QuestionRequest } from "../src/events/types.ts";
import { textOf } from "../src/events/types.ts";
import { Controller, type InteractionHandlers } from "../src/session/controller.ts";
import { SessionStore, type SessionHandle } from "../src/store/store.ts";

class FakeAdapter implements HarnessAdapter {
  readonly capabilities: AdapterCapabilities = { prompt: {} };
  openOptions?: OpenOptions;
  sink?: EventSink;
  model: string | null = null;
  effort: string | null = null;
  synced: string[] = [];
  prompts: string[] = [];

  constructor(
    readonly harness: string,
    private readonly hooks: { enter?: () => void; leave?: () => void; delayMs?: number } = {},
  ) {}

  async open(opts: OpenOptions, sink: EventSink): Promise<HarnessSessionRef> {
    this.openOptions = opts;
    this.sink = sink;
    return {
      harness: this.harness,
      harnessSessionId: `${this.harness}-controller-ref`,
      resumed: Boolean(opts.resumeSessionId),
    };
  }

  nativeSessionId(_ref: HarnessSessionRef): string {
    return `${this.harness}-native`;
  }

  async syncContext(_ref: HarnessSessionRef, blocks: PromptBlock[]): Promise<void> {
    this.synced.push(textOf(blocks));
  }

  async listModels(_ref: HarnessSessionRef): Promise<ModelOption[]> {
    return [{ id: "default", label: "Default" }, { id: "fast", label: "Fast" }];
  }

  async setModel(_ref: HarnessSessionRef, modelId: string | null): Promise<void> {
    this.model = modelId === "default" ? null : modelId;
  }

  currentModel(_ref: HarnessSessionRef): string | null {
    return this.model;
  }

  async listEfforts(_ref: HarnessSessionRef): Promise<EffortOption[]> {
    return [{ id: "default", label: "Default" }, { id: "high", label: "High" }];
  }

  async setEffort(_ref: HarnessSessionRef, effortId: string | null): Promise<void> {
    this.effort = effortId === "default" ? null : effortId;
  }

  currentEffort(_ref: HarnessSessionRef): string | null {
    return this.effort;
  }

  /** submit 立即回执；事件（含终态）异步经 open 绑定的 sink 上报。user_message 由 controller 落盘 */
  async submit(_ref: HarnessSessionRef, input: PromptInput): Promise<PromptReceipt> {
    this.hooks.enter?.();
    this.prompts.push(textOf(input.blocks));
    void (async () => {
      if (this.hooks.delayMs) await Bun.sleep(this.hooks.delayMs);
      this.sink?.({
        kind: "agent_message",
        harness: this.harness,
        turnId: input.turnId,
        payload: { messageId: `${input.turnId}-agent`, content: [{ type: "text", text: "done" }] },
      });
      this.hooks.leave?.();
      this.sink?.({
        kind: "state_update",
        harness: this.harness,
        turnId: input.turnId,
        payload: { state: "idle", stopReason: "end_turn" },
      });
    })();
    return { accepted: true };
  }

  async cancel(_ref: HarnessSessionRef): Promise<void> {}
  async close(_ref: HarnessSessionRef): Promise<void> {}
}

class TargetedFakeAdapter extends FakeAdapter {
  constructor(readonly instanceId: string) {
    super("codex");
  }

  override async open(opts: OpenOptions, sink: EventSink): Promise<HarnessSessionRef> {
    this.openOptions = opts;
    this.sink = sink;
    return {
      harness: this.harness,
      harnessSessionId: `${this.instanceId}-controller-ref`,
      resumed: Boolean(opts.resumeSessionId),
    };
  }

  override nativeSessionId(_ref: HarnessSessionRef): string {
    return `${this.instanceId}-native`;
  }
}

class CompactAdapter extends FakeAdapter {
  override readonly capabilities: AdapterCapabilities = { prompt: {}, compact: { supported: true } };
  compactCalls: string[] = [];

  async compactContext(_ref: HarnessSessionRef, turnId: string): Promise<PromptReceipt> {
    this.compactCalls.push(turnId);
    this.sink?.({
      kind: "_baton_run_status",
      harness: this.harness,
      turnId,
      payload: { phase: "compacting", title: "Compacting context…" },
    });
    this.sink?.({
      kind: "state_update",
      harness: this.harness,
      turnId,
      payload: { state: "idle", stopReason: "end_turn" },
    });
    return { accepted: true };
  }
}

let root: string;
let session: SessionHandle;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baton-controller-"));
  session = new SessionStore(root).createSession({ cwd: "/repo" });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

function completedTurn(handle: SessionHandle, harness: string, turnId: string, text: string): void {
  handle.append({
    kind: "user_message",
    harness,
    turnId,
    payload: { messageId: `${turnId}-user`, content: [{ type: "text", text }] },
  });
  handle.append({
    kind: "agent_message",
    harness,
    turnId,
    payload: { messageId: `${turnId}-agent`, content: [{ type: "text", text: `${text}-done` }] },
  });
  handle.append({
    kind: "state_update",
    harness,
    turnId,
    payload: { state: "idle", stopReason: "end_turn" },
  });
  handle.summarizeTurn(turnId);
}

describe("Controller", () => {
  test("does not publish a second controller change for persisted streaming events", async () => {
    class ManualAdapter extends FakeAdapter {
      turnId?: string;

      override async submit(_ref: HarnessSessionRef, input: PromptInput): Promise<PromptReceipt> {
        this.turnId = input.turnId;
        return { accepted: true };
      }
    }

    const adapter = new ManualAdapter("codex");
    let controllerChanges = 0;
    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      createAdapter: () => adapter,
      onChange: () => controllerChanges++,
    });

    const turn = controller.submit("codex", [{ type: "text", text: "hello" }]);
    while (!adapter.sink || !adapter.turnId) await Bun.sleep(0);

    const beforeChunk = controllerChanges;
    adapter.sink({
      kind: "agent_message_chunk",
      harness: "codex",
      turnId: adapter.turnId,
      payload: { messageId: "m_stream", content: { type: "text", text: "a" } },
    });
    expect(controllerChanges).toBe(beforeChunk);

    adapter.sink({
      kind: "state_update",
      harness: "codex",
      turnId: adapter.turnId,
      payload: { state: "idle", stopReason: "end_turn" },
    });
    await turn;
  });

  test("accepts harness IDs outside the initially bundled registry", async () => {
    const adapter = new FakeAdapter("example-harness");
    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      createAdapter: (harness) => {
        expect(harness).toBe("example");
        return adapter;
      },
    });

    await controller.submit("example", [{ type: "text", text: "hello" }]);

    expect(adapter.prompts).toEqual(["hello"]);
    expect(session.meta.harnessSessions.example).toMatchObject({
      harnessTargetId: "example",
      harness: "example-harness",
      harnessSessionId: "example-harness-native",
    });
  });

  test("isolates two targets backed by the same Harness and preserves launch provenance", async () => {
    const adapters: TargetedFakeAdapter[] = [];
    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      modelPreferences: { "codex-a": "fast" },
      resolveTarget: (harnessTargetId) => ({ id: harnessTargetId, harness: "codex" }),
      createAdapter: (harness) => {
        expect(harness).toBe("codex");
        const adapter = new TargetedFakeAdapter(`instance-${adapters.length + 1}`);
        adapters.push(adapter);
        return adapter;
      },
    });
    session.setHarnessSession("codex-b", {
      harnessTargetId: "codex-b",
      harness: "codex",
      harnessSessionId: "instance-2-old",
      syncedSeq: 0,
    });

    await controller.submit("codex-a", [{ type: "text", text: "first target" }]);
    await controller.submit("codex-b", [{ type: "text", text: "second target" }]);

    expect(adapters).toHaveLength(2);
    expect(adapters[0]?.prompts).toEqual(["first target"]);
    expect(adapters[1]?.prompts).toEqual(["second target"]);
    expect(adapters[1]?.openOptions?.resumeSessionId).toBe("instance-2-old");
    expect(adapters[1]?.synced[0]).toContain("first target");
    expect(session.meta.harnessSessions["codex-a"]).toMatchObject({
      harnessTargetId: "codex-a",
      harness: "codex",
      harnessSessionId: "instance-1-native",
      model: "fast",
      launchSnapshot: {
        harnessTargetId: "codex-a",
        harness: "codex",
        harnessSessionKey: "codex",
        cwd: "/repo",
        model: "fast",
      },
    });
    expect(session.meta.harnessSessions["codex-b"]).toMatchObject({
      harnessTargetId: "codex-b",
      harness: "codex",
      harnessSessionId: "instance-2-native",
    });

    const summaries = session
      .readEvents()
      .filter((event) => event.kind === "_baton_turn_summary");
    expect(summaries.map((event) => event.harnessTargetId)).toEqual(["codex-a", "codex-b"]);

    const launchSnapshot = session.meta.harnessSessions["codex-a"]?.launchSnapshot;
    await controller.setModel("codex-a", null);
    expect(session.meta.harnessSessions["codex-a"]?.model).toBeUndefined();
    expect(session.meta.harnessSessions["codex-a"]?.launchSnapshot).toEqual(launchSnapshot);
  });

  test("publishes the persisted turn summary to event-stream subscribers", async () => {
    const adapter = new FakeAdapter("codex");
    const events: AnyEventEnvelope[] = [];
    // 投影单通道：消费者订阅事件流（append 即广播），不从 submit 的回调取事件
    session.subscribe((event) => events.push(event));
    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      createAdapter: () => adapter,
    });

    await controller.submit("codex", [{ type: "text", text: "hello" }]);

    expect(events.filter((event) => event.kind === "_baton_turn_summary")).toHaveLength(1);
    expect(events.filter((event) => event.kind === "agent_message")).toHaveLength(1);
  });

  test("serializes turns across harnesses into one BatonSession timeline", async () => {
    let active = 0;
    let maxActive = 0;
    const order: string[] = [];
    const adapters = new Map<string, FakeAdapter>();
    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      createAdapter: (harness) => {
        const adapter = new FakeAdapter(harness === "claude" ? "claude-code" : harness, {
          delayMs: 10,
          enter: () => {
            active++;
            maxActive = Math.max(maxActive, active);
            order.push(`start:${harness}`);
          },
          leave: () => {
            order.push(`end:${harness}`);
            active--;
          },
        });
        adapters.set(harness, adapter);
        return adapter;
      },
    });

    await Promise.all([
      controller.submit("codex", [{ type: "text", text: "one" }]),
      controller.submit("claude", [{ type: "text", text: "two" }]),
    ]);

    expect(maxActive).toBe(1);
    expect(order).toEqual(["start:codex", "end:codex", "start:claude", "end:claude"]);
    expect(session.loadState().turnSummaries).toHaveLength(2);
    expect(adapters.get("codex")?.prompts).toEqual(["one"]);
  });

  test("exposes queued turns and recalls the latest one before it starts", async () => {
    const adapter = new FakeAdapter("codex", { delayMs: 20 });
    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      createAdapter: () => adapter,
    });

    const active = controller.submit("codex", [{ type: "text", text: "one" }]);
    const queued = controller.submit("codex", [{ type: "text", text: "two" }]);
    const latest = controller.submit("claude", [{ type: "text", text: "three" }]);

    expect(controller.queuedTurns.map((turn) => textOf(turn.blocks))).toEqual(["two", "three"]);
    const recalled = controller.recallLatestQueued();
    expect(recalled && textOf(recalled.blocks)).toBe("three");
    expect(controller.queueLength).toBe(1);
    expect(await latest).toBe("recalled");
    expect(await active).toBe("completed");
    expect(await queued).toBe("completed");
    expect(adapter.prompts).toEqual(["one", "two"]);
  });

  test("rebuilds full BatonSession history for a fresh harness before prompting", async () => {
    completedTurn(session, "codex", "t_old", "existing work");
    const claude = new FakeAdapter("claude-code");
    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      createAdapter: () => claude,
    });

    await controller.submit("claude", [{ type: "text", text: "continue" }]);

    expect(claude.synced).toHaveLength(1);
    expect(claude.synced[0]).toContain("BatonSession history");
    expect(claude.synced[0]).toContain("existing work");
    expect(claude.prompts).toEqual(["continue"]);
    expect(session.meta.harnessSessions.claude?.syncedSeq).toBeGreaterThan(0);
  });

  test("resumes native session, restores config, and syncs only other-harness progress", async () => {
    completedTurn(session, "codex", "t_codex", "old codex work");
    const watermark = session.readEvents().at(-1)?.seq ?? 0;
    session.setHarnessSession("codex", {
      harnessTargetId: "codex",
      harness: "codex",
      harnessSessionId: "thread-old",
      model: "fast",
      effort: "high",
      syncedSeq: watermark,
    });
    completedTurn(session, "claude-code", "t_claude", "new claude work");
    const codex = new FakeAdapter("codex");
    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      modelPreferences: { codex: "remembered-global-model" },
      effortPreferences: { codex: "remembered-global-effort" },
      createAdapter: () => codex,
    });

    await controller.submit("codex", [{ type: "text", text: "next" }]);

    expect(codex.openOptions?.resumeSessionId).toBe("thread-old");
    expect(codex.model).toBe("fast");
    expect(codex.effort).toBe("high");
    expect(codex.synced[0]).toContain("new claude work");
    expect(codex.synced[0]).not.toContain("old codex work");
    expect(session.meta.harnessSessions.codex?.harnessSessionId).toBe("codex-native");
  });

  test("uses the remembered harness model for a new BatonSession", async () => {
    const codex = new FakeAdapter("codex");
    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      modelPreferences: { codex: "fast" },
      createAdapter: () => codex,
    });

    await controller.submit("codex", [{ type: "text", text: "next" }]);

    expect(codex.model).toBe("fast");
    expect(session.meta.harnessSessions.codex?.model).toBe("fast");
  });

  test("uses the remembered harness effort for a new BatonSession", async () => {
    const codex = new FakeAdapter("codex");
    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      effortPreferences: { codex: "high" },
      createAdapter: () => codex,
    });

    await controller.submit("codex", [{ type: "text", text: "next" }]);

    expect(codex.effort).toBe("high");
    expect(session.meta.harnessSessions.codex?.effort).toBe("high");
  });

  test("compacts through a control turn without persisting a user message", async () => {
    const adapter = new CompactAdapter("codex");
    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      createAdapter: () => adapter,
    });

    await controller.compactContext("codex");

    expect(adapter.compactCalls).toHaveLength(1);
    const events = session.readEvents();
    expect(events.filter((event) => event.kind === "user_message")).toHaveLength(0);
    expect(events.filter((event) => event.kind === "state_update").map((event) => event.payload)).toEqual([
      { state: "running" },
      { state: "idle", stopReason: "end_turn" },
    ]);
    expect(events.filter((event) => event.kind === "_baton_turn_summary")).toHaveLength(1);
  });

  test("rejects /compact when the harness does not declare the capability", async () => {
    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      createAdapter: () => new FakeAdapter("example"),
    });

    await expect(controller.compactContext("example")).rejects.toThrow("does not support /compact");
    expect(session.readEvents()).toHaveLength(0);
  });
});

// ---- 交互 resolver 注册表：adapter 的 await 点由统一 respond() 唤醒（permission/question 同路由）----
// 事件留痕（*_request / *_resolved）由 adapter 负责；controller 只持有 requestId → resolver 通道。

describe("interaction resolver registry", () => {
  /** 先审批、后提问、再收口的交互式 fake adapter；handlers 由 controller 经 createAdapter 注入 */
  class InteractiveAdapter implements HarnessAdapter {
    readonly harness = "codex";
    readonly capabilities: AdapterCapabilities = { prompt: {} };
    sink?: EventSink;

    constructor(private readonly handlers: InteractionHandlers) {}

    async open(_opts: OpenOptions, sink: EventSink): Promise<HarnessSessionRef> {
      this.sink = sink;
      return { harness: this.harness, harnessSessionId: "ia-ref", resumed: false };
    }

    async submit(_ref: HarnessSessionRef, input: PromptInput): Promise<PromptReceipt> {
      const emit = (ev: Parameters<EventSink>[0]) => this.sink?.({ ...ev, turnId: input.turnId });
      emit({ kind: "state_update", harness: this.harness, payload: { state: "running" } });
      void (async () => {
        const request: PermissionRequest = {
          kind: "permission",
          requestId: "ar_1",
          title: "Run command?",
          options: [
            { optionId: "allow", name: "Allow", polarity: "allow" as const, lifetime: "once" as const },
          ],
        };
        emit({ kind: "permission_request", harness: this.harness, payload: request });
        const decision = await this.handlers.requestHandler(request);
        emit({
          kind: "permission_resolved",
          harness: this.harness,
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
        emit({ kind: "question_request", harness: this.harness, payload: question });
        const answers = await this.handlers.requestHandler(question);
        emit({
          kind: "question_resolved",
          harness: this.harness,
          payload: {
            requestId: "qr_1",
            outcome: "answered",
            answers: answers.kind === "question" ? answers.answers : {},
          },
        });

        emit({ kind: "state_update", harness: this.harness, payload: { state: "idle", stopReason: "end_turn" } });
      })();
      return { accepted: true };
    }

    async cancel(_ref: HarnessSessionRef): Promise<void> {}
    async close(_ref: HarnessSessionRef): Promise<void> {}
  }

  test("resolve wakes the adapter exactly once; unknown/stale ids report false", async () => {
    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      createAdapter: (_name, handlers) => new InteractiveAdapter(handlers),
    });

    const turn = controller.submit("codex", [{ type: "text", text: "do it" }]);
    await Bun.sleep(5); // permission_request 已落盘、resolver 已注册

    expect(controller.respond({ kind: "permission", requestId: "ar_unknown", optionId: "allow" })).toBe(false);
    expect(controller.respond({ kind: "permission", requestId: "ar_1", optionId: "allow" })).toBe(true);
    expect(controller.respond({ kind: "permission", requestId: "ar_1", optionId: "allow" })).toBe(false); // resolver 一次性

    await Bun.sleep(5); // question_request 已落盘
    expect(controller.respond({ kind: "question", requestId: "qr_1", answers: { q1: ["prod"] } })).toBe(true);
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

  test("a harness-startup hook trust request belongs to the preparing turn", async () => {
    class StartupTrustAdapter implements HarnessAdapter {
      readonly harness = "codex";
      readonly capabilities: AdapterCapabilities = { prompt: {} };
      private sink?: EventSink;

      constructor(private readonly handlers: InteractionHandlers) {}

      async open(_opts: OpenOptions, sink: EventSink): Promise<HarnessSessionRef> {
        this.sink = sink;
        const request = {
          kind: "hook_trust" as const,
          requestId: "htr_start",
          harnessName: "Codex",
          hooks: [
            {
              key: "hook1",
              source: "plugin",
              sourcePath: "/plugins/devloop/hooks.json",
              trustStatus: "modified" as const,
              command: "python hook.py",
            },
          ],
        };
        sink({ kind: "hook_trust_request", harness: this.harness, payload: request });
        const response = await this.handlers.requestHandler(request);
        sink({
          kind: "hook_trust_resolved",
          harness: this.harness,
          payload: {
            requestId: request.requestId,
            outcome: response.kind === "hook_trust" && response.decision === "trust" ? "trusted" : "skipped",
          },
        });
        return { harness: this.harness, harnessSessionId: "startup-trust", resumed: false };
      }

      async submit(_ref: HarnessSessionRef, input: PromptInput): Promise<PromptReceipt> {
        this.sink?.({
          kind: "state_update",
          harness: this.harness,
          turnId: input.turnId,
          payload: { state: "idle", stopReason: "end_turn" },
        });
        return { accepted: true };
      }

      async cancel(): Promise<void> {}
      async close(): Promise<void> {}
    }

    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      createAdapter: (_name, handlers) => new StartupTrustAdapter(handlers),
    });
    const outcome = controller.submit("codex", [{ type: "text", text: "go" }]);
    await Bun.sleep(5);
    const request = session.readEvents().find((event) => event.kind === "hook_trust_request");
    expect(request?.turnId).toBeDefined();
    expect(controller.respond({ kind: "hook_trust", requestId: "htr_start", decision: "trust" })).toBe(true);
    await outcome;
    expect(session.loadState().pendingHookTrusts.size).toBe(0);
  });

  test("setup-phase attribution covers any request kind, not just hook trust", async () => {
    // setup 阶段（slot 创建 → open 完成）的归属规则按"是不是 request"判断：
    // 新 harness 的冷启动若阻塞征询 permission / question，不需要再回 controller 加 kind 特判。
    class SetupPermissionAdapter implements HarnessAdapter {
      readonly harness = "codex";
      readonly capabilities: AdapterCapabilities = { prompt: {} };
      private sink?: EventSink;

      constructor(private readonly handlers: InteractionHandlers) {}

      async open(_opts: OpenOptions, sink: EventSink): Promise<HarnessSessionRef> {
        this.sink = sink;
        const request = {
          kind: "permission" as const,
          requestId: "ar_setup",
          title: "Allow launch profile?",
          options: [
            { optionId: "allow", name: "Allow once", polarity: "allow" as const, lifetime: "once" as const },
          ],
        };
        sink({ kind: "permission_request", harness: this.harness, payload: request });
        const response = await this.handlers.requestHandler(request);
        sink({
          kind: "permission_resolved",
          harness: this.harness,
          payload: {
            requestId: request.requestId,
            outcome: "selected",
            optionId: response.kind === "permission" ? response.optionId : "allow",
          },
        });
        return { harness: this.harness, harnessSessionId: "setup-permission", resumed: false };
      }

      async submit(_ref: HarnessSessionRef, input: PromptInput): Promise<PromptReceipt> {
        this.sink?.({
          kind: "state_update",
          harness: this.harness,
          turnId: input.turnId,
          payload: { state: "idle", stopReason: "end_turn" },
        });
        return { accepted: true };
      }

      async cancel(): Promise<void> {}
      async close(): Promise<void> {}
    }

    const controller = new Controller({
      session,
      mentionBudgetChars: 4096,
      createAdapter: (_name, handlers) => new SetupPermissionAdapter(handlers),
    });
    const outcome = controller.submit("codex", [{ type: "text", text: "go" }]);
    await Bun.sleep(5);
    const request = session.readEvents().find((event) => event.kind === "permission_request");
    expect(request?.turnId).toBeDefined();
    expect(controller.respond({ kind: "permission", requestId: "ar_setup", optionId: "allow" })).toBe(true);
    await outcome;
    expect(session.loadState().pendingPermissions.size).toBe(0);
  });
});

// 委托状态必须对当前活跃 harness 可见（kernel §3 审批闭环），但可见性的来源只能是
// harness 自己报的生效路由——不是 baton 的配置意图。曾经投影层直接读
// config.codexApprovalReviewer，于是跟 claude 对话时 footer 也显示 codex 的委托状态。
describe("controller.approvalRoute reports the harness's own effective route", () => {
  class RoutableAdapter extends FakeAdapter {
    readonly capabilities: AdapterCapabilities = { prompt: {}, approvalRouting: { supported: true } };
    constructor(
      harness: string,
      private readonly route: "user" | "delegated" | null,
    ) {
      super(harness);
    }
    approvalRoute(): "user" | "delegated" | null {
      return this.route;
    }
  }

  const routeAfterOpen = async (adapter: HarnessAdapter, harness: string) => {
    const controller = new Controller({ session, mentionBudgetChars: 4096, createAdapter: () => adapter });
    await controller.submit(harness, [{ type: "text", text: "hi" }]);
    return controller.approvalRoute(harness);
  };

  test("a delegated route is visible", async () => {
    expect(await routeAfterOpen(new RoutableAdapter("codex", "delegated"), "codex")).toBe("delegated");
  });

  test("a user route is visible and is not delegation", async () => {
    expect(await routeAfterOpen(new RoutableAdapter("codex", "user"), "codex")).toBe("user");
  });

  test("a harness that cannot report stays null — never guessed", async () => {
    expect(await routeAfterOpen(new RoutableAdapter("codex", null), "codex")).toBeNull();
  });

  // 不声明 approvalRouting 的 harness（如 claude）不该被安上别家的委托状态
  test("a harness without the capability stays null (no cross-harness bleed)", async () => {
    expect(await routeAfterOpen(new FakeAdapter("claude-code"), "claude")).toBeNull();
  });
});
