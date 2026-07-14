// provider 运行时定义的唯一权威：轻量身份（id + aliases）来自 ids.ts，
// wire/持久化 key、展示名、认色和 adapter 工厂在这里组装成 ProviderDefinition。
// 任何按名字分发、贴标签、着色的代码都必须经本模块归一。

import { ClaudeAdapter } from "../adapters/claude/adapter.ts";
import { CodexAdapter } from "../adapters/codex/adapter.ts";
import type { AgentAdapter, RequestHandler } from "../adapters/types.ts";
import type { BatonConfig } from "../config/config.ts";
import { PROVIDER_IDENTITIES, PROVIDERS, parseProvider, type ProviderName } from "./ids.ts";

export { PROVIDERS, parseProvider, type ProviderName };

export interface ProviderAdapterOptions {
  requestHandler: RequestHandler;
  config: BatonConfig;
}

export interface ProviderDefinition<Id extends string = string> {
  /** canonical id：用户侧词汇（slash command、--agent、config.defaultAgent） */
  id: Id;
  /** 用户侧简写；输入时归一到 id，不进入事件或持久化 */
  aliases: readonly string[];
  /** picker / 帮助文案里的展示长名 */
  label: string;
  /**
   * wire/持久化 key：事件 provider 字段与 meta providerSessions 的 key。
   * **冻结值，永不变更**——已持久化的 session.jsonl 与 meta.json 都用它，
   * 改动意味着同一文件里新旧值并存，所有按 provider 过滤的逻辑都要背 alias 集合。
   */
  sessionKey: string;
  /** 时间线 author 短名，同时是着色 key（agentColorFor 的输入） */
  shortName: string;
  /** 固定认色：用户会形成"橙=claude"的肌肉记忆，颜色不随池子调整漂移 */
  color: string;
  create(options: ProviderAdapterOptions): AgentAdapter;
}

/** 首批内置 provider；扩展支持只在这里注册，不进入 BatonSession core。 */
export const PROVIDER_REGISTRY = [
  {
    ...PROVIDER_IDENTITIES.codex,
    label: "Codex",
    sessionKey: "codex",
    shortName: "codex",
    color: "#73daca", // 青
    create: ({ requestHandler, config }) =>
      new CodexAdapter({
        requestHandler,
        command: config.codexCommand,
        approvalReviewer: config.codexApprovalReviewer,
      }),
  },
  {
    ...PROVIDER_IDENTITIES.claude,
    label: "Claude Code",
    sessionKey: "claude-code",
    shortName: "claude",
    color: "#ff9e64", // 橙
    create: ({ requestHandler, config }) =>
      new ClaudeAdapter({ requestHandler, executablePath: config.claudeExecutable }),
  },
] as const satisfies readonly ProviderDefinition<ProviderName>[];

/**
 * 按 canonical id、alias **或** wire key 归一到 definition。
 * 未知输入返回 undefined（provider 是开放扩展点）。
 */
export function providerDefinitionFor(idOrSessionKey: string): ProviderDefinition | undefined {
  const canonicalId = parseProvider(idOrSessionKey);
  return PROVIDER_REGISTRY.find(
    (candidate) => candidate.id === canonicalId || candidate.sessionKey === idOrSessionKey,
  );
}

/** 时间线 author / 着色 key；未知 provider 原样返回（开放扩展点的兜底展示） */
export function providerShortName(idOrSessionKey: string): string {
  return providerDefinitionFor(idOrSessionKey)?.shortName ?? idOrSessionKey;
}

export function createProviderAdapter(
  provider: ProviderName,
  options: ProviderAdapterOptions,
): AgentAdapter {
  const definition = PROVIDER_REGISTRY.find((candidate) => candidate.id === provider);
  if (!definition) throw new Error(`Provider not registered: ${provider}`);
  return definition.create(options);
}

export function providerSessionKey(provider: ProviderName): string {
  const definition = PROVIDER_REGISTRY.find((candidate) => candidate.id === provider);
  if (!definition) throw new Error(`Provider not registered: ${provider}`);
  return definition.sessionKey;
}
