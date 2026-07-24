import { newId } from "../event/ids.ts";
import type {
  AnyEventEnvelope,
  EventDraft,
  EventEnvelope,
} from "../event/types.ts";
import type { HarnessLaunchSnapshot } from "../harness/target.ts";

export type DeliveryAttemptPhase =
  | "prepared"
  | "dispatching"
  | "accepted"
  | "uncertain"
  | "finalized";

export type DeliveryAttemptOutcome =
  | "completed"
  | "not_accepted"
  | "failed"
  | "cancelled";

export type HarnessDeliveryAttemptUpdate =
  | {
      attemptId: string;
      phase: "prepared";
      /** 当前 Input 的稳定身份；用户输入阶段就是其 messageId。 */
      inputId: string;
      launchSnapshot: HarnessLaunchSnapshot;
    }
  | {
      attemptId: string;
      phase: "dispatching" | "accepted" | "uncertain";
      detail?: string;
    }
  | {
      attemptId: string;
      phase: "finalized";
      outcome: DeliveryAttemptOutcome;
      detail?: string;
    };

export interface HarnessDeliveryAttemptState {
  attemptId: string;
  inputId: string;
  launchSnapshot: HarnessLaunchSnapshot;
  turnId: string;
  harness?: string;
  harnessTargetId: string;
  harnessSessionId?: string;
  phase: DeliveryAttemptPhase;
  /** 曾收到 admission Receipt；进入 uncertain 不抹掉这条已经发生的事实。 */
  accepted: boolean;
  outcome?: DeliveryAttemptOutcome;
  detail?: string;
  /** prepared Event 的固定序号；恢复查 Receipt 不能用随后不断前移的 lastSeq。 */
  preparedSeq: number;
  lastEventId: string;
  lastSeq: number;
}

export function deliveryOutcomeFromStopReason(
  stopReason: string | undefined,
): DeliveryAttemptOutcome {
  if (stopReason === "cancelled") return "cancelled";
  if (stopReason === "error" || stopReason === "failed") return "failed";
  return "completed";
}

/**
 * Harness Delivery Attempt 的内存索引与重放器。事实先进入 session ledger，再 apply；
 * Controller 不能只改这份索引，否则 crash recovery 看不到相同状态。
 */
export class DeliveryAttemptLedger {
  private readonly attempts = new Map<string, HarnessDeliveryAttemptState>();
  private readonly latestByTurn = new Map<string, string>();

  constructor(events: Iterable<AnyEventEnvelope> = []) {
    for (const event of events) this.apply(event);
  }

  values(): IterableIterator<HarnessDeliveryAttemptState> {
    return this.attempts.values();
  }

  get(attemptId: string): HarnessDeliveryAttemptState | undefined {
    return this.attempts.get(attemptId);
  }

  forTurn(turnId: string): HarnessDeliveryAttemptState | undefined {
    const attemptId = this.latestByTurn.get(turnId);
    return attemptId ? this.attempts.get(attemptId) : undefined;
  }

  apply(event: AnyEventEnvelope): HarnessDeliveryAttemptState | undefined {
    if (event.kind !== "_baton_delivery_attempt_update") return undefined;
    const update = event.payload;
    const existing = this.attempts.get(update.attemptId);

    if (update.phase === "prepared") {
      if (existing) return existing;
      if (!event.turnId || !event.harnessTargetId) {
        throw new Error(
          `delivery attempt ${update.attemptId} prepared without turnId or harnessTargetId`,
        );
      }
      const state: HarnessDeliveryAttemptState = {
        attemptId: update.attemptId,
        inputId: update.inputId,
        launchSnapshot: update.launchSnapshot,
        turnId: event.turnId,
        harness: event.harness,
        harnessTargetId: event.harnessTargetId,
        harnessSessionId: event.harnessSessionId,
        phase: "prepared",
        accepted: false,
        preparedSeq: event.seq,
        lastEventId: event.eventId,
        lastSeq: event.seq,
      };
      this.attempts.set(state.attemptId, state);
      this.latestByTurn.set(state.turnId, state.attemptId);
      return state;
    }

    if (!existing) {
      throw new Error(
        `delivery attempt ${update.attemptId} entered ${update.phase} before prepared`,
      );
    }
    if (existing.phase === "finalized") return existing;
    if (!canTransition(existing.phase, update.phase)) {
      throw new Error(
        `invalid delivery attempt transition ${existing.attemptId}: ${existing.phase} -> ${update.phase}`,
      );
    }

    existing.phase = update.phase;
    if (update.phase === "accepted") existing.accepted = true;
    existing.lastEventId = event.eventId;
    existing.lastSeq = event.seq;
    existing.detail = update.detail;
    if (event.harnessSessionId) existing.harnessSessionId = event.harnessSessionId;
    if (update.phase === "finalized") existing.outcome = update.outcome;
    return existing;
  }
}

export function reduceDeliveryAttempts(
  events: Iterable<AnyEventEnvelope>,
): DeliveryAttemptLedger {
  return new DeliveryAttemptLedger(events);
}

function canTransition(
  from: DeliveryAttemptPhase,
  to: Exclude<DeliveryAttemptPhase, "prepared">,
): boolean {
  switch (from) {
    case "prepared":
      return to === "dispatching" || to === "finalized";
    case "dispatching":
      return to === "accepted" || to === "uncertain" || to === "finalized";
    case "accepted":
      return to === "uncertain" || to === "finalized";
    case "uncertain":
      return to === "accepted" || to === "finalized";
    case "finalized":
      return false;
  }
}

type AttemptDraft = EventDraft<"_baton_delivery_attempt_update"> & {
  /** recovery 没有 live HarnessBinding，需沿用 prepared 时已持久化的执行归属。 */
  harness?: string;
  harnessTargetId?: string;
};
type AttemptEnvelope = EventEnvelope<"_baton_delivery_attempt_update">;

