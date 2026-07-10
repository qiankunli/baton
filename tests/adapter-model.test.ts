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
});
