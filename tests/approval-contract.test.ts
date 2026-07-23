// 审批/终态诚实性契约（对所有 adapter 参数化）：
// 1. 审批闭环——adapter 把 Harness 请求提交给 InteractionHandler、等待宿主决策，
//    并把决定回传 Harness；opened / resolved 的持久化由 Controller 统一负责；
// 2. 终态白名单——只有明确的成功值可以映射 completed，declined 是一等终态，
//    未知终态悲观归 failed（乐观兜底曾把 codex declined 渲染成绿勾）；
// 3. 审批路由收权——codex 默认钉死 reviewer=auto_review 并留下权威回执；显式 user
//    时人工选项必须服从 app-server 的 availableDecisions，未知旁路继续发对账 notice。
import { describe, expect, test } from "bun:test";

import { ClaudeAdapter } from "../src/adapters/claude/adapter.ts";
import { CodexAdapter, codexLaunchCommand, codexToolTerminalStatus } from "../src/adapters/codex/adapter.ts";
import type { AnyEventDraft } from "../src/event/types.ts";
import type { InteractionDraft } from "../src/interaction/types.ts";

function codexServerRequestHarness(optionId: string) {
  const events: AnyEventDraft[] = [];
  const interactions: InteractionDraft[] = [];
  const adapter = new CodexAdapter({
    interactionHandler: async (interaction) => {
      interactions.push(interaction);
      return { kind: "permission", outcome: "selected", optionId };
    },
  });
  const rt = { threadId: "th1", turnId: "t1", sink: (ev: AnyEventDraft) => events.push(ev) };
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
  return { events, interactions, request, notify };
}

