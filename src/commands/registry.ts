// Baton 只实现自己承诺的命令，不透传各 provider TUI 的私有 slash command。
// `/` 控制 baton/provider；`@` 只引用 baton session/turn/产物。

import { providerPrefixMatches, PROVIDERS, parseProvider, type ProviderName } from "../providers/ids.ts";

export { PROVIDERS, parseProvider, type ProviderName };

export type CommandName = ProviderName | "model" | "sessions" | "status" | "new" | "exit";

export interface CommandDefinition {
  name: CommandName;
  description: string;
  scope: "baton" | "provider";
  /** 切换 BatonSession 会替换 runtime，只允许 idle；其它控制命令可随时执行。 */
  runPolicy: "always" | "idle";
}

export const COMMANDS: readonly CommandDefinition[] = [
  ...PROVIDERS.map((name) => ({
    name,
    description: `Switch the input target to ${name}`,
    scope: "baton",
    runPolicy: "always",
  }) satisfies CommandDefinition),
  {
    name: "model",
    description: "Set the model for the current provider's next turns",
    scope: "provider",
    runPolicy: "always",
  },
  {
    name: "sessions",
    description: "Open the BatonSession picker ('tree' for the fork-lineage view)",
    scope: "baton",
    runPolicy: "idle",
  },
  {
    name: "status",
    description: "Show the current BatonSession information",
    scope: "baton",
    runPolicy: "always",
  },
  {
    name: "new",
    description: "Create a new BatonSession in the current directory",
    scope: "baton",
    runPolicy: "idle",
  },
  { name: "exit", description: "Exit baton", scope: "baton", runPolicy: "always" },
];

export interface MatchedProviderRoute {
  kind: "matched";
  provider: ProviderName;
  message: string;
}

export interface AmbiguousProviderRoute {
  kind: "ambiguous";
  token: string;
  providers: ProviderName[];
}

export type ProviderRoute = MatchedProviderRoute | AmbiguousProviderRoute;

/** 未命中 baton command 时，将开头的 `/provider` token 按 id + aliases 唯一前缀路由。 */
export function parseProviderRoute(input: string): ProviderRoute | null {
  const match = /^\/([a-z-]+)(?:\s+([\s\S]*))?$/i.exec(input.trim());
  if (!match) return null;
  const token = match[1]?.toLowerCase() ?? "";
  const providers = providerPrefixMatches(token);
  if (providers.length === 0) return null;
  if (providers.length > 1) return { kind: "ambiguous", token, providers };
  return { kind: "matched", provider: providers[0]!, message: match[2]?.trim() ?? "" };
}
