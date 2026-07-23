import type { RequestHandler } from "../src/adapters/types.ts";
import { describe, expect, test } from "bun:test";

import { ClaudeAdapter, type ClaudeAdapterOptions } from "../src/adapters/claude/adapter.ts";
import { CodexAdapter } from "../src/adapters/codex/adapter.ts";

const requestHandler: RequestHandler = async (req) =>
  req.kind === "permission"
    ? { kind: "permission", requestId: req.requestId, optionId: "deny" }
    : { kind: "question", requestId: req.requestId, answers: {} };

describe("Claude model capability", () => {
  test("discovers models before the first turn without sending a user message", async () => {
    let prompt: unknown;
    let closes = 0;
    const queryFactory: NonNullable<ClaudeAdapterOptions["queryFactory"]> = ((params) => {
      prompt = params.prompt;
      return {
        initializationResult: async () => ({
          models: [
            {
              value: "default",
              resolvedModel: "claude-opus-4-8[1m]",
              displayName: "Default (recommended)",
              description: "Opus 4.8 with 1M context",
              supportedEffortLevels: ["high"],
            },
            {
              value: "claude-fable-5[1m]",
              resolvedModel: "claude-fable-5",
              displayName: "Fable",
              description: "Fable 5",
              supportedEffortLevels: ["high", "max"],
            },
            {
              value: "sonnet",
              resolvedModel: "claude-sonnet-5",
              displayName: "Sonnet",
              description: "Sonnet 5",
              supportedEffortLevels: ["high"],
            },
          ],
        }),
        close: () => closes++,
      } as unknown as ReturnType<NonNullable<ClaudeAdapterOptions["queryFactory"]>>;
    }) as NonNullable<ClaudeAdapterOptions["queryFactory"]>;
    const adapter = new ClaudeAdapter({ requestHandler, queryFactory });
    const ref = await adapter.open({ cwd: "/tmp" }, () => {});

    expect((await adapter.listModels(ref)).map((model) => model.id)).toEqual([
      "default",
      "claude-fable-5[1m]",
      "sonnet",
    ]);
    expect(closes).toBe(1);
    expect(typeof (prompt as AsyncIterable<unknown>)[Symbol.asyncIterator]).toBe("function");
    expect((await adapter.listEfforts(ref)).map((effort) => effort.id)).toEqual(["default", "high"]);
    expect(closes).toBe(1); // model catalog is cached; /effort must not start another CLI
    await adapter.setModel(ref, "sonnet");
    await adapter.setEffort(ref, "high");
    expect(adapter.currentModel(ref)).toBe("sonnet");
    expect(adapter.currentEffort(ref)).toBe("high");
    await adapter.setModel(ref, "default");
    await adapter.setEffort(ref, "default");
    expect(adapter.currentModel(ref)).toBeNull();
    expect(adapter.currentEffort(ref)).toBeNull();
  });

  test("records a native session id for resume", async () => {
    const adapter = new ClaudeAdapter({ requestHandler });
    const ref = await adapter.open({ cwd: "/tmp", resumeSessionId: "claude-session-1" }, () => {});
    expect(ref.resumed).toBe(true);
    expect(adapter.nativeSessionId(ref)).toBe("claude-session-1");
  });

  test("requires an existing native conversation before compacting", async () => {
    const adapter = new ClaudeAdapter({ requestHandler });
    const ref = await adapter.open({ cwd: "/tmp" }, () => {});
    await expect(adapter.compactContext(ref, "t_compact")).rejects.toThrow("no conversation to compact");
  });

  test("rejects efforts unsupported by the selected Claude model", async () => {
    const adapter = new ClaudeAdapter({ requestHandler });
    const ref = await adapter.open({ cwd: "/tmp" }, () => {});
    const runtime = (
      adapter as unknown as {
        sessions: Map<string, { modelInfos?: unknown[] }>;
      }
    ).sessions.get(ref.harnessSessionId);
    if (!runtime) throw new Error("missing Claude test runtime");
    runtime.modelInfos = [
      { value: "opus", displayName: "Opus", supportedEffortLevels: ["high"] },
      { value: "haiku", displayName: "Haiku", supportedEffortLevels: ["low"] },
    ];

    await adapter.setModel(ref, "opus");
    await adapter.setEffort(ref, "high");
    await expect(adapter.setEffort(ref, "low")).rejects.toThrow(/does not support effort low/);
    await expect(adapter.setModel(ref, "haiku")).rejects.toThrow(/does not support effort high/);
    expect(adapter.currentModel(ref)).toBe("opus");
    expect(adapter.currentEffort(ref)).toBe("high");
  });
});

