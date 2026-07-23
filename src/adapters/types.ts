// Adapter 统一抽象："小核心 + 可选能力"（见 docs/design.md §5.1）。
// 各家用原生协议接入，翻译成内部事件（AnyNewEvent）交给 sink；信封字段由 Store 补齐。

import type { AnyNewEvent, InteractionRequest, PromptBlock } from "../events/types.ts";

export interface HarnessSessionRef {
  harness: string;
  harnessSessionId: string;
  /** 是否成功恢复了既有原生会话；false 表示新建，宿主需要从 BatonSession 补历史。 */
  resumed?: boolean;
}

/** adapter 产出的事件由宿主决定去向（append 到 Store、推给 TUI…） */
export type EventSink = (ev: AnyNewEvent) => void;

export interface OpenOptions {
  cwd: string;
  env?: Record<string, string>;
  /** 已记录的原生 HarnessSession ID；adapter 应优先恢复，缺失时新建。 */
  resumeSessionId?: string;
}

/**
 * 一轮输入。ID 都由 controller 分配（design §4.10.1）：turnId 在入队时分配（steer 的
 * expectedTurnId 引用它）；harness 侧各自的 turn/message id 只进 raw 或 adapter
 * 内部映射，不进 controller 契约。
 *
 * 普通 prompt 的 `user_message` / `state_update(running)` 由 controller 在出队时落盘
 * （用户输入是 BatonSession 的事实，不等 harness 冷启动；且 submit 的 blocks 可能
 * 含 <baton-sync> prepend，不能进正典历史）——adapter **不得**为 prompt 重复发这两个
 * 事件；messageId 仅供 steer 成功路径发 delivery:"steer" 的 user_message upsert。
 */
export interface PromptInput {
  /** baton turn ID（t_ 前缀），本 turn 所有事件携带它 */
  turnId: string;
  /** 用户消息的 baton message ID（m_ 前缀） */
  messageId: string;
  blocks: PromptBlock[];
  /**
   * 跨 harness catch-up 注入（不属于用户输入正文，不进正典历史）。仅当 adapter 声明
   * `capabilities.sync` 时由 controller 传入，adapter 用原生 side-channel 随本次 submit
   * 送达（codex: `turn/start.additionalContext`）——独立注入 user message 会污染原生
   * 历史，text prepend 则把注入混进用户消息并暴露给 UserPromptSubmit hook。
   * 契约：与本 turn 一起送达；admission 失败视为未送达（controller 水位不动，下次重注入）。
   */
  syncBlocks?: PromptBlock[];
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
 * 供 controller/UI 决策（如不支持 image 时 admission 报错、不展示 steer 选项）。
 * 行为仍由可选接口承载（ModelConfigurable、EffortConfigurable、Steerable/CommandDiscoverable/
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
  /** 声明后必须实现 ContextCompactable：可请求 harness 压缩当前原生会话。 */
  compact?: CapabilityMarker;
  /**
   * submit 原生承载 `PromptInput.syncBlocks`（side-channel 注入）。与 ContextSynchronizable
   * 互斥使用：syncContext 是"急切注入、resolve 即送达"（水位立即推进）；sync 是"随下一次
   * submit 送达"（水位在 admission 通过后推进，语义同 prepend 路径）。都未声明时 controller
   * 回落为把 sync 块 prepend 进 prompt 文本。
   */
  sync?: CapabilityMarker;
  commands?: CapabilityMarker;
  config?: CapabilityMarker;
  /** 声明后必须实现 ApprovalRoutable：能报告审批请求当前路由给谁。 */
  approvalRouting?: CapabilityMarker;
  interactions?: {
    permission?: CapabilityMarker;
    question?: CapabilityMarker;
    elicitation?: { supported: true; form?: CapabilityMarker; url?: CapabilityMarker };
  };
}

/**
 * Adapter 生命周期（ACP v2 风格，design §4.1）：open 时绑定事件出口，submit 只确认接收，
 * turn 进展与终结全部经 sink 的事件报告；controller 以 state event 驱动 busy/idle，
 * 不以任何 Promise 生命周期推断。
 *
 * 终态硬性约定：每个被 submit 接受的 turn，adapter 在**任何退出路径**（正常结束、
 * wire fatal error、子进程退出、transport close）都必须恰好报告或合成一次
 * `state_update(idle)`；错误路径先发 `_baton_error_update` 再发 idle。重复/迟到的
 * 物理终态允许存在，由 controller 按 baton turn id 幂等 finalize。
 */
