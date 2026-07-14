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
      route: null,
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
      route: null,
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

// 审批路由改由 app-server 的原生 thread 参数承载（不再往 argv 注入 -c approvals_reviewer）：
// 不配就不下发——codex 自己的解析链（config.toml / profile / 企业 requirements）照常生效，
// baton 与 codex 天然一致；生效值只认响应回吐，因为请求值可能被企业策略打回。
describe("codex approval routing rides the native thread param", () => {
  const peerReturning = (response: Record<string, unknown>, calls: Array<{ method: string; params: unknown }>) => ({
    request: async (method: string, params: unknown) => {
      calls.push({ method, params });
      return { thread: { id: "th1" }, ...response };
    },
  });

  test("no configured reviewer → nothing is sent, codex decides for itself", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    await openCodexThread(peerReturning({ approvalsReviewer: "user" }, calls), { cwd: "/repo" });
    expect(calls).toEqual([{ method: "thread/start", params: { cwd: "/repo" } }]);
  });

  test("an explicit reviewer is sent as a thread/start param", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const opened = await openCodexThread(peerReturning({ approvalsReviewer: "auto_review" }, calls), {
      cwd: "/repo",
      approvalReviewer: "auto_review",
    });
    expect(calls).toEqual([
      { method: "thread/start", params: { cwd: "/repo", approvalsReviewer: "auto_review" } },
    ]);
    expect(opened.route).toBe("delegated");
  });

  test("the response wins over what baton asked for (enterprise requirements can override)", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    // baton 请求 user，codex 因 allowed_approvals_reviewers=["guardian_subagent"] 打回 auto_review
    const opened = await openCodexThread(peerReturning({ approvalsReviewer: "auto_review" }, calls), {
      cwd: "/repo",
      approvalReviewer: "user",
    });
    expect(opened.route).toBe("delegated");
  });

  test("guardian_subagent is the wire alias of auto_review", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    const opened = await openCodexThread(peerReturning({ approvalsReviewer: "guardian_subagent" }, calls), {
      cwd: "/repo",
    });
    expect(opened.route).toBe("delegated");
  });

  test("an unknown or missing reviewer stays unknown — never guessed", async () => {
    const calls: Array<{ method: string; params: unknown }> = [];
    expect((await openCodexThread(peerReturning({}, calls), { cwd: "/repo" })).route).toBeNull();
    expect(
      (await openCodexThread(peerReturning({ approvalsReviewer: "future_mode" }, calls), { cwd: "/repo" }))
        .route,
    ).toBeNull();
  });
});
