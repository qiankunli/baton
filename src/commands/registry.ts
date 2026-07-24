// Baton 只实现自己承诺的命令，不透传各 harness TUI 的私有 slash command。
// `/` 控制 baton/harness；`@` 只引用 baton session/turn/产物。

import { harnessPrefixMatches, HARNESSES, parseHarness, type HarnessName } from "../harness/ids.ts";

export { HARNESSES, parseHarness, type HarnessName };

export type CommandName =
  | HarnessName
  | "model"
  | "effort"
  | "compact"
  | "plugins"
  | "reload-plugins"
  | "sessions"
  | "status"
  | "new"
  | "exit";

export interface CommandDefinition {
  name: CommandName;
  description: string;
  scope: "baton" | "harness";
  /** 切换 BatonSession 会替换 controller，只允许 idle；其它控制命令可随时执行。 */
  runPolicy: "always" | "idle";
}

export const COMMANDS: readonly CommandDefinition[] = [
  ...HARNESSES.map((name) => ({
    name,
    description: `Switch the input target to ${name}`,
    scope: "baton",
    runPolicy: "always",
  }) satisfies CommandDefinition),
  {
    name: "model",
    description: "Set the model for the current harness's next turns",
    scope: "harness",
    runPolicy: "always",
  },
  {
    name: "effort",
    description: "Set the reasoning effort for the current harness's next turns",
    scope: "harness",
    runPolicy: "always",
  },
  {
    name: "compact",
    description: "Compact the current harness context",
    scope: "harness",
    runPolicy: "idle",
  },
  {
    name: "plugins",
    description: "Manage Baton plugins",
    scope: "baton",
    runPolicy: "always",
  },
  {
    name: "reload-plugins",
    description: "Reload enabled plugins in the current BatonSession",
    scope: "baton",
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

export interface MatchedHarnessRoute {
  kind: "matched";
  harness: HarnessName;
  message: string;
}

export interface AmbiguousHarnessRoute {
  kind: "ambiguous";
  token: string;
  harnesses: HarnessName[];
}

export type HarnessRoute = MatchedHarnessRoute | AmbiguousHarnessRoute;

/** 未命中 baton command 时，将开头的 `/harness` token 按 id + aliases 唯一前缀路由。 */
export function parseHarnessRoute(input: string): HarnessRoute | null {
  const match = /^\/([a-z-]+)(?:\s+([\s\S]*))?$/i.exec(input.trim());
  if (!match) return null;
  const token = match[1]?.toLowerCase() ?? "";
  const harnesses = harnessPrefixMatches(token);
  if (harnesses.length === 0) return null;
  if (harnesses.length > 1) return { kind: "ambiguous", token, harnesses };
  return { kind: "matched", harness: harnesses[0]!, message: match[2]?.trim() ?? "" };
}