describe("approval loop closes through the host (all adapters)", () => {
  test("codex: requestApproval → permission Interaction and decision returned", async () => {
    const { events, interactions, request } = codexServerRequestHarness("accept");
    const result = await request("item/commandExecution/requestApproval", {
      threadId: "th1",
      itemId: "item1",
      command: "bun install",
    });
    expect(events).toEqual([]);
    expect(result).toEqual({ decision: "accept" });
    expect(interactions[0]).toMatchObject({
      title: "Run command?",
      description: "bun install",
      options: [
        { optionId: "accept" },
        { optionId: "acceptForSession" },
        { optionId: "decline" },
        { optionId: "cancel" },
      ],
    });
  });

  test("claude: canUseTool → permission Interaction; allow/deny honor the host decision", async () => {
    for (const [optionId, behavior] of [
      ["allow", "allow"],
      ["deny", "deny"],
    ] as const) {
      const events: AnyEventDraft[] = [];
      const interactions: InteractionDraft[] = [];
      const adapter = new ClaudeAdapter({
        interactionHandler: async (interaction) => {
          interactions.push(interaction);
          return { kind: "permission", outcome: "selected", optionId };
        },
      });
      const result = await (
        adapter as unknown as {
          handleCanUseTool: (
            emit: (ev: AnyEventDraft) => void,
            name: string,
            input: Record<string, unknown>,
            meta: Record<string, unknown>,
          ) => Promise<{ behavior: string }>;
        }
      ).handleCanUseTool((ev) => events.push(ev), "Bash", { command: "bun install" }, {});
      expect(events).toEqual([]);
      expect(interactions[0]).toMatchObject({ kind: "permission", title: "Bash: bun install" });
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

describe("codex launch command is not a policy channel", () => {
  // 审批路由曾经靠往 argv 注入 -c approvals_reviewer 实现：既盖掉用户的 codex 配置，
  // 又反推不出生效值（企业 requirements 能把注入值打回）。现在它只负责挑二进制，
  // 路由走 thread/start 原生参数（见 codex-session.test.ts）。
  test("the command is passed through untouched", () => {
    expect(codexLaunchCommand(undefined)).toEqual(["codex", "app-server"]);
    expect(codexLaunchCommand(["/opt/codex", "app-server", "--verbose"])).toEqual([
      "/opt/codex",
      "app-server",
      "--verbose",
    ]);
    const escapeHatch = ["codex", "-c", 'approvals_reviewer="user"', "app-server"];
    expect(codexLaunchCommand(escapeHatch)).toEqual(escapeHatch);
    const wrapper = ["bun", "-e", "fake-server-script"];
    expect(codexLaunchCommand(wrapper)).toEqual(wrapper);
  });
});

describe("codex approval routing is pinned by the adapter", () => {
  test("declined without a prior requestApproval emits a bypass warning notice", () => {
    const { events, notify } = codexServerRequestHarness("decline");
    notify("item/completed", {
      threadId: "th1",
      item: { type: "commandExecution", id: "cmd1", status: "declined", command: "bun install" },
    });
    const notice = events.find((e) => e.kind === "_baton_notice");
    expect(notice?.payload).toMatchObject({ level: "warning", title: "Approval bypassed by harness-side policy" });
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

  test("availableDecisions drive the card and preserve structured Codex decisions", async () => {
    const structuredDecision = {
      acceptWithExecpolicyAmendment: {
        execpolicy_amendment: ["make", "-C", "devloop", "bump-version"],
      },
    };
    const { interactions, request } = codexServerRequestHarness("acceptWithExecpolicyAmendment:1");
    const result = await request("item/commandExecution/requestApproval", {
      threadId: "th1",
      itemId: "cmd1",
      command: "make -C devloop bump-version PLUGIN=devloop",
      availableDecisions: ["accept", structuredDecision, "cancel"],
    });

    expect(interactions[0]).toMatchObject({
      options: [
        { optionId: "accept", name: "Allow once", polarity: "allow", lifetime: "once" },
        {
          optionId: "acceptWithExecpolicyAmendment:1",
          // 作用对象（命令前缀）只在 name 里——两轴表达不了它，UI 也不许拿两轴合成标签
          name: "Allow and remember: make -C devloop bump-version",
          polarity: "allow",
          lifetime: "persistent",
        },
        { optionId: "cancel", name: "Deny and interrupt turn", polarity: "reject", lifetime: "once" },
      ],
    });
    expect(result).toEqual({ decision: structuredDecision });
  });

  test("a deny network amendment is a reject, not an allow", async () => {
    // codex 会提议"永久拉黑某 host"（NetworkPolicyRuleAction::Deny）。极性压进单一 kind 的
    // 年代，它被映射成 allow_always + "Allow and remember: deny evil.com"——最危险的选项
    // 长得最安全。两轴把它钉成 reject。
    const denyRule = {
      applyNetworkPolicyAmendment: {
        network_policy_amendment: { host: "evil.example.com", action: "deny" },
      },
    };
    const { interactions, request } = codexServerRequestHarness("applyNetworkPolicyAmendment:0");
    await request("item/commandExecution/requestApproval", {
      threadId: "th1",
      itemId: "cmd1",
      command: "curl https://evil.example.com",
      availableDecisions: [denyRule],
    });
    expect(interactions[0]).toMatchObject({
      options: [
        {
          optionId: "applyNetworkPolicyAmendment:0",
          name: "Deny and remember: evil.example.com",
          polarity: "reject",
          lifetime: "persistent",
        },
      ],
    });
  });

  test("an allow network amendment keeps allow polarity", async () => {
    const allowRule = {
      applyNetworkPolicyAmendment: {
        network_policy_amendment: { host: "registry.npmjs.org", action: "allow" },
      },
    };
    const { interactions, request } = codexServerRequestHarness("applyNetworkPolicyAmendment:0");
    await request("item/commandExecution/requestApproval", {
      threadId: "th1",
      itemId: "cmd1",
      command: "npm install",
      availableDecisions: [allowRule],
    });
    expect(interactions[0]).toMatchObject({
      options: [
        {
          optionId: "applyNetworkPolicyAmendment:0",
          name: "Allow and remember: registry.npmjs.org",
          polarity: "allow",
          lifetime: "persistent",
        },
      ],
    });
  });

  test("availableDecisions baton cannot map at all fall back to an answerable card", async () => {
    // 非空但一项都认不出（codex 改名 / 新增第三种 amendment）时，逐项映射会得到空数组
    // → 零选项审批卡 → 用户无从作答、turn 永久挂起。宁可退回四选项也不能失去应答能力。
    const { interactions, request } = codexServerRequestHarness("accept");
    await request("item/commandExecution/requestApproval", {
      threadId: "th1",
      itemId: "cmd1",
      command: "bun install",
      availableDecisions: ["someFutureDecision", { unknownAmendment: {} }],
    });
    expect(interactions[0]?.kind).toBe("permission");
    expect(interactions[0]?.kind === "permission" ? interactions[0].options : []).toHaveLength(4);
  });

  // 悲观丢弃只是不变量 #2 的前半句；"绝不失声"要求把降级说出来——codex 迭代快，
  // 新增 decision 是常态，静默丢弃会让用户长期少一个选项而毫不知情。
  test("unrecognized decisions are surfaced, not silently dropped", async () => {
    const { events, interactions, request } = codexServerRequestHarness("accept");
    await request("item/commandExecution/requestApproval", {
      threadId: "th1",
      itemId: "cmd1",
      command: "bun install",
      availableDecisions: ["accept", { brandNewAmendment: { foo: 1 } }, "cancel"],
    });
    const notice = events.find((e) => e.kind === "_baton_notice");
    expect(notice?.payload).toMatchObject({
      level: "warning",
      title: "Unrecognized approval choices from codex",
    });
    // 形状键要能说清 codex 新增了什么，而不只是"有个东西没认出来"
    expect((notice?.payload as { detail: string }).detail).toContain("brandNewAmendment");
    // 认得的候选照常可用
    expect(interactions[0]?.kind === "permission" ? interactions[0].options : []).toHaveLength(2);
  });

  test("the same unrecognized shape only warns once per thread", async () => {
    const { events, interactions, request } = codexServerRequestHarness("accept");
    const ask = () =>
      request("item/commandExecution/requestApproval", {
        threadId: "th1",
        itemId: "cmd1",
        command: "bun install",
        availableDecisions: ["accept", { brandNewAmendment: {} }],
      });
    await ask();
    await ask();
    await ask();
    expect(events.filter((e) => e.kind === "_baton_notice")).toHaveLength(1);
  });

  // 字段缺失 = 老版本 codex 压根没这个能力，不是"认不出"——不该报警
  test("an absent availableDecisions is not a warning", async () => {
    const { events, interactions, request } = codexServerRequestHarness("accept");
    await request("item/commandExecution/requestApproval", {
      threadId: "th1",
      itemId: "cmd1",
      command: "bun install",
    });
    expect(events.find((e) => e.kind === "_baton_notice")).toBeUndefined();
  });

  // 读不出 amendment 就不给该选项：永久授权的标签说不清作用对象，就不能让用户点。
  // network 尤其致命——action 读不出时若默认 allow，一条 deny 规则会被渲染成放行。
  test("an unreadable amendment is dropped and surfaced rather than guessed", async () => {
    const { events, interactions, request } = codexServerRequestHarness("accept");
    await request("item/commandExecution/requestApproval", {
      threadId: "th1",
      itemId: "cmd1",
      command: "curl https://evil.example.com",
      availableDecisions: [
        "accept",
        { applyNetworkPolicyAmendment: { network_policy_amendment: { host: "evil.example.com" } } },
        { acceptWithExecpolicyAmendment: { execpolicy_amendment: [] } },
      ],
    });
    const options = interactions[0]?.kind === "permission" ? interactions[0].options : [];
    expect(options).toHaveLength(1);
    expect(options[0]).toMatchObject({ optionId: "accept" });
    expect(events.find((e) => e.kind === "_baton_notice")?.payload).toMatchObject({
      level: "warning",
      title: "Unrecognized approval choices from codex",
    });
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

    // 只有终态（/completed）铸造一条权威回执；/started 只驱动运行相位，不落回执。
    const receipts = events.filter((event) => event.kind === "approval_review_update");
    expect(receipts).toHaveLength(1);
    expect(receipts[0]?.payload).toMatchObject({
      toolCallId: "cmd1",
      decision: "denied",
      riskLevel: "high",
      userAuthorization: "low",
      rationale: "writes outside the workspace",
      actionType: "applyPatch",
    });
    // 一等回执自带 reviewId（arv_ 前缀）。
    expect((receipts[0]?.payload as { reviewId?: string }).reviewId).toMatch(/^arv_/);
    expect(events.find((event) => event.kind === "_baton_notice")).toBeUndefined();
  });

  test("auto-review tolerates missing unstable fields", () => {
    const { events, notify } = codexServerRequestHarness("decline");
    notify("item/autoApprovalReview/completed", { threadId: "th1", targetItemId: "cmd1" });
    const receipt = events.find((event) => event.kind === "approval_review_update")?.payload as {
      reviewId?: string;
      toolCallId?: string;
      decision?: string;
    };
    expect(receipt).toMatchObject({ toolCallId: "cmd1", decision: "aborted" });
    expect(receipt?.reviewId).toMatch(/^arv_/);
  });

  test("auto-review with an explicit null targetItemId stays targetless (no fabricated \"null\" id)", () => {
    // UNSTABLE wire 可能显式送 null；String(null) 会造出假 toolCallId "null"，
    // 把回执挂到不存在的工具卡上。null 与缺失同义：无 target，照样留痕。
    const { events, notify } = codexServerRequestHarness("decline");
    notify("item/autoApprovalReview/completed", {
      threadId: "th1",
      targetItemId: null,
      review: { status: "denied" },
    });
    const receipt = events.find((event) => event.kind === "approval_review_update")?.payload as {
      toolCallId?: string;
      decision?: string;
    };
    expect(receipt?.decision).toBe("denied");
    expect(receipt).not.toHaveProperty("toolCallId");
  });
});
