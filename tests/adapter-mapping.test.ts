// 中间过程最大公约数规范的 provider 适配测试：两家 adapter 必须把各自原生形态
// 归一成同一套事件（plan_update / diff 内容块 / tool_call_content_chunk）。
import { describe, expect, test } from "bun:test";

import {
  ClaudeAdapter,
  claudeApprovalOptions,
  claudeResultDiff,
  claudeToolDiff,
  claudeToolTitle,
  todoWritePlan,
} from "../src/adapters/claude/adapter.ts";
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

  test("Edit carries intent-only modify diff (real patch arrives via tool_use_result)", () => {
    const diff = claudeToolDiff("Edit", { file_path: "/a/b.ts", old_string: "old", new_string: "new" });
    expect(diff).toEqual({
      type: "diff",
      changes: [{ operation: "modify", path: "/a/b.ts" }],
    });
  });

  test("Write is add; Bash has no diff", () => {
    expect(claudeToolDiff("Write", { file_path: "/a/new.ts", content: "x" })?.changes[0]!.operation).toBe("add");
    expect(claudeToolDiff("Bash", { command: "ls" })).toBeNull();
  });

  test("claudeResultDiff synthesizes a unified patch from structuredPatch", () => {
    const diff = claudeResultDiff({
      filePath: "/a/b.ts",
      oldString: "old",
      newString: "new",
      originalFile: "const x = 1;\nold\n",
      structuredPatch: [
        { oldStart: 1, oldLines: 2, newStart: 1, newLines: 2, lines: [" const x = 1;", "-old", "+new"] },
      ],
      userModified: false,
    });
    expect(diff).toEqual({
      type: "diff",
      changes: [{ operation: "modify", path: "/a/b.ts" }],
      patch: "--- /a/b.ts\n+++ /a/b.ts\n@@ -1,2 +1,2 @@\n const x = 1;\n-old\n+new",
    });
  });

  test("claudeResultDiff maps Write create to add with /dev/null header", () => {
    const diff = claudeResultDiff({
      type: "create",
      filePath: "/a/new.ts",
      content: "x\ny",
      structuredPatch: [{ oldStart: 0, oldLines: 0, newStart: 1, newLines: 2, lines: ["+x", "+y"] }],
    });
    expect(diff?.changes).toEqual([{ operation: "add", path: "/a/new.ts" }]);
    expect(diff?.patch).toBe("--- /dev/null\n+++ /a/new.ts\n@@ -0,0 +1,2 @@\n+x\n+y");
  });

  test("claudeResultDiff rejects unknown shapes instead of guessing", () => {
    expect(claudeResultDiff(undefined)).toBeNull();
    expect(claudeResultDiff("The file has been updated")).toBeNull();
    expect(claudeResultDiff({ filePath: "/a.ts", structuredPatch: [] })).toBeNull();
    // hunk 字段不合形状（私有格式漂移）→ 整体降级，不产出半合法 patch
    expect(claudeResultDiff({ filePath: "/a.ts", structuredPatch: [{ oldStart: "1", lines: ["+x"] }] })).toBeNull();
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

  test("edit tool_use_result backfills the real patch and suppresses duplicate text output", () => {
    const { events, feed } = claudeHarness();
    feed({
      type: "user",
      message: { content: [{ type: "tool_result", tool_use_id: "tu3", content: "The file /a.ts has been updated.\n" }] },
      tool_use_result: {
        filePath: "/a.ts",
        structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ["-old", "+new"] }],
      },
    });
    const tc = events.find((e) => e.kind === "tool_call_update");
    expect(tc?.payload).toMatchObject({
      toolCallId: "tu3",
      status: "completed",
      content: [
        {
          type: "diff",
          changes: [{ operation: "modify", path: "/a.ts" }],
          patch: "--- /a.ts\n+++ /a.ts\n@@ -1,1 +1,1 @@\n-old\n+new",
        },
      ],
    });
    // diff 即输出：编辑结果的说明文本与 patch 重复，不再追加文本块
    expect(events.find((e) => e.kind === "tool_call_content_chunk")).toBeUndefined();
  });
});

