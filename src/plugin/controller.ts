import type { PluginResource } from "./resource.ts";
import { PluginResourceStore } from "./resource.ts";
import { ReconcileQueue } from "./queue.ts";

export interface ReconcileScope {
  readonly batonSessionId: string;
  readonly pluginInstanceId: string;
  readonly resourceKind: string;
}

export interface ReconcileKey extends ReconcileScope {
  readonly resourceId: string;
}

export interface ReconcileContext<TSpec, TStatus> {
  readonly resource: Readonly<PluginResource<TSpec, TStatus>>;
  patchStatus(patch: Partial<TStatus>): Promise<void>;
}

export interface ReconcileResult {
  /** 供用户审核、编辑后作为普通 Input 提交；它本身不创建 Input。 */
  proposedInput?: {
    text: string;
  };
  /** 一次性动态唤醒间隔；Controller 负责换算并持久化 nextReconcileAt。 */
  requeueAfterMs?: number;
}

export interface Reconciler<TSpec, TStatus> {
  reconcile(context: ReconcileContext<TSpec, TStatus>): Promise<ReconcileResult | void>;
}

export interface ReconcileProposal {
  readonly key: ReconcileKey;
  readonly basedOnGeneration: number;
  readonly text: string;
}

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
  };
  for (const [name, value] of Object.entries(copy)) {
    if (!value.trim()) throw new Error(`reconcile key ${name} must not be empty`);
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
        let latestResourceVersion = resource.metadata.resourceVersion;
        const context: ReconcileContext<TSpec, TStatus> = Object.freeze({
          resource,
          patchStatus: async (patch: Partial<TStatus>) => {
            const updated = this.store.patchStatus<TSpec, TStatus>(
              this.resourceKind,
              key.resourceId,
              patch,
              { expectedResourceVersion: latestResourceVersion },
            );
            latestResourceVersion = updated.metadata.resourceVersion;
          },
        });

        const result = validatedResult(await this.reconciler.reconcile(context));
        const now = this.now();
        if (Number.isNaN(now.getTime())) {
          throw new Error("plugin Controller now() returned an invalid Date");
        }
        const nextReconcileAt =
          result.requeueAfterMs === undefined
            ? null
            : new Date(now.getTime() + result.requeueAfterMs);
        this.store.setNextReconcileAt<TSpec, TStatus>(
          this.resourceKind,
          key.resourceId,
          nextReconcileAt,
          { expectedResourceVersion: latestResourceVersion },
        );

        return {
          nextReconcileAt,
          ...(result.proposedInput
            ? {
                proposal: Object.freeze({
                  key,
                  basedOnGeneration: resource.metadata.generation,
                  text: result.proposedInput.text,
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
      key.resourceKind !== this.scope.resourceKind
    ) {
      throw new Error(
        `reconcile key is outside controller scope: ${key.batonSessionId}/${key.pluginInstanceId}/${key.resourceKind}/${key.resourceId}`,
      );
    }
  }
}
