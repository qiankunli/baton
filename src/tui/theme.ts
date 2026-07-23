// baton 的 TUI 配色：在 chat-tui defaultTheme 之上按 author 区分 agent 消息颜色。
// harness 语义归 harness（chat-tui 的边界约定），所以映射放这里而不是 chat-tui。

import { defaultTheme, type Theme } from "chat-tui";

import { HARNESS_REGISTRY } from "../harnesses/registry.ts";

/**
 * 已知 harness 的固定认色，从 registry 派生（shortName 即 author 展示名 =
 * 着色 key，单一来源，不再靠注释约定两处一致）。取色约束见 HarnessDefinition.color
 * 的注释：避开 user 蓝 / error 红 / success 绿。
 */
const HARNESS_COLORS: Record<string, string> = Object.fromEntries(
  HARNESS_REGISTRY.map((definition) => [definition.shortName, definition.color]),
);

/**
 * 未知 harness 的兜底池：harness 是开放扩展点，新 harness 按名字哈希
 * 拿稳定颜色，而不是全部跌回同一个默认紫。
 */
const FALLBACK_POOL = ["#bb9af7", "#7dcfff", "#9ece6a", "#e0af68"];

export function agentColorFor(author: string): string {
  const named = HARNESS_COLORS[author];
  if (named) return named;
  let hash = 0;
  for (const ch of author) hash = (hash + ch.charCodeAt(0)) % FALLBACK_POOL.length;
  return FALLBACK_POOL[hash] as string;
}

export const batonTheme: Theme = {
  ...defaultTheme,
  agentColorFor,
};
