import {
  isContextSynchronizable,
  isModelConfigurable,
  isNativeSessionIdentifiable,
  isSteerable,
  type AgentAdapter,
  type ApprovalDecision,
  type ApprovalHandler,
  type ModelOption,
  type ProviderSessionRef,
  type QuestionDecision,
  type QuestionHandler,
  type SteerReceipt,
} from "../adapters/types.ts";
import { buildProviderCatchUpContext } from "../context/mention.ts";
import { newId } from "../events/ids.ts";
import type { AnyEventEnvelope, AnyNewEvent, PromptBlock, StopReason } from "../events/types.ts";
import type { SessionHandle } from "../store/store.ts";

interface ProviderSlot {
  adapter: AgentAdapter;
  ref?: ProviderSessionRef;
  starting?: Promise<void>;
  freshNative: boolean;
}

interface QueuedTurn {
  id: number;
  /** baton turn id：入队时即分配（steer 的 expectedTurnId 引用它，design §4.3） */
  turnId: string;
  /** 用户消息的 baton message id，交给 adapter 发 user_message upsert */
  messageId: string;
  provider: string;
  blocks: PromptBlock[];
  resolve: (outcome: SubmitOutcome) => void;
  reject: (error: unknown) => void;
}

type TurnRole = "driven" | "observed";

/**
 * turn 台账记录：一个 turn 从进入执行（driven 被 drain 取走 / observed 开界）到
 * 逻辑终结的一等状态。所有终态通知按 turnId 查表路由到这里，status 保证逻辑终结
 * 每 turn 恰好一次（迟到/重复/未知终态一律 inert）。
 *
 * 合法迁移：
 * - （队列，不入台账）→ driven/active：drain 取走 QueuedTurn，runTurn 在 submit 前登记；
 *   排队中的 turn 留在 queue（无事件可路由），被 recall 的永不入账。
 * - （无）→ observed/active：`state_update(running, origin:"provider")` 开界登记，不进队列。
 * - active → finalized：`state_update(idle)` 按 envelope.turnId 命中；或 cancel 宽限期
 *   到期 / driven admission 失败时合成。此后记录保留在内存作幂等判定依据（会话级规模）。
 */
interface TurnRecord {
  turnId: string;
  role: TurnRole;
  slot: ProviderSlot;
  /** 事件 provider 字段同源（slot.adapter.provider，wire key） */
  provider: string;
  status: "active" | "finalized";
  startedAt: number;
  stopReason?: StopReason;
  /** driven 专属：入队原件（canSteer/steer 需要用户侧 provider 名） */
  turn?: QueuedTurn;
  /** driven 专属：finalize 时 resolve，释放 drain 循环推进队列 */
  release?: () => void;
  cancelGraceTimer?: ReturnType<typeof setTimeout>;
}

export interface QueuedTurnSnapshot {
  id: number;
  turnId: string;
  provider: string;
  blocks: PromptBlock[];
}

export type SubmitOutcome = "completed" | "recalled";

/**
 * steer 请求的调度结果（design §3.7：requested 与 effective 分开呈现）：
 * - `steer`：已注入当前 turn 的下一个安全边界，不产生新 turn；
 * - `follow_up`：不可 steer 或 provider 拒绝，已显式降级入队；outcome 与 submit
 *   的回执同语义（turn 完成/被撤回时 resolve），UI 不得把降级结果仍标成 steer。
 */
export type SteerOutcome =
  | { effective: "steer" }
  | { effective: "follow_up"; outcome: Promise<SubmitOutcome> };

/** runtime 注入给 adapter 构造器的交互回调（见 InteractionHandlers 的注入点 ensureProvider） */
export interface InteractionHandlers {
  approvalHandler: ApprovalHandler;
  questionHandler: QuestionHandler;
}

export interface BatonSessionRuntimeOptions {
  session: SessionHandle;
  mentionBudgetChars: number;
  createAdapter(provider: string, handlers: InteractionHandlers): AgentAdapter;
  providerSessionKey?(provider: string): string;
  onStateChange?: () => void;
  /**
   * cancel 后等待 provider 确认终态的宽限期。到期仍无终态则合成 terminal error 并
   * 推进队列（design §4.1：除 cancel grace 与 transport close 外不设全局 watchdog，
   * 合法的长任务不应被误杀）。
   */
  cancelGraceMs?: number;
}

