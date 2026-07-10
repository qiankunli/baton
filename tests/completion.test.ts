import { describe, expect, test } from "bun:test";

import { applyCompletion, buildCandidates, triggerAt } from "../src/tui/completion.ts";
import type { SessionMeta } from "../src/store/store.ts";

const sessions: SessionMeta[] = [
  { batonSessionId: "bs_01AAAAAAAAAAAAAAAAAAAAAAAA", title: "claude 设计会话", cwd: "/a", createdAt: "2026-07-09T00:00:00Z", providerSessions: {} },
  { batonSessionId: "bs_01BBBBBBBBBBBBBBBBBBBBBBBB", title: "codex 实现会话", cwd: "/b", createdAt: "2026-07-09T01:00:00Z", providerSessions: {} },
];

describe("triggerAt", () => {
  test("slash only at line start", () => {
    expect(triggerAt("/")).toEqual({ kind: "slash", start: 0, prefix: "" });
    expect(triggerAt("/cl")).toEqual({ kind: "slash", start: 0, prefix: "cl" });
    expect(triggerAt("hello /cl")).toBeNull(); // 行中的 / 是内容
    expect(triggerAt("/claude 帮我")).toBeNull(); // 已经带参数，不再补全
  });

  test("at anywhere at tail", () => {
    expect(triggerAt("@")).toEqual({ kind: "at", start: 0, prefix: "" });
    expect(triggerAt("参考 @bs_01")).toEqual({ kind: "at", start: 3, prefix: "bs_01" });
    expect(triggerAt("邮箱 a@b 之后")).toBeNull();
  });
});

describe("buildCandidates", () => {
  test("slash lists commands filtered by prefix", () => {
    const all = buildCandidates({ kind: "slash", start: 0, prefix: "" }, sessions);
    expect(all.map((c) => c.insert)).toEqual(["/provider", "/model", "/sessions", "/new", "/exit"]);
    const pr = buildCandidates({ kind: "slash", start: 0, prefix: "pr" }, sessions);
    expect(pr.map((c) => c.insert)).toEqual(["/provider"]);
  });

  test("at lists baton sessions, not providers", () => {
    const all = buildCandidates({ kind: "at", start: 0, prefix: "" }, sessions);
    expect(all.some((c) => c.insert === "@codex" || c.insert === "@claude")).toBe(false);
    expect(all.some((c) => c.insert === "@bs_01AAAAAAAAAAAAAAAAAAAAAAAA")).toBe(true);
  });

  test("at matches session by id prefix or title substring", () => {
    const byId = buildCandidates({ kind: "at", start: 0, prefix: "bs_01B" }, sessions);
    expect(byId.map((c) => c.insert)).toEqual(["@bs_01BBBBBBBBBBBBBBBBBBBBBBBB"]);
    const byTitle = buildCandidates({ kind: "at", start: 0, prefix: "设计" }, sessions);
    expect(byTitle.map((c) => c.insert)).toEqual(["@bs_01AAAAAAAAAAAAAAAAAAAAAAAA"]);
  });

  test("excludes current session", () => {
    const cands = buildCandidates({ kind: "at", start: 0, prefix: "bs_" }, sessions, {
      excludeSessionId: "bs_01AAAAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(cands.map((c) => c.insert)).toEqual(["@bs_01BBBBBBBBBBBBBBBBBBBBBBBB"]);
  });
});

describe("applyCompletion", () => {
  test("replaces trailing token, keeps preceding text", () => {
    const trigger = triggerAt("按照 @bs_01A");
    const done = applyCompletion("按照 @bs_01A", trigger!, {
      insert: "@bs_01AAAAAAAAAAAAAAAAAAAAAAAA",
      label: "",
      detail: "",
    });
    expect(done).toBe("按照 @bs_01AAAAAAAAAAAAAAAAAAAAAAAA ");
  });

  test("slash completion replaces whole line head", () => {
    const trigger = triggerAt("/pr");
    expect(applyCompletion("/pr", trigger!, { insert: "/provider", label: "", detail: "" })).toBe("/provider ");
  });
});
