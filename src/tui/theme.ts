// baton 的 TUI 配色：在 chat-tui defaultTheme 之上按 author 区分 agent 消息颜色。
// provider 语义归 harness（chat-tui 的边界约定），所以映射放这里而不是 chat-tui。

import { defaultTheme, type Theme } from "chat-tui";

/**
 * 已知 provider 的固定认色（key 是 protocol.ts PROVIDER_LABEL 之后的展示名，
 * 两处需保持一致）。固定而不是哈希分配：用户会形成"橙=claude"的肌肉记忆，
 * 颜色不应随名字或池子调整而漂移。取色避开 user 蓝 / error 红 / success 绿。
 */
const PROVIDER_COLORS: Record<string, string> = {
  claude: "#ff9e64", // 橙
  codex: "#73daca", // 青
};

/**
 * 未知 provider 的兜底池：provider 是开放扩展点，新 provider 按名字哈希
 * 拿稳定颜色，而不是全部跌回同一个默认紫。
 */
const FALLBACK_POOL = ["#bb9af7", "#7dcfff", "#9ece6a", "#e0af68"];

export function agentColorFor(author: string): string {
  const named = PROVIDER_COLORS[author];
  if (named) return named;
  let hash = 0;
  for (const ch of author) hash = (hash + ch.charCodeAt(0)) % FALLBACK_POOL.length;
  return FALLBACK_POOL[hash] as string;
}

export const batonTheme: Theme = {
  ...defaultTheme,
  agentColorFor,
};
