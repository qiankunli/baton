// Adapter 统一抽象："小核心 + 可选能力"（见 docs/design.md §5.1）。
// 各家用原生协议接入，翻译成内部事件（AnyNewEvent）交给 sink；信封字段由 Store 补齐。

import type { AnyNewEvent, PermissionRequest, PromptBlock, QuestionRequest } from "../events/types.ts";

export interface ProviderSessionRef {
  provider: string;
  providerSessionId: string;
  /** 是否成功恢复了既有原生会话；false 表示新建，宿主需要从 BatonSession 补历史。 */
  resumed?: boolean;
}

/** adapter 产出的事件由宿主决定去向（append 到 Store、推给 TUI…） */
export type EventSink = (ev: AnyNewEvent) => void;

export interface OpenOptions {
  cwd: string;
  env?: Record<string, string>;
  /** 已记录的原生 ProviderSession ID；adapter 应优先恢复，缺失时新建。 */
  resumeSessionId?: string;
}

/**
 * 一轮输入。ID 都由 runtime 分配（design §4.10.1）：turnId 在入队时分配（steer 的
 * expectedTurnId 引用它）；provider 侧各自的 turn/message id 只进 raw 或 adapter
 * 内部映射，不进 runtime 契约。
 *
 * 普通 prompt 的 `user_message` / `state_update(running)` 由 runtime 在出队时落盘
 * （用户输入是 BatonSession 的事实，不等 provider 冷启动；且 submit 的 blocks 可能
 * 含 <baton-sync> prepend，不能进正典历史）——adapter **不得**为 prompt 重复发这两个
 * 事件；messageId 仅供 steer 成功路径发 delivery:"steer" 的 user_message upsert。
 */
export interface PromptInput {
  /** baton turn ID（t_ 前缀），本 turn 所有事件携带它 */
  turnId: string;
  /** 用户消息的 baton message ID（m_ 前缀） */
  messageId: string;
  blocks: PromptBlock[];
}

/** submit 的回执：只代表 admission 通过，不代表 turn 完成（design §4.1） */
export interface PromptReceipt {
  accepted: true;
}

/**
 * 能力标记：用显式 marker object 而不是 TypeScript `{}`（`{}` 会接受几乎所有非 nullish 值），
 * 也不用 boolean——object 给以后扩字段（如支持的 mimeType 列表）留空间。
 */
export interface CapabilityMarker {
  supported: true;
}

/**
 * 可展示的能力 descriptor（design §4.4）：声明"这个 adapter 支持哪些可选能力"，
 * 供 runtime/UI 决策（如不支持 image 时 admission 报错、不展示 steer 选项）。
 * 行为仍由可选接口承载（ModelConfigurable、后续的 Steerable/CommandDiscoverable/
 * SessionConfigurable/Interactive）；契约测试保证"声明支持就必须实现对应接口"。
 */
export interface AdapterCapabilities {
  prompt: {
    image?: CapabilityMarker;
    audio?: CapabilityMarker;
    embeddedResource?: CapabilityMarker;
    resourceLink?: CapabilityMarker;
  };
  steer?: CapabilityMarker;
  commands?: CapabilityMarker;
  config?: CapabilityMarker;
  interactions?: {
    permission?: CapabilityMarker;
    question?: CapabilityMarker;
    elicitation?: { supported: true; form?: CapabilityMarker; url?: CapabilityMarker };
  };
}

/**
 * Adapter 生命周期（ACP v2 风格，design §4.1）：open 时绑定事件出口，submit 只确认接收，
 * turn 进展与终结全部经 sink 的事件报告；runtime 以 state event 驱动 busy/idle，
 * 不以任何 Promise 生命周期推断。
 *
 * 终态硬性约定：每个被 submit 接受的 turn，adapter 在**任何退出路径**（正常结束、
 * wire fatal error、子进程退出、transport close）都必须恰好报告或合成一次
 * `state_update(idle)`；错误路径先发 `_baton_error_update` 再发 idle。重复/迟到的
 * 物理终态允许存在，由 runtime 按 baton turn id 幂等 finalize。
 */
