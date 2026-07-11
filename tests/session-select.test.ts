import { describe, expect, test } from "bun:test";

import type { SessionMeta } from "../src/store/store.ts";
import { sessionSelectOptions } from "../src/tui/session-select.tsx";

describe("sessionSelectOptions", () => {
  test("projects SessionMeta into select rows (title fallback, providers, time fallback)", () => {
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

    expect(sessionSelectOptions(sessions)).toEqual([
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
});
