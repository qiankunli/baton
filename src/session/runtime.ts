import {
  isContextSynchronizable,
  isModelConfigurable,
  isNativeSessionIdentifiable,
  type AgentAdapter,
  type ModelOption,
  type ProviderSessionRef,
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
  onEvent?: (event: AnyEventEnvelope) => void;
  resolve: (outcome: SubmitOutcome) => void;
  reject: (error: unknown) => void;
}

/** 正在执行（已被 drain 取走）的 turn；finalized 保证逻辑终结每 turn 只发生一次 */
interface ActiveTurn {
  turn: QueuedTurn;
  slot: ProviderSlot;
  finalized: boolean;
  /** finalize 时 resolve，释放 drain 循环推进队列 */
  release: () => void;
  cancelGraceTimer?: ReturnType<typeof setTimeout>;
}

export interface QueuedTurnSnapshot {
  id: number;
  turnId: string;
  provider: string;
  blocks: PromptBlock[];
}

export type SubmitOutcome = "completed" | "recalled";

export interface BatonSessionRuntimeOptions {
  session: SessionHandle;
  mentionBudgetChars: number;
  createAdapter(provider: string): AgentAdapter;
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
 * UI 只提交意图和消费事件，不能分别维护各 provider 的并发状态。
 *
 * 生命周期由 state event 驱动（design §4.1）：adapter.submit 只确认接收，turn 的
 * 完成以 `state_update(idle)` 为准，经 finalizeTurn 按 baton turn id 幂等收口——
 * 重复/迟到的物理终态（reconnect、transport race）不会二次终结，也不会关闭更新的 turn。
 */
export class BatonSessionRuntime {
  private readonly slots = new Map<string, ProviderSlot>();
  private readonly queue: QueuedTurn[] = [];
  private nextQueueId = 1;
  private draining = false;
  private processingProvider?: string;
  private processingStartedAt?: number;
  private active?: ActiveTurn;

  constructor(private readonly options: BatonSessionRuntimeOptions) {}

  get activeProvider(): string | undefined {
    return this.processingProvider;
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

  submit(
    provider: string,
    blocks: PromptBlock[],
    onEvent?: (event: AnyEventEnvelope) => void,
  ): Promise<SubmitOutcome> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        id: this.nextQueueId++,
        turnId: newId("t"),
        messageId: newId("m"),
        provider,
        blocks,
        onEvent,
        resolve,
        reject,
      });
      this.changed();
      void this.drain();
    });
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
    const active = this.active;
    if (!active?.slot.ref || active.finalized) return;
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
        // active 必须在 submit 前就位：admission 通过后 adapter 立即经 sink 发
        // user_message/running，事件路由要能命中本 turn。
        this.active = { turn, slot, finalized: false, release: resolve };
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
          blocks = [syncBlock, { type: "text", text: "\n\n" }, ...blocks];
        }
      }

      // submit 只确认 admission；完成以 finalizeTurn 收到 idle 终态为准
      await slot.adapter.submit(slot.ref, {
        turnId: turn.turnId,
        messageId: turn.messageId,
        blocks,
      });
      await released;
    } catch (error) {
      // admission/启动失败：本 turn 没有（也不会再有）事件流，直接清理并上抛
      this.active = undefined;
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

  /** 所有 provider 事件的唯一入口：持久化 → 转发消费者 → 识别终态并 finalize */
  private onAdapterEvent(slot: ProviderSlot, ev: AnyNewEvent): void {
    const envelope = this.options.session.append(ev) as AnyEventEnvelope;
    const active = this.active;
    if (active && active.slot === slot && !active.finalized) {
      active.turn.onEvent?.(envelope);
      if (envelope.kind === "state_update" && envelope.payload.state === "idle") {
        this.finalizeTurn(envelope.turnId, envelope.payload.stopReason);
      }
    }
    // 无活跃 turn（provider 主动事件）或迟到/重复终态：已持久化，不驱动队列
    this.changed();
  }

  /**
   * 统一的有序 finalize 路径（design §4.1）：终态已持久化 → interrupted notice →
   * 一次 turn summary → 同步元数据 → 释放等待者推进队列。按 baton turn id 幂等：
   * 迟到/重复终态、或不属于当前 active turn 的终态一律忽略。
   */
  private finalizeTurn(turnId: string | undefined, stopReason: StopReason | undefined): void {
    const active = this.active;
    if (!active || active.finalized) return;
    if (turnId !== active.turn.turnId) return; // 迟到终态不能关闭更新的 active turn
    active.finalized = true;
    if (active.cancelGraceTimer) clearTimeout(active.cancelGraceTimer);

    const session = this.options.session;
    const slot = active.slot;
    const key = slot.adapter.provider;

    // 用户打断的 turn 在时间线留下醒目标记；排队的后续输入会自然跟在标记后面
    if (stopReason === "cancelled") {
      const notice = session.append({
        kind: "_baton_notice",
        provider: key,
        turnId: active.turn.turnId,
        payload: { level: "warning", title: INTERRUPTED_NOTICE_TITLE },
      }) as AnyEventEnvelope;
      active.turn.onEvent?.(notice);
    }

    const summaryEvent = session.summarizeTurnEvent(active.turn.turnId);
    active.turn.onEvent?.(summaryEvent);

    slot.freshNative = false;
    session.setProviderSession(key, {
      ...session.meta.providerSessions[key],
      provider: key,
      providerSessionId: this.nativeSessionId(slot) ?? session.meta.providerSessions[key]?.providerSessionId,
      syncedSeq: session.readEvents().at(-1)?.seq,
    });

    this.active = undefined;
    active.release();
    this.changed();
  }

  /** cancel 宽限期到期 / cancel 请求失败：合成结构化 error + idle，走统一事件管线 */
  private synthesizeTerminal(active: ActiveTurn, message: string): void {
    if (this.active !== active || active.finalized) return;
    const provider = active.slot.adapter.provider;
    this.onAdapterEvent(active.slot, {
      kind: "_baton_error_update",
      provider,
      turnId: active.turn.turnId,
      payload: { message, retryable: false },
    });
    this.onAdapterEvent(active.slot, {
      kind: "state_update",
      provider,
      turnId: active.turn.turnId,
      payload: { state: "idle", stopReason: "cancelled" },
    });
  }

  private async ensureProvider(provider: string): Promise<ProviderSlot> {
    let slot = this.slots.get(provider);
    if (!slot) {
      const adapter = this.options.createAdapter(provider);
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
