// Adapter 统一抽象："小核心 + 可选能力"（见 docs/design.md §5.1）。
// 各家用原生协议接入，翻译成内部事件（AnyNewEvent）交给 sink；信封字段由 Store 补齐。

import type { AnyNewEvent, ContentBlock, PermissionRequest } from "../events/types.ts";

export interface ProviderSessionRef {
  provider: string;
  providerSessionId: string;
}

/** adapter 产出的事件由宿主决定去向（append 到 Store、推给 TUI…） */
export type EventSink = (ev: AnyNewEvent) => void;

export interface StartOptions {
  cwd: string;
  env?: Record<string, string>;
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

/** 审批决策：optionId 取自 PermissionRequest.options */
export interface ApprovalDecision {
  optionId: string;
}

/**
 * 宿主提供的审批回调：adapter 收到 provider 的审批请求时调用并等待。
 * adapter 负责把 permission_request / permission_resolved 事件发给 sink 留痕。
 */
export type ApprovalHandler = (req: PermissionRequest) => Promise<ApprovalDecision>;
