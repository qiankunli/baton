import type { PluginResource } from "./resource.ts";
import { PluginResourceStore } from "./resource.ts";
import { ReconcileQueue } from "./queue.ts";
import { reconcileResourceOwner } from "./reconcile-scope.ts";
import {
  emptyBatonSnapshot,
  type BatonSnapshot,
} from "./baton-snapshot.ts";
import {
  type PluginOutput,
  validatePluginOutput,
} from "./output.ts";

export type ReconcileResourceOwner = "plugin" | "baton";

export interface ReconcileScope {
  readonly batonSessionId: string;
  readonly pluginInstanceId: string;
  readonly resourceKind: string;
  /** 旧 key 缺省为 plugin；baton 表示只读 Builtin Resource 投影。 */
  readonly resourceOwner?: ReconcileResourceOwner;
}

export interface ReconcileKey extends ReconcileScope {
  readonly resourceId: string;
}

export interface ReconcileResult {
  /** 交给 Baton 校验、持久化并进入对应宿主生命周期。 */
  output?: PluginOutput;
  /** 一次性动态唤醒间隔；Controller 负责换算并持久化 nextReconcileAt。 */
  requeueAfterMs?: number;
}

export interface ResourceReconciler<TResource> {
  reconcile(
    baton: Readonly<BatonSnapshot>,
    resource: Readonly<TResource>,
  ): Promise<ReconcileResult | void>;
}

export type Reconciler<TSpec, TStatus> = ResourceReconciler<
  PluginResource<TSpec, TStatus>
>;

export interface PluginResourceReconcileProposal {
  readonly key: ReconcileKey;
  readonly basedOnGeneration: number;
  readonly basedOnRevision?: never;
  readonly text: string;
}

export interface BuiltinResourceReconcileProposal {
  readonly key: ReconcileKey;
  readonly basedOnGeneration?: never;
  readonly basedOnRevision: number;
  readonly text: string;
}

export type ReconcileProposal =
  | PluginResourceReconcileProposal
  | BuiltinResourceReconcileProposal;

export interface ScheduledReconcile {
  readonly key: ReconcileKey;
  readonly nextReconcileAt: Date;
}

export interface ControllerOptions<TSpec, TStatus> {
  store: PluginResourceStore;
  resourceKind: string;
  reconciler: Reconciler<TSpec, TStatus>;
  maxConcurrency?: number;
  now?: () => Date;
  /** 每次执行前读取最新 BatonSession 只读视图。 */
  snapshot?: () => BatonSnapshot;
  /** Manager 注入的进程总容量；缺省表示不额外限流。 */
  executeWithCapacity?: <T>(execute: () => Promise<T>) => Promise<T>;
  onProposal(proposal: ReconcileProposal): Promise<void> | void;
  /** 仅供 Manager 收口成功后的动态唤醒；持久化由 Controller 先完成。 */
  onReconcileSuccess?(key: ReconcileKey, nextReconcileAt: Date | null): void;
  /** 仅报告实际执行失败，不包含 enqueue 参数校验错误。 */
  onReconcileError?(key: ReconcileKey, error: unknown): void;
}

