import type {
  AnyEventEnvelope,
  EventEnvelope,
  TurnSummary,
} from "../event/types.ts";
import type { SessionHandle } from "../store/store.ts";
import {
  type BuiltinResourceReconcileProposal,
  type ReconcileKey,
  type ReconcileResult,
  type ReconcileScope,
  type ScheduledReconcile,
} from "./controller.ts";
import { ReconcileQueue } from "./queue.ts";
import { reconcileResourceOwner } from "./reconcile-scope.ts";

export const BATON_TURN_RESOURCE_KIND = "baton.turn" as const;

export type DeepReadonly<T> =
  T extends (...args: never[]) => unknown
    ? T
    : T extends readonly (infer Item)[]
      ? readonly DeepReadonly<Item>[]
      : T extends object
        ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> }
        : T;

export type BatonTurnResourceData = DeepReadonly<TurnSummary> & {
  readonly harness?: string;
  readonly harnessTargetId?: string;
  readonly harnessSessionId?: string;
};

export interface BuiltinResourceDataMap {
  [BATON_TURN_RESOURCE_KIND]: BatonTurnResourceData;
}

export type BuiltinResourceKind = keyof BuiltinResourceDataMap;

export interface BuiltinResourceMetadata {
  readonly batonSessionId: string;
  readonly resourceId: string;
  /** 产生当前投影的 ledger seq；Builtin Resource 自身不另设持久真相。 */
  readonly revision: number;
  readonly sourceEventId: string;
  readonly observedAt: string;
}

export interface BuiltinResource<K extends BuiltinResourceKind = BuiltinResourceKind> {
  readonly kind: K;
  readonly metadata: BuiltinResourceMetadata;
  readonly data: BuiltinResourceDataMap[K];
}

export type AnyBuiltinResource = {
  [K in BuiltinResourceKind]: BuiltinResource<K>;
}[BuiltinResourceKind];

export interface BuiltinReconcileContext<K extends BuiltinResourceKind> {
  readonly resource: Readonly<BuiltinResource<K>>;
}

export interface BuiltinReconciler<K extends BuiltinResourceKind> {
  reconcile(
    context: BuiltinReconcileContext<K>,
  ): Promise<ReconcileResult | void>;
}

type BuiltinSession = Pick<
  SessionHandle,
  "id" | "dir" | "readEvents" | "subscribe"
>;

export interface BuiltinResourceProjectionOptions {
  session: BuiltinSession;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function turnResource(
  event: EventEnvelope<"_baton_turn_summary">,
): BuiltinResource<typeof BATON_TURN_RESOURCE_KIND> {
  return deepFreeze({
    kind: BATON_TURN_RESOURCE_KIND,
    metadata: {
      batonSessionId: event.scope.batonSessionId,
      resourceId: event.payload.turnId,
      revision: event.seq,
      sourceEventId: event.eventId,
      observedAt: event.ts,
    },
    data: {
      ...event.payload,
      ...(event.harness === undefined ? {} : { harness: event.harness }),
      ...(event.harnessTargetId === undefined
        ? {}
        : { harnessTargetId: event.harnessTargetId }),
      ...(event.harnessSessionId === undefined
        ? {}
        : { harnessSessionId: event.harnessSessionId }),
    },
  });
}

/**
 * Event Ledger 的只读、level-based Plugin 投影。它不创建第二份事实，也不提供 patch API。
 */
export class BuiltinResourceProjection {
  readonly batonSessionId: string;
  readonly session: Readonly<Pick<SessionHandle, "id" | "dir">>;
  private readonly turns = new Map<
    string,
    BuiltinResource<typeof BATON_TURN_RESOURCE_KIND>
  >();
  private readonly listeners = new Set<(resource: AnyBuiltinResource) => void>();
  private readonly unsubscribeSession: () => void;
  private closed = false;

  constructor(options: BuiltinResourceProjectionOptions) {
    this.batonSessionId = options.session.id;
    this.session = Object.freeze({
      id: options.session.id,
      dir: options.session.dir,
    });
    for (const event of options.session.readEvents()) this.project(event, false);
    this.unsubscribeSession = options.session.subscribe((event) => {
      this.project(event, true);
    });
  }

  get<K extends BuiltinResourceKind>(
    kind: K,
    resourceId: string,
  ): BuiltinResource<K> {
    this.assertKind(kind);
    const resource = this.turns.get(resourceId);
    if (!resource) {
      throw new Error(`builtin resource not found: ${kind}/${resourceId}`);
    }
    return resource as BuiltinResource<K>;
  }

  list<K extends BuiltinResourceKind>(kind: K): BuiltinResource<K>[] {
    this.assertKind(kind);
    return [...this.turns.values()]
      .sort((left, right) => left.metadata.revision - right.metadata.revision)
      .map((resource) => resource as BuiltinResource<K>);
  }

  subscribe(listener: (resource: AnyBuiltinResource) => void): () => void {
    if (this.closed) throw new Error("builtin resource projection is closed");
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.unsubscribeSession();
    this.listeners.clear();
  }

