import { describe, expect, test } from "bun:test";

import { sessionTreeRows, treeRowPrefix } from "../src/store/session-tree.ts";
import type { SessionMeta } from "../src/store/store.ts";

function meta(
  id: string,
  opts: { forkedFrom?: string; createdAt?: string; updatedAt?: string } = {},
): SessionMeta {
  return {
    batonSessionId: id,
    cwd: "/repo",
    createdAt: opts.createdAt ?? "2026-07-01T00:00:00Z",
    ...(opts.updatedAt ? { updatedAt: opts.updatedAt } : {}),
    providerSessions: {},
    ...(opts.forkedFrom ? { forkedFrom: { batonSessionId: opts.forkedFrom, throughSeq: 1 } } : {}),
  } as SessionMeta;
}

const ids = (rows: ReturnType<typeof sessionTreeRows>) =>
  rows.map((r) => `${r.depth}:${r.meta.batonSessionId}`);

describe("sessionTreeRows", () => {
  test("nests forks under their source with depth", () => {
    const rows = sessionTreeRows([
      meta("bs_root"),
      meta("bs_child", { forkedFrom: "bs_root", createdAt: "2026-07-02T00:00:00Z" }),
      meta("bs_grand", { forkedFrom: "bs_child", createdAt: "2026-07-03T00:00:00Z" }),
    ]);
    expect(ids(rows)).toEqual(["0:bs_root", "1:bs_child", "2:bs_grand"]);
  });

  test("siblings are ordered by createdAt (fork chronology)", () => {
    const rows = sessionTreeRows([
      meta("bs_root"),
      meta("bs_late", { forkedFrom: "bs_root", createdAt: "2026-07-05T00:00:00Z" }),
      meta("bs_early", { forkedFrom: "bs_root", createdAt: "2026-07-02T00:00:00Z" }),
    ]);
    expect(ids(rows)).toEqual(["0:bs_root", "1:bs_early", "1:bs_late"]);
  });

  test("roots sort by subtree latest activity, not root's own", () => {
    const rows = sessionTreeRows([
      meta("bs_old_tree", { updatedAt: "2026-07-01T00:00:00Z" }),
      // 老 root，但它的 fork 昨天还在动 → 整棵树应浮顶
      meta("bs_older_tree", { updatedAt: "2026-06-01T00:00:00Z" }),
      meta("bs_active_fork", { forkedFrom: "bs_older_tree", updatedAt: "2026-07-10T00:00:00Z" }),
    ]);
    expect(ids(rows)).toEqual(["0:bs_older_tree", "1:bs_active_fork", "0:bs_old_tree"]);
  });

  test("orphan whose parent was deleted shows as a root", () => {
    const rows = sessionTreeRows([meta("bs_orphan", { forkedFrom: "bs_gone" })]);
    expect(ids(rows)).toEqual(["0:bs_orphan"]);
  });

  test("corrupt cyclic lineage neither loops nor drops rows", () => {
    const rows = sessionTreeRows([
      meta("bs_a", { forkedFrom: "bs_b" }),
      meta("bs_b", { forkedFrom: "bs_a" }),
      meta("bs_plain"),
    ]);
    expect(rows).toHaveLength(3);
    const rendered = rows.map((r) => r.meta.batonSessionId).sort();
    expect(rendered).toEqual(["bs_a", "bs_b", "bs_plain"]);
  });
});

describe("treeRowPrefix", () => {
  test("depth to indent", () => {
    expect(treeRowPrefix(0)).toBe("");
    expect(treeRowPrefix(1)).toBe("└ ");
    expect(treeRowPrefix(2)).toBe("  └ ");
  });
});
