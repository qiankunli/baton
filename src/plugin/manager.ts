import {
  Controller,
  type ReconcileKey,
  type ReconcileProposal,
  type ReconcileScope,
  type Reconciler,
} from "./controller.ts";
import {
  type Proposal,
  type ProposalOutcome,
  ProposalStore,
} from "./proposal.ts";
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
}

interface ManagedController {
  scope: ReconcileScope;
  enqueue(key: ReconcileKey): Promise<void>;
}

function scopeId(scope: ReconcileScope): string {
  return JSON.stringify([scope.batonSessionId, scope.pluginInstanceId, scope.resourceKind]);
}

function scopeLabel(scope: ReconcileScope): string {
  return `${scope.batonSessionId}/${scope.pluginInstanceId}/${scope.resourceKind}`;
}

class ReconcileCapacity {
  private active = 0;
  private readonly waiting: Array<() => void> = [];

  constructor(private readonly limit: number) {
    if (!Number.isInteger(limit) || limit < 1) {
      throw new Error("maxTotalConcurrency must be a positive integer");
    }
  }

  async run<T>(execute: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await execute();
    } finally {
      this.release();
    }
  }

  private acquire(): Promise<void> {
    if (this.active < this.limit) {
      this.active += 1;
      return Promise.resolve();
    }
    return new Promise((resolve) => this.waiting.push(resolve));
  }

  private release(): void {
    const next = this.waiting.shift();
    if (next) next();
    else this.active -= 1;
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
  private started = false;
  private starting?: Promise<void>;

  constructor(options: ManagerOptions) {
    this.capacity = new ReconcileCapacity(options.maxTotalConcurrency ?? 1);
    this.proposals = options.proposals;
    this.onProposal = options.onProposal;
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
    });
    const id = scopeId(controller.scope);
    if (this.controllers.has(id)) {
      throw new Error(`plugin Controller already registered for ${scopeLabel(controller.scope)}`);
    }
    this.controllers.set(id, controller);
    let active = true;
    return Object.freeze({
      close: () => {
        if (!active) return;
        active = false;
        if (this.controllers.get(id) === controller) this.controllers.delete(id);
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
   * 恢复进程退出前尚未处理的 Proposal。重复调用不重复投影；
   * 投影失败时允许重试，接收方依靠 proposalId 去重。
   */
  start(): Promise<void> {
    if (this.started) return Promise.resolve();
    if (this.starting) return this.starting;
    const starting = this.restoreProposals();
    this.starting = starting;
    void starting.then(
      () => {
        this.started = true;
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
}
