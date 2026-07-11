import { describe, expect, test } from "bun:test";

import type { SessionMeta } from "../src/store/store.ts";
import { sessionPickerOptions } from "../src/tui/session-picker.tsx";

describe("sessionPickerOptions", () => {
  const sessions: SessionMeta[] = [
    {
      batonSessionId: "bs_titled",
      title: "chat @ /repo",
      cwd: "/repo",
      createdAt: "2026-07-01T00:00:00Z",
      updatedAt: "2026-07-02T00:00:00Z",
      providerSessions: { codex: { provider: "codex" }, "claude-code": { provider: "claude-code" } },
    },
    {
      batonSessionId: "bs_untitled",
      cwd: "/other",
      createdAt: "2026-07-03T00:00:00Z",
      providerSessions: {},
    },
  ] as SessionMeta[];

  test("projects SessionMeta into select rows (title fallback, providers, time fallback)", () => {
    expect(sessionPickerOptions(sessions)).toEqual([
      {
        name: "chat @ /repo",
        description: "bs_titled · /repo · 2026-07-02T00:00:00Z · [codex,claude-code]",
        value: "bs_titled",
      },
      {
        name: "bs_untitled",
        description: "bs_untitled · /other · 2026-07-03T00:00:00Z · [-]",
        value: "bs_untitled",
      },
    ]);
  });

  test("marks the current session for the in-chat /sessions entry", () => {
    const names = sessionPickerOptions(sessions, { currentSessionId: "bs_untitled" }).map((o) => o.name);
    expect(names).toEqual(["chat @ /repo", "● bs_untitled"]);
  });
});
