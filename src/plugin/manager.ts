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
  type CreatePluginInstance,
  type PluginInstance,
  PluginInstanceStore,
} from "./instance.ts";
import {
  PluginBinding,
  type PluginPackage,
  pluginPackageKey,
  type ResourceContribution,
  validatePluginPackage,
} from "./package.ts";
import {
  reconcileKeyId,
  ReconcileCapacity,
  ReconcileDueQueue,
} from "./queue.ts";
import { PluginResourceStore } from "./resource.ts";

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
  /** 缺省与 ProposalStore 使用同一个 BatonSession。 */
  instances?: PluginInstanceStore;
  /** 当前进程可激活的可信、不可变 Package 版本。 */
  packages?: readonly PluginPackage[];
  /** 按需加载已安装 Package；fresh 用于开发期 `/reload-plugins` 绕过模块缓存。 */
  loadPackage?(
    pluginId: string,
    version: string,
    options?: { fresh?: boolean },
  ): Promise<PluginPackage>;
  /** Proposal 已落盘；接收方按 proposalId 幂等投影即可。 */
  onProposal(proposal: Proposal): Promise<void> | void;
  /** Reconciler 失败后的指数退避；默认从 1 秒增长到最多 1 分钟。 */
  retryBackoff?: {
    initialDelayMs?: number;
    maxDelayMs?: number;
  };
  now?: () => Date;
  /** 单个 Instance 激活失败不阻断其他 Plugin；宿主可将失败投影到 UI 或诊断日志。 */
  onActivationError?(failure: PluginActivationFailure): void;
  /** 自动重试已安排；宿主可将错误投影到 UI 或诊断日志。 */
  onReconcileError?(failure: ReconcileFailure): void;
}

export interface PluginActivationFailure {
  readonly pluginInstanceId: string;
  readonly error: unknown;
}

export interface ReconcileFailure {
  readonly key: ReconcileKey;
  readonly error: unknown;
  readonly attempt: number;
  readonly nextRetryAt?: string;
}

export interface PluginReloadResult {
  readonly activated: readonly string[];
  readonly failures: readonly PluginActivationFailure[];
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
  private readonly instances: PluginInstanceStore;
  private readonly packages = new Map<string, PluginPackage>();
  private readonly packageLoads = new Map<string, Promise<PluginPackage>>();
  private readonly loadPackage: ManagerOptions["loadPackage"];
  private readonly bindings = new Map<string, PluginBinding>();
  private readonly activations = new Map<string, Promise<void>>();
  private readonly capacity: ReconcileCapacity;
  private readonly proposals: ProposalStore;
  private readonly onProposal: ManagerOptions["onProposal"];
  private readonly onActivationError: ManagerOptions["onActivationError"];
  private readonly onReconcileError: ManagerOptions["onReconcileError"];
  private readonly retryInitialDelayMs: number;
  private readonly retryMaxDelayMs: number;
  private readonly retries = new Map<string, RetryState>();
  private readonly now: () => Date;
  private readonly dueQueue: ReconcileDueQueue;
  private started = false;
  private starting?: Promise<void>;
  private closed = false;
  private closing?: Promise<void>;

