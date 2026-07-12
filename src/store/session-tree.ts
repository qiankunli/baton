// session 谱系森林投影：forkedFrom 父指针 → 带深度的先序行序列。
// tree/list 是同一集合的两种投影——list（时间序）归 listSessions，这里只负责
// tree（谱系序）。三个入口（启动 picker、/sessions 浮层、baton sessions CLI）共用，
// 保证缩进语义一致。

import type { SessionMeta } from "./store.ts";

export interface SessionTreeRow {
  meta: SessionMeta;
  depth: number;
}

function touchedAt(meta: SessionMeta): string {
  return meta.updatedAt ?? meta.createdAt;
}

/**
 * 把 sessions 按 fork 谱系铺成先序行序列（depth 供渲染缩进）。
 * 排序约定：
 * - 根按「子树最新活跃时间」倒序——root 本身很旧但分支还在动的探索树应整体浮顶；
 * - 兄弟按 createdAt 正序，呈现 fork 的时间线；
 * - 父不在集合里（已删除或被过滤）的会话按根展示，不隐藏；
 * - 谱系损坏成环时兜底：不死循环，环上节点按根补在末尾，不丢行。
 */
export function sessionTreeRows(sessions: SessionMeta[]): SessionTreeRow[] {
  const ids = new Set(sessions.map((s) => s.batonSessionId));
  const children = new Map<string, SessionMeta[]>();
  const roots: SessionMeta[] = [];
  for (const s of sessions) {
    const parentId = s.forkedFrom?.batonSessionId;
    if (parentId && parentId !== s.batonSessionId && ids.has(parentId)) {
      const list = children.get(parentId) ?? [];
      list.push(s);
      children.set(parentId, list);
    } else {
      roots.push(s);
    }
  }

  // 子树最新活跃时间（memoized DFS；guard 防谱系成环时无限递归）
  const subtreeLatest = new Map<string, string>();
  const latestOf = (s: SessionMeta, guard: Set<string>): string => {
    const cached = subtreeLatest.get(s.batonSessionId);
    if (cached !== undefined) return cached;
    if (guard.has(s.batonSessionId)) return touchedAt(s);
    guard.add(s.batonSessionId);
    let latest = touchedAt(s);
    for (const child of children.get(s.batonSessionId) ?? []) {
      const childLatest = latestOf(child, guard);
      if (childLatest > latest) latest = childLatest;
    }
    subtreeLatest.set(s.batonSessionId, latest);
    return latest;
  };
  const guard = new Set<string>();
  roots.sort((a, b) => latestOf(b, guard).localeCompare(latestOf(a, guard)));

  const rows: SessionTreeRow[] = [];
  const visited = new Set<string>();
  const walk = (s: SessionMeta, depth: number): void => {
    if (visited.has(s.batonSessionId)) return;
    visited.add(s.batonSessionId);
    rows.push({ meta: s, depth });
    const kids = [...(children.get(s.batonSessionId) ?? [])].sort((a, b) =>
      a.createdAt.localeCompare(b.createdAt),
    );
    for (const kid of kids) walk(kid, depth + 1);
  };
  for (const root of roots) walk(root, 0);
  // 环上的节点从任何根都走不到（互为父子、无根可入），这里兜底补齐
  for (const s of sessions) walk(s, 0);
  return rows;
}

/** tree 行的缩进前缀；picker 与 CLI 打印共用同一视觉语言 */
export function treeRowPrefix(depth: number): string {
  return depth === 0 ? "" : `${"  ".repeat(depth - 1)}└ `;
}
