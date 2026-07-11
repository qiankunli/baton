import { describe, expect, test } from "bun:test";

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { DEFAULT_CONFIG } from "../src/config/config.ts";
import { SessionStore } from "../src/store/store.ts";
import { BatonChatProtocol, thoughtDisplayBlocks, toolTranscriptItem } from "../src/tui/protocol.ts";

describe("BatonChatProtocol exit", () => {
  test("restores the TUI only after runtime and session cleanup", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-tui-exit-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      const calls: string[] = [];
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => {
        calls.push("quit");
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
      expect(calls).toEqual(["runtime", "lock", "quit"]);
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

describe("BatonChatProtocol startup picker", () => {
  // resolvePicker 的 onSelect 走 fire-and-forget async；switchSession 内部只有
  // 立即 resolve 的 await，一次宏任务足够收敛
  const settle = () => new Promise((resolve) => setTimeout(resolve, 20));

  function harness() {
    const root = mkdtempSync(join(tmpdir(), "baton-startup-picker-"));
    const store = new SessionStore(root);
    const other = store.createSession({ cwd: "/repo", title: "other" });
    const current = store.createSession({ cwd: "/repo", title: "current" });
    current.acquireLock();
    const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session: current, resumed: false }, () => undefined);
    const currentSessionId = () => (protocol as unknown as { session: { id: string } }).session.id;
    return { root, store, other, current, protocol, currentSessionId };
  }

  test("resume intent reuses the /sessions picker and switches on select", async () => {
    const { root, store, other, protocol, currentSessionId } = harness();
    try {
      protocol.openStartupPicker("resume");
      const picker = protocol.getView().picker;
      expect(picker?.title).toBe("Select BatonSession");
      protocol.resolvePicker(picker!.id, other.id);
      await settle();
      expect(currentSessionId()).toBe(other.id);
      expect(store.listSessions()).toHaveLength(2); // 只切换，不新建
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("fork intent forks the picked source only after selection", async () => {
    const { root, store, other, current, protocol, currentSessionId } = harness();
    try {
      protocol.openStartupPicker("fork");
      const picker = protocol.getView().picker;
      expect(picker?.title).toBe("Select session to fork");
      expect(store.listSessions()).toHaveLength(2); // 弹层阶段不落盘

      protocol.resolvePicker(picker!.id, other.id);
      await settle();
      const child = (protocol as unknown as { session: { id: string; meta: { forkedFrom?: { batonSessionId: string } } } })
        .session;
      expect(store.listSessions()).toHaveLength(3);
      expect(child.id).not.toBe(current.id);
      expect(child.id).not.toBe(other.id);
      expect(child.meta.forkedFrom?.batonSessionId).toBe(other.id);
      expect(currentSessionId()).toBe(child.id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("esc keeps the default session and forks nothing", async () => {
    const { root, store, current, protocol, currentSessionId } = harness();
    try {
      protocol.openStartupPicker("fork");
      const picker = protocol.getView().picker;
      protocol.resolvePicker(picker!.id, null);
      await settle();
      expect(protocol.getView().picker).toBeNull();
      expect(currentSessionId()).toBe(current.id);
      expect(store.listSessions()).toHaveLength(2);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("skips the picker when there is nothing else to choose", () => {
    const root = mkdtempSync(join(tmpdir(), "baton-startup-single-"));
    try {
      const store = new SessionStore(root);
      const session = store.createSession({ cwd: "/repo" });
      session.acquireLock();
      const protocol = new BatonChatProtocol(store, DEFAULT_CONFIG, { session, resumed: false }, () => undefined);
      protocol.openStartupPicker("resume");
      expect(protocol.getView().picker).toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
