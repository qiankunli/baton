import type { RequestHandler } from "../src/adapters/types.ts";
import { describe, expect, test } from "bun:test";

import { ClaudeAdapter } from "../src/adapters/claude/adapter.ts";
import { CodexAdapter } from "../src/adapters/codex/adapter.ts";

const requestHandler: RequestHandler = async (req) =>
  req.kind === "permission"
    ? { kind: "permission", requestId: req.requestId, optionId: "deny" }
    : { kind: "question", requestId: req.requestId, answers: {} };

describe("Claude model capability", () => {
  test("stores model for subsequent queries and exposes fallback catalog", async () => {
    const adapter = new ClaudeAdapter({ requestHandler });
    const ref = await adapter.open({ cwd: "/tmp" }, () => {});

    expect((await adapter.listModels(ref)).map((model) => model.id)).toContain("sonnet");
    await adapter.setModel(ref, "sonnet");
    expect(adapter.currentModel(ref)).toBe("sonnet");
    await adapter.setModel(ref, "default");
    expect(adapter.currentModel(ref)).toBeNull();
  });

  test("records a native session id for resume", async () => {
    const adapter = new ClaudeAdapter({ requestHandler });
    const ref = await adapter.open({ cwd: "/tmp", resumeSessionId: "claude-session-1" }, () => {});
    expect(ref.resumed).toBe(true);
    expect(adapter.nativeSessionId(ref)).toBe("claude-session-1");
  });
});

describe("Codex model capability", () => {
  test("normalizes model/list and sends the selected model on the next turn", async () => {
    const adapter = new CodexAdapter({ requestHandler });
    let turnParams: Record<string, unknown> | undefined;
    const peer = {
      request: async (method: string, params: Record<string, unknown>) => {
        if (method === "model/list") {
          return { data: [{ id: "gpt-5", displayName: "GPT-5", description: "default" }] };
        }
        if (method === "turn/start") {
          turnParams = params;
          return { turn: { id: "turn-1", status: "completed" } };
        }
        throw new Error(`unexpected request: ${method}`);
      },
    };
    const runtime = { threadId: "thread-1", peer };
    (
      adapter as unknown as { threads: Map<string, typeof runtime> }
    ).threads.set("thread-1", runtime);
    const ref = { provider: "codex", providerSessionId: "thread-1" };

    expect((await adapter.listModels(ref)).map((model) => model.id)).toEqual(["default", "gpt-5"]);
    await adapter.setModel(ref, "gpt-5");
    await adapter.submit(ref, { turnId: "t_1", messageId: "m_1", blocks: [{ type: "text", text: "hello" }] });
    await Bun.sleep(0); // turn/start 在 submit 回执后异步发出，等微任务刷新

    expect(turnParams?.model).toBe("gpt-5");
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
    const ref = { provider: "codex", providerSessionId: "thread-1" };

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
      { provider: "codex", providerSessionId: "thread-1" },
      { turnId: "t_1", messageId: "m_1", blocks: [{ type: "text", text: "hello" }] },
    );
    await Bun.sleep(0);

    expect(turnParams && "additionalContext" in turnParams).toBe(false);
  });
});
