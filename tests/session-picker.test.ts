import { describe, expect, test } from "bun:test";

import type { SessionMeta } from "../src/store/store.ts";
import { sessionPickerOptions } from "../src/tui/session-picker.tsx";

describe("sessionPickerOptions", () => {
  const sessions: SessionMeta[] = [
    {
      batonSessionId: "bs_titled",
      title: "chat @ /repo",
      preview: "Implement resume titles",
      cwd: "/repo",
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-02T00:00:00Z",
      providerSessions: { codex: { provider: "codex" }, "claude-code": { provider: "claude-code" } },
    },
    {
      batonSessionId: "bs_untitled",
      preview: "Inspect provider logs",
      cwd: "/other",
      createdAt: "2026-07-03T00:00:00Z",
      providerSessions: {},
    },
  ] as SessionMeta[];

  test("projects SessionMeta into select rows (title fallback, providers, time fallback)", () => {
    expect(sessionPickerOptions(sessions)).toEqual([
      {
        name: "Implement resume titles",
        description: "bs_titled · /repo · 2026-07-02T00:00:00Z · [codex,claude-code]",
        value: "bs_titled",
      },
      {
        name: "Inspect provider logs",
        description: "bs_untitled · /other · 2026-07-03T00:00:00Z · [-]",
        value: "bs_untitled",
      },
    ]);
  });

  test("marks the current session for the in-chat /sessions entry", () => {
    const names = sessionPickerOptions(sessions, { currentSessionId: "bs_untitled" }).map((o) => o.name);
    expect(names).toEqual(["Implement resume titles", "● Inspect provider logs"]);
  });

  test("keeps an explicit title ahead of preview", () => {
    const [option] = sessionPickerOptions([
      { ...sessions[0]!, title: "Release follow-up", preview: "first prompt" },
    ]);
    expect(option!.name).toBe("Release follow-up");
  });

  test("tree mode nests forks with indent and keeps the current marker", () => {
    const fork: SessionMeta = {
      ...sessions[1]!,
      batonSessionId: "bs_fork",
      name: "Inspect provider logs",
      description: "fork: Implement resume titles",
      updatedAt: "2026-07-04T00:00:00Z",
      forkedFrom: { batonSessionId: "bs_titled", throughSeq: 3 },
    };
    const options = sessionPickerOptions([fork, ...sessions], {
      mode: "tree",
      currentSessionId: "bs_fork",
    });
    const names = options.map((o) => o.name);
    // fork（07-04）把 bs_titled 整棵树浮顶；fork 缩进挂在源下并保留 ● 标记
    expect(names).toEqual([
      "Implement resume titles",
      "└ ● Inspect provider logs",
      "Inspect provider logs",
    ]);
    expect(options[1]!.description).toBe(
      "fork: Implement resume titles · bs_fork · /other · 2026-07-04T00:00:00Z · [-]",
    );
  });

  test("list mode keeps incoming order untouched", () => {
    const names = sessionPickerOptions(sessions, { mode: "list" }).map((o) => o.name);
    expect(names).toEqual(["Implement resume titles", "Inspect provider logs"]);
  });
});
