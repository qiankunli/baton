import { describe, expect, test } from "bun:test";

import { sessionMentionCandidates } from "../src/tui/mentions.ts";
import type { SessionMeta } from "../src/store/store.ts";

const sessions: SessionMeta[] = [
  { batonSessionId: "bs_01AAAAAAAAAAAAAAAAAAAAAAAA", title: "claude 设计会话", cwd: "/a", createdAt: "2026-07-09T00:00:00Z", providerSessions: {} },
  { batonSessionId: "bs_01BBBBBBBBBBBBBBBBBBBBBBBB", title: "codex 实现会话", cwd: "/b", createdAt: "2026-07-09T01:00:00Z", providerSessions: {} },
];

describe("sessionMentionCandidates", () => {
  test("matches by id prefix or title substring", () => {
    const byId = sessionMentionCandidates(sessions, "bs_01B");
    expect(byId.map((c) => c.insert)).toEqual(["@bs_01BBBBBBBBBBBBBBBBBBBBBBBB"]);
    const byTitle = sessionMentionCandidates(sessions, "设计");
    expect(byTitle.map((c) => c.insert)).toEqual(["@bs_01AAAAAAAAAAAAAAAAAAAAAAAA"]);
  });

  test("lists sessions, not providers", () => {
    const all = sessionMentionCandidates(sessions, "");
    expect(all.some((c) => c.insert === "@codex" || c.insert === "@claude")).toBe(false);
    expect(all).toHaveLength(2);
  });

  test("excludes current session", () => {
    const cands = sessionMentionCandidates(sessions, "bs_", {
      excludeSessionId: "bs_01AAAAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(cands.map((c) => c.insert)).toEqual(["@bs_01BBBBBBBBBBBBBBBBBBBBBBBB"]);
  });
});