  constructor(options: ManagerOptions) {
    this.capacity = new ReconcileCapacity(options.maxTotalConcurrency ?? 1);
    this.proposals = options.proposals;
    this.now = options.now ?? (() => new Date());
    this.instances =
      options.instances ??
      new PluginInstanceStore({
        session: options.proposals.session,
        now: this.now,
      });
    if (
      this.instances.session.id !== options.proposals.session.id ||
      this.instances.session.dir !== options.proposals.session.dir
    ) {
      throw new Error("plugin InstanceStore and ProposalStore must own the same BatonSession");
    }
    for (const plugin of options.packages ?? []) {
      validatePluginPackage(plugin);
      const key = pluginPackageKey(plugin.pluginId, plugin.version);
      if (this.packages.has(key)) {
        throw new Error(`plugin Package already registered: ${plugin.pluginId}@${plugin.version}`);
      }
      this.packages.set(key, plugin);
    }
    this.loadPackage = options.loadPackage;
    this.onProposal = options.onProposal;
    this.onActivationError = options.onActivationError;
    this.onReconcileError = options.onReconcileError;
    this.retryInitialDelayMs = options.retryBackoff?.initialDelayMs ?? 1_000;
    this.retryMaxDelayMs = options.retryBackoff?.maxDelayMs ?? 60_000;
    positiveDelay("retryBackoff.initialDelayMs", this.retryInitialDelayMs);
    positiveDelay("retryBackoff.maxDelayMs", this.retryMaxDelayMs);
    if (this.retryMaxDelayMs < this.retryInitialDelayMs) {
      throw new Error("retryBackoff.maxDelayMs must be at least initialDelayMs");
    }
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
    if (this.closed) throw new Error("plugin Manager is closed");
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
    if (this.closed) return Promise.reject(new Error("plugin Manager is closed"));
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
    if (this.closed) return Promise.reject(new Error("plugin Manager is closed"));
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

  /**
   * 将一份已启用 Instance 原子绑定到对应 Package。失败时撤销本次已产生的全部注册。
   */
  async activateInstance(pluginInstanceId: string): Promise<void> {
    if (this.closed) throw new Error("plugin Manager is closed");
    if (this.bindings.has(pluginInstanceId)) return;
    const existing = this.activations.get(pluginInstanceId);
    if (existing) return await existing;

    const instance = this.instances.get(pluginInstanceId);
    if (!instance.enabled) {
      throw new Error(`plugin Instance is disabled: ${pluginInstanceId}`);
    }
    const plugin = await this.resolvePackage(instance.pluginId, instance.packageVersion);

    const binding = new PluginBinding(instance, (contribution) =>
      this.bindResource(instance.pluginInstanceId, contribution),
    );
    let activation!: Promise<void>;
    activation = Promise.resolve()
      .then(async () => {
        try {
          await plugin.activate(binding);
          binding.completeActivation();
          if (this.closed) throw new Error("plugin Manager is closed");
          this.bindings.set(pluginInstanceId, binding);
        } catch (error) {
          try {
            await binding.close();
          } catch (closeError) {
            throw new AggregateError(
              [error, closeError],
              `could not activate plugin Instance ${pluginInstanceId}`,
            );
          }
          throw error;
        }
      })
      .finally(() => {
        if (this.activations.get(pluginInstanceId) === activation) {
          this.activations.delete(pluginInstanceId);
        }
      });
    this.activations.set(pluginInstanceId, activation);
    await activation;
  }

  async deactivateInstance(pluginInstanceId: string): Promise<void> {
    const activation = this.activations.get(pluginInstanceId);
    if (activation) await activation;
    const binding = this.bindings.get(pluginInstanceId);
    if (!binding) return;
    this.bindings.delete(pluginInstanceId);
    await binding.close();
  }

  isInstanceActive(pluginInstanceId: string): boolean {
    return this.bindings.has(pluginInstanceId);
  }

  listInstances(): PluginInstance[] {
    return this.instances.list();
  }

  /**
   * Instance 先以 disabled 落盘，再显式启用；激活失败时仍保留一份可诊断、可重试的配置。
   */
  async createInstance(input: CreatePluginInstance): Promise<PluginInstance> {
    if (this.closed) throw new Error("plugin Manager is closed");
    await this.start();
    const shouldEnable = input.enabled ?? true;
    const instance = this.instances.create({ ...input, enabled: false });
    if (!shouldEnable) return instance;
    return await this.setInstanceEnabled(instance.pluginInstanceId, true);
  }

  async setInstanceEnabled(
    pluginInstanceId: string,
    enabled: boolean,
  ): Promise<PluginInstance> {
    if (this.closed) throw new Error("plugin Manager is closed");
    await this.start();
    const current = this.instances.get(pluginInstanceId);
    if (!enabled) {
      const disabled = this.instances.setEnabled(pluginInstanceId, false);
      await this.deactivateInstance(pluginInstanceId);
      return disabled;
    }
    if (current.enabled && this.isInstanceActive(pluginInstanceId)) return current;
    const next = current.enabled
      ? current
      : this.instances.setEnabled(pluginInstanceId, true);
    try {
      await this.activateInstance(pluginInstanceId);
      return next;
    } catch (error) {
      if (!current.enabled) this.instances.setEnabled(pluginInstanceId, false);
      throw error;
    }
  }

  /**
   * 重载当前 BatonSession 的全部 enabled Instance。Package 每个版本只 fresh load 一次；
   * 单个 Package 或 Instance 失败不阻断其它插件，也不改变用户的 enabled 配置。
   */
  async reload(): Promise<PluginReloadResult> {
    if (this.closed) throw new Error("plugin Manager is closed");
    await this.start();
    const failures = new Map<string, PluginActivationFailure>();
    for (const pluginInstanceId of [...this.bindings.keys()].reverse()) {
      try {
        await this.deactivateInstance(pluginInstanceId);
      } catch (error) {
        failures.set(pluginInstanceId, { pluginInstanceId, error });
      }
    }

    const enabled = this.instances.list().filter((instance) => instance.enabled);
    const packageFailures = new Map<string, unknown>();
    const loadedPackages = new Set<string>();
    for (const instance of enabled) {
      const key = pluginPackageKey(instance.pluginId, instance.packageVersion);
      if (loadedPackages.has(key)) continue;
      loadedPackages.add(key);
      try {
        await this.resolvePackage(instance.pluginId, instance.packageVersion, true);
      } catch (error) {
        packageFailures.set(key, error);
      }
    }

    const activated: string[] = [];
    for (const instance of enabled) {
      if (failures.has(instance.pluginInstanceId)) continue;
      const error = packageFailures.get(
        pluginPackageKey(instance.pluginId, instance.packageVersion),
      );
      if (error) {
        failures.set(instance.pluginInstanceId, {
          pluginInstanceId: instance.pluginInstanceId,
          error,
        });
        continue;
      }
      try {
        await this.activateInstance(instance.pluginInstanceId);
        activated.push(instance.pluginInstanceId);
      } catch (activationError) {
        failures.set(instance.pluginInstanceId, {
          pluginInstanceId: instance.pluginInstanceId,
          error: activationError,
        });
      }
    }
    const failureList = [...failures.values()];
    for (const failure of failureList) this.reportActivationFailure(failure);
    return Object.freeze({
      activated: Object.freeze(activated),
      failures: Object.freeze(failureList.map((failure) => Object.freeze(failure))),
    });
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    const closing = this.closeManager();
    this.closing = closing;
    return closing;
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
    const enabled = this.instances.list().filter((instance) => instance.enabled);
    const failures = await Promise.all(
      enabled.map(async (instance): Promise<PluginActivationFailure | undefined> => {
        try {
          await this.activateInstance(instance.pluginInstanceId);
          return undefined;
        } catch (error) {
          return { pluginInstanceId: instance.pluginInstanceId, error };
        }
      }),
    );
    for (const failure of failures) {
      if (failure) this.reportActivationFailure(failure);
    }
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
    if (this.closed) throw new Error("plugin Manager is closed");
    this.started = true;
  }

  private async resolvePackage(
    pluginId: string,
    version: string,
    fresh = false,
  ): Promise<PluginPackage> {
    const key = pluginPackageKey(pluginId, version);
    if (!fresh) {
      const cached = this.packages.get(key);
      if (cached) return cached;
      const loading = this.packageLoads.get(key);
      if (loading) return await loading;
    }
    if (!this.loadPackage) {
      const cached = this.packages.get(key);
      if (cached) return cached;
      throw new Error(`plugin Package is unavailable: ${pluginId}@${version}`);
    }
    const loading = Promise.resolve()
      .then(() => this.loadPackage!(pluginId, version, fresh ? { fresh: true } : undefined))
      .then((plugin) => {
        validatePluginPackage(plugin);
        if (plugin.pluginId !== pluginId || plugin.version !== version) {
          throw new Error(
            `loaded Package identity ${plugin.pluginId}@${plugin.version} does not match ${pluginId}@${version}`,
          );
        }
        this.packages.set(key, plugin);
        return plugin;
      })
      .finally(() => {
        if (this.packageLoads.get(key) === loading) this.packageLoads.delete(key);
      });
    this.packageLoads.set(key, loading);
    return await loading;
  }

  private bindResource<TSpec, TStatus>(
    pluginInstanceId: string,
    contribution: ResourceContribution<TSpec, TStatus>,
  ): () => void {
    const registration = this.registerController({
      ...contribution,
      store: new PluginResourceStore({
        session: this.instances.session,
        pluginInstanceId,
      }),
      now: this.now,
    });
    return () => registration.close();
  }

  private async closeManager(): Promise<void> {
    await Promise.allSettled(this.activations.values());
    const errors: unknown[] = [];
    for (const [pluginInstanceId, binding] of [...this.bindings].reverse()) {
      this.bindings.delete(pluginInstanceId);
      try {
        await binding.close();
      } catch (error) {
        errors.push(error);
      }
    }
    for (const controller of this.controllers.values()) controller.close();
    this.controllers.clear();
    this.retries.clear();
    this.dueQueue.close();
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "could not close plugin Manager");
  }

  private reportActivationFailure(failure: PluginActivationFailure): void {
    try {
      this.onActivationError?.(Object.freeze(failure));
    } catch {
      // Diagnostic projection must not keep healthy Plugin instances from starting.
    }
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