const DEFAULT_CANCEL_GRACE_MS = 10_000;

/** 打断标记文案：cancelled 终态时落一条 notice，TUI 时间线醒目提示（对齐 Codex 的体验） */
export const INTERRUPTED_NOTICE_TITLE = "Conversation interrupted — tell the agent what to do differently";

/**
 * 一个 BatonSession 的唯一 turn 编排入口：统一负责 provider 恢复、上下文追平与全局串行。
 * UI 只提交意图和消费事件（经 SessionHandle.subscribe 订阅事件流），不能分别维护
 * 各 provider 的并发状态。
 *
 * turn 分两类生命周期（docs/design.md §5.10）：
 * - driven turn：baton 发起（用户 submit），入队、全局串行、finalize 推进队列；
 * - observed turn：provider 自发（`state_update(running, origin:"provider")` 开界），
 *   baton 不控制其开始，只划界、记账（turn summary + 同步水位），不进队列。
 *
 * 生命周期由 state event 驱动（design §4.1）：adapter.submit 只确认接收，turn 的
 * 完成以 `state_update(idle)` 为准，经 finalize 按 baton turn id 幂等收口——
 * 重复/迟到的物理终态（reconnect、transport race）不会二次终结，也不会关闭更新的 turn。
 *
 * TurnLedger：driven/observed 统一入 `turns` 台账，终态一律按 envelope.turnId 查表
 * 路由（不看 slot——按 slot 路由在同 provider driven+observed 并发时会吞掉 observed
 * 的终态）。driven ≤ 1 是**队列策略**（activeDrivenTurnId 指针 + drain 串行），不是
 * 台账模型假设；将来放开并行 driven 只改 drain 取件策略，台账与路由不动。
 */
export class BatonSessionRuntime {
  private readonly slots = new Map<string, ProviderSlot>();
  private readonly queue: QueuedTurn[] = [];
  private nextQueueId = 1;
  private draining = false;
  private processingProvider?: string;
  private processingStartedAt?: number;
  /** turn 台账：turnId → 记录。finalized 记录保留，作迟到终态的幂等判定依据 */
  private readonly turns = new Map<string, TurnRecord>();
  /** 队列策略指针：当前唯一 driven turn（本轮 driven ≤ 1；见类 docstring） */
  private activeDrivenTurnId?: string;
  /**
   * 未决交互的应答通道：requestId → resolver。**只有应答通道，没有状态**——
   * pending 交互的真相源是事件流（adapter 先 emit permission_request 再 await 回调，
   * UI 从 reduced state 投影），内存只保留唤醒 adapter 的 resolve 函数。
   * 崩溃后新进程没有 resolver，open 时的 crash recovery 会对 reduced pending
   * 一律补 resolved(cancelled)，两侧语义自洽。
   */
  private readonly pendingApprovals = new Map<string, (d: ApprovalDecision) => void>();
  private readonly pendingQuestions = new Map<string, (d: QuestionDecision) => void>();

  constructor(private readonly options: BatonSessionRuntimeOptions) {}

  /** 注入给 adapter 的审批回调：注册 resolver 后挂起，等宿主经 resolvePermission 应答 */
  readonly approvalHandler: ApprovalHandler = (request) =>
    new Promise((resolve) => {
      this.pendingApprovals.set(request.requestId, resolve);
      this.changed();
    });

  readonly questionHandler: QuestionHandler = (request) =>
    new Promise((resolve) => {
      this.pendingQuestions.set(request.requestId, resolve);
      this.changed();
    });

  /**
   * 宿主应答一个未决审批。false = requestId 不在挂起集合（已被应答、或事件流里的
   * pending 来自已死进程且无 resolver）——UI 据此提示 stale 而不是静默吞掉。
   * 事件留痕（permission_resolved）由被唤醒的 adapter 负责，这里不落事件。
   */
  resolvePermission(requestId: string, decision: ApprovalDecision): boolean {
    const resolve = this.pendingApprovals.get(requestId);
    if (!resolve) return false;
    this.pendingApprovals.delete(requestId);
    resolve(decision);
    return true;
  }

