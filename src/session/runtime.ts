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
import type { AnyEventEnvelope, ContentBlock } from "../events/types.ts";
import type { SessionHandle } from "../store/store.ts";

interface ProviderSlot {
  adapter: AgentAdapter;
  ref?: ProviderSessionRef;
  starting?: Promise<void>;
  freshNative: boolean;
}

interface QueuedTurn {
  id: number;
  provider: string;
  blocks: ContentBlock[];
  onEvent?: (event: AnyEventEnvelope) => void;
  resolve: (outcome: SubmitOutcome) => void;
  reject: (error: unknown) => void;
}

export interface QueuedTurnSnapshot {
  id: number;
  provider: string;
  blocks: ContentBlock[];
}

export type SubmitOutcome = "completed" | "recalled";

export interface BatonSessionRuntimeOptions {
  session: SessionHandle;
  mentionBudgetChars: number;
  createAdapter(provider: string): AgentAdapter;
  providerSessionKey?(provider: string): string;
  onStateChange?: () => void;
}

/**
 * 一个 BatonSession 的唯一 turn 编排入口：统一负责 provider 恢复、上下文追平与全局串行。
 * UI 只提交意图和消费事件，不能分别维护各 provider 的并发状态。
 */
export class BatonSessionRuntime {
  private readonly slots = new Map<string, ProviderSlot>();
  private readonly queue: QueuedTurn[] = [];
  private nextQueueId = 1;
  private draining = false;
  private processingProvider?: string;
  private active?: { provider: string; slot: ProviderSlot };

  constructor(private readonly options: BatonSessionRuntimeOptions) {}

  get activeProvider(): string | undefined {
    return this.processingProvider;
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
    blocks: ContentBlock[],
    onEvent?: (event: AnyEventEnvelope) => void,
  ): Promise<SubmitOutcome> {
    return new Promise((resolve, reject) => {
      this.queue.push({ id: this.nextQueueId++, provider, blocks, onEvent, resolve, reject });
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

  async cancelActive(): Promise<void> {
    const active = this.active;
    if (active?.slot.ref) await active.slot.adapter.cancel(active.slot.ref);
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
    this.changed();
    try {
      const slot = await this.ensureProvider(turn.provider);
      if (!slot.ref) throw new Error(`${turn.provider} failed to start`);
      this.active = { provider: turn.provider, slot };
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
        const syncBlock: ContentBlock = {
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

      const turnId = newId("t");
      await slot.adapter.prompt(
        slot.ref,
        blocks,
        (event) => {
          const envelope = session.append(event) as AnyEventEnvelope;
          turn.onEvent?.(envelope);
        },
        { turnId },
      );
      const summaryEvent = session.summarizeTurnEvent(turnId);
      turn.onEvent?.(summaryEvent);
      slot.freshNative = false;
      session.setProviderSession(key, {
        ...session.meta.providerSessions[key],
        provider: key,
        providerSessionId: this.nativeSessionId(slot),
        syncedSeq: session.readEvents().at(-1)?.seq,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`BatonSession ${this.options.session.id} · ${turn.provider}: ${detail}`, {
        cause: error,
      });
    } finally {
      const slot = this.active?.slot;
      const nativeId = slot ? this.nativeSessionId(slot) : undefined;
      if (slot && nativeId) {
        const key = slot.adapter.provider;
        this.options.session.setProviderSession(key, {
          ...this.options.session.meta.providerSessions[key],
          provider: key,
          providerSessionId: nativeId,
        });
      }
      this.active = undefined;
      this.processingProvider = undefined;
      this.changed();
    }
  }

  private async ensureProvider(provider: string): Promise<ProviderSlot> {
    let slot = this.slots.get(provider);
    if (!slot) {
      const adapter = this.options.createAdapter(provider);
      slot = { adapter, freshNative: true };
      this.slots.set(provider, slot);
      slot.starting = (async () => {
        const existing = this.options.session.meta.providerSessions[adapter.provider];
        slot!.ref = await adapter.start({
          cwd: this.options.session.meta.cwd,
          resumeSessionId: existing?.providerSessionId,
        });
        slot!.freshNative = !slot!.ref.resumed;
        if (existing?.model && isModelConfigurable(adapter)) {
          await adapter.setModel(slot!.ref, existing.model);
        }
        this.options.session.setProviderSession(adapter.provider, {
          ...existing,
          provider: adapter.provider,
          providerSessionId: this.nativeSessionId(slot!),
          syncedSeq: slot!.ref.resumed ? existing?.syncedSeq : 0,
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
    return { id: turn.id, provider: turn.provider, blocks: [...turn.blocks] };
  }

  private changed(): void {
    this.options.onStateChange?.();
  }
}