export interface AgentAdapter {
  readonly provider: string;
  readonly capabilities: AdapterCapabilities;
  /** 建立（或恢复）provider session 并绑定事件出口；此后包括 provider 主动事件在内都经 sink 上报 */
  open(opts: OpenOptions, sink: EventSink): Promise<ProviderSessionRef>;
  /**
   * 提交一轮输入；resolve 仅代表 admission 通过。入参是闭合的 PromptBlock（非开放
   * ContentBlock）：不支持的 block 类型必须在 admission 前报带类型的明确错误，
   * 禁止静默丢弃（design §4.2）。
   */
  submit(ref: ProviderSessionRef, input: PromptInput): Promise<PromptReceipt>;
  /** 请求中断当前 turn；确认以最终 `idle/cancelled` 事件为准，发出后仍接受在途 update */
  cancel(ref: ProviderSessionRef): Promise<void>;
  close(ref: ProviderSessionRef): Promise<void>;
}

/** admission 检查：返回 capabilities 未声明支持的 block 类型（text 恒支持） */
export function unsupportedPromptBlocks(
  blocks: PromptBlock[],
  capabilities: AdapterCapabilities,
): string[] {
  const unsupported = new Set<string>();
  for (const block of blocks) {
    if (block.type === "text") continue;
    const marker =
      block.type === "image"
        ? capabilities.prompt.image
        : block.type === "audio"
          ? capabilities.prompt.audio
          : block.type === "resource"
            ? capabilities.prompt.embeddedResource
            : block.type === "resource_link"
              ? capabilities.prompt.resourceLink
              : undefined;
    if (!marker) unsupported.add(block.type);
  }
  return [...unsupported];
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

/**
 * steer 的回执：`rejected` 是正常返回值而非异常——expectedTurnId 已过期（race）、
 * provider 侧拒绝（review/compact 等特殊 turn）都归入 rejected，由 runtime 决定降级；
 * 只有 wire/transport 故障才 throw。
 */
export interface SteerReceipt {
  effective: "steer" | "rejected";
}

/**
 * 可选能力（design §4.3）：把输入注入当前活跃 turn 的下一个安全边界，不新开 turn。
 *
 * 契约：
 * - `expectedTurnId` 恒为 baton turn id；到 provider turn id 的映射留在 adapter 内部，
 *   不进 runtime 词汇。expectedTurnId 与 adapter 当前 active turn 不符必须返回 rejected
 *   （防 race：用户提交时看到的 turn 已结束，不能把输入注入新 turn）。
 * - `input.turnId` 即被注入的 turn；effective:"steer" 时 adapter 负责发 delivery:"steer"
 *   的 user_message upsert（信封 turnId 绑定该 turn），rejected 时不得发任何事件。
 * - 声明 capabilities.steer 才可被 runtime 调用；契约测试钉住"声明即实现"。
 */
export interface Steerable {
  steer(ref: ProviderSessionRef, input: PromptInput, expectedTurnId: string): Promise<SteerReceipt>;
}

export function isSteerable(adapter: AgentAdapter): adapter is AgentAdapter & Steerable {
  return typeof (adapter as Partial<Steerable>).steer === "function";
}

/** 可把 BatonSession 的缺失历史追加到 provider 自己的 model-visible history。 */
export interface ContextSynchronizable {
  syncContext(ref: ProviderSessionRef, blocks: PromptBlock[]): Promise<void>;
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

export interface QuestionDecision {
  answers: Record<string, string[]>;
}

/** agent 结构化提问的宿主回调；与 permission approval 不共享 payload。 */
export type QuestionHandler = (req: QuestionRequest) => Promise<QuestionDecision>;
