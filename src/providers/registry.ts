import { ClaudeAdapter } from "../adapters/claude/adapter.ts";
import { CodexAdapter } from "../adapters/codex/adapter.ts";
import type { AgentAdapter, ApprovalHandler } from "../adapters/types.ts";
import type { BatonConfig } from "../config/config.ts";

export interface ProviderAdapterOptions {
  approvalHandler: ApprovalHandler;
  config: BatonConfig;
}

interface ProviderDefinition<Id extends string = string> {
  id: Id;
  label: string;
  sessionKey: string;
  create(options: ProviderAdapterOptions): AgentAdapter;
}

/** 首批内置 provider；扩展支持只在这里注册，不进入 BatonSession core。 */
export const PROVIDER_REGISTRY = [
  {
    id: "codex",
    label: "Codex",
    sessionKey: "codex",
    create: ({ approvalHandler, config }) =>
      new CodexAdapter({ approvalHandler, command: config.codexCommand }),
  },
  {
    id: "claude",
    label: "Claude Code",
    sessionKey: "claude-code",
    create: ({ approvalHandler, config }) =>
      new ClaudeAdapter({ approvalHandler, executablePath: config.claudeExecutable }),
  },
] as const satisfies readonly ProviderDefinition[];

export type ProviderName = (typeof PROVIDER_REGISTRY)[number]["id"];
export const PROVIDERS = PROVIDER_REGISTRY.map((provider) => provider.id) as ProviderName[];

export function createProviderAdapter(
  provider: ProviderName,
  options: ProviderAdapterOptions,
): AgentAdapter {
  const definition = PROVIDER_REGISTRY.find((candidate) => candidate.id === provider);
  if (!definition) throw new Error(`provider 未注册: ${provider}`);
  return definition.create(options);
}

export function providerSessionKey(provider: ProviderName): string {
  const definition = PROVIDER_REGISTRY.find((candidate) => candidate.id === provider);
  if (!definition) throw new Error(`provider 未注册: ${provider}`);
  return definition.sessionKey;
}
