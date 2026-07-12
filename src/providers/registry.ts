// provider identity 的唯一权威：canonical id、wire/持久化 key、展示名、认色、
// adapter 工厂全部挂在 ProviderDefinition 上。三套取值的对齐关系（id "claude" /
// sessionKey "claude-code" / shortName "claude"）只在这里声明一次，
// 任何按名字分发、贴标签、着色的代码都必须经本模块归一，不得手写字面量映射。

import { ClaudeAdapter } from "../adapters/claude/adapter.ts";
import { CodexAdapter } from "../adapters/codex/adapter.ts";
import type { AgentAdapter, ApprovalHandler, QuestionHandler } from "../adapters/types.ts";
import type { BatonConfig } from "../config/config.ts";
import { PROVIDERS, parseProvider, type ProviderName } from "./ids.ts";

export { PROVIDERS, parseProvider, type ProviderName };

export interface ProviderAdapterOptions {
  approvalHandler: ApprovalHandler;
  questionHandler?: QuestionHandler;
  config: BatonConfig;
}

export interface ProviderDefinition<Id extends string = string> {
  /** canonical id：用户侧词汇（/provider、--agent、config.defaultAgent） */
  id: Id;
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
    id: "codex",
    label: "Codex",
    sessionKey: "codex",
    shortName: "codex",
    color: "#73daca", // 青
    create: ({ approvalHandler, questionHandler, config }) =>
      new CodexAdapter({ approvalHandler, questionHandler, command: config.codexCommand }),
  },
  {
    id: "claude",
    label: "Claude Code",
    sessionKey: "claude-code",
    shortName: "claude",
    color: "#ff9e64", // 橙
    create: ({ approvalHandler, questionHandler, config }) =>
      new ClaudeAdapter({ approvalHandler, questionHandler, executablePath: config.claudeExecutable }),
  },
] as const satisfies readonly ProviderDefinition<ProviderName>[];

/**
 * 按 canonical id **或** wire key 归一到 definition：消费方拿到的 provider 值
 * 可能来自用户输入（"claude"）也可能来自事件/持久化（"claude-code"），
 * 两个命名空间的反向映射只在这里。未知输入返回 undefined（provider 是开放扩展点）。
 */
export function providerDefinitionFor(idOrSessionKey: string): ProviderDefinition | undefined {
  return PROVIDER_REGISTRY.find(
    (candidate) => candidate.id === idOrSessionKey || candidate.sessionKey === idOrSessionKey,
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