export interface HarnessAdapter {
  readonly harness: string;
  readonly capabilities: AdapterCapabilities;
  /** 建立（或恢复）harness session 并绑定事件出口；此后包括 harness 主动事件在内都经 sink 上报 */
  open(opts: OpenOptions, sink: EventSink): Promise<HarnessSessionRef>;
  /**
   * 提交一轮输入；resolve 仅代表 admission 通过。入参是闭合的 PromptBlock（非开放
   * ContentBlock）：不支持的 block 类型必须在 admission 前报带类型的明确错误，
   * 禁止静默丢弃（design §4.2）。
   */
  submit(ref: HarnessSessionRef, input: PromptInput): Promise<PromptReceipt>;
  /** 请求中断当前 turn；确认以最终 `idle/cancelled` 事件为准，发出后仍接受在途 update */
  cancel(ref: HarnessSessionRef): Promise<void>;
  close(ref: HarnessSessionRef): Promise<void>;
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
 * 让 `/model` 在 harness busy 时也有稳定、跨 harness 一致的语义。
 */
export interface ModelConfigurable {
  listModels(ref: HarnessSessionRef): Promise<ModelOption[]>;
  setModel(ref: HarnessSessionRef, modelId: string | null): Promise<void>;
  currentModel(ref: HarnessSessionRef): string | null;
}

export function isModelConfigurable(adapter: HarnessAdapter): adapter is HarnessAdapter & ModelConfigurable {
  const candidate = adapter as Partial<ModelConfigurable>;
  return (
    typeof candidate.listModels === "function" &&
    typeof candidate.setModel === "function" &&
    typeof candidate.currentModel === "function"
  );
}

export interface EffortOption {
  id: string;
  label: string;
  description?: string;
}

/**
 * 可选推理强度能力。候选值可随当前 model 变化，因此由 adapter 动态返回；setEffort
 * 与 setModel 一样只影响后续 prompt，不改变正在运行的 turn。
 */
export interface EffortConfigurable {
  listEfforts(ref: HarnessSessionRef): Promise<EffortOption[]>;
  setEffort(ref: HarnessSessionRef, effortId: string | null): Promise<void>;
  currentEffort(ref: HarnessSessionRef): string | null;
}

export function isEffortConfigurable(adapter: HarnessAdapter): adapter is HarnessAdapter & EffortConfigurable {
  const candidate = adapter as Partial<EffortConfigurable>;
  return (
    typeof candidate.listEfforts === "function" &&
    typeof candidate.setEffort === "function" &&
    typeof candidate.currentEffort === "function"
  );
}

/**
 * 审批路由的归一值：`user` = 请求进 baton TUI；`delegated` = harness 侧 reviewer 代批
 * （必须留下带 id 的回执，kernel §4 MUST NOT "静默持有审批授权"）。harness 的方言词
 * （codex 的 `auto_review` / `guardian_subagent`）在 adapter 边界收口，不越界。
 */
export type ApprovalRoute = "user" | "delegated";

export interface ApprovalRoutable {
  /**
   * 当前**实际生效**的审批路由。
   *
   * 必须是权威值——由 harness 自己解析后报告，不是 baton 从配置意图反推的。反推必错：
   * codex 的 reviewer 解析链含云端下发的企业 requirements（`allowed_approvals_reviewers`），
   * 能覆盖用户 config.toml 里写死的值、也能覆盖启动参数。无法确知时返回 null——
   * 不知道就别声称（不变量 #2），投影据此静默而不是编一个。
   */
  approvalRoute(ref: HarnessSessionRef): ApprovalRoute | null;
}

export function isApprovalRoutable(adapter: HarnessAdapter): adapter is HarnessAdapter & ApprovalRoutable {
  return typeof (adapter as Partial<ApprovalRoutable>).approvalRoute === "function";
}

/**
 * steer 的回执：`rejected` 是正常返回值而非异常——expectedTurnId 已过期（race）、
 * harness 侧拒绝（review/compact 等特殊 turn）都归入 rejected，由 controller 决定降级；
 * 只有 wire/transport 故障才 throw。
 */
export interface SteerReceipt {
  effective: "steer" | "rejected";
}

/**
 * 可选能力（design §4.3）：把输入注入当前活跃 turn 的下一个安全边界，不新开 turn。
 *
 * 契约：
 * - `expectedTurnId` 恒为 baton turn id；到 harness turn id 的映射留在 adapter 内部，
 *   不进 controller 词汇。expectedTurnId 与 adapter 当前 active turn 不符必须返回 rejected
 *   （防 race：用户提交时看到的 turn 已结束，不能把输入注入新 turn）。
 * - `input.turnId` 即被注入的 turn；effective:"steer" 时 adapter 负责发 delivery:"steer"
 *   的 user_message upsert（信封 turnId 绑定该 turn），rejected 时不得发任何事件。
 * - 声明 capabilities.steer 才可被 controller 调用；契约测试钉住"声明即实现"。
 */
export interface Steerable {
  steer(ref: HarnessSessionRef, input: PromptInput, expectedTurnId: string): Promise<SteerReceipt>;
}

export function isSteerable(adapter: HarnessAdapter): adapter is HarnessAdapter & Steerable {
  return typeof (adapter as Partial<Steerable>).steer === "function";
}

/**
 * 可选能力：让 harness 用自己的原生机制压缩当前会话上下文。
 *
 * `turnId` 由 controller 分配；controller 已先发 running 开界，adapter 必须把压缩过程事件绑定
 * 到该 turn，并在所有终结路径发一次 idle。方法 resolve 只表示请求已被接收，不表示压缩完成。
 */
export interface ContextCompactable {
  compactContext(ref: HarnessSessionRef, turnId: string): Promise<PromptReceipt>;
}

export function isContextCompactable(adapter: HarnessAdapter): adapter is HarnessAdapter & ContextCompactable {
  return typeof (adapter as Partial<ContextCompactable>).compactContext === "function";
}

/** 可把 BatonSession 的缺失历史追加到 harness 自己的 model-visible history。 */
export interface ContextSynchronizable {
  syncContext(ref: HarnessSessionRef, blocks: PromptBlock[]): Promise<void>;
}

export function isContextSynchronizable(
  adapter: HarnessAdapter,
): adapter is HarnessAdapter & ContextSynchronizable {
  return typeof (adapter as Partial<ContextSynchronizable>).syncContext === "function";
}

/** adapter 的运行时句柄与可持久化的原生 session ID 不同时，由此能力显式暴露。 */
export interface NativeSessionIdentifiable {
  nativeSessionId(ref: HarnessSessionRef): string | undefined;
}

export function isNativeSessionIdentifiable(
  adapter: HarnessAdapter,
): adapter is HarnessAdapter & NativeSessionIdentifiable {
  return typeof (adapter as Partial<NativeSessionIdentifiable>).nativeSessionId === "function";
}

// Response：用户对某个 InteractionRequest 的答复（Request ↔ Response 轴，见
// harness-interaction-design.md §3.5）。按 `kind` 与对应 request 判别配对，`requestId`
// 关联（refersTo）该 request、供统一 respond() 路由。各 kind payload 独立，不复用。

/** permission 答复：optionId 取自 PermissionRequest.options */
export interface PermissionResponse {
  kind: "permission";
  requestId: string;
  optionId: string;
}

/** question 答复：answers 按 questionId 收集 */
export interface QuestionResponse {
  kind: "question";
  requestId: string;
  answers: Record<string, string[]>;
}

/** 信任当前 hook 精确定义；定义 hash 不变时后续 harness 进程自动放行。 */
export interface HookTrustResponse {
  kind: "hook_trust";
  requestId: string;
  decision: "trust" | "skip";
}

/** InteractionResponse：用户答复的判别联合（按 `kind` 收窄）。elicitation 待接入 */
export type InteractionResponse = PermissionResponse | QuestionResponse | HookTrustResponse;

/**
 * 所属 turn 被打断/收口时，controller 用它级联解开仍挂起的 request（cancel-cascade）：不是用户
 * 答复，而是"这个 request 随 turn 一起黄了"。adapter 收到即发 `*_resolved(cancelled)` 留痕、
 * 并回 harness 一个 abort/deny（不静默丢、不当成 allow）。参考 codex `clear_pending_waiters`
 * → `unwrap_or(Abort)`、opencode interrupt 的 `ensuring(pending.delete)`。
 */
export interface InteractionCancelled {
  kind: "cancelled";
  requestId: string;
}

/** adapter `await requestHandler` 的解值：用户答复 或 turn 收口时的级联取消 */
export type RequestOutcome = InteractionResponse | InteractionCancelled;

/**
 * 宿主提供的统一 request 回调：adapter 收到 harness 的 permission / question / hook trust 请求时，
 * 构造对应 kind 的 InteractionRequest 调用并等待 `RequestOutcome`（用户答复，或 turn 收口时
 * 的 cancelled）。adapter 负责把 *_request / *_resolved 事件发给 sink 留痕。取代旧的
 * approvalHandler / questionHandler 双回调——只保留一条 request→response 通道（design §4.7）。
 */
export type RequestHandler = (req: InteractionRequest) => Promise<RequestOutcome>;