  private project(event: AnyEventEnvelope, notify: boolean): void {
    if (event.kind !== "_baton_turn_summary") return;
    const resource = turnResource(event);
    const current = this.turns.get(resource.metadata.resourceId);
    if (current && current.metadata.revision >= resource.metadata.revision) return;
    this.turns.set(resource.metadata.resourceId, resource);
    if (!notify || this.closed) return;
    for (const listener of this.listeners) listener(resource);
  }

  private assertKind(kind: string): asserts kind is BuiltinResourceKind {
    if (kind !== BATON_TURN_RESOURCE_KIND) {
      throw new Error(`unsupported builtin resource kind: ${kind}`);
    }
  }
}

export interface BuiltinControllerOptions<K extends BuiltinResourceKind> {
  projection: BuiltinResourceProjection;
  pluginInstanceId: string;
  resourceKind: K;
  reconciler: BuiltinReconciler<K>;
  maxConcurrency?: number;
  now?: () => Date;
  executeWithCapacity?: <T>(execute: () => Promise<T>) => Promise<T>;
  onProposal(
    proposal: BuiltinResourceReconcileProposal,
  ): Promise<void> | void;
  onReconcileSuccess?(key: ReconcileKey, nextReconcileAt: Date | null): void;
  onReconcileError?(key: ReconcileKey, error: unknown): void;
}

function validatedResult(result: ReconcileResult | void): ReconcileResult {
  if (!result) return {};
  if (result.proposedInput !== undefined) {
    if (typeof result.proposedInput.text !== "string" || !result.proposedInput.text.trim()) {
      throw new Error("reconcile proposedInput.text must not be empty");
    }
  }
  if (
    result.requeueAfterMs !== undefined &&
    (!Number.isSafeInteger(result.requeueAfterMs) || result.requeueAfterMs < 1)
  ) {
    throw new Error("reconcile requeueAfterMs must be a positive integer");
  }
  return result;
}

/**
 * 一个 Plugin 对一种 Baton Builtin Resource 的只读 Controller。
 * 重放和 live event 最终都只入同一 keyed queue，Reconciler 每次重新读取最新投影。
 */
export class BuiltinController<K extends BuiltinResourceKind> {
  readonly scope: ReconcileScope;
  private readonly projection: BuiltinResourceProjection;
  private readonly resourceKind: K;
  private readonly reconciler: BuiltinReconciler<K>;
  private readonly now: () => Date;
  private readonly onProposal: BuiltinControllerOptions<K>["onProposal"];
  private readonly queue: ReconcileQueue;
  private closed = false;

  constructor(options: BuiltinControllerOptions<K>) {
    if (!options.pluginInstanceId.trim()) {
      throw new Error("pluginInstanceId must not be empty");
    }
    this.projection = options.projection;
    this.resourceKind = options.resourceKind;
    this.projection.list(options.resourceKind);
    this.reconciler = options.reconciler;
    this.now = options.now ?? (() => new Date());
    this.onProposal = options.onProposal;
    this.scope = Object.freeze({
      batonSessionId: options.projection.batonSessionId,
      pluginInstanceId: options.pluginInstanceId,
      resourceKind: options.resourceKind,
      resourceOwner: "baton",
    });
    const executeWithCapacity =
      options.executeWithCapacity ?? (async <T>(execute: () => Promise<T>) => await execute());
    this.queue = new ReconcileQueue({
      execute: (key) =>
        executeWithCapacity(async () => {
          if (this.closed) throw new Error("plugin Controller is closed");
          const resource = this.projection.get(this.resourceKind, key.resourceId);
          const result = validatedResult(
            await this.reconciler.reconcile(Object.freeze({ resource })),
          );
          const now = this.now();
          if (Number.isNaN(now.getTime())) {
            throw new Error("plugin Controller now() returned an invalid Date");
          }
          const nextReconcileAt =
            result.requeueAfterMs === undefined
              ? null
              : new Date(now.getTime() + result.requeueAfterMs);
          if (result.proposedInput) {
            await this.onProposal(Object.freeze({
              key,
              basedOnRevision: resource.metadata.revision,
              text: result.proposedInput.text,
            }));
          }
          options.onReconcileSuccess?.(key, nextReconcileAt);
        }),
      maxConcurrency: options.maxConcurrency,
      onError: options.onReconcileError,
    });
  }

  enqueue(key: ReconcileKey): Promise<void> {
    try {
      this.assertOwns(key);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.queue.enqueue(Object.freeze({ ...key, resourceOwner: "baton" }));
  }

  close(): void {
    this.closed = true;
    this.queue.close();
  }

  initialReconciles(): ReconcileKey[] {
    return this.projection.list(this.resourceKind).map((resource) =>
      Object.freeze({
        ...this.scope,
        resourceId: resource.metadata.resourceId,
      }),
    );
  }

  scheduledReconciles(): ScheduledReconcile[] {
    return [];
  }

  private assertOwns(key: ReconcileKey): void {
    if (
      key.batonSessionId !== this.scope.batonSessionId ||
      key.pluginInstanceId !== this.scope.pluginInstanceId ||
      key.resourceKind !== this.scope.resourceKind ||
      reconcileResourceOwner(key) !== "baton"
    ) {
      throw new Error(
        `reconcile key is outside controller scope: ${key.batonSessionId}/${key.pluginInstanceId}/${key.resourceKind}/${key.resourceId}`,
      );
    }
  }
}
