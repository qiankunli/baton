// @ 引用候选（纯逻辑，可单测）：按 id 前缀或标题子串匹配 BatonSession。
// 触发识别与浮层交互归 chat-tui，这里只提供 baton 对象的候选源。

import type { Candidate } from "chat-tui";

import { sessionDisplayTitle, type SessionMeta } from "../store/store.ts";

export function sessionMentionCandidates(
  sessions: SessionMeta[],
  prefix: string,
  opts: { excludeSessionId?: string } = {},
): Candidate[] {
  const p = prefix.toLowerCase();
  return sessions
    .filter((s) => s.batonSessionId !== opts.excludeSessionId)
    .filter(
      (s) =>
        s.batonSessionId.toLowerCase().startsWith(p) ||
        (p !== "" && sessionDisplayTitle(s).toLowerCase().includes(p)),
    )
    .map((s) => ({
      insert: `@${s.batonSessionId}`,
      label: `@${s.batonSessionId.slice(0, 12)}…`,
      detail: sessionDisplayTitle(s),
    }));
}
