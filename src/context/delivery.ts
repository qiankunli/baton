import { newId } from "../event/ids.ts";
import type {
  AnyEventEnvelope,
  EventDraft,
  EventEnvelope,
} from "../event/types.ts";

/**
 * ContextSource 先只承载已经被两种内置 Harness 共同使用的 BatonSession 历史。
 * 后续 Board / Plugin / Resource 各自增加 kind，不为第一种来源预造 registry。
 */
export type ContextSource = {
  kind: "session_history";
  /** owner 内稳定；同一 BatonSession 的正典历史始终使用这个 key。 */
  key: "history";
  owner: { type: "baton_session"; batonSessionId: string };
};

export function sessionHistoryContextSource(batonSessionId: string): ContextSource {
  return {
    kind: "session_history",
    key: "history",
    owner: { type: "baton_session", batonSessionId },
  };
}

/** 一次实际组装出的 source 内容；范围是 `(afterSeq, throughSeq]`。 */
export interface ContextSnapshot {
  snapshotId: string;
  source: ContextSource;
  afterSeq: number;
  throughSeq: number;
  text: string;
}

export type ContextDeliveryTransport =
  | "sync_context"
  | "submit_side_channel"
  | "prompt_prepend";

/**
 * accepted 只表示对应 transport 已接受这份 snapshot，不声称 model 已读取或采用。
 * 目标 Harness / Target / Session 和当前 Turn 使用 Event envelope 的执行坐标。
 */
export interface ContextDeliveryReceipt {
  snapshotId: string;
  contextEpochId: string;
  transport: ContextDeliveryTransport;
  accepted: true;
}

/** ContextEpoch 不单独落可变快照；它由同一 epoch 的 DeliveryReceipt 重放得到。 */
export interface ContextEpoch {
  contextEpochId: string;
  throughSeq: number;
  snapshotId: string;
  receiptEventId: string;
}

export type ContextSnapshotEnvelope = EventEnvelope<"_baton_context_snapshot">;
type ReceiptEnvelope = EventEnvelope<"_baton_context_delivery_receipt">;
type ContextDeliveryDraft =
  | EventDraft<"_baton_context_snapshot">
  | EventDraft<"_baton_context_delivery_receipt">;
type ContextDeliveryEnvelope = ContextSnapshotEnvelope | ReceiptEnvelope;

/**
 * Context delivery 的重放索引。Snapshot 说明“准备送什么”，Receipt 才能推进
 * HarnessSession 的 ContextEpoch；只有 snapshot、没有 receipt 时，下次仍会重投。
 */
export class ContextDeliveryLedger {
  private readonly snapshots = new Map<string, ContextSnapshotEnvelope>();
  private readonly epochs = new Map<string, ContextEpoch>();

  constructor(events: Iterable<AnyEventEnvelope> = []) {
    for (const event of events) this.apply(event);
  }

  snapshot(snapshotId: string): ContextSnapshotEnvelope | undefined {
    return this.snapshots.get(snapshotId);
  }

  epoch(contextEpochId: string): ContextEpoch | undefined {
    return this.epochs.get(contextEpochId);
  }

  apply(event: AnyEventEnvelope): ContextDeliveryEnvelope | undefined {
    if (event.kind === "_baton_context_snapshot") {
      const snapshot = event.payload;
      if (snapshot.afterSeq > snapshot.throughSeq) {
        throw new Error(
          `context snapshot ${snapshot.snapshotId} has invalid range ${snapshot.afterSeq}..${snapshot.throughSeq}`,
        );
      }
      // fork 会把同一段历史事实复制到 child ledger，但 source owner 仍是当时实际组装
      // snapshot 的 BatonSession；不能用当前 event scope 覆写或拒绝这段 provenance。
      if (!this.snapshots.has(snapshot.snapshotId)) {
        this.snapshots.set(snapshot.snapshotId, event);
      }
      return event;
    }

    if (event.kind !== "_baton_context_delivery_receipt") return undefined;
    const receipt = event.payload;
    const snapshot = this.snapshots.get(receipt.snapshotId);
    if (!snapshot) {
      throw new Error(
        `context receipt for ${receipt.snapshotId} appeared before its snapshot`,
      );
    }
    const current = this.epochs.get(receipt.contextEpochId);
    if (!current || snapshot.payload.throughSeq >= current.throughSeq) {
      this.epochs.set(receipt.contextEpochId, {
        contextEpochId: receipt.contextEpochId,
        throughSeq: snapshot.payload.throughSeq,
        snapshotId: receipt.snapshotId,
        receiptEventId: event.eventId,
      });
    }
    return event;
  }
}

export type ContextDeliveryAppender<TContext> = (
  context: TContext,
  draft: ContextDeliveryDraft,
) => AnyEventEnvelope;

/** Controller 使用的持久化入口：总是先 append 正典事件，再更新内存重放索引。 */
export class ContextDeliveries<TContext> {
  private readonly ledger: ContextDeliveryLedger;

  constructor(
    private readonly append: ContextDeliveryAppender<TContext>,
    events: Iterable<AnyEventEnvelope> = [],
  ) {
    this.ledger = new ContextDeliveryLedger(events);
  }

  epoch(contextEpochId: string): ContextEpoch | undefined {
    return this.ledger.epoch(contextEpochId);
  }

  prepare(
    context: TContext,
    opts: {
      turnId: string;
      harnessSessionId?: string;
      source: ContextSource;
      afterSeq: number;
      throughSeq: number;
      text: string;
    },
  ): ContextSnapshotEnvelope {
    const event = this.append(context, {
      kind: "_baton_context_snapshot",
      harnessSessionId: opts.harnessSessionId,
      turnId: opts.turnId,
      payload: {
        snapshotId: newId("ctx"),
        source: opts.source,
        afterSeq: opts.afterSeq,
        throughSeq: opts.throughSeq,
        text: opts.text,
      },
    }) as ContextSnapshotEnvelope;
    this.ledger.apply(event);
    return event;
  }

  accept(
    context: TContext,
    snapshot: ContextSnapshotEnvelope,
    opts: {
      contextEpochId: string;
      harnessSessionId?: string;
      transport: ContextDeliveryTransport;
    },
  ): ReceiptEnvelope {
    const event = this.append(context, {
      kind: "_baton_context_delivery_receipt",
      parentEventId: snapshot.eventId,
      harnessSessionId: opts.harnessSessionId,
      turnId: snapshot.turnId,
      payload: {
        snapshotId: snapshot.payload.snapshotId,
        contextEpochId: opts.contextEpochId,
        transport: opts.transport,
        accepted: true,
      },
    }) as ReceiptEnvelope;
    this.ledger.apply(event);
    return event;
  }
}
