// Baton 只实现自己承诺的命令，不透传各 provider TUI 的私有 slash command。
// `/` 控制 baton/provider；`@` 只引用 baton session/turn/产物。

import { PROVIDERS, type ProviderName } from "../providers/registry.ts";

export { PROVIDERS, type ProviderName };

export type CommandName = "provider" | "model" | "sessions" | "status" | "new" | "exit";

export interface CommandDefinition {
  name: CommandName;
  description: string;
  scope: "baton" | "provider";
  /** 切换 BatonSession 会替换 runtime，只允许 idle；其它控制命令可随时执行。 */
  runPolicy: "always" | "idle";
}

export const COMMANDS: readonly CommandDefinition[] = [
  {
    name: "provider",
    description: "Select the input target (codex / claude)",
    scope: "baton",
    runPolicy: "always",
  },
  {
    name: "model",
    description: "Set the model for the current provider's next turns",
    scope: "provider",
    runPolicy: "always",
  },
  {
    name: "sessions",
    description: "Open the BatonSession picker",
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

export function parseProvider(value: string): ProviderName | null {
  const normalized = value.trim().toLowerCase();
  return PROVIDERS.find((provider) => provider === normalized) ?? null;
}
