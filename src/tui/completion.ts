// 输入补全的纯逻辑（TUI 渲染无关，可单测）。按终端 coding agent 的通用习惯：
//   /  行首触发命令候选（切换 agent、退出等动作）
//   @  任意位置触发引用候选（agent provider、其它会话）——与 claude/codex 的 @ 语义一致

import type { SessionMeta } from "../store/store.ts";

export interface Candidate {
  /** 插入文本，如 "/claude"、"@codex"、"@bs_01…" */
  insert: string;
  label: string;
  detail: string;
}

export interface Trigger {
  kind: "slash" | "at";
  /** token 在原文中的起始下标（/ 或 @ 处） */
  start: number;
  prefix: string;
}

export function triggerAt(text: string): Trigger | null {
  // 斜杠命令只在行首（TUI 惯例：/ 开头是命令，不是内容）
  const slash = /^\/([A-Za-z]*)$/.exec(text);
  if (slash) return { kind: "slash", start: 0, prefix: slash[1] as string };
  const at = /(^|\s)@([A-Za-z0-9_-]*)$/.exec(text);
  if (at) return { kind: "at", start: (at.index ?? 0) + (at[1] as string).length, prefix: at[2] as string };
  return null;
}

const SLASH_COMMANDS: Candidate[] = [
  { insert: "/codex", label: "/codex", detail: "切换到 codex（可直接跟消息）" },
  { insert: "/claude", label: "/claude", detail: "切换到 claude（可直接跟消息）" },
  { insert: "/exit", label: "/exit", detail: "退出 baton" },
];

const PROVIDER_CANDIDATES: Candidate[] = [
  { insert: "@codex", label: "@codex", detail: "OpenAI Codex" },
  { insert: "@claude", label: "@claude", detail: "Claude Code" },
];

export function buildCandidates(
  trigger: Trigger,
  sessions: SessionMeta[],
  opts: { excludeSessionId?: string; limit?: number } = {},
): Candidate[] {
  const limit = opts.limit ?? 6;
  const p = trigger.prefix.toLowerCase();
  if (trigger.kind === "slash") {
    return SLASH_COMMANDS.filter((c) => c.insert.slice(1).startsWith(p)).slice(0, limit);
  }
  const providers = PROVIDER_CANDIDATES.filter((c) => c.insert.slice(1).toLowerCase().startsWith(p));
  const sessionCands = sessions
    .filter((s) => s.batonSessionId !== opts.excludeSessionId)
    .filter(
      (s) =>
        s.batonSessionId.toLowerCase().startsWith(p) ||
        (p !== "" && (s.title ?? "").toLowerCase().includes(p)),
    )
    .map((s) => ({
      insert: `@${s.batonSessionId}`,
      label: `@${s.batonSessionId.slice(0, 12)}…`,
      detail: s.title ?? "",
    }));
  return [...providers, ...sessionCands].slice(0, limit);
}

/** 用选中的候选替换触发 token，返回新输入（尾随空格便于继续打字） */
export function applyCompletion(text: string, trigger: Trigger, candidate: Candidate): string {
  return `${text.slice(0, trigger.start)}${candidate.insert} `;
}
