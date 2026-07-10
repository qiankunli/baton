import { describe, expect, test } from "bun:test";

import { openCodexThread } from "../src/adapters/codex/adapter.ts";

describe("openCodexThread", () => {
  test("resumes an existing thread by id", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const peer = {
      request: async (method: string, params: unknown) => {
        calls.push({ method, params });
        return { thread: { id: "thread-old" } };
      },
    };

    expect(await openCodexThread(peer, { cwd: "/repo", resumeSessionId: "thread-old" })).toEqual({
      threadId: "thread-old",
      resumed: true,
    });
    expect(calls).toEqual([{ method: "thread/resume", params: { threadId: "thread-old" } }]);
  });

  test("starts a replacement thread when the native rollout is gone", async () => {
    const calls: string[] = [];
    const peer = {
      request: async (method: string) => {
        calls.push(method);
        if (method === "thread/resume") throw new Error("thread not found: thread-old");
        return { thread: { id: "thread-new" } };
      },
    };

    expect(await openCodexThread(peer, { cwd: "/repo", resumeSessionId: "thread-old" })).toEqual({
      threadId: "thread-new",
      resumed: false,
    });
    expect(calls).toEqual(["thread/resume", "thread/start"]);
  });

  test("does not hide non-missing resume failures", async () => {
    const peer = {
      request: async () => {
        throw new Error("Server overloaded; retry later");
      },
    };
    expect(openCodexThread(peer, { cwd: "/repo", resumeSessionId: "thread-old" })).rejects.toThrow(
      /overloaded/,
    );
  });
});
