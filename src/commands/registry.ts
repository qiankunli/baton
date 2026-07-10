// Baton 只实现自己承诺的命令，不透传各 provider TUI 的私有 slash command。
// `/` 控制 baton/provider；`@` 只引用 baton session/turn/产物。

import { PROVIDERS, type ProviderName } from "../providers/registry.ts";

export { PROVIDERS, type ProviderName };

export type CommandName = "provider" | "model" | "sessions" | "new" | "exit";

export interface CommandDefinition {
  name: CommandName;
  description: string;
  scope: "baton" | "provider";
  /** 切换 BatonSession 会替换 runtime，只允许 idle；其它控制命令可随时执行。 */
  runPolicy: "always" | "idle";
}

export interface CommandInvocation {
  definition: CommandDefinition;
  argument: string;
}

export const COMMANDS: readonly CommandDefinition[] = [
  {
    name: "provider",
    description: "选择输入目标（codex / claude）",
    scope: "baton",
    runPolicy: "always",
  },
  {
    name: "model",
    description: "设置当前 provider 后续 turn 使用的模型",
    scope: "provider",
    runPolicy: "always",
  },
  {
    name: "sessions",
    description: "打开 BatonSession 选择器",
    scope: "baton",
    runPolicy: "idle",
  },
  {
    name: "new",
    description: "在当前工作目录新建 BatonSession",
    scope: "baton",
    runPolicy: "idle",
  },
  { name: "exit", description: "退出 baton", scope: "baton", runPolicy: "always" },
];

/** 只识别 registry 中的命令；未知的 `/path` 等输入仍作为普通 prompt。 */
export function parseCommand(input: string): CommandInvocation | null {
  const match = /^\/([a-z-]+)(?:\s+(.*))?$/i.exec(input.trim());
  if (!match) return null;
  const name = match[1]?.toLowerCase();
  const definition = COMMANDS.find((command) => command.name === name);
  if (!definition) return null;
  return { definition, argument: match[2]?.trim() ?? "" };
}

export function parseProvider(value: string): ProviderName | null {
  const normalized = value.trim().toLowerCase();
  return PROVIDERS.find((provider) => provider === normalized) ?? null;
}
