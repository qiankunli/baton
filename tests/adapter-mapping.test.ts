// 中间过程最大公约数规范的 provider 适配测试：两家 adapter 必须把各自原生形态
// 归一成同一套事件（plan_update / diff 内容块 / tool_call_content_chunk）。
import { describe, expect, test } from "bun:test";

import { ClaudeAdapter, claudeApprovalOptions, claudeToolDiff, claudeToolTitle, todoWritePlan } from "../src/adapters/claude/adapter.ts";
import { CodexAdapter } from "../src/adapters/codex/adapter.ts";
import type { AnyNewEvent } from "../src/events/types.ts";

const approvalHandler = async () => ({ optionId: "deny" });

function claudeHarness(): { events: AnyNewEvent[]; feed: (msg: unknown) => void } {
  const adapter = new ClaudeAdapter({ approvalHandler });
  const events: AnyNewEvent[] = [];
  const rt = { cwd: "/tmp", suppressedToolIds: new Set<string>(), claudeSessionId: "sess1" };
  const feed = (msg: unknown) =>
    (adapter as unknown as { handleMessage: (r: unknown, e: (ev: AnyNewEvent) => void, m: unknown) => void }).handleMessage(
      rt,
      (ev) => events.push(ev),
      msg,
    );
  return { events, feed };
}

function codexHarness(): { events: AnyNewEvent[]; notify: (method: string, params: unknown) => void } {
  const adapter = new CodexAdapter({ approvalHandler });
  const events: AnyNewEvent[] = [];
  const rt = { threadId: "th1", turnId: "t1", sink: (ev: AnyNewEvent) => events.push(ev) };
  const notify = (method: string, params: unknown) =>
    (adapter as unknown as { handleNotification: (r: unknown, m: string, p: unknown) => void }).handleNotification(
      rt,
      method,
      params,
    );
  return { events, notify };
}

describe("claude: TodoWrite → plan_update", () => {
  test("emits plan_update with mapped entries, no tool card", () => {
    const { events, feed } = claudeHarness();
    feed({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        content: [
          {
            type: "tool_use",
            id: "tu1",
            name: "TodoWrite",
            input: { todos: [{ content: "步骤一", status: "completed" }, { content: "步骤二", status: "in_progress" }] },
          },
        ],
      },
    });
    const plans = events.filter((e) => e.kind === "plan_update");
    expect(plans).toHaveLength(1);
    expect((plans[0]!.payload as { entries: unknown[] }).entries).toEqual([
      { content: "步骤一", priority: "medium", status: "completed" },
      { content: "步骤二", priority: "medium", status: "in_progress" },
    ]);
    expect(events.filter((e) => e.kind === "tool_call_update")).toHaveLength(0);

    // 对应 tool_result 也被吞掉，不会凭空造出工具卡
    feed({ type: "user", message: { content: [{ type: "tool_result", tool_use_id: "tu1", content: "ok" }] } });
    expect(events.filter((e) => e.kind === "tool_call_update")).toHaveLength(0);
  });

  test("todoWritePlan tolerates unknown status", () => {
    expect(todoWritePlan({ todos: [{ content: "x", status: "weird" }] })[0]!.status).toBe("pending");
  });
});

describe("claude: edit tools → diff content", () => {
  test("Skill title includes the launched skill name", () => {
    expect(claudeToolTitle("Skill", { skill: "devloop:gcampr" })).toBe("Skill: devloop:gcampr");
  });

  test("Edit carries modify diff with patch", () => {
    const diff = claudeToolDiff("Edit", { file_path: "/a/b.ts", old_string: "old", new_string: "new" });
    expect(diff).toEqual({
      type: "diff",
      changes: [{ operation: "modify", path: "/a/b.ts" }],
      patch: "--- /a/b.ts\n- old\n+ new",
    });
  });

  test("Write is add; Bash has no diff", () => {
    expect(claudeToolDiff("Write", { file_path: "/a/new.ts", content: "x" })?.changes[0]!.operation).toBe("add");
    expect(claudeToolDiff("Bash", { command: "ls" })).toBeNull();
  });

  test("tool_use emits tool_call_update with diff block", () => {
    const { events, feed } = claudeHarness();
    feed({
      type: "assistant",
      parent_tool_use_id: null,
      message: {
        content: [{ type: "tool_use", id: "tu2", name: "Edit", input: { file_path: "/a.ts", old_string: "1", new_string: "2" } }],
      },
    });
    const tc = events.find((e) => e.kind === "tool_call_update");
    expect(tc).toBeDefined();
    const content = (tc!.payload as { content: Array<{ type: string }> }).content;
    expect(content[0]!.type).toBe("diff");
  });

  test("tool_result appends displayable output without replacing existing content", () => {
    const { events, feed } = claudeHarness();
    feed({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tu2", content: "command output\n" }] },
    });
    const chunk = events.find((e) => e.kind === "tool_call_content_chunk");
    expect(chunk?.payload).toEqual({
      toolCallId: "tu2",
      content: { type: "text", text: "command output\n" },
    });
  });
});