export type DeliveryAttemptAppender<TContext> = (
  context: TContext,
  draft: AttemptDraft,
) => AttemptEnvelope;

/**
 * Controller 域内的 Harness submit Attempt owner。所有 live 与 recovery 迁移都经
 * 同一个入口，且总是先写 session ledger、再更新内存索引。
 */
export class DeliveryAttempts<TContext> {
  private readonly ledger: DeliveryAttemptLedger;

  constructor(
    private readonly append: DeliveryAttemptAppender<TContext>,
    events: Iterable<AnyEventEnvelope> = [],
  ) {
    this.ledger = reduceDeliveryAttempts(events);
  }

  values(): IterableIterator<HarnessDeliveryAttemptState> {
    return this.ledger.values();
  }

  get(attemptId: string): HarnessDeliveryAttemptState | undefined {
    return this.ledger.get(attemptId);
  }

  forTurn(turnId: string): HarnessDeliveryAttemptState | undefined {
    return this.ledger.forTurn(turnId);
  }

  prepare(
    context: TContext,
    opts: {
      turnId: string;
      inputEventId?: string;
      inputId: string;
      launchSnapshot: HarnessLaunchSnapshot;
      harnessSessionId?: string;
    },
  ): HarnessDeliveryAttemptState {
    const attemptId = newId("att");
    this.record(context, {
      kind: "_baton_delivery_attempt_update",
      parentEventId: opts.inputEventId,
      harnessSessionId: opts.harnessSessionId,
      turnId: opts.turnId,
      payload: {
        attemptId,
        phase: "prepared",
        inputId: opts.inputId,
        launchSnapshot: opts.launchSnapshot,
      },
    });
    return this.ledger.get(attemptId) as HarnessDeliveryAttemptState;
  }

  markDispatching(context: TContext, attempt: HarnessDeliveryAttemptState): void {
    this.update(context, attempt, {
      attemptId: attempt.attemptId,
      phase: "dispatching",
    });
  }

  markAccepted(context: TContext, attempt: HarnessDeliveryAttemptState): void {
    if (attempt.phase === "finalized" || attempt.phase === "uncertain") return;
    this.update(context, attempt, {
      attemptId: attempt.attemptId,
      phase: "accepted",
    });
  }

  markUncertain(
    context: TContext,
    attempt: HarnessDeliveryAttemptState,
    detail: string,
    parentEventId?: string,
  ): void {
    if (attempt.phase === "finalized" || attempt.phase === "uncertain") return;
    this.update(
      context,
      attempt,
      { attemptId: attempt.attemptId, phase: "uncertain", detail },
      parentEventId,
    );
  }

  finalize(
    context: TContext,
    attempt: HarnessDeliveryAttemptState,
    outcome: DeliveryAttemptOutcome,
    opts: {
      detail?: string;
      parentEventId?: string;
      harnessSessionId?: string;
    } = {},
  ): void {
    if (attempt.phase === "finalized") return;
    this.update(
      context,
      attempt,
      {
        attemptId: attempt.attemptId,
        phase: "finalized",
        outcome,
        ...(opts.detail ? { detail: opts.detail } : {}),
      },
      opts.parentEventId,
      opts.harnessSessionId,
    );
  }

  /**
   * Harness idle 是执行 owner 的终态 Receipt；Baton 合成 idle 只能结束本地 Turn，
   * 不能冒充远端已停止，已 dispatch 的 Attempt 因此转 uncertain 等待对账。
   */
  observeTerminal(
    context: TContext,
    terminal: EventEnvelope<"state_update">,
  ): void {
    const turnId = terminal.turnId;
    if (!turnId) return;
    const attempt = this.ledger.forTurn(turnId);
    if (!attempt || attempt.phase === "finalized") return;

    if (terminal.source.type !== "harness") {
      if (attempt.phase === "prepared") {
        this.finalize(context, attempt, "not_accepted", {
          parentEventId: terminal.eventId,
        });
      } else {
        this.markUncertain(
          context,
          attempt,
          `Baton finalized turn without a Harness terminal receipt (${terminal.payload.stopReason ?? "unknown"})`,
          terminal.eventId,
        );
      }
      return;
    }

    // 极快的 Harness 可能在 submit Promise continuation 之前报告 idle；终态本身足以证明
    // admission。uncertain 若已有 accepted Receipt，则不重复写 accepted。
    if (
      attempt.phase === "dispatching" ||
      (attempt.phase === "uncertain" && !attempt.accepted)
    ) {
      this.update(
        context,
        attempt,
        { attemptId: attempt.attemptId, phase: "accepted" },
        terminal.eventId,
        terminal.harnessSessionId,
      );
    }
    this.finalize(
      context,
      attempt,
      deliveryOutcomeFromStopReason(terminal.payload.stopReason),
      {
        parentEventId: terminal.eventId,
        harnessSessionId: terminal.harnessSessionId,
      },
    );
  }

  private update(
    context: TContext,
    attempt: HarnessDeliveryAttemptState,
    update: HarnessDeliveryAttemptUpdate,
    parentEventId: string = attempt.lastEventId,
    harnessSessionId: string | undefined = attempt.harnessSessionId,
  ): void {
    this.record(context, {
      kind: "_baton_delivery_attempt_update",
      parentEventId,
      harness: attempt.harness,
      harnessTargetId: attempt.harnessTargetId,
      harnessSessionId,
      turnId: attempt.turnId,
      payload: update,
    });
  }

  private record(context: TContext, draft: AttemptDraft): void {
    this.ledger.apply(this.append(context, draft));
  }
}