describe("structured questions", () => {
  test("Claude AskUserQuestion emits request/resolved and returns answers in updatedInput", async () => {
    const events: AnyNewEvent[] = [];
    const adapter = new ClaudeAdapter({
      approvalHandler,
      questionHandler: async (request) => ({ answers: { [request.questions[0]!.questionId]: ["Careful"] } }),
    });
    const result = await (
      adapter as unknown as {
        handleCanUseTool: (
          emit: (event: AnyNewEvent) => void,
          name: string,
          input: Record<string, unknown>,
          meta: Record<string, unknown>,
        ) => Promise<{ behavior: string; updatedInput?: Record<string, unknown> }>;
      }
    ).handleCanUseTool(
      (event) => events.push(event),
      "AskUserQuestion",
      {
        questions: [
          {
            header: "Approach",
            question: "How should we proceed?",
            multiSelect: false,
            options: [{ label: "Careful", description: "Verify first" }],
          },
        ],
      },
      {},
    );

    expect(events.map((event) => event.kind)).toEqual(["question_request", "question_resolved"]);
    expect(result).toEqual({
      behavior: "allow",
      updatedInput: {
        questions: [
          {
            header: "Approach",
            question: "How should we proceed?",
            multiSelect: false,
            options: [{ label: "Careful", description: "Verify first" }],
          },
        ],
        answers: { "How should we proceed?": "Careful" },
      },
    });
  });

  test("Codex requestUserInput returns the app-server answer envelope", async () => {
    const events: AnyNewEvent[] = [];
    const adapter = new CodexAdapter({
      approvalHandler,
      questionHandler: async () => ({ answers: { approach: ["Fast", "Safe"] } }),
    });
    const result = await (
      adapter as unknown as {
        handleServerRequest: (runtime: unknown, method: string, params: unknown) => Promise<unknown>;
      }
    ).handleServerRequest(
      { threadId: "th1", sink: (event: AnyNewEvent) => events.push(event) },
      "item/tool/requestUserInput",
      {
        itemId: "item1",
        questions: [
          {
            id: "approach",
            header: "Approach",
            question: "Choose approaches",
            isOther: true,
            options: [{ label: "Fast", description: "Move quickly" }],
          },
        ],
      },
    );

    expect(events.map((event) => event.kind)).toEqual(["question_request", "question_resolved"]);
    expect(result).toEqual({ answers: { approach: { answers: ["Fast", "Safe"] } } });
  });
});

describe("codex: tool output mapping", () => {
  test("fileChange item maps object kinds and builds renderable unified patches", () => {
    const { events, notify } = codexHarness();
    notify("item/completed", {
      threadId: "th1",
      turnId: "ct1",
      item: {
        type: "fileChange",
        id: "fc1",
        status: "completed",
        changes: [
          { path: "/x.ts", kind: { type: "update", move_path: null }, diff: "@@ -1 +1 @@\n-old\n+new" },
          { path: "/y.ts", kind: { type: "add" }, diff: "new file" },
          { path: "/z.ts", kind: { type: "delete" }, diff: "old file" },
        ],
      },
    });
    const tc = events.find((e) => e.kind === "tool_call_update");
    const content = (tc!.payload as { content: Array<Record<string, unknown>> }).content;
    expect(content.map((block) => block.changes)).toEqual([
      [{ operation: "modify", path: "/x.ts" }],
      [{ operation: "add", path: "/y.ts" }],
      [{ operation: "delete", path: "/z.ts" }],
    ]);
    expect(content.map((block) => block.patch)).toEqual([
      "--- /x.ts\n+++ /x.ts\n@@ -1 +1 @@\n-old\n+new",
      "--- /dev/null\n+++ /y.ts\n@@ -0,0 +1,1 @@\n+new file",
      "--- /z.ts\n+++ /dev/null\n@@ -1,1 +0,0 @@\n-old file",
    ]);
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
