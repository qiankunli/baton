// canonical provider id 的叶子真相源：registry / config / commands 都从这里取。
// 单列成无依赖文件的原因：config 校验只需要 id 集合，而 providers/registry.ts
// 携带 adapter 的完整依赖图（SDK、子进程封装）——"读配置"不应连带加载它，
// 反向 import（config → registry）还会成环。

export const PROVIDERS = ["codex", "claude"] as const;
export type ProviderName = (typeof PROVIDERS)[number];

/** 用户输入（slash command、--agent、config.defaultAgent）归一为 canonical id；未知返回 null */
export function parseProvider(value: string): ProviderName | null {
  const normalized = value.trim().toLowerCase();
  return PROVIDERS.find((provider) => provider === normalized) ?? null;
}
