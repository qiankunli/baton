// @ 引用的急切解析（MVP，design §5.6）：发送时把目标会话的内容拼进目标 agent 的 prompt，
// 以"用户提供的材料"身份出现。二期换 mention:// 句柄 + CLI 惰性回查。
// 投影方式由"有无共同历史"决定，用户无需选择：同一 fork 树 → 全量注入共享水位后的增量；
// 无共同历史 → 预算内的紧凑摘要。

import type { TurnSummary } from "../events/types.ts";
import {
  sessionDisplayTitle,
  type SessionForkOrigin,
  type SessionHandle,
  type SessionStore,
} from "../store/store.ts";

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
 * 沿 forkedFrom 链收集「祖先 id → 与该祖先共享历史的最大 seq」。
 * fork 复制保留原 seq（同一段逻辑历史，见 store.forkSession），所以沿途 throughSeq
 * 的 running-min 就是相对更远祖先仍然共享的水位；自身条目的水位为 Infinity。
 */
function lineageCuts(store: SessionStore, batonSessionId: string): Map<string, number> {
  const cuts = new Map<string, number>();
  let cur = batonSessionId;
  let cut = Infinity;
  while (!cuts.has(cur)) {
    cuts.set(cur, cut);
    let forkedFrom: SessionForkOrigin | undefined;
    try {
      forkedFrom = store.openSession(cur).meta.forkedFrom;
    } catch {
      break; // 祖先会话可能已被删除；其 id 已入表，仍可参与共同祖先匹配
    }
    if (!forkedFrom) break;
    cut = Math.min(cut, forkedFrom.throughSeq);
    cur = forkedFrom.batonSessionId;
  }
  return cuts;
}

/**
 * 两个会话的共同历史水位（seq）：在 fork 谱系上找共同祖先，取双方相对它的共享水位
 * 中较小者；链上多个共同祖先取最近的（水位最大）。无共同历史返回 null。
 * 引用自己时返回 Infinity（全部共享，没有增量可注入）。
 */
export function sharedHistoryWatermark(
  store: SessionStore,
  aSessionId: string,
  bSessionId: string,
): number | null {
  const a = lineageCuts(store, aSessionId);
  const b = lineageCuts(store, bSessionId);
  let best: number | null = null;
  for (const [ancestor, cutB] of b) {
    const cutA = a.get(ancestor);
    if (cutA === undefined) continue;
    const shared = Math.min(cutA, cutB);
    if (best === null || shared > best) best = shared;
  }
  return best;
}

/** turn-summary 事件带 seq 读出，供共同历史水位过滤（reduce 的 turnSummaries 不带 seq） */
function summariesWithSeq(handle: SessionHandle): Array<{ seq: number; summary: TurnSummary }> {
  return handle
    .readEvents()
    .filter((e) => e.kind === "_baton_turn_summary")
    .map((e) => ({ seq: e.seq, summary: e.payload as TurnSummary }));
}

/**
 * 目标会话注入上下文。投影方式由与 fromSessionId 的关系决定（用户不选择）：
 * - 有共同历史（同一 fork 树）：注入共享水位之后的全部 turn，不做预算截断——
 *   共享前缀双方都有无需重复，增量通常小，截断反而丢掉引用的关键内容。
 * - 无共同历史（或未提供 fromSessionId）：预算内的紧凑摘要，从最新往回装，
 *   装不下即停，再恢复时间序。
 * 数据源都是 turn-summary 事件（写入时已压缩，见 store.summarizeTurn）。
 */
export function buildSessionContext(
  store: SessionStore,
  batonSessionId: string,
  budgetChars: number = DEFAULT_MENTION_BUDGET_CHARS,
  opts: { fromSessionId?: string } = {},
): string {
  const session = store.openSession(batonSessionId);
  const entries = summariesWithSeq(session);
  const summaries = entries.map((e) => e.summary);
  const title = sessionDisplayTitle(session.meta);
  const providers = Object.keys(session.meta.providerSessions).join(", ") || "unknown";

  const watermark = opts.fromSessionId
    ? sharedHistoryWatermark(store, opts.fromSessionId, batonSessionId)
    : null;
  if (watermark !== null) {
    const header = `# Session context: ${title} (id: ${batonSessionId}, agent: ${providers}, shares history with this session)`;
    const fresh = entries.filter((e) => e.seq > watermark);
    if (fresh.length === 0) {
      return `${header}\n(no new turns beyond the shared history)`;
    }
    const parts = [header];
    const sharedCount = entries.length - fresh.length;
    if (sharedCount > 0) parts.push(`(${sharedCount} turns of shared history omitted)`);
    // Turn 编号沿用该会话自己的序号，便于和共享前缀对齐
    parts.push(...fresh.map((e) => turnBlock(e.summary, entries.indexOf(e))));
    return parts.join("\n\n");
  }

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
 * currentSessionId 用于判断引用会话与当前会话有无共同历史（见 buildSessionContext）；
 * 预算只约束摘要投影，同树增量注入不受预算限制。
 */
export function expandMentions(
  store: SessionStore,
  text: string,
  budgetChars: number = DEFAULT_MENTION_BUDGET_CHARS,
  currentSessionId?: string,
): { prompt: string; mentions: ParsedMention[] } {
  const mentions = parseMentions(text);
  if (mentions.length === 0) return { prompt: text, mentions };
  const perMentionBudget = Math.floor(budgetChars / mentions.length);
  const contexts = mentions.map((m) =>
    buildSessionContext(store, m.batonSessionId, perMentionBudget, { fromSessionId: currentSessionId }),
  );
  const prompt = [
    "<baton-context>",
    "Content from other agent sessions referenced by the user, provided as background context only:",
    ...contexts,
    "</baton-context>",
    "",
    text,
  ].join("\n\n");
  return { prompt, mentions };
}