describe("codex: tool output mapping", () => {
  test("fileChange item maps changes and joins patch", () => {
    const { events, notify } = codexHarness();
    notify("item/completed", {
      threadId: "th1",
      turnId: "ct1",
      item: {
        type: "fileChange",
        id: "fc1",
        status: "completed",
        changes: [
          { path: "/x.ts", kind: "update", diff: "@@ -1 +1 @@" },
          { path: "/y.ts", kind: "add", diff: "+new file" },
        ],
      },
    });
    const tc = events.find((e) => e.kind === "tool_call_update");
    const content = (tc!.payload as { content: Array<Record<string, unknown>> }).content;
    expect(content[0]!.type).toBe("diff");
    expect(content[0]!.changes).toEqual([
      { operation: "modify", path: "/x.ts" },
      { operation: "add", path: "/y.ts" },
    ]);
    expect(content[0]!.patch).toBe("@@ -1 +1 @@\n+new file");
  });

  test("commandExecution outputDelta streams as tool_call_content_chunk", () => {
    const { events, notify } = codexHarness();
    notify("item/commandExecution/outputDelta", { threadId: "th1", turnId: "ct1", itemId: "cmd1", delta: "line1\n" });
    const chunk = events.find((e) => e.kind === "tool_call_content_chunk");
    expect(chunk).toBeDefined();
    expect((chunk!.payload as { toolCallId: string }).toolCallId).toBe("cmd1");
    expect((chunk!.payload as { content: { text: string } }).content.text).toBe("line1\n");
  });

  test("commandExecution completed backfills the full aggregated output", () => {
    const { events, notify } = codexHarness();
    notify("item/completed", {
      threadId: "th1",
      turnId: "ct1",
      item: {
        type: "commandExecution",
        id: "cmd1",
        status: "completed",
        command: "printf hello",
        aggregatedOutput: "hello\n",
      },
    });
    const update = events.find((e) => e.kind === "tool_call_update");
    expect((update!.payload as { content: Array<{ type: string; text: string }> }).content).toEqual([
      { type: "text", text: "hello\n" },
    ]);
  });
});

describe("codex: reasoning summary parts", () => {
  test("keeps each summary part as an independent thought message", () => {
    const { events, notify } = codexHarness();
    notify("item/reasoning/summaryTextDelta", {
      threadId: "th1",
      itemId: "rs1",
      summaryIndex: 0,
      delta: "**Inspecting files**\n\n<!-- -->",
    });
    notify("item/reasoning/summaryTextDelta", {
      threadId: "th1",
      itemId: "rs1",
      summaryIndex: 1,
      delta: "**Planning changes**\n\n<!-- -->",
    });
    notify("item/completed", {
      threadId: "th1",
      item: {
        type: "reasoning",
        id: "rs1",
        summary: ["**Inspecting files**\n\n<!-- -->", "**Planning changes**\n\n<!-- -->"],
      },
    });

    expect(
      events
        .filter((event) => event.kind === "agent_thought" || event.kind === "agent_thought_chunk")
        .map((event) => ({ kind: event.kind, messageId: (event.payload as { messageId: string }).messageId })),
    ).toEqual([
      { kind: "agent_thought_chunk", messageId: "rs1:summary:0" },
      { kind: "agent_thought_chunk", messageId: "rs1:summary:1" },
      { kind: "agent_thought", messageId: "rs1:summary:0" },
      { kind: "agent_thought", messageId: "rs1:summary:1" },
    ]);
  });
});

describe("claude: approval options", () => {
  test("without SDK suggestions there is no always option (baton 不自造授权规则)", () => {
    const options = claudeApprovalOptions(false);
    expect(options.map((o) => o.kind)).toEqual(["allow_once", "reject_once"]);
  });

  test("with suggestions an allow_always option appears between allow and deny", () => {
    const options = claudeApprovalOptions(true);
    expect(options.map((o) => o.kind)).toEqual(["allow_once", "allow_always", "reject_once"]);
    expect(new Set(options.map((o) => o.optionId)).size).toBe(options.length);
  });
});
