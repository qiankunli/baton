// canonical provider id 的叶子真相源：registry / config / commands 都从这里取。
// 单列成无依赖文件的原因：config 校验只需要 id 集合，而 providers/registry.ts
// 携带 adapter 的完整依赖图（SDK、子进程封装）——"读配置"不应连带加载它，
// 反向 import（config → registry）还会成环。

/** 轻量 provider 身份目录；config / commands 可以安全依赖，不会带入 adapter SDK。 */
export const PROVIDER_IDENTITIES = {
  codex: { id: "codex", aliases: ["cx"] },
  claude: { id: "claude", aliases: ["cc"] },
} as const;

export type ProviderName = keyof typeof PROVIDER_IDENTITIES;
export type ProviderAlias = (typeof PROVIDER_IDENTITIES)[ProviderName]["aliases"][number];
export const PROVIDERS = Object.keys(PROVIDER_IDENTITIES) as ProviderName[];

/** 用户输入（slash command、--agent、config.defaultAgent）归一为 canonical id；未知返回 null */
export function parseProvider(value: string): ProviderName | null {
  const normalized = value.trim().toLowerCase();
  const identity = Object.values(PROVIDER_IDENTITIES).find(
    (candidate) =>
      candidate.id === normalized || (candidate.aliases as readonly string[]).includes(normalized),
  );
  return identity?.id ?? null;
}

/** provider id + aliases 的前缀候选；按 provider 去重便于上层报歧义。 */
export function providerPrefixMatches(value: string): ProviderName[] {
  const normalized = value.trim().toLowerCase();
  if (!normalized) return [];
  const exact = parseProvider(normalized);
  if (exact) return [exact];
  return Object.values(PROVIDER_IDENTITIES)
    .filter(
      (candidate) =>
        candidate.id.startsWith(normalized) ||
        (candidate.aliases as readonly string[]).some((alias) => alias.startsWith(normalized)),
    )
    .map((candidate) => candidate.id);
}
