// 审批/终态诚实性契约（对所有 adapter 参数化）：
// 1. 审批闭环——provider 的审批请求必须成为 permission_request 事件、等待宿主决策、
//    以 permission_resolved 留痕并把决定回传 provider；
// 2. 终态白名单——只有明确的成功值可以映射 completed，declined 是一等终态，
//    未知终态悲观归 failed（乐观兜底曾把 codex declined 渲染成绿勾）；
// 3. 审批路由收权——codex 默认钉死 reviewer=user；显式 auto-review 必须有权威回执，
//    未知策略导致的 declined-without-approval 继续发对账 notice。
import { describe, expect, test } from "bun:test";

import { ClaudeAdapter } from "../src/adapters/claude/adapter.ts";
import { CodexAdapter, codexLaunchCommand, codexToolTerminalStatus } from "../src/adapters/codex/adapter.ts";
import type { AnyNewEvent } from "../src/events/types.ts";

function codexServerRequestHarness(optionId: string) {
  const events: AnyNewEvent[] = [];
  const adapter = new CodexAdapter({ approvalHandler: async () => ({ optionId }) });
  const rt = { threadId: "th1", turnId: "t1", sink: (ev: AnyNewEvent) => events.push(ev) };
  const request = (method: string, params: unknown) =>
    (
      adapter as unknown as {
        handleServerRequest: (r: unknown, m: string, p: unknown) => Promise<unknown>;
      }
    ).handleServerRequest(rt, method, params);
  const notify = (method: string, params: unknown) =>
    (adapter as unknown as { handleNotification: (r: unknown, m: string, p: unknown) => void }).handleNotification(
      rt,
      method,
      params,
    );
  return { events, request, notify };
}

describe("approval loop closes through the host (all adapters)", () => {
  test("codex: requestApproval → permission_request, decision returned and resolved", async () => {
    const { events, request } = codexServerRequestHarness("accept");
    const result = await request("item/commandExecution/requestApproval", {
      threadId: "th1",
      itemId: "item1",
      command: "bun install",
    });
    expect(events.map((e) => e.kind)).toEqual(["permission_request", "permission_resolved"]);
    expect(result).toEqual({ decision: "accept" });
    expect(events[0]!.payload).toMatchObject({
      title: "Run command?",
      description: "bun install",
      options: [
        { optionId: "accept" },
        { optionId: "acceptForSession" },
        { optionId: "decline" },
        { optionId: "cancel" },
      ],
    });
    const resolved = events[1]!.payload as { requestId: string; optionId: string };
    expect(resolved.optionId).toBe("accept");
  });

  test("claude: canUseTool → permission_request, allow/deny honor the host decision", async () => {
    for (const [optionId, behavior] of [
      ["allow", "allow"],
      ["deny", "deny"],
    ] as const) {
      const events: AnyNewEvent[] = [];
      const adapter = new ClaudeAdapter({ approvalHandler: async () => ({ optionId }) });
      const result = await (
        adapter as unknown as {
          handleCanUseTool: (
            emit: (ev: AnyNewEvent) => void,
            name: string,
            input: Record<string, unknown>,
            meta: Record<string, unknown>,
          ) => Promise<{ behavior: string }>;
        }
      ).handleCanUseTool((ev) => events.push(ev), "Bash", { command: "bun install" }, {});
      expect(events.map((e) => e.kind)).toEqual(["permission_request", "permission_resolved"]);
      expect(result.behavior).toBe(behavior);
    }
  });
});

describe("codex terminal status whitelist", () => {
  // 白名单契约：新终态词汇没进映射表时必须落红（failed），绝不能默认绿勾。
  const cases: Array<[unknown, string]> = [
    ["completed", "completed"],
    ["failed", "failed"],
    ["declined", "declined"],
    ["some-future-status", "failed"],
    // item/completed 方法名本身就是完成语义：status 缺失不是词汇漂移
    [undefined, "completed"],
    ["", "completed"],
  ];
  test.each(cases)("item.status=%p → %p", (raw, expected) => {
    expect(codexToolTerminalStatus(raw)).toBe(expected);
  });

  test("declined item surfaces as a declined tool card, not a green check", () => {
    const { events, notify } = codexServerRequestHarness("decline");
    notify("item/completed", {
      threadId: "th1",
      item: { type: "commandExecution", id: "cmd1", status: "declined", command: "bun install" },
    });
    const tc = events.find((e) => e.kind === "tool_call_update");
    expect(tc?.payload).toMatchObject({ toolCallId: "cmd1", status: "declined" });
  });
});