  resolveQuestion(requestId: string, decision: QuestionDecision): boolean {
    const resolve = this.pendingQuestions.get(requestId);
    if (!resolve) return false;
    this.pendingQuestions.delete(requestId);
    resolve(decision);
    return true;
  }

  /** 当前未终结的 driven turn 记录；无或已终结时 undefined */
  private activeDriven(): TurnRecord | undefined {
    if (!this.activeDrivenTurnId) return undefined;
    const record = this.turns.get(this.activeDrivenTurnId);
    return record && record.status === "active" ? record : undefined;
  }

  get activeProvider(): string | undefined {
    return this.processingProvider;
  }

  /** 当前 driven turn 的 baton turn id；TUI 据此做 per-turn 投影（运行阶段等） */
  get activeTurnId(): string | undefined {
    return this.activeDriven()?.turnId;
  }

  /** 当前 turn 的起跑时刻（epoch ms）；elapsed 跳秒由 TUI 组件自理，这里只给起点 */
  get activeStartedAt(): number | undefined {
    return this.processingStartedAt;
  }

  get queueLength(): number {
    return this.queue.length;
  }

  get queuedTurns(): QueuedTurnSnapshot[] {
    return this.queue.map((turn) => this.snapshot(turn));
  }

  get isBusy(): boolean {
    return this.draining;
  }

