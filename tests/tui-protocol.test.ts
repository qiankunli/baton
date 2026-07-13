import { describe, expect, test } from "bun:test";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/config.ts";
import { SessionStore } from "../src/store/store.ts";
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
});

describe("BatonChatProtocol status command", () => {
  test("shows current session information without persisting command output", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-status-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      session.setPreviewIfEmpty("Implement status command");
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
      await protocol.command("status", "");
      expect(protocol.getView().transcript.at(-1)).toMatchObject({
        id: "_baton_status",
        author: "baton",
        text: expect.stringContaining(`Session: ${session.id}`),
      });
      expect(session.readEvents()).toHaveLength(0);
      const internals = protocol as unknown as { runtime: { submit: () => Promise<"completed"> } };
      internals.runtime.submit = async () => "completed";
      await protocol.submit("continue");
      expect(protocol.getView().transcript.some((item) => item.id === "_baton_status")).toBe(false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("BatonChatProtocol provider commands", () => {
  test("switches the input target directly and rejects arguments", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-provider-command-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);

      await protocol.command("claude", "");
      expect(protocol.getView().runStatus?.[0]).toMatchObject({ author: "claude" });

      await protocol.command("codex", "");
      expect(protocol.getView().runStatus?.[0]).toMatchObject({ author: "codex" });

      expect(protocol.command("claude", "extra")).rejects.toThrow("/claude takes no arguments");
      await protocol.exit();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("BatonChatProtocol view projection", () => {
  type ViewInternals = {
    state: {
      plans: Map<string, { planId: string; entries: Array<{ content: string; status: string }> }>;
      timeline: Array<{ type: string; id: string }>;
      activeTurns: Map<
        string,
        {
          turnId: string;
          provider?: string;
          origin: "user" | "provider";
          state: "running" | "requires_action";
          startedAt?: number;
        }
      >;
    };
    changed: () => void;
  };

  test("idle agent status keeps the input target visible without run phase", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-agentstatus-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
      const view = protocol.getView();
      // 主行常驻：idle 退化为目标标识（provider · model），无相位/计时/中断提示
      expect(view.runStatus).toHaveLength(1);
      expect(view.runStatus?.[0]).toMatchObject({ author: "codex", label: "default" });
      expect(view.runStatus?.[0]?.startedAt).toBeUndefined();
      expect(view.runStatus?.[0]?.hint).toBeUndefined();
      expect(view.composerPlaceholder).toContain("Ctrl+J newline");
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
        entries: [
          { content: "step one", status: "completed" },
          { content: "step two", status: "in_progress" },
        ],
      });
      internals.state.timeline.push({ type: "plan", id: "p1" });
      // pin 是"现在时"层：需有回合在运行（observed run 也算）
      internals.state.activeTurns.set("t_obs", { turnId: "t_obs", provider: "claude-code", origin: "provider", state: "running" });
      internals.changed();
      expect(protocol.getView().plan).toEqual([
        { content: "step one", status: "completed" },
        { content: "step two", status: "in_progress" },
      ]);
      expect(protocol.getView().footer).toContain("plan:1/2");
      // 互补显示：进行中归 pin，transcript 不重复渲染（过去时区域不该有实时改写的块）
      expect(planInTranscript()).toBe(false);

      // idle 且未完成：pin 卸下（搁置即过去时）——否则状态更新缺失/中途放弃时 pin 永驻
      internals.state.activeTurns.clear();
      internals.changed();
      expect(protocol.getView().plan).toBeUndefined();
      expect(protocol.getView().footer).not.toContain("plan:");
      expect(planInTranscript()).toBe(true);

      // 回合重新开跑：未完成 plan 重新上 pin，transcript 卡随之撤下
      internals.state.activeTurns.set("t_obs", { turnId: "t_obs", provider: "claude-code", origin: "provider", state: "running" });
      internals.changed();
      expect(protocol.getView().plan).toHaveLength(2);
      expect(planInTranscript()).toBe(false);

      // 全部完成：即使仍在运行，pin 停发、footer 摘要撤下，终态卡在 transcript 原位供回看
      internals.state.plans.set("p1", {
        planId: "p1",
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
  test("renders agent messages as Markdown with an explicit streaming boundary", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-markdown-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      session.append({
        kind: "user_message",
        provider: "codex",
        turnId: "t1",
        payload: { messageId: "m_user", content: [{ type: "text", text: "## literal" }] },
      });
      session.append({ kind: "state_update", provider: "codex", turnId: "t1", payload: { state: "running" } });
      session.append({
        kind: "agent_thought",
        provider: "codex",
        turnId: "t1",
        payload: { messageId: "m_thought", content: [{ type: "text", text: "**Inspecting image**" }] },
      });
      session.append({
        kind: "agent_message_chunk",
        provider: "codex",
        turnId: "t1",
        payload: { messageId: "m_stream", content: { type: "text", text: "## Streaming" } },
      });
      session.append({
        kind: "agent_message",
        provider: "codex",
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
        provider: "codex",
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

describe("runStatusLabel", () => {
  const base = { activeTurns: new Map(), lastError: undefined, lastSeq: 5 };
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
    { optionId: "allow", name: "Allow", kind: "allow_once" as const },
    { optionId: "deny", name: "Deny", kind: "reject_once" as const },
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
        provider: "claude-code",
        turnId: "t1",
        payload: { requestId: "ar_1", title: "Write file?", options: APPROVAL_OPTIONS },
      });
      let view = protocol.getView();
      expect(view.approval).toMatchObject({ id: "ar_1", title: "Write file?" });

      // 无 live resolver（如崩溃残留）：应答提示 stale，不静默吞掉
      protocol.resolveApproval("ar_1", "allow");
      view = protocol.getView();
      expect(view.approval).not.toBeNull(); // 卡片消失只由 resolved 事件驱动
      expect(view.status?.text).toContain("no longer pending");

      // resolved 落盘 → 卡片消失
      session.append({
        kind: "permission_resolved",
        provider: "baton",
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
        provider: "codex",
        turnId: "t1",
        payload: {
          requestId: "qr_1",
          questions: [{ questionId: "q1", header: "Scope", question: "Which scope?" }],
        },
      });
      expect(protocol.getView().question).toMatchObject({ id: "qr_1" });

      session.append({
        kind: "question_resolved",
        provider: "baton",
        payload: { requestId: "qr_1", outcome: "cancelled" },
      });
      expect(protocol.getView().question).toBeNull();
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
          canSteer: (provider: string) => boolean;
          steer: (provider: string, blocks: unknown) => Promise<{ effective: string }>;
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
          canSteer: (provider: string) => boolean;
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
          canSteer: (provider: string) => boolean;
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
