// Adapter 统一抽象："小核心 + 可选能力"（见 docs/design.md §5.1）。
// 各家用原生协议接入，翻译成内部事件（AnyNewEvent）交给 sink；信封字段由 Store 补齐。

import type { AnyNewEvent, ContentBlock, PermissionRequest } from "../events/types.ts";

export interface ProviderSessionRef {
  provider: string;
  providerSessionId: string;
  /** 是否成功恢复了既有原生会话；false 表示新建，宿主需要从 BatonSession 补历史。 */
  resumed?: boolean;
}

/** adapter 产出的事件由宿主决定去向（append 到 Store、推给 TUI…） */
export type EventSink = (ev: AnyNewEvent) => void;

export interface StartOptions {
  cwd: string;
  env?: Record<string, string>;
  /** 已记录的原生 ProviderSession ID；adapter 应优先恢复，缺失时新建。 */
  resumeSessionId?: string;
}

export interface PromptOptions {
  /** 宿主生成的 turn ID（t_ 前缀），本 turn 所有事件携带它；provider 侧的 turn id 进 raw */
  turnId: string;
}

export interface AgentAdapter {
  readonly provider: string;
  start(opts: StartOptions): Promise<ProviderSessionRef>;
  /** 发送一轮输入；resolve 于 turn 结束（idle）。流式进展经 sink 回传。 */
  prompt(
    ref: ProviderSessionRef,
    blocks: ContentBlock[],
    sink: EventSink,
    opts: PromptOptions,
  ): Promise<void>;
  cancel(ref: ProviderSessionRef): Promise<void>;
  close(ref: ProviderSessionRef): Promise<void>;
}

export interface ModelOption {
  id: string;
  label: string;
  description?: string;
}

/**
 * 可选模型能力。setModel 只影响后续 prompt，不得改变已经在运行的 turn，
 * 让 `/model` 在 provider busy 时也有稳定、跨 provider 一致的语义。
 */
export interface ModelConfigurable {
  listModels(ref: ProviderSessionRef): Promise<ModelOption[]>;
  setModel(ref: ProviderSessionRef, modelId: string | null): Promise<void>;
  currentModel(ref: ProviderSessionRef): string | null;
}

export function isModelConfigurable(adapter: AgentAdapter): adapter is AgentAdapter & ModelConfigurable {
  const candidate = adapter as Partial<ModelConfigurable>;
  return (
    typeof candidate.listModels === "function" &&
    typeof candidate.setModel === "function" &&
    typeof candidate.currentModel === "function"
  );
}

/** 可把 BatonSession 的缺失历史追加到 provider 自己的 model-visible history。 */
export interface ContextSynchronizable {
  syncContext(ref: ProviderSessionRef, blocks: ContentBlock[]): Promise<void>;
}

export function isContextSynchronizable(
  adapter: AgentAdapter,
): adapter is AgentAdapter & ContextSynchronizable {
  return typeof (adapter as Partial<ContextSynchronizable>).syncContext === "function";
}

/** adapter 的运行时句柄与可持久化的原生 session ID 不同时，由此能力显式暴露。 */
export interface NativeSessionIdentifiable {
  nativeSessionId(ref: ProviderSessionRef): string | undefined;
}

export function isNativeSessionIdentifiable(
  adapter: AgentAdapter,
): adapter is AgentAdapter & NativeSessionIdentifiable {
  return typeof (adapter as Partial<NativeSessionIdentifiable>).nativeSessionId === "function";
}

/** 审批决策：optionId 取自 PermissionRequest.options */
export interface ApprovalDecision {
  optionId: string;
}

/**
 * 宿主提供的审批回调：adapter 收到 provider 的审批请求时调用并等待。
 * adapter 负责把 permission_request / permission_resolved 事件发给 sink 留痕。
 */
export type ApprovalHandler = (req: PermissionRequest) => Promise<ApprovalDecision>;