  submit(provider: string, blocks: PromptBlock[]): Promise<SubmitOutcome> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        id: this.nextQueueId++,
        turnId: newId("t"),
        messageId: newId("m"),
        provider,
        blocks,
        resolve,
        reject,
      });
      this.changed();
      void this.drain();
    });
  }

  /**
   * 当前输入能否 steer 到活跃 turn：有未终结的 driven turn、provider 匹配、
   * adapter 声明并实现了 steer。UI 据此决定 busy 时的默认 delivery 与选项展示。
   * observed turn（provider 自发）不接受 steer——baton 不拥有其生命周期。
   */
  canSteer(provider: string): boolean {
    const active = this.activeDriven();
    if (!active?.turn) return false;
    if (active.turn.provider !== provider) return false;
    if (!active.slot.ref) return false;
    return Boolean(active.slot.adapter.capabilities.steer) && isSteerable(active.slot.adapter);
  }

  /**
   * 把输入注入当前 turn 的下一个安全边界（design §4.3）。不可 steer、provider 拒绝
   * （expectedTurnId 过期 / review turn）或 wire 故障时，一律显式降级为 follow-up
   * 入队——永不静默丢失输入，也不把降级结果伪装成 steer（effective 如实上报）。
   */
  async steer(provider: string, blocks: PromptBlock[]): Promise<SteerOutcome> {
    const active = this.activeDriven();
    if (!active || !this.canSteer(provider) || !active.slot.ref) {
      return { effective: "follow_up", outcome: this.submit(provider, blocks) };
    }
    const adapter = active.slot.adapter;
    if (!isSteerable(adapter)) {
      return { effective: "follow_up", outcome: this.submit(provider, blocks) };
    }
    let receipt: SteerReceipt;
    try {
      receipt = await adapter.steer(
        active.slot.ref,
        // steer 消息归属被注入的 turn；messageId 照常由 runtime 分配（design §4.10.1）
        { turnId: active.turnId, messageId: newId("m"), blocks },
        active.turnId,
      );
    } catch {
      // wire 故障视同拒绝：降级路径会经 submit 的正常错误通道暴露 transport 问题，
      // 这里不吞掉输入本身
      receipt = { effective: "rejected" };
    }
    if (receipt.effective !== "steer") {
      return { effective: "follow_up", outcome: this.submit(provider, blocks) };
    }
    this.changed();
    return { effective: "steer" };
  }

  /** 只允许撤回尚未开始执行的最新 turn；已被 drain 取走的 active turn 不在此列。 */
  recallLatestQueued(): QueuedTurnSnapshot | undefined {
    const turn = this.queue.pop();
    if (!turn) return undefined;
    turn.resolve("recalled");
    this.changed();
    return this.snapshot(turn);
  }

  async listModels(provider: string): Promise<ModelOption[]> {
    const slot = await this.ensureProvider(provider);
    if (!slot.ref || !isModelConfigurable(slot.adapter)) throw new Error(`${provider} does not support /model`);
    return slot.adapter.listModels(slot.ref);
  }

  async setModel(provider: string, modelId: string | null): Promise<void> {
    const slot = await this.ensureProvider(provider);
    if (!slot.ref || !isModelConfigurable(slot.adapter)) throw new Error(`${provider} does not support /model`);
    await slot.adapter.setModel(slot.ref, modelId);
    const key = slot.adapter.provider;
    const existing = this.options.session.meta.providerSessions[key] ?? { provider: key };
    this.options.session.setProviderSession(key, {
      ...existing,
      provider: key,
      providerSessionId: existing.providerSessionId ?? this.nativeSessionId(slot),
      model: !modelId || modelId === "default" ? undefined : modelId,
    });
    this.changed();
  }

  currentModel(provider: string): string | null {
    const slot = this.slots.get(provider);
    if (!slot?.ref || !isModelConfigurable(slot.adapter)) {
      const key = this.options.providerSessionKey?.(provider) ?? provider;
      return this.options.session.meta.providerSessions[key]?.model ?? null;
    }
    return slot.adapter.currentModel(slot.ref);
  }

  /**
   * 请求中断当前 turn。确认以 provider 的 idle/cancelled 终态为准；宽限期内没等到
   * 则合成 terminal error，保证队列永远能推进（不能因 provider 失联而死锁）。
   */
  async cancelActive(): Promise<void> {
    const active = this.activeDriven();
    if (!active?.slot.ref) return;
    active.cancelGraceTimer ??= setTimeout(() => {
      this.synthesizeTerminal(active, "cancel grace period expired without provider confirmation");
    }, this.options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS);
    try {
      await active.slot.adapter.cancel(active.slot.ref);
    } catch (error) {
      // cancel 请求本身失败（transport 已断等）：不再等 provider，直接合成终态
      this.synthesizeTerminal(
        active,
        `cancel request failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  async close(): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const slot of this.slots.values()) {
      if (slot.ref) closing.push(slot.adapter.close(slot.ref).catch(() => {}));
    }
    await Promise.all(closing);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.queue.length > 0) {
        const turn = this.queue.shift() as QueuedTurn;
        this.changed();
        try {
          await this.runTurn(turn);
          turn.resolve("completed");
        } catch (error) {
          turn.reject(error);
        }
      }
    } finally {
      this.draining = false;
      this.changed();
    }
  }

  private async runTurn(turn: QueuedTurn): Promise<void> {
    this.processingProvider = turn.provider;
    this.processingStartedAt = Date.now();
    this.changed();
    try {
      const slot = await this.ensureProvider(turn.provider);
      if (!slot.ref) throw new Error(`${turn.provider} failed to start`);

      const released = new Promise<void>((resolve) => {
        // 台账登记必须在 submit 前就位：admission 通过后 adapter 立即经 sink 发
        // user_message/running，事件路由要能按 turnId 命中本 turn。
        this.turns.set(turn.turnId, {
          turnId: turn.turnId,
          role: "driven",
          slot,
          provider: slot.adapter.provider,
          status: "active",
          startedAt: Date.now(),
          turn,
          release: resolve,
        });
        this.activeDrivenTurnId = turn.turnId;
      });
      this.changed();

      const session = this.options.session;
      const key = slot.adapter.provider;
      const meta = session.meta.providerSessions[key];
      const catchUp = buildProviderCatchUpContext(session, {
        provider: key,
        sinceSeq: meta?.syncedSeq ?? 0,
        includeProviderTurns: slot.freshNative,
        budgetChars: this.options.mentionBudgetChars,
      });
      let blocks = turn.blocks;
      // 水位（syncedSeq）只在注入时前进到本批 throughSeq（并发正确性的关键：
      // throughSeq 固定在注入时点，turn 运行期间其它 provider 落盘的事件 seq 必然
      // 大于它，下一次注入自然回补；finalize 推尾水位则会永久越过它们）。
      let prependedCatchUp: typeof catchUp = null;
      if (catchUp) {
        const syncBlock: PromptBlock = {
          type: "text",
          text: `<baton-sync>\n${catchUp.text}\n</baton-sync>`,
        };
        if (isContextSynchronizable(slot.adapter)) {
          await slot.adapter.syncContext(slot.ref, [syncBlock]);
          session.setProviderSession(key, {
            ...meta,
            provider: key,
            providerSessionId: meta?.providerSessionId ?? this.nativeSessionId(slot),
            syncedSeq: catchUp.throughSeq,
          });
          slot.freshNative = false;
        } else {
          // prepend 注入随本 turn 的 submit 送达；水位在 admission 通过后才推进
          blocks = [syncBlock, { type: "text", text: "\n\n" }, ...blocks];
          prependedCatchUp = catchUp;
        }
      }

      // submit 只确认 admission；完成以 finalize 收到 idle 终态为准
      await slot.adapter.submit(slot.ref, {
        turnId: turn.turnId,
        messageId: turn.messageId,
        blocks,
      });
      if (prependedCatchUp) {
        // admission 通过 ⇒ prepend 的 sync 块已进入 provider 输入：视为同步到 throughSeq。
        // admission 失败走 catch 上抛，水位不动，下次重新注入。
        session.setProviderSession(key, {
          ...session.meta.providerSessions[key],
          provider: key,
          providerSessionId:
            session.meta.providerSessions[key]?.providerSessionId ?? this.nativeSessionId(slot),
          syncedSeq: prependedCatchUp.throughSeq,
        });
        slot.freshNative = false;
      }
      await released;
    } catch (error) {
      // admission/启动失败：本 turn 没有（也不会再有）事件流，直接终结记录并上抛
      const record = this.turns.get(turn.turnId);
      if (record) record.status = "finalized";
      if (this.activeDrivenTurnId === turn.turnId) this.activeDrivenTurnId = undefined;
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`BatonSession ${this.options.session.id} · ${turn.provider}: ${detail}`, {
        cause: error,
      });
    } finally {
      this.processingProvider = undefined;
      this.processingStartedAt = undefined;
      this.changed();
    }
  }

  /**
   * 所有 provider 事件的唯一入口：持久化（append 即广播给事件流订阅者，UI 投影
   * 由订阅侧完成，这里不做任何转发）→ 识别 turn 边界并记账。
   * 不变量：任何进入本方法的事件必然对订阅者可见——投影正确性由 append 广播
   * 单通道保证，不依赖"是否有活跃 turn"。
   */
  private onAdapterEvent(slot: ProviderSlot, ev: AnyNewEvent): void {
    const envelope = this.options.session.append(ev) as AnyEventEnvelope;
    if (envelope.kind === "state_update") {
      const p = envelope.payload;
      if (p.state === "running" && p.origin === "provider" && envelope.turnId) {
        // observed turn 开界：登记入台账，不进队列（design §5.10）
        if (!this.turns.has(envelope.turnId)) {
          this.turns.set(envelope.turnId, {
            turnId: envelope.turnId,
            role: "observed",
            slot,
            provider: slot.adapter.provider,
            status: "active",
            startedAt: Date.now(),
          });
        }
      } else if (p.state === "idle") {
        // 终态一律按 baton turn id 查表路由（不看 slot）。无 turnId 的终态：
        // 已持久化留痕，但无法归属任何 turn，不驱动生命周期（adapter 契约要求
        // 终态必带 turnId，由契约测试钉住）。
        if (envelope.turnId) this.finalize(envelope.turnId, p.stopReason);
      }
    }
    this.changed();
  }

  /**
   * 所有 turn 的统一有序 finalize 路径（design §4.1）：终态已持久化 →
   * （driven 被打断时）interrupted notice → 一次 turn summary → 同步元数据 →
   * （driven）释放等待者推进队列。observed 只记账，不碰队列——summary 让 provider
   * 自发产出进入 @ 引用与跨 provider catch-up 的正典历史，否则后台唤醒的结论对
   * 下一棒 provider 是永久盲区。
   * 按 baton turn id 幂等：迟到/重复/未知终态一律 inert，不会关闭更新的 turn。
   */
  private finalize(turnId: string, stopReason: StopReason | undefined): void {
    const record = this.turns.get(turnId);
    if (!record || record.status === "finalized") return;
    record.status = "finalized";
    record.stopReason = stopReason;
    if (record.cancelGraceTimer) clearTimeout(record.cancelGraceTimer);

    const session = this.options.session;

    // 用户打断的 turn 在时间线留下醒目标记；排队的后续输入会自然跟在标记后面
    if (record.role === "driven" && stopReason === "cancelled") {
      session.append({
        kind: "_baton_notice",
        provider: record.provider,
        turnId,
        payload: { level: "warning", title: INTERRUPTED_NOTICE_TITLE },
      });
    }

    session.summarizeTurnEvent(turnId);
    if (record.role === "driven") record.slot.freshNative = false;
    this.backfillProviderSessionId(record.slot);

    if (record.role === "driven") {
      if (this.activeDrivenTurnId === turnId) this.activeDrivenTurnId = undefined;
      record.release?.();
    }
    this.changed();
  }

  /**
   * turn 收界后的元数据回填：原生 session id 首轮结束才拿得到（claude）。
   * 刻意**不**推进 syncedSeq——水位只在注入时前进（见 runTurn）：finalize 推尾水位
   * 会越过并发期间其它 provider 落盘、尚未注入本 provider 的事件，形成永久同步洞。
   */
  private backfillProviderSessionId(slot: ProviderSlot): void {
    const session = this.options.session;
    const key = slot.adapter.provider;
    const existing = session.meta.providerSessions[key];
    const nativeId = this.nativeSessionId(slot) ?? existing?.providerSessionId;
    if (nativeId === existing?.providerSessionId) return; // 无变化不写盘
    session.setProviderSession(key, {
      ...existing,
      provider: key,
      providerSessionId: nativeId,
    });
  }

  /** cancel 宽限期到期 / cancel 请求失败：合成结构化 error + idle，走统一事件管线 */
  private synthesizeTerminal(record: TurnRecord, message: string): void {
    if (record.status === "finalized") return;
    this.onAdapterEvent(record.slot, {
      kind: "_baton_error_update",
      provider: record.provider,
      turnId: record.turnId,
      payload: { message, retryable: false },
    });
    this.onAdapterEvent(record.slot, {
      kind: "state_update",
      provider: record.provider,
      turnId: record.turnId,
      payload: { state: "idle", stopReason: "cancelled" },
    });
  }

  private async ensureProvider(provider: string): Promise<ProviderSlot> {
    let slot = this.slots.get(provider);
    if (!slot) {
      const adapter = this.options.createAdapter(provider, {
        approvalHandler: this.approvalHandler,
        questionHandler: this.questionHandler,
      });
      const created: ProviderSlot = { adapter, freshNative: true };
      slot = created;
      this.slots.set(provider, created);
      created.starting = (async () => {
        const existing = this.options.session.meta.providerSessions[adapter.provider];
        created.ref = await adapter.open(
          {
            cwd: this.options.session.meta.cwd,
            resumeSessionId: existing?.providerSessionId,
          },
          (ev) => this.onAdapterEvent(created, ev),
        );
        created.freshNative = !created.ref.resumed;
        if (existing?.model && isModelConfigurable(adapter)) {
          await adapter.setModel(created.ref, existing.model);
        }
        this.options.session.setProviderSession(adapter.provider, {
          ...existing,
          provider: adapter.provider,
          providerSessionId: this.nativeSessionId(created),
          syncedSeq: created.ref.resumed ? existing?.syncedSeq : 0,
        });
      })();
    }
    if (slot.starting) {
      try {
        await slot.starting;
      } catch (error) {
        this.slots.delete(provider);
        throw error;
      } finally {
        slot.starting = undefined;
        this.changed();
      }
    }
    return slot;
  }

  private nativeSessionId(slot: ProviderSlot): string | undefined {
    if (!slot.ref) return undefined;
    return isNativeSessionIdentifiable(slot.adapter)
      ? slot.adapter.nativeSessionId(slot.ref)
      : slot.ref.providerSessionId;
  }

  private snapshot(turn: QueuedTurn): QueuedTurnSnapshot {
    return { id: turn.id, turnId: turn.turnId, provider: turn.provider, blocks: [...turn.blocks] };
  }

  private changed(): void {
    this.options.onStateChange?.();
  }
}
