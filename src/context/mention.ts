// @ 引用的急切解析（MVP，design §5.6）：发送时把目标会话的 turn-summary 压成紧凑文本，
// 以"用户提供的材料"身份拼进目标 agent 的 prompt。二期换 mention:// 句柄 + CLI 惰性回查。

import type { TurnSummary } from "../events/types.ts";
import type { SessionHandle, SessionStore } from "../store/store.ts";

/** @bs_<ULID>：MVP 只支持引用整个 BatonSession */
const MENTION_PATTERN = /@(bs_[0-9A-HJKMNP-TV-Z]{26})/g;

// 摘要 token 预算的初值拍 4KB 字符（design 开放问题 #4），超限丢最旧的 turn
export const DEFAULT_MENTION_BUDGET_CHARS = 4096;

export interface ParsedMention {
  batonSessionId: string;
}

interface ProviderSummary {
  provider: string;
  seq: number;
  summary: TurnSummary;
}

export interface ProviderCatchUpContext {
  text: string;
  throughSeq: number;
}

export function parseMentions(text: string): ParsedMention[] {
  const seen = new Set<string>();
  const out: ParsedMention[] = [];
  for (const m of text.matchAll(MENTION_PATTERN)) {
    const id = m[1] as string;
    if (!seen.has(id)) {
      seen.add(id);
      out.push({ batonSessionId: id });
    }
  }
  return out;
}

function turnBlock(s: TurnSummary, index: number): string {
  const lines: string[] = [`## Turn ${index + 1}${s.stopReason ? ` (${s.stopReason})` : ""}`];
  if (s.userText) lines.push(`user: ${s.userText}`);
  if (s.agentText) lines.push(`agent: ${s.agentText}`);
  if (s.toolCalls.length) {
    lines.push(`tools: ${s.toolCalls.map((t) => `${t.title ?? t.toolCallId} [${t.status ?? "?"}]`).join("; ")}`);
  }
  return lines.join("\n");
}

/**
 * 目标会话的紧凑摘要。数据源是 turn-summary 事件（写入时已压缩，见 store.summarizeTurn）。
 * 预算内优先保最近的 turn：从最新往回装，装不下即停，再恢复时间序。
 */
export function buildSessionContext(
  store: SessionStore,
  batonSessionId: string,
  budgetChars: number = DEFAULT_MENTION_BUDGET_CHARS,
): string {
  const session = store.openSession(batonSessionId);
  const summaries = session.loadState().turnSummaries;
  const title = session.meta.title ?? batonSessionId;
  const providers = Object.keys(session.meta.providerSessions).join(", ") || "unknown";
  const header = `# Session summary: ${title} (id: ${batonSessionId}, agent: ${providers})`;

  if (summaries.length === 0) {
    return `${header}\n(no completed turns in this session yet)`;
  }

  const picked: string[] = [];
  let used = header.length;
  let dropped = 0;
  for (let i = summaries.length - 1; i >= 0; i--) {
    const block = turnBlock(summaries[i] as TurnSummary, i);
    if (used + block.length + 2 > budgetChars && picked.length > 0) {
      dropped = i + 1;
      break;
    }
    used += block.length + 2;
    picked.unshift(block);
    if (used > budgetChars) {
      // 单个 block 就超预算：硬截断保留尾部（最新内容在后）
      picked[0] = (picked[0] as string).slice(-(budgetChars - header.length));
      dropped = i;
      break;
    }
  }
  const parts = [header];
  if (dropped > 0) parts.push(`(${dropped} earlier turns omitted for length)`);
  parts.push(...picked);
  return parts.join("\n\n");
}

/**
 * 同会话多 agent 的"补课"上下文：目标 provider 上次参与之后、其它 provider 完成的 turn 摘要。
 * chat-first TUI 里切换 @agent 时自动注入，让新接手的 agent 无需手动 @ 就知道进展。
 * 无需补课时返回 null。
 */
export function buildCatchUpContext(
  handle: SessionHandle,
  provider: string,
  budgetChars: number = DEFAULT_MENTION_BUDGET_CHARS,
): string | null {
  const summaries = providerSummaries(handle);
  let lastMine = 0;
  for (const s of summaries) {
    if (s.provider === provider) lastMine = s.seq;
  }
  return buildProviderCatchUpContext(handle, {
    provider,
    sinceSeq: lastMine,
    includeProviderTurns: false,
    budgetChars,
  })?.text ?? null;
}

function providerSummaries(handle: SessionHandle): ProviderSummary[] {
  return handle
    .readEvents()
    .filter((e) => e.kind === "_baton_turn_summary")
    .map((e) => ({ provider: e.provider, seq: e.seq, summary: e.payload as TurnSummary }));
}

/**
 * 生成 provider 尚未同步的 BatonSession 历史，并返回本批覆盖到的事件水位。
 * 新建原生会话时 includeProviderTurns=true，从零恢复完整逻辑历史；resume 时只补其它 provider 的增量。
 */
export function buildProviderCatchUpContext(
  handle: SessionHandle,
  opts: {
    provider: string;
    sinceSeq: number;
    includeProviderTurns: boolean;
    budgetChars?: number;
  },
): ProviderCatchUpContext | null {
  const summaries = providerSummaries(handle);
  const missed = summaries.filter(
    (item) => item.seq > opts.sinceSeq && (opts.includeProviderTurns || item.provider !== opts.provider),
  );
  if (missed.length === 0) return null;

  const header = opts.includeProviderTurns
    ? "# BatonSession history (auto-restored by baton)"
    : "# Latest progress from other agents in this session (auto-synced by baton)";
  const budgetChars = opts.budgetChars ?? DEFAULT_MENTION_BUDGET_CHARS;
  const picked: string[] = [];
  let used = header.length;
  let dropped = 0;
  for (let i = missed.length - 1; i >= 0; i--) {
    const m = missed[i] as (typeof missed)[number];
    const block = `[${m.provider}]\n${turnBlock(m.summary, i)}`;
    if (used + block.length + 2 > budgetChars && picked.length > 0) {
      dropped = i + 1;
      break;
    }
    used += block.length + 2;
    picked.unshift(block);
  }
  const parts = [header];
  if (dropped > 0) parts.push(`(${dropped} earlier turns omitted for length)`);
  parts.push(...picked);
  return {
    text: parts.join("\n\n"),
    throughSeq: summaries.at(-1)?.seq ?? opts.sinceSeq,
  };
}

/**
 * 展开输入里的所有 @ 引用：返回最终发给 agent 的文本。
 * 注入内容以"用户提供的只读参考材料"身份出现，归属清晰（design §5.4：不伪造对方记忆）。
 */
export function expandMentions(
  store: SessionStore,
  text: string,
  budgetChars: number = DEFAULT_MENTION_BUDGET_CHARS,
): { prompt: string; mentions: ParsedMention[] } {
  const mentions = parseMentions(text);
  if (mentions.length === 0) return { prompt: text, mentions };
  const perMentionBudget = Math.floor(budgetChars / mentions.length);
  const contexts = mentions.map((m) => buildSessionContext(store, m.batonSessionId, perMentionBudget));
  const prompt = [
    "<baton-context>",
    "Summaries of other agent sessions referenced by the user, provided as background context only:",
    ...contexts,
    "</baton-context>",
    "",
    text,
  ].join("\n\n");
  return { prompt, mentions };
}