describe("Codex model capability", () => {
  test("maps context compaction to thread/compact/start", async () => {
    const adapter = new CodexAdapter({ requestHandler });
    const requests: Array<{ method: string; params: unknown }> = [];
    const runtime = {
      threadId: "thread-1",
      peer: {
        request: async (method: string, params: unknown) => {
          requests.push({ method, params });
          return {};
        },
      },
    };
    (adapter as unknown as { threads: Map<string, typeof runtime> }).threads.set("thread-1", runtime);
    const ref = { harness: "codex", harnessSessionId: "thread-1" };

    await adapter.compactContext(ref, "t_compact");
    await Bun.sleep(0);

    expect(requests).toEqual([{ method: "thread/compact/start", params: { threadId: "thread-1" } }]);
  });

  test("normalizes model/list and sends the selected model on the next turn", async () => {
    const adapter = new CodexAdapter({ requestHandler });
    const turnRequests: Record<string, unknown>[] = [];
    const peer = {
      request: async (method: string, params: Record<string, unknown>) => {
        if (method === "model/list") {
          return {
            data: [
              {
                id: "gpt-5",
                displayName: "GPT-5",
                description: "default",
                isDefault: true,
                defaultReasoningEffort: "medium",
                supportedReasoningEfforts: [
                  { reasoningEffort: "low", description: "Fast" },
                  { reasoningEffort: "high", description: "Deep" },
                ],
              },
            ],
          };
        }
        if (method === "turn/start") {
          turnRequests.push(params);
          return { turn: { id: "turn-1", status: "completed" } };
        }
        throw new Error(`unexpected request: ${method}`);
      },
    };
    const runtime = { threadId: "thread-1", peer };
    (
      adapter as unknown as { threads: Map<string, typeof runtime> }
    ).threads.set("thread-1", runtime);
    const ref = { harness: "codex", harnessSessionId: "thread-1" };

    expect((await adapter.listModels(ref)).map((model) => model.id)).toEqual(["default", "gpt-5"]);
    await adapter.setModel(ref, "gpt-5");
    expect((await adapter.listEfforts(ref)).map((effort) => effort.id)).toEqual(["default", "low", "high"]);
    await adapter.setEffort(ref, "high");
    await adapter.submit(ref, { turnId: "t_1", messageId: "m_1", blocks: [{ type: "text", text: "hello" }] });
    await Bun.sleep(0); // turn/start 在 submit 回执后异步发出，等微任务刷新

    expect(turnRequests[0]?.model).toBe("gpt-5");
    expect(turnRequests[0]?.effort).toBe("high");
    await adapter.setEffort(ref, "default");
    expect(adapter.currentEffort(ref)).toBeNull();
    await adapter.submit(ref, { turnId: "t_2", messageId: "m_2", blocks: [{ type: "text", text: "again" }] });
    await Bun.sleep(0);
    expect(turnRequests[1]?.effort).toBe("medium");
  });

  test("rejects efforts unsupported by the selected Codex model", async () => {
    const adapter = new CodexAdapter({ requestHandler });
    const catalog = {
      data: [
        {
          id: "gpt-5",
          displayName: "GPT-5",
          isDefault: true,
          supportedReasoningEfforts: [{ reasoningEffort: "high" }],
        },
        {
          id: "gpt-5-mini",
          displayName: "GPT-5 mini",
          supportedReasoningEfforts: [{ reasoningEffort: "low" }],
        },
      ],
    };
    const peer = {
      request: async (method: string) => {
        if (method === "model/list") return catalog;
        throw new Error(`unexpected request: ${method}`);
      },
    };
    const runtime = { threadId: "thread-1", peer };
    (
      adapter as unknown as { threads: Map<string, typeof runtime> }
    ).threads.set("thread-1", runtime);
    const ref = { harness: "codex", harnessSessionId: "thread-1" };

    await adapter.setModel(ref, "gpt-5");
    await adapter.setEffort(ref, "high");
    await expect(adapter.setEffort(ref, "low")).rejects.toThrow(/does not support effort low/);
    await expect(adapter.setModel(ref, "gpt-5-mini")).rejects.toThrow(/does not support effort high/);
    expect(adapter.currentModel(ref)).toBe("gpt-5");
    expect(adapter.currentEffort(ref)).toBe("high");
  });

  test("delivers BatonSession catch-up via turn/start.additionalContext", async () => {
    // 曾走 thread/inject_items 注入独立 user message：会污染 codex 原生历史（悬空
    // user message），改为随本 turn 的 additionalContext side-channel 送达。
    const adapter = new CodexAdapter({ requestHandler });
    let turnParams: Record<string, unknown> | undefined;
    const peer = {
      request: async (method: string, params: Record<string, unknown>) => {
        if (method === "turn/start") {
          turnParams = params;
          return { turn: { id: "turn-1", status: "inProgress" } };
        }
        throw new Error(`unexpected request: ${method}`);
      },
    };
    const runtime = { threadId: "thread-1", peer };
    (
      adapter as unknown as { threads: Map<string, typeof runtime> }
    ).threads.set("thread-1", runtime);
    const ref = { harness: "codex", harnessSessionId: "thread-1" };

    expect(adapter.capabilities.sync?.supported).toBe(true);
    await adapter.submit(ref, {
      turnId: "t_1",
      messageId: "m_1",
      blocks: [{ type: "text", text: "hello" }],
      syncBlocks: [{ type: "text", text: "handoff" }],
    });
    await Bun.sleep(0); // turn/start 在 submit 回执后异步发出，等微任务刷新

    expect(turnParams?.input).toEqual([{ type: "text", text: "hello" }]);
    expect(turnParams?.additionalContext).toEqual({
      "baton-sync": { value: "handoff", kind: "untrusted" },
    });
  });

  test("omits additionalContext when there is no catch-up", async () => {
    const adapter = new CodexAdapter({ requestHandler });
    let turnParams: Record<string, unknown> | undefined;
    const peer = {
      request: async (method: string, params: Record<string, unknown>) => {
        if (method === "turn/start") {
          turnParams = params;
          return { turn: { id: "turn-1", status: "inProgress" } };
        }
        throw new Error(`unexpected request: ${method}`);
      },
    };
    const runtime = { threadId: "thread-1", peer };
    (
      adapter as unknown as { threads: Map<string, typeof runtime> }
    ).threads.set("thread-1", runtime);

    await adapter.submit(
      { harness: "codex", harnessSessionId: "thread-1" },
      { turnId: "t_1", messageId: "m_1", blocks: [{ type: "text", text: "hello" }] },
    );
    await Bun.sleep(0);

    expect(turnParams && "additionalContext" in turnParams).toBe(false);
  });
});
