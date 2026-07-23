// harness 运行时定义的唯一权威：轻量身份（id + aliases）来自 ids.ts，
// wire/持久化 key、展示名、认色和 adapter 工厂在这里组装成 HarnessDefinition。
// 任何按名字分发、贴标签、着色的代码都必须经本模块归一。

import { ClaudeAdapter } from "../adapters/claude/adapter.ts";
import { CodexAdapter } from "../adapters/codex/adapter.ts";
import type { HarnessAdapter, RequestHandler } from "../adapters/types.ts";
import type { BatonConfig } from "../config/config.ts";
import { FileHookTrustStore } from "../config/hook.ts";
import type { DiagnosticSink } from "../diagnostics.ts";
import { HARNESS_IDENTITIES, HARNESSES, parseHarness, type HarnessName } from "./ids.ts";

export { HARNESSES, parseHarness, type HarnessName };

export interface HarnessAdapterOptions {
  requestHandler: RequestHandler;
  diagnostic?: DiagnosticSink;
  config: BatonConfig;
  rootDir?: string;
}

export interface HarnessDefinition<Id extends string = string> {
  /** canonical id：用户侧词汇（slash command、--agent、config.defaultAgent） */
  id: Id;
  /** 用户侧简写；输入时归一到 id，不进入事件或持久化 */
  aliases: readonly string[];
  /** picker / 帮助文案里的展示长名 */
  label: string;
  /**
   * wire/持久化 key：事件 harness 字段与 meta harnessSessions 的 key。
   * **冻结值，永不变更**——已持久化的 session.jsonl 与 meta.json 都用它，
   * 改动意味着同一文件里新旧值并存，所有按 harness 过滤的逻辑都要背 alias 集合。
   */
  sessionKey: string;
  /** 时间线 author 短名，同时是着色 key（agentColorFor 的输入） */
  shortName: string;
  /** 固定认色：用户会形成"橙=claude"的肌肉记忆，颜色不随池子调整漂移 */
  color: string;
  create(options: HarnessAdapterOptions): HarnessAdapter;
}

/** 首批内置 harness；扩展支持只在这里注册，不进入 BatonSession core。 */
export const HARNESS_REGISTRY = [
  {
    ...HARNESS_IDENTITIES.codex,
    label: "Codex",
    sessionKey: "codex",
    shortName: "codex",
    color: "#73daca", // 青
    create: ({ requestHandler, diagnostic, config, rootDir }) =>
      new CodexAdapter({
        requestHandler,
        diagnostic,
        command: config.codexCommand,
        approvalReviewer: config.codexApprovalReviewer,
        hookTrustStore: new FileHookTrustStore(rootDir),
      }),
  },
  {
    ...HARNESS_IDENTITIES.claude,
    label: "Claude Code",
    sessionKey: "claude-code",
    shortName: "claude",
    color: "#ff9e64", // 橙
    create: ({ requestHandler, diagnostic, config }) =>
      new ClaudeAdapter({ requestHandler, diagnostic, executablePath: config.claudeExecutable }),
  },
] as const satisfies readonly HarnessDefinition<HarnessName>[];

/**
 * 按 canonical id、alias **或** wire key 归一到 definition。
 * 未知输入返回 undefined（harness 是开放扩展点）。
 */
export function harnessDefinitionFor(idOrSessionKey: string): HarnessDefinition | undefined {
  const canonicalId = parseHarness(idOrSessionKey);
  return HARNESS_REGISTRY.find(
    (candidate) => candidate.id === canonicalId || candidate.sessionKey === idOrSessionKey,
  );
}

/** 时间线 author / 着色 key；未知 harness 原样返回（开放扩展点的兜底展示） */
export function harnessShortName(idOrSessionKey: string): string {
  return harnessDefinitionFor(idOrSessionKey)?.shortName ?? idOrSessionKey;
}

export function createHarnessAdapter(
  harness: HarnessName,
  options: HarnessAdapterOptions,
): HarnessAdapter {
  const definition = HARNESS_REGISTRY.find((candidate) => candidate.id === harness);
  if (!definition) throw new Error(`Harness not registered: ${harness}`);
  return definition.create(options);
}

export function harnessSessionKey(harness: HarnessName): string {
  const definition = HARNESS_REGISTRY.find((candidate) => candidate.id === harness);
  if (!definition) throw new Error(`Harness not registered: ${harness}`);
  return definition.sessionKey;
}
