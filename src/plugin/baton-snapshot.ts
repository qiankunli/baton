import type { InputSnapshot } from "../controller/input.ts";
import type { TurnSummary } from "../event/types.ts";
import type { HarnessTarget } from "../harness/target.ts";
import type {
  Interaction,
  InteractionRequester,
} from "../interaction/types.ts";
import type { SessionState } from "../store/reduce.ts";

type SnapshotReadonly<T> =
  T extends (...args: never[]) => unknown
    ? T
    : T extends readonly (infer Item)[]
      ? readonly SnapshotReadonly<Item>[]
      : T extends object
        ? { readonly [Key in keyof T]: SnapshotReadonly<T[Key]> }
        : T;

export interface BatonSessionSnapshot {
  readonly batonSessionId: string;
  readonly cwd?: string;
  readonly runState: SessionState["runState"];
  /** Event Ledger 当前水位。 */
  readonly revision: number;
}

export interface BatonActiveTurnSnapshot {
  readonly turnId: string;
  readonly role: "driven" | "observed";
  readonly state: "running" | "requires_action";
  readonly harness?: string;
  readonly harnessTargetId?: string;
  readonly startedAt?: number;
}

export interface BatonInputSnapshot {
  readonly messageId: string;
  readonly turnId: string;
  readonly harnessTargetId: string;
  readonly harness: string;
  readonly status: InputSnapshot["status"];
  readonly delivery: InputSnapshot["delivery"];
}

export interface BatonHarnessTargetSnapshot {
  readonly id: string;
  readonly harness: string;
  readonly label?: string;
}

export interface BatonPendingInteractionSnapshot {
  readonly interactionId: string;
  readonly kind: Interaction["kind"];
  readonly requester: SnapshotReadonly<InteractionRequester>;
  readonly turnId?: string;
}

/**
 * Plugin reconcile 开始时冻结的 BatonSession 只读视图。
 *
 * Snapshot 只暴露 Plugin 做当前决策所需的稳定投影；内部 Controller、Store、HarnessBinding
 * 和其他可变 owner 不穿透这条边界。
 */
export interface BatonSnapshot {
  readonly session: BatonSessionSnapshot;
  readonly activeTurns: readonly BatonActiveTurnSnapshot[];
  readonly inputs: readonly BatonInputSnapshot[];
  readonly harnessTargets: readonly BatonHarnessTargetSnapshot[];
  readonly pendingInteractions: readonly BatonPendingInteractionSnapshot[];
  readonly latestTurn?: SnapshotReadonly<TurnSummary>;
}

interface CreateBatonSnapshotOptions {
  readonly batonSessionId: string;
  readonly cwd?: string;
  readonly state: Pick<
    SessionState,
    "runState" | "lastSeq" | "activeTurns" | "interactions" | "turnSummaries"
  >;
  readonly inputs?: readonly InputSnapshot[];
  readonly harnessTargets?: readonly (HarnessTarget & { readonly label?: string })[];
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/** Host-side projector; Plugin packages only consume the resulting BatonSnapshot type. */
export function createBatonSnapshot(options: CreateBatonSnapshotOptions): BatonSnapshot {
  const latestTurn = options.state.turnSummaries.at(-1);
  return deepFreeze({
    session: {
      batonSessionId: options.batonSessionId,
      ...(options.cwd === undefined ? {} : { cwd: options.cwd }),
      runState: options.state.runState,
      revision: options.state.lastSeq,
    },
    activeTurns: [...options.state.activeTurns.values()].map((turn) => ({
      turnId: turn.turnId,
      role: turn.role,
      state: turn.state,
      ...(turn.harness === undefined ? {} : { harness: turn.harness }),
      ...(turn.harnessTargetId === undefined
        ? {}
        : { harnessTargetId: turn.harnessTargetId }),
      ...(turn.startedAt === undefined ? {} : { startedAt: turn.startedAt }),
    })),
    inputs: (options.inputs ?? []).map((input) => ({ ...input })),
    harnessTargets: (options.harnessTargets ?? []).map((target) => ({
      id: target.id,
      harness: target.harness,
      ...(target.label === undefined ? {} : { label: target.label }),
    })),
    pendingInteractions: [...options.state.interactions.values()]
      .filter((entry) => entry.resolution === undefined)
      .map((entry) => ({
        interactionId: entry.interaction.interactionId,
        kind: entry.interaction.kind,
        requester: { ...entry.interaction.requester },
        ...(entry.turnId === undefined ? {} : { turnId: entry.turnId }),
      })),
    ...(latestTurn === undefined
      ? {}
      : {
          latestTurn: {
            ...latestTurn,
            toolCalls: latestTurn.toolCalls.map((toolCall) => ({ ...toolCall })),
            ...(latestTurn.usage === undefined ? {} : { usage: { ...latestTurn.usage } }),
          },
        }),
  });
}

export function emptyBatonSnapshot(batonSessionId: string): BatonSnapshot {
  return deepFreeze({
    session: {
      batonSessionId,
      runState: "idle",
      revision: 0,
    },
    activeTurns: [],
    inputs: [],
    harnessTargets: [],
    pendingInteractions: [],
  });
}