function ownedKey(key: ReconcileKey): ReconcileKey {
  const copy = {
    batonSessionId: key.batonSessionId,
    pluginInstanceId: key.pluginInstanceId,
    resourceKind: key.resourceKind,
    resourceId: key.resourceId,
    ...(key.resourceOwner === undefined
      ? {}
      : { resourceOwner: key.resourceOwner }),
  };
  for (const [name, value] of Object.entries({
    batonSessionId: copy.batonSessionId,
    pluginInstanceId: copy.pluginInstanceId,
    resourceKind: copy.resourceKind,
    resourceId: copy.resourceId,
  })) {
    if (!value.trim()) throw new Error(`reconcile key ${name} must not be empty`);
  }
  if (
    copy.resourceOwner !== undefined &&
    copy.resourceOwner !== "plugin" &&
    copy.resourceOwner !== "baton"
  ) {
    throw new Error(`reconcile key resourceOwner is invalid: ${String(copy.resourceOwner)}`);
  }
  return Object.freeze(copy);
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function validatedResult(result: ReconcileResult | void): ReconcileResult {
  if (!result) return {};
  if (result.output !== undefined) {
    validatePluginOutput(result.output);
  }
  if (
    result.requeueAfterMs !== undefined &&
    (!Number.isSafeInteger(result.requeueAfterMs) || result.requeueAfterMs < 1)
  ) {
    throw new Error("reconcile requeueAfterMs must be a positive integer");
  }
  return result;
}

interface ReconcileExecution {
  proposal?: ReconcileProposal;
  nextReconcileAt: Date | null;
}

/**
 * 单个 Plugin Resource Kind 的控制器：拥有 Reconciler、独立队列、局部并发和执行边界。
 * Manager 只负责注册、路由和所有 Controller 共享的总容量。
 */
export class Controller<TSpec, TStatus> {
  readonly scope: ReconcileScope;
  private readonly store: PluginResourceStore;
  private readonly resourceKind: string;
  private readonly reconciler: Reconciler<TSpec, TStatus>;
  private readonly now: () => Date;
  private readonly snapshot: () => BatonSnapshot;
  private readonly executeWithCapacity: NonNullable<
    ControllerOptions<TSpec, TStatus>["executeWithCapacity"]
  >;
  private readonly onProposal: ControllerOptions<TSpec, TStatus>["onProposal"];
  private readonly queue: ReconcileQueue;
  private closed = false;

  constructor(options: ControllerOptions<TSpec, TStatus>) {
    if (!options.resourceKind.trim()) throw new Error("resourceKind must not be empty");
    this.store = options.store;
    this.resourceKind = options.resourceKind;
    this.reconciler = options.reconciler;
    this.now = options.now ?? (() => new Date());
    this.snapshot =
      options.snapshot ?? (() => emptyBatonSnapshot(options.store.batonSessionId));
    this.executeWithCapacity =
      options.executeWithCapacity ?? (async (execute) => await execute());
    this.onProposal = options.onProposal;
    this.scope = Object.freeze({
      batonSessionId: options.store.batonSessionId,
      pluginInstanceId: options.store.pluginInstanceId,
      resourceKind: options.resourceKind,
    });
    this.queue = new ReconcileQueue({
      execute: (key) =>
        this.executeWithCapacity(async () => {
          if (this.closed) throw new Error("plugin Controller is closed");
          const execution = await this.reconcile(key);
          if (execution.proposal) await this.onProposal(execution.proposal);
          options.onReconcileSuccess?.(key, execution.nextReconcileAt);
        }),
      maxConcurrency: options.maxConcurrency,
      onError: options.onReconcileError,
    });
  }

  enqueue(key: ReconcileKey): Promise<void> {
    let reconcileKey: ReconcileKey;
    try {
      reconcileKey = ownedKey(key);
      this.assertOwns(reconcileKey);
    } catch (error) {
      return Promise.reject(error);
    }
    return this.queue.enqueue(reconcileKey);
  }

  close(): void {
    this.closed = true;
    this.queue.close();
  }

  scheduledReconciles(): ScheduledReconcile[] {
    return this.store.list(this.resourceKind).flatMap((resource) => {
      const value = resource.metadata.nextReconcileAt;
      if (value === undefined) return [];
      return [
        Object.freeze({
          key: ownedKey({
            ...this.scope,
            resourceId: resource.metadata.resourceId,
          }),
          nextReconcileAt: new Date(value),
        }),
      ];
    });
  }

  setNextReconcileAt(key: ReconcileKey, next: Date): void {
    const reconcileKey = ownedKey(key);
    this.assertOwns(reconcileKey);
    this.store.setNextReconcileAt(
      this.resourceKind,
      reconcileKey.resourceId,
      next,
    );
  }

  private async reconcile(key: ReconcileKey): Promise<ReconcileExecution> {
    return await this.store.withReconcileLock(
      this.resourceKind,
      key.resourceId,
      async () => {
        const resource = deepFreeze(
          this.store.get<TSpec, TStatus>(this.resourceKind, key.resourceId),
        );
        const baton = deepFreeze(this.snapshot());
        if (baton.session.batonSessionId !== this.scope.batonSessionId) {
          throw new Error(
            `BatonSnapshot batonSessionId must be ${this.scope.batonSessionId}, got ${baton.session.batonSessionId}`,
          );
        }
        const result = validatedResult(
          await this.reconciler.reconcile(baton, resource),
        );
        const now = this.now();
        if (Number.isNaN(now.getTime())) {
          throw new Error("plugin Controller now() returned an invalid Date");
        }
        const latest = this.store.get<TSpec, TStatus>(
          this.resourceKind,
          key.resourceId,
        );
        if (latest.metadata.generation !== resource.metadata.generation) {
          throw new Error(
            `plugin resource generation changed during reconcile: expected ${resource.metadata.generation}, current ${latest.metadata.generation}`,
          );
        }
        const nextReconcileAt =
          result.requeueAfterMs === undefined
            ? null
            : new Date(now.getTime() + result.requeueAfterMs);
        this.store.setNextReconcileAt<TSpec, TStatus>(
          this.resourceKind,
          key.resourceId,
          nextReconcileAt,
          { expectedResourceVersion: latest.metadata.resourceVersion },
        );

        return {
          nextReconcileAt,
          ...(result.output
            ? {
                proposal: Object.freeze({
                  key,
                  basedOnGeneration: resource.metadata.generation,
                  text: result.output.text,
                }),
              }
            : {}),
        };
      },
    );
  }

  private assertOwns(key: ReconcileKey): void {
    if (
      key.batonSessionId !== this.scope.batonSessionId ||
      key.pluginInstanceId !== this.scope.pluginInstanceId ||
      key.resourceKind !== this.scope.resourceKind ||
      reconcileResourceOwner(key) !== reconcileResourceOwner(this.scope)
    ) {
      throw new Error(
        `reconcile key is outside controller scope: ${key.batonSessionId}/${key.pluginInstanceId}/${key.resourceKind}/${key.resourceId}`,
      );
    }
  }
}