describe("codex approval routing is pinned by the adapter", () => {
  test("default and custom commands get approvals_reviewer=user injected before app-server", () => {
    expect(codexLaunchCommand(undefined)).toEqual(["codex", "-c", 'approvals_reviewer="user"', "app-server"]);
    expect(codexLaunchCommand(["/opt/codex", "app-server", "--verbose"])).toEqual([
      "/opt/codex",
      "-c",
      'approvals_reviewer="user"',
      "app-server",
      "--verbose",
    ]);
  });

  test("explicit auto-review config is injected while command-level overrides still win", () => {
    expect(codexLaunchCommand(undefined, "auto_review")).toEqual([
      "codex",
      "-c",
      'approvals_reviewer="auto_review"',
      "app-server",
    ]);
    const command = ["codex", "-c", 'approvals_reviewer="user"', "app-server"];
    expect(codexLaunchCommand(command, "auto_review")).toEqual(command);
  });

  test("an explicit approvals_reviewer in the user command is respected (escape hatch)", () => {
    const command = ["codex", "-c", 'approvals_reviewer="agent"', "app-server"];
    expect(codexLaunchCommand(command)).toEqual(command);
  });

  test("commands without the app-server subcommand are left untouched", () => {
    // 假进程/不透明 wrapper：adapter 不理解其参数语言，猜错注入位置比不注入更糟
    const command = ["bun", "-e", "fake-server-script"];
    expect(codexLaunchCommand(command)).toEqual(command);
  });

  test("declined without a prior requestApproval emits a bypass warning notice", () => {
    const { events, notify } = codexServerRequestHarness("decline");
    notify("item/completed", {
      threadId: "th1",
      item: { type: "commandExecution", id: "cmd1", status: "declined", command: "bun install" },
    });
    const notice = events.find((e) => e.kind === "_baton_notice");
    expect(notice?.payload).toMatchObject({ level: "warning", title: "Approval bypassed by provider-side policy" });
  });

  test("declined after asking baton is the user's own decision: no notice", async () => {
    const { events, request, notify } = codexServerRequestHarness("decline");
    await request("item/commandExecution/requestApproval", { threadId: "th1", itemId: "cmd1", command: "bun install" });
    notify("item/completed", {
      threadId: "th1",
      item: { type: "commandExecution", id: "cmd1", status: "declined", command: "bun install" },
    });
    expect(events.find((e) => e.kind === "_baton_notice")).toBeUndefined();
    expect(events.find((e) => e.kind === "tool_call_update")?.payload).toMatchObject({ status: "declined" });
  });

  test("auto-review notifications emit authoritative receipts and suppress the heuristic warning", () => {
    const { events, notify } = codexServerRequestHarness("decline");
    notify("item/autoApprovalReview/started", {
      threadId: "th1",
      turnId: "codex-turn-1",
      targetItemId: "cmd1",
      review: { status: "inProgress" },
      action: { type: "applyPatch" },
    });
    notify("item/autoApprovalReview/completed", {
      threadId: "th1",
      turnId: "codex-turn-1",
      targetItemId: "cmd1",
      review: {
        status: "denied",
        riskLevel: "high",
        userAuthorization: "low",
        rationale: "writes outside the workspace",
      },
      action: { type: "applyPatch" },
    });
    notify("item/completed", {
      threadId: "th1",
      item: { type: "commandExecution", id: "cmd1", status: "declined", command: "bun install" },
    });

    const receipts = events.filter((event) => event.kind === "approval_review_update");
    expect(receipts).toHaveLength(2);
    expect(receipts[0]?.payload).toMatchObject({ toolCallId: "cmd1", decision: "in_progress" });
    expect(receipts[1]?.payload).toMatchObject({
      toolCallId: "cmd1",
      decision: "denied",
      riskLevel: "high",
      userAuthorization: "low",
      rationale: "writes outside the workspace",
      actionType: "applyPatch",
    });
    expect(events.find((event) => event.kind === "_baton_notice")).toBeUndefined();
  });

  test("auto-review tolerates missing unstable fields", () => {
    const { events, notify } = codexServerRequestHarness("decline");
    notify("item/autoApprovalReview/completed", { threadId: "th1", targetItemId: "cmd1" });
    expect(events.find((event) => event.kind === "approval_review_update")?.payload).toEqual({
      toolCallId: "cmd1",
      decision: "aborted",
    });
  });
});
