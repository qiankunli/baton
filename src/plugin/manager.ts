import {
  Controller,
  type ReconcileKey,
  type ReconcileProposal,
  type ReconcileScope,
  type Reconciler,
  type ScheduledReconcile,
} from "./controller.ts";
import {
  type Proposal,
  type ProposalOutcome,
  ProposalStore,
} from "./proposal.ts";
import {
  reconcileKeyId,
  ReconcileCapacity,
  ReconcileDueQueue,
} from "./queue.ts";
import type { PluginResourceStore } from "./resource.ts";

export interface ControllerRegistration {
  close(): void;
}

export interface ControllerDefinition<TSpec, TStatus> {
  store: PluginResourceStore;
  resourceKind: string;
  reconciler: Reconciler<TSpec, TStatus>;
  /** 当前 Controller 内不同 Resource 的并发数；默认 1。 */
  maxConcurrency?: number;
  now?: () => Date;
}

export interface ManagerOptions {
  /** 所有 Controller 合计可占用的执行容量；默认 1。 */
  maxTotalConcurrency?: number;
  proposals: ProposalStore;
  /** Proposal 已落盘；接收方按 proposalId 幂等投影即可。 */
  onProposal(proposal: Proposal): Promise<void> | void;
  /** Reconciler 失败后的指数退避；默认从 1 秒增长到最多 1 分钟。 */
  retryBackoff?: {
    initialDelayMs?: number;
    maxDelayMs?: number;
  };
  now?: () => Date;
  /** 自动重试已安排；宿主可将错误投影到 UI 或诊断日志。 */
  onReconcileError?(failure: ReconcileFailure): void;
}

export interface ReconcileFailure {
  readonly key: ReconcileKey;
  readonly error: unknown;
  readonly attempt: number;
  readonly nextRetryAt?: string;
}

interface ManagedController {
  scope: ReconcileScope;
  enqueue(key: ReconcileKey): Promise<void>;
  close(): void;
  scheduledReconciles(): ScheduledReconcile[];
  setNextReconcileAt(key: ReconcileKey, next: Date): void;
}

interface RetryState {
  key: ReconcileKey;
  attempt: number;
}

function scopeId(scope: ReconcileScope): string {
  return JSON.stringify([scope.batonSessionId, scope.pluginInstanceId, scope.resourceKind]);
}

function scopeLabel(scope: ReconcileScope): string {
  return `${scope.batonSessionId}/${scope.pluginInstanceId}/${scope.resourceKind}`;
}

function sameScope(left: ReconcileScope, right: ReconcileScope): boolean {
  return (
    left.batonSessionId === right.batonSessionId &&
    left.pluginInstanceId === right.pluginInstanceId &&
    left.resourceKind === right.resourceKind
  );
}

function positiveDelay(name: string, value: number): void {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
}

/**
 * Plugin 域统一入口：注册和路由 Controller，并限制所有 Plugin 的进程总并发。
 */
export class Manager {
  private readonly controllers = new Map<string, ManagedController>();
  private readonly capacity: ReconcileCapacity;
  private readonly proposals: ProposalStore;
  private readonly onProposal: ManagerOptions["onProposal"];
  private readonly onReconcileError: ManagerOptions["onReconcileError"];
  private readonly retryInitialDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly retries = new Map<string, RetryState>();
  private readonly now: () => Date;
  private readonly dueQueue: ReconcileDueQueue;
  private started = false;
  private starting?: Promise<void>;

  constructor(options: ManagerOptions) {
    this.capacity = new ReconcileCapacity(options.maxTotalConcurrency ?? 1);
    this.proposals = options.proposals;
    this.onProposal = options.onProposal;
    this.onReconcileError = options.onReconcileError;
    this.retryInitialDelayMs = options.retryBackoff?.initialDelayMs ?? 1_000;
    this.retryMaxDelayMs = options.retryBackoff?.maxDelayMs ?? 60_000;
    positiveDelay("retryBackoff.initialDelayMs", this.retryInitialDelayMs);
    positiveDelay("retryBackoff.maxDelayMs", this.retryMaxDelayMs);
    if (this.retryMaxDelayMs < this.retryInitialDelayMs) {
      throw new Error("retryBackoff.maxDelayMs must be at least initialDelayMs");
    }
    this.now = options.now ?? (() => new Date());
    this.dueQueue = new ReconcileDueQueue({
      now: this.now,
      onDue: (key) => {
        void this.enqueue(key).catch(() => {
          // The Controller error callback has already persisted and scheduled the retry.
        });
      },
    });
  }

