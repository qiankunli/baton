import { describe, expect, test } from "bun:test";

import { ClaudeAdapter } from "../src/adapters/claude/adapter.ts";
import { CodexAdapter } from "../src/adapters/codex/adapter.ts";
import type { AnyNewEvent } from "../src/events/types.ts";

const approvalHandler = async () => ({ optionId: "deny" });

describe("Claude model capability", () => {
  test("stores model for subsequent queries and exposes fallback catalog", async () => {
    const adapter = new ClaudeAdapter({ approvalHandler });
    const ref = await adapter.start({ cwd: "/tmp" });

    expect((await adapter.listModels(ref)).map((model) => model.id)).toContain("sonnet");
    await adapter.setModel(ref, "sonnet");
    expect(adapter.currentModel(ref)).toBe("sonnet");
    await adapter.setModel(ref, "default");
    expect(adapter.currentModel(ref)).toBeNull();
  });

  test("records a native session id for resume", async () => {
    const adapter = new ClaudeAdapter({ approvalHandler });
    const ref = await adapter.start({ cwd: "/tmp", resumeSessionId: "claude-session-1" });
    expect(ref.resumed).toBe(true);
    expect(adapter.nativeSessionId(ref)).toBe("claude-session-1");
  });
});

describe("Codex model capability", () => {
  test("normalizes model/list and sends the selected model on the next turn", async () => {
    const adapter = new CodexAdapter({ approvalHandler });
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
    await adapter.prompt(ref, [{ type: "text", text: "hello" }], (_event: AnyNewEvent) => {}, { turnId: "t_1" });

    expect(turnParams?.model).toBe("gpt-5");
  });

  test("injects BatonSession context into model-visible thread history", async () => {
    const adapter = new CodexAdapter({ approvalHandler });
    let request: { method: string; params: unknown } | undefined;
    const peer = {
      request: async (method: string, params: unknown) => {
        request = { method, params };
        return {};
      },
    };
    const runtime = { threadId: "thread-1", peer };
    (
      adapter as unknown as { threads: Map<string, typeof runtime> }
    ).threads.set("thread-1", runtime);

    await adapter.syncContext(
      { provider: "codex", providerSessionId: "thread-1" },
      [{ type: "text", text: "handoff" }],
    );

    expect(request).toEqual({
      method: "thread/inject_items",
      params: {
        threadId: "thread-1",
        items: [
          {
            type: "message",
            role: "user",
            content: [{ type: "input_text", text: "handoff" }],
          },
        ],
      },
    });
  });
});
