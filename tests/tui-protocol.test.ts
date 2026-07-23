import { describe, expect, test } from "bun:test";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/config.ts";
import { sessionDisplayTitle, SessionStore } from "../src/store/store.ts";
import { BatonChatProtocol, runStatusLabel, thoughtDisplayBlocks, toolTranscriptItem } from "../src/tui/protocol.ts";

describe("BatonChatProtocol exit", () => {
  test("restores the TUI only after runtime and session cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-exit-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const calls: string[] = [];
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, (sessionId) => {
        calls.push(`quit:${sessionId}`);
      });

      const internals = protocol as unknown as {
        runtime: { close: () => Promise<void> };
        session: { releaseLock: () => void };
      };
      internals.runtime.close = async () => {
        calls.push("runtime");
      };
      internals.session.releaseLock = () => {
        calls.push("lock");
      };

      await protocol.exit();
      expect(calls).toEqual(["runtime", "lock", `quit:${session.id}`]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("BatonChatProtocol session preview", () => {
  test("captures the first raw user input before mention expansion", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-preview-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
      const internals = protocol as unknown as {
        runtime: { submit: () => Promise<"completed">; close: () => Promise<void> };
      };
      internals.runtime.submit = async () => "completed";

      await protocol.submit("Implement session previews");
      await protocol.submit("Do not replace the preview");
      expect(store.openSession(session.id).meta.preview).toBe("Implement session previews");
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("names a fork from its first queued input and keeps the source as description", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-fork-name-"));
    try {
      const store = new SessionStore(root);
      const source = store.createSession({ cwd: "/repo" });
      source.setPreviewIfEmpty("Design session labels");
      const session = store.forkSession(source.id);
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
      const internals = protocol as unknown as {
        runtime: { submit: () => Promise<"completed">; close: () => Promise<void> };
      };
      internals.runtime.submit = async () => "completed";

      expect(sessionDisplayTitle(session.meta)).toBe("fork: Design session labels");
      await protocol.submit("Implement fork session labels");
      await protocol.submit("Do not replace the fork name");

      const reopened = store.openSession(session.id);
      expect(reopened.meta.title).toBe("Implement fork session labels");
      expect(reopened.meta.description).toBe("fork: Design session labels");
      expect(sessionDisplayTitle(reopened.meta)).toBe("Implement fork session labels");
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("BatonChatProtocol status command", () => {
  test("shows current session information without persisting command output", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-status-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      session.setPreviewIfEmpty("Implement status command");
      session.append({
        kind: "context_usage_update",
        harness: "codex",
        payload: { model: "default", contextUsed: 12_500, contextSize: 200_000 },
      });
      const eventCount = session.readEvents().length;
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
      await protocol.command("status", "");
      const status = protocol.getView().transcript.at(-1);
      expect(status).toMatchObject({
        id: "_baton_status",
        author: "baton",
        text: expect.stringContaining("Context: 12,500 / 200,000 tokens (6%)"),
      });
      expect(session.readEvents()).toHaveLength(eventCount);
      const internals = protocol as unknown as { runtime: { submit: () => Promise<"completed"> } };
      internals.runtime.submit = async () => "completed";
      await protocol.submit("continue");
      expect(protocol.getView().transcript.some((item) => item.id === "_baton_status")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("context lookup keys by wire sessionKey, not canonical id (claude vs claude-code)", async () => {
    // 回归：事件信封 harness 是 sessionKey（"claude-code"），曾用 canonical id（"claude"）
    // 查 per-harness 槽，导致 claude 的 /status context 永远 unavailable。codex 两键相同，
    // 只有 claude 能暴露这个错位。
    const root = mkdtempSync(join(tmpdir(), "baton-tui-status-claude-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      session.append({
        kind: "context_usage_update",
        harness: "claude-code",
        payload: { model: "default", contextUsed: 40_000, contextSize: 200_000 },
      });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
      await protocol.command("claude", "");
      await protocol.command("status", "");
      const status = protocol.getView().transcript.at(-1);
      expect(status).toMatchObject({
        id: "_baton_status",
        text: expect.stringContaining("Context: 40,000 / 200,000 tokens (20%)"),
      });
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("BatonChatProtocol streaming projection", () => {
  test("coalesces synchronous stream chunks into one view notification", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-stream-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
      let notifications = 0;
      protocol.subscribe(() => notifications++);

      for (const text of ["one ", "two ", "three"]) {
        session.append({
          kind: "agent_message_chunk",
          harness: "codex",
          turnId: "t1",
          payload: { messageId: "m_stream", content: { type: "text", text } },
        });
      }

      expect(notifications).toBe(0);
      await Bun.sleep(50);
      expect(notifications).toBe(1);
      expect(protocol.getView().transcript).toContainEqual(
        expect.objectContaining({ id: "m_stream", text: "one two three" }),
      );
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("flushes pending stream state immediately when an interaction arrives", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-stream-interaction-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
      let notifications = 0;
      protocol.subscribe(() => notifications++);

      session.append({
        kind: "agent_message_chunk",
        harness: "codex",
        turnId: "t1",
        payload: { messageId: "m_stream", content: { type: "text", text: "latest output" } },
      });
      session.append({
        kind: "permission_request",
        harness: "codex",
        turnId: "t1",
        payload: {
          kind: "permission",
          requestId: "ar_stream",
          title: "Run command?",
          options: [],
        },
      });

      expect(notifications).toBe(1);
      expect(protocol.getView().approval?.id).toBe("ar_stream");
      expect(protocol.getView().transcript).toContainEqual(
        expect.objectContaining({ id: "m_stream", text: "latest output" }),
      );
      await Bun.sleep(50);
      expect(notifications).toBe(1);
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("BatonChatProtocol harness commands", () => {
  test("switches the input target and sends a trailing message in one action", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-harness-command-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
      const submitted: Array<{ harness: string; text: string }> = [];
      const internals = protocol as unknown as {
        runtime: {
          submit: (harness: string, blocks: Array<{ type: string; text?: string }>) => Promise<"completed">;
          compactContext: (harness: string) => Promise<void>;
        };
      };
      internals.runtime.submit = async (harness, blocks) => {
        submitted.push({ harness, text: blocks[0]?.text ?? "" });
        return "completed";
      };
      const compacted: string[] = [];
      internals.runtime.compactContext = async (harness) => {
        compacted.push(harness);
      };

      await protocol.command("claude", "");
      expect(protocol.getView().runStatus?.[0]).toMatchObject({ author: "claude" });

      await protocol.command("codex", "");
      expect(protocol.getView().runStatus?.[0]).toMatchObject({ author: "codex" });

      await protocol.submit("/cc review this");
      expect(protocol.getView().runStatus?.[0]).toMatchObject({ author: "claude" });
      expect(submitted).toEqual([{ harness: "claude", text: "review this" }]);

      await protocol.submit("/cx fix it");
      expect(submitted.at(-1)).toEqual({ harness: "codex", text: "fix it" });

      await protocol.command("claude", "explain it");
      expect(submitted.at(-1)).toEqual({ harness: "claude", text: "explain it" });

      await protocol.command("codex", "implement it");
      expect(submitted.at(-1)).toEqual({ harness: "codex", text: "implement it" });

      await protocol.command("compact", "");
      expect(compacted).toEqual(["codex"]);
      expect(protocol.getView().status?.text).toBe("codex context compacted");

      await protocol.submit("/c ambiguous");
      expect(submitted).toHaveLength(4);
      expect(protocol.getView().transcript.at(-1)).toMatchObject({
        id: "_baton_harness_route_error",
        author: "baton",
        text: expect.stringContaining('harness prefix "/c" is ambiguous; matches codex, claude'),
      });
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("BatonChatProtocol view projection", () => {
  type ViewInternals = {
    state: {
      plans: Map<string, { planId: string; harness?: string; entries: Array<{ content: string; status: string }> }>;
      perHarness: Map<string, { lastPlanId?: string }>;
      timeline: Array<{ type: string; id: string }>;
      activeTurns: Map<
        string,
        {
          turnId: string;
          harness?: string;
          origin: "user" | "harness";
          state: "running" | "requires_action";
          startedAt?: number;
        }
      >;
    };
    changed: () => void;
  };

  test("idle agent status explicitly confirms the harness is no longer running", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-agentstatus-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
      const view = protocol.getView();
      // 主行常驻：idle 显式可见，无计时/中断提示
      expect(view.runStatus).toHaveLength(1);
      expect(view.runStatus?.[0]).toMatchObject({
        author: "codex",
        label: "default · idle",
      });
      expect(view.runStatus?.[0]?.startedAt).toBeUndefined();
      expect(view.runStatus?.[0]?.hint).toBeUndefined();
      expect(view.footer).toStartWith(`session: ${session.id}  `);
      expect(view.composerPlaceholder).toContain("Ctrl+J newline");
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("agent status shows context usage for its harness and model", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-context-status-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      session.append({
        kind: "context_usage_update",
        harness: "codex",
        payload: { model: "default", contextUsed: 12_500, contextSize: 200_000 },
      });
      session.append({
        kind: "context_usage_update",
        harness: "claude-code",
        payload: { model: "default", contextUsed: 80_000, contextSize: 200_000 },
      });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);

      expect(protocol.getView().runStatus).toHaveLength(2);
      expect(protocol.getView().runStatus?.[0]?.label).toBe("default · idle");
      expect(protocol.getView().runStatus?.[1]?.label).toBe("context 12,500/200,000 (6%)");
      expect(protocol.getView().footer).not.toContain("context");
      await protocol.command("claude", "");
      expect(protocol.getView().runStatus).toHaveLength(2);
      expect(protocol.getView().runStatus?.[0]?.label).toBe("default · idle");
      expect(protocol.getView().runStatus?.[1]?.label).toBe("context 80,000/200,000 (40%)");
      expect(protocol.getView().footer).not.toContain("context");

      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("agent status omits context usage reported for an old model", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-stale-context-status-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      session.append({
        kind: "context_usage_update",
        harness: "codex",
        payload: { model: "gpt-old", contextUsed: 190_000, contextSize: 200_000 },
      });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);

      expect(protocol.getView().runStatus?.[0]?.label).toBe("default · idle");

      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("plan shows in exactly one place: pin while unfinished, transcript once done", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-plan-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
      const internals = protocol as unknown as ViewInternals;
      const planInTranscript = () =>
        protocol.getView().transcript.some((item) => item.type === "block" && item.kind === "plan");

      internals.state.plans.set("p1", {
        planId: "p1",
        harness: "codex",
        entries: [
          { content: "step one", status: "completed" },
          { content: "step two", status: "in_progress" },
        ],
      });
      internals.state.timeline.push({ type: "plan", id: "p1" });
      // 归属查询键在统一 per-harness 槽（reduce 里由 plan_update 维护；这里直接摆内部状态）
      internals.state.perHarness.set("codex", { lastPlanId: "p1" });
      // pin 是"现在时"层：需有回合在运行（observed run 也算）
      internals.state.activeTurns.set("t_obs", { turnId: "t_obs", harness: "codex", origin: "harness", state: "running" });
      internals.changed();
      expect(protocol.getView().plan).toEqual([
        { content: "step one", status: "completed" },
        { content: "step two", status: "in_progress" },
      ]);
      expect(protocol.getView().footer).toContain("plan:1/2");
      // 互补显示：进行中归 pin，transcript 不重复渲染（过去时区域不该有实时改写的块）
      expect(planInTranscript()).toBe(false);

      // plan 跟随 harness：切到另一家后不再占用 pinned 层，切回则恢复。
      await protocol.command("claude", "");
      expect(protocol.getView().plan).toBeUndefined();
      expect(protocol.getView().footer).not.toContain("plan:");
      expect(planInTranscript()).toBe(true);
      await protocol.command("codex", "");
      expect(protocol.getView().plan).toHaveLength(2);
      expect(planInTranscript()).toBe(false);

      // idle 且未完成：pin 卸下（搁置即过去时）——否则状态更新缺失/中途放弃时 pin 永驻
      internals.state.activeTurns.clear();
      internals.changed();
      expect(protocol.getView().plan).toBeUndefined();
      expect(protocol.getView().footer).not.toContain("plan:");
      expect(planInTranscript()).toBe(true);

      // 回合重新开跑：未完成 plan 重新上 pin，transcript 卡随之撤下
      internals.state.activeTurns.set("t_obs", { turnId: "t_obs", harness: "codex", origin: "harness", state: "running" });
      internals.changed();
      expect(protocol.getView().plan).toHaveLength(2);
      expect(planInTranscript()).toBe(false);

      // 全部完成：即使仍在运行，pin 停发、footer 摘要撤下，终态卡在 transcript 原位供回看
      internals.state.plans.set("p1", {
        planId: "p1",
        harness: "codex",
        entries: [
          { content: "step one", status: "completed" },
          { content: "step two", status: "completed" },
        ],
      });
      internals.changed();
      expect(protocol.getView().plan).toBeUndefined();
      expect(protocol.getView().footer).not.toContain("plan:");
      expect(planInTranscript()).toBe(true);
      expect(
        protocol.getView().transcript.find((item) => item.type === "block" && item.kind === "plan"),
      ).toMatchObject({ id: "p1", status: "completed" });
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("BatonChatProtocol transcript projection", () => {
  // 委托状态是否可见改由 adapter 报告的生效路由驱动（见 session-runtime.test.ts）：
  // 投影不再读 config——config 是意图，且投影层不得按 harness 分支（不变量 #3）。
  test("renders auto-review receipts beside the target tool", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-auto-review-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      session.append({
        kind: "tool_call_update",
        harness: "codex",
        turnId: "t1",
        payload: { toolCallId: "tc1", title: "edit src/app.ts", kind: "edit", status: "completed" },
      });
      session.append({
        kind: "approval_review_update",
        harness: "codex",
        turnId: "t1",
        payload: {
          reviewId: "arv_test1",
          toolCallId: "tc1",
          decision: "approved",
          riskLevel: "low",
          userAuthorization: "unknown",
          rationale: "Auto-review returned a low-risk allow decision.",
        },
      });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);

      const toolIndex = protocol.getView().transcript.findIndex((item) => item.id === "tc1");
      // 展示双轴：approved 的 outcome 是 completed（审到底了，不被遮成 warning），
      // 需留痕由正交的 tone 表达（委托代批放行 → 审计痕）
      expect(protocol.getView().transcript[toolIndex + 1]).toMatchObject({
        id: "approval-review:arv_test1",
        kind: "notice",
        status: "completed",
        tone: "warning",
        title: "Automatic approval review approved (risk: low, authorization: unknown)",
        content: { type: "text", text: "Auto-review returned a low-risk allow decision." },
      });
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("renders agent messages as Markdown with an explicit streaming boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-markdown-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      session.append({
        kind: "user_message",
        harness: "codex",
        turnId: "t1",
        payload: { messageId: "m_user", content: [{ type: "text", text: "## literal" }] },
      });
      session.append({ kind: "state_update", harness: "codex", turnId: "t1", payload: { state: "running" } });
      session.append({
        kind: "agent_thought",
        harness: "codex",
        turnId: "t1",
        payload: { messageId: "m_thought", content: [{ type: "text", text: "**Inspecting image**" }] },
      });
      session.append({
        kind: "agent_message_chunk",
        harness: "codex",
        turnId: "t1",
        payload: { messageId: "m_stream", content: { type: "text", text: "## Streaming" } },
      });
      session.append({
        kind: "agent_message",
        harness: "codex",
        turnId: "t1",
        payload: { messageId: "m_done", content: [{ type: "text", text: "**Done**" }] },
      });

      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: true }, () => undefined);
      const messages = protocol.getView().transcript.filter((item) => item.type === "message");
      expect(messages).toEqual([
        {
          type: "message",
          id: "m_user",
          role: "user",
          author: "you",
          text: "## literal",
          format: "plain",
        },
        {
          type: "message",
          id: "m_stream",
          role: "agent",
          author: "codex",
          text: "## Streaming",
          format: "markdown",
          streaming: true,
        },
        {
          type: "message",
          id: "m_done",
          role: "agent",
          author: "codex",
          text: "**Done**",
          format: "markdown",
          streaming: false,
        },
      ]);
      // thought/tool block 的归属走一等 author 字段，不再拼进 title
      expect(protocol.getView().transcript.find((item) => item.id === "m_thought:0")).toMatchObject({
        author: "codex",
        title: "Inspecting image",
      });
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("thoughtDisplayBlocks", () => {
  test("turns Codex title-only summaries into separate blocks", () => {
    expect(thoughtDisplayBlocks("**Inspecting files**\n\n<!-- -->\n**Planning changes**\n\n<!-- -->")).toEqual([
      { title: "Inspecting files" },
      { title: "Planning changes" },
    ]);
  });

  test("hides an incomplete streaming placeholder", () => {
    expect(thoughtDisplayBlocks("**Inspecting files**\n\n<!--")).toEqual([{ title: "Inspecting files" }]);
  });

  test("keeps an ordinary thought body", () => {
    expect(thoughtDisplayBlocks("**Comparing options**\n\nThe second approach is smaller.")).toEqual([
      { title: "Comparing options", content: "The second approach is smaller." },
    ]);
  });
});

describe("toolTranscriptItem", () => {
  test("keeps command source separate from its output", () => {
    expect(
      toolTranscriptItem({
        toolCallId: "tc_cmd",
        harness: "codex",
        title: "Bash: git status --short",
        kind: "execute",
        status: "completed",
        content: [{ type: "text", text: " M src/index.ts\n" }],
        locations: [],
        rawInput: { command: "git status --short" },
      }),
    ).toEqual({
      type: "block",
      id: "tc_cmd",
      kind: "tool",
      author: "codex",
      title: "Ran",
      status: "completed",
      content: [
        { type: "command", command: "git status --short" },
        { type: "output", lines: [" M src/index.ts"] },
      ],
    });
  });

  test("maps diff blocks to op-tagged chat-tui diff content", () => {
    const patch = "--- src/index.ts\n+++ src/index.ts\n@@ -1 +1 @@\n-old\n+new";
    expect(
      toolTranscriptItem({
        toolCallId: "tc_edit",
        title: "edit src/index.ts",
        kind: "edit",
        status: "completed",
        content: [{ type: "diff", changes: [{ operation: "modify", path: "src/index.ts" }], patch }],
        locations: [],
      }),
    ).toEqual({
      type: "block",
      id: "tc_edit",
      kind: "tool",
      title: "edit src/index.ts",
      status: "completed",
      content: [{ type: "diff", op: "modify", path: "src/index.ts", oldPath: undefined, patch }],
    });
  });

  test("patchless diff still yields an op-tagged block; open operations normalize", () => {
    const item = toolTranscriptItem({
      toolCallId: "tc_patch",
      title: "apply patch",
      kind: "edit",
      status: "completed",
      content: [
        { type: "diff", changes: [{ operation: "add", path: "a.ts" }] },
        { type: "diff", changes: [{ operation: "update", path: "b.ts" }] },
        { type: "diff", changes: [{ operation: "rename", path: "d.ts", oldPath: "c.ts" }] },
      ],
      locations: [],
    });
    expect(item.content).toEqual([
      { type: "diff", op: "add", path: "a.ts", oldPath: undefined, patch: undefined },
      { type: "diff", op: "modify", path: "b.ts", oldPath: undefined, patch: undefined },
      { type: "diff", op: "move", path: "d.ts", oldPath: "c.ts", patch: undefined },
    ]);
  });
});

// 启动时的 resume/fork 会话选择已移到 session picker（src/tui/session-picker.tsx，
// 不经过 BatonChatProtocol）；/sessions 的会话内切换浮层仍由 protocol 承载。

describe("BatonChatProtocol sessions picker", () => {
  test("only shows sessions from the current project", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-project-sessions-"));
    try {
      const store = new SessionStore(root);
      const current = store.createSession({ cwd: "/repo" });
      const sibling = store.createSession({ cwd: "/repo" });
      const other = store.createSession({ cwd: "/other" });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session: current, resumed: false }, () => undefined);

      await protocol.command("sessions", "");

      const values = protocol.getView().picker?.options.map((option) => option.value) ?? [];
      expect(values).toHaveLength(2);
      expect(values).toContain(current.id);
      expect(values).toContain(sibling.id);
      expect(values).not.toContain(other.id);
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("runStatusLabel", () => {
  const base = { activeTurns: new Map(), toolCalls: new Map(), lastError: undefined, lastSeq: 5 };
  const withPhase = (turnId: string, phase: { phase: string; title?: string }) => ({
    ...base,
    activeTurns: new Map([[turnId, { turnId, origin: "user" as const, state: "running" as const, phase }]]),
  });

  test("defaults to thinking", () => {
    expect(runStatusLabel(base)).toBe("thinking…");
  });

  test("phase overrides thinking; title wins over generic phase text", () => {
    expect(runStatusLabel(withPhase("t1", { phase: "compacting", title: "Compacting context…" }), "t1")).toBe(
      "Compacting context…",
    );
    expect(runStatusLabel(withPhase("t1", { phase: "warming" }), "t1")).toBe("warming…");
  });

  test("shows the current tool activity instead of generic thinking", () => {
    const toolCalls = new Map([
      [
        "tc1",
        {
          toolCallId: "tc1",
          turnId: "t1",
          title: "Read: /repo/src/main.ts",
          kind: "read",
          status: "in_progress",
          content: [],
          locations: [],
        },
      ],
    ]);
    expect(runStatusLabel({ ...base, toolCalls }, "t1")).toBe("reading…");
    expect(runStatusLabel({ ...base, toolCalls }, "t2")).toBe("thinking…");
    toolCalls.get("tc1")!.status = "completed";
    expect(runStatusLabel({ ...base, toolCalls }, "t1")).toBe("thinking…");
  });

  test("phase is per-turn: another turn's phase does not leak", () => {
    const state = withPhase("t1", { phase: "compacting" });
    expect(runStatusLabel(state, "t2")).toBe("thinking…");
    // turnId 缺省时退化为任一带 phase 的 turn
    expect(runStatusLabel(state)).toBe("compacting…");
  });

  test("willRetry shows retrying only while the error is the latest event", () => {
    const err = { message: "boom", willRetry: true, seq: 5 };
    expect(runStatusLabel({ ...base, lastError: err })).toBe("retrying…");
    // 其后有任何事件（lastSeq 前进）即视为已恢复
    expect(runStatusLabel({ ...base, lastError: err, lastSeq: 6 })).toBe("thinking…");
  });
});

describe("interaction eventization: pending projects from the event stream", () => {
  const APPROVAL_OPTIONS = [
    { optionId: "allow", name: "Allow", polarity: "allow" as const, lifetime: "once" as const },
    { optionId: "deny", name: "Deny", polarity: "reject" as const, lifetime: "once" as const },
  ];

  test("approval card follows permission_request/resolved events; stale answer is a hint, not a crash", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-interaction-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);

      // 事件流是 pending 交互的唯一真相源：request 落盘即出卡片，id = requestId
      session.append({
        kind: "permission_request",
        harness: "claude-code",
        turnId: "t1",
        payload: {
          kind: "permission",
          requestId: "ar_1",
          title: "Write file?",
          description: "/repo/output.txt",
          options: APPROVAL_OPTIONS,
        },
      });
      let view = protocol.getView();
      expect(view.approval).toMatchObject({
        id: "ar_1",
        title: "Write file?",
        description: "/repo/output.txt",
      });

      // 无 live resolver（如崩溃残留）：应答提示 stale，不静默吞掉
      protocol.resolveApproval("ar_1", "allow");
      view = protocol.getView();
      expect(view.approval).not.toBeNull(); // 卡片消失只由 resolved 事件驱动
      expect(view.status?.text).toContain("no longer pending");

      // resolved 落盘 → 卡片消失
      session.append({
        kind: "permission_resolved",
        harness: "baton",
        payload: { requestId: "ar_1", outcome: "cancelled" },
      });
      expect(protocol.getView().approval).toBeNull();
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("question card follows question_request/resolved events", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-question-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);

      session.append({
        kind: "question_request",
        harness: "codex",
        turnId: "t1",
        payload: {
          kind: "question",
          requestId: "qr_1",
          questions: [{ questionId: "q1", header: "Scope", question: "Which scope?" }],
        },
      });
      expect(protocol.getView().question).toMatchObject({ id: "qr_1" });

      session.append({
        kind: "question_resolved",
        harness: "baton",
        payload: { requestId: "qr_1", outcome: "cancelled" },
      });
      expect(protocol.getView().question).toBeNull();
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("hook trust request uses the approval primitive but keeps its own response kind", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-hook-trust-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
      session.append({
        kind: "hook_trust_request",
        harness: "codex",
        turnId: "t1",
        payload: {
          kind: "hook_trust",
          requestId: "htr_1",
          harnessName: "Codex",
          hooks: [
            {
              key: "hook1",
              source: "plugin",
              sourcePath: "/plugins/devloop/hooks.json",
              trustStatus: "modified",
              command: "python hook.py",
              pluginId: "devloop@devloop",
            },
          ],
        },
      });
      expect(protocol.getView().approval).toMatchObject({
        id: "htr_1",
        title: "Trust 1 Codex hook?",
        options: [{ optionId: "trust" }, { optionId: "skip" }],
      });
      protocol.resolveApproval("htr_1", "trust");
      expect(protocol.getView().status?.text).toContain("no longer pending");
      session.append({
        kind: "hook_trust_resolved",
        harness: "baton",
        payload: { requestId: "htr_1", outcome: "cancelled" },
      });
      expect(protocol.getView().approval).toBeNull();
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("BatonChatProtocol steer submit", () => {
  function protocolWith(root: string) {
    const store = new SessionStore(root);
    const session = store.createSession({ cwd: "/repo" });
    return new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
  }

  test("busy + steerable: Enter steers instead of queueing", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-steer-"));
    try {
      const protocol = protocolWith(root);
      const calls: string[] = [];
      const internals = protocol as unknown as {
        runtime: {
          queueLength: number;
          canSteer: (harness: string) => boolean;
          steer: (harness: string, blocks: unknown) => Promise<{ effective: string }>;
          submit: () => Promise<"completed">;
        };
      };
      internals.runtime.canSteer = () => true;
      internals.runtime.steer = async () => {
        calls.push("steer");
        return { effective: "steer" };
      };
      internals.runtime.submit = async () => {
        calls.push("submit");
        return "completed";
      };

      await protocol.submit("prefer approach B");
      expect(calls).toEqual(["steer"]);
      expect(protocol.getView().status?.text).toContain("steering");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejected steer degrades honestly: status says follow-up, not steer", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-steer-degrade-"));
    try {
      const protocol = protocolWith(root);
      const internals = protocol as unknown as {
        runtime: {
          canSteer: (harness: string) => boolean;
          steer: () => Promise<{ effective: string; outcome: Promise<string> }>;
        };
      };
      let resolveOutcome: ((value: string) => void) | undefined;
      const outcome = new Promise<string>((resolve) => {
        resolveOutcome = resolve;
      });
      internals.runtime.canSteer = () => true;
      internals.runtime.steer = async () => ({ effective: "follow_up", outcome });

      const submitted = protocol.submit("prefer approach B");
      await Bun.sleep(1); // 让 protocol 走到降级状态提示、停在等待 outcome 处
      const degraded = protocol.getView().status?.text;
      expect(degraded).toContain("queued as follow-up");
      expect(degraded).not.toContain("steering");
      resolveOutcome?.("completed");
      await submitted;
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("queued follow-ups suppress steer: order intent wins over injection", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-steer-queue-"));
    try {
      const protocol = protocolWith(root);
      const calls: string[] = [];
      const internals = protocol as unknown as {
        runtime: {
          queueLength: number;
          isBusy: boolean;
          canSteer: (harness: string) => boolean;
          submit: () => Promise<"completed">;
        };
      };
      Object.defineProperty(internals.runtime, "queueLength", { get: () => 1 });
      Object.defineProperty(internals.runtime, "isBusy", { get: () => true });
      internals.runtime.canSteer = () => {
        throw new Error("canSteer must not decide when follow-ups are already queued");
      };
      internals.runtime.submit = async () => {
        calls.push("submit");
        return "completed";
      };

      await protocol.submit("after those");
      expect(calls).toEqual(["submit"]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("BatonChatProtocol input history", () => {
  function makeProtocol(prefix: string) {
    const root = mkdtempSync(join(tmpdir(), prefix));
    const store = new SessionStore(root);
    const session = store.createSession({ cwd: "/repo" });
    const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
    (protocol as unknown as { runtime: { submit: () => Promise<"completed"> } }).runtime.submit = async () => "completed";
    return { root, store, session, protocol };
  }

  test("↑ walks newest→oldest and stops at the oldest; ↓ returns then restores empty draft", async () => {
    const { root, protocol } = makeProtocol("baton-hist-walk-");
    try {
      await protocol.submit("first");
      await protocol.submit("second");
      await protocol.submit("third");
      expect(protocol.historyPrev("")).toEqual({ text: "third" });
      expect(protocol.historyPrev("third")).toEqual({ text: "second" });
      expect(protocol.historyPrev("second")).toEqual({ text: "first" });
      expect(protocol.historyPrev("first")).toBeNull(); // 已到最旧，停住
      expect(protocol.historyNext("first")).toEqual({ text: "second" });
      expect(protocol.historyNext("second")).toEqual({ text: "third" });
      expect(protocol.historyNext("third")).toEqual({ text: "" }); // 越过最新 → 恢复空草稿
      expect(protocol.historyNext("")).toBeNull(); // 未在浏览
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("editing a recalled entry stops navigation (null → cursor move)", async () => {
    const { root, protocol } = makeProtocol("baton-hist-edit-");
    try {
      await protocol.submit("a");
      await protocol.submit("b");
      expect(protocol.historyPrev("")).toEqual({ text: "b" });
      expect(protocol.historyPrev("b-edited")).toBeNull();
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("stash restores a half-typed draft when ↓ passes the newest entry", async () => {
    const { root, protocol } = makeProtocol("baton-hist-stash-");
    try {
      await protocol.submit("one");
      expect(protocol.historyPrev("typed draft")).toEqual({ text: "one" });
      expect(protocol.historyNext("one")).toEqual({ text: "typed draft" });
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("adjacent duplicate submissions collapse into one entry", async () => {
    const { root, protocol } = makeProtocol("baton-hist-dedup-");
    try {
      await protocol.submit("same");
      await protocol.submit("same");
      await protocol.submit("other");
      expect(protocol.historyPrev("")).toEqual({ text: "other" });
      expect(protocol.historyPrev("other")).toEqual({ text: "same" });
      expect(protocol.historyPrev("same")).toBeNull(); // 只有一条 "same"
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("seeds history from a resumed session's persisted user messages", () => {
    const root = mkdtempSync(join(tmpdir(), "baton-hist-seed-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      session.append({
        kind: "user_message",
        harness: "claude-code",
        turnId: "t_1",
        payload: { messageId: "m_1", content: [{ type: "text", text: "seeded one" }] },
      });
      session.append({
        kind: "user_message",
        harness: "claude-code",
        turnId: "t_2",
        payload: { messageId: "m_2", content: [{ type: "text", text: "seeded two" }] },
      });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
      expect(protocol.historyPrev("")).toEqual({ text: "seeded two" });
      expect(protocol.historyPrev("seeded two")).toEqual({ text: "seeded one" });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