  registerController<TSpec, TStatus>(
    definition: ControllerDefinition<TSpec, TStatus>,
  ): ControllerRegistration {
    if (definition.store.batonSessionId !== this.proposals.batonSessionId) {
      throw new Error(
        `plugin Controller batonSessionId must be ${this.proposals.batonSessionId}, got ${definition.store.batonSessionId}`,
      );
    }
    const controller = new Controller({
      ...definition,
      executeWithCapacity: (execute) => this.capacity.run(execute),
      onProposal: (proposal) => this.publishProposal(proposal),
      onReconcileSuccess: (key, next) => {
        if (this.controllers.get(scopeId(key)) !== controller) return;
        this.retries.delete(reconcileKeyId(key));
        if (this.started) this.dueQueue.schedule(key, next);
      },
      onReconcileError: (key, error) => {
        this.retry(controller, key, error);
      },
    });
    const id = scopeId(controller.scope);
    if (this.controllers.has(id)) {
      throw new Error(`plugin Controller already registered for ${scopeLabel(controller.scope)}`);
    }
    this.controllers.set(id, controller);
    try {
      if (this.started) this.restoreSchedules(controller);
    } catch (error) {
      this.controllers.delete(id);
      controller.close();
      this.dueQueue.removeScope(controller.scope);
      throw error;
    }
    let active = true;
    return Object.freeze({
      close: () => {
        if (!active) return;
        active = false;
        if (this.controllers.get(id) !== controller) return;
        this.controllers.delete(id);
        controller.close();
        this.dueQueue.removeScope(controller.scope);
        for (const [keyId, retry] of this.retries) {
          if (sameScope(retry.key, controller.scope)) this.retries.delete(keyId);
        }
      },
    });
  }

  enqueue(key: ReconcileKey): Promise<void> {
    const controller = this.controllers.get(scopeId(key));
    if (!controller) {
      return Promise.reject(
        new Error(`no plugin Controller registered for ${scopeLabel(key)}`),
      );
    }
    return controller.enqueue(key);
  }

  /**
   * 恢复进程退出前尚未处理的 Proposal 和 Resource due time。
   * Proposal 投影失败时允许重试，接收方依靠 proposalId 去重。
   */
  start(): Promise<void> {
    if (this.started) return Promise.resolve();
    if (this.starting) return this.starting;
    const starting = this.startManager();
    this.starting = starting;
    void starting.then(
      () => {
        if (this.starting === starting) this.starting = undefined;
      },
      () => {
        if (this.starting === starting) this.starting = undefined;
      },
    );
    return starting;
  }

  listPendingProposals(): Proposal[] {
    return this.proposals.listPending();
  }

  resolveProposal(proposalId: string, outcome: ProposalOutcome): Proposal {
    return this.proposals.resolve(proposalId, outcome);
  }

  private async publishProposal(draft: ReconcileProposal): Promise<void> {
    const proposal = this.proposals.record(draft);
    if (!proposal.resolution) await this.onProposal(proposal);
  }

  private async restoreProposals(): Promise<void> {
    for (const proposal of this.proposals.listPending()) {
      await this.onProposal(proposal);
    }
  }

  private async startManager(): Promise<void> {
    await this.restoreProposals();
    const scheduled = [...this.controllers.values()].map((controller) => ({
      controller,
      entries: controller.scheduledReconciles(),
    }));
    for (const { controller, entries } of scheduled) {
      if (this.controllers.get(scopeId(controller.scope)) !== controller) continue;
      for (const entry of entries) {
        this.dueQueue.schedule(entry.key, entry.nextReconcileAt);
      }
    }
    this.started = true;
  }

  private restoreSchedules(controller: ManagedController): void {
    for (const entry of controller.scheduledReconciles()) {
      this.dueQueue.schedule(entry.key, entry.nextReconcileAt);
    }
  }

  private retry(controller: ManagedController, key: ReconcileKey, error: unknown): void {
    if (this.controllers.get(scopeId(key)) !== controller) return;
    const id = reconcileKeyId(key);
    const attempt = (this.retries.get(id)?.attempt ?? 0) + 1;
    this.retries.set(id, { key, attempt });
    const now = this.now();
    if (Number.isNaN(now.getTime())) {
      this.reportFailure({
        key,
        error: new AggregateError([error], "plugin Manager now() returned an invalid Date"),
        attempt,
      });
      return;
    }
    const delay = Math.min(
      this.retryMaxDelayMs,
      this.retryInitialDelayMs * 2 ** Math.min(attempt - 1, 30),
    );
    const nextRetryAt = new Date(now.getTime() + delay);
    try {
      controller.setNextReconcileAt(key, nextRetryAt);
      if (this.started) this.dueQueue.schedule(key, nextRetryAt);
      this.reportFailure({
        key,
        error,
        attempt,
        nextRetryAt: nextRetryAt.toISOString(),
      });
    } catch (retryError) {
      this.reportFailure({
        key,
        error: new AggregateError(
          [error, retryError],
          `could not persist retry for ${scopeLabel(key)}/${key.resourceId}`,
        ),
        attempt,
      });
    }
  }

  private reportFailure(failure: ReconcileFailure): void {
    try {
      this.onReconcileError?.(Object.freeze(failure));
    } catch {
      // Diagnostic projection must not break retry scheduling.
    }
  }
}
