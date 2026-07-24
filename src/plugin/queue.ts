import type {
  ReconcileKey,
  ReconcileScope,
} from "./controller.ts";
import {
  reconcileResourceOwner,
  sameReconcileScope,
} from "./reconcile-scope.ts";

interface QueuedReconcile {
  key: ReconcileKey;
  completion: Promise<void>;
  resolve: () => void;
  reject: (error: unknown) => void;
}

interface DueReconcile {
  key: ReconcileKey;
  dueAtMs: number;
}

export interface ReconcileQueueOptions {
  maxConcurrency?: number;
  execute(key: ReconcileKey): Promise<void>;
  onError?(key: ReconcileKey, error: unknown): void;
}

export interface DueQueueOptions {
  now?: () => Date;
  onDue(key: ReconcileKey): void;
}

export class ReconcileCapacity {
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

const MAX_TIMER_DELAY_MS = 2_147_483_647;

export function reconcileKeyId(key: ReconcileKey): string {
  return JSON.stringify([
    key.batonSessionId,
    key.pluginInstanceId,
    key.resourceKind,
    key.resourceId,
    reconcileResourceOwner(key),
  ]);
}

function queuedReconcile(key: ReconcileKey): QueuedReconcile {
  let resolve!: () => void;
  let reject!: (error: unknown) => void;
  const completion = new Promise<void>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { key, completion, resolve, reject };
}

function timestamp(now: () => Date, label: string): number {
  const value = now();
  if (Number.isNaN(value.getTime())) throw new Error(`${label} now() returned an invalid Date`);
  return value.getTime();
}

/**
 * Controller 进程内 workqueue。语义对齐 controller-runtime/client-go：
 * pending key 去重；运行期间的新触发只保留一次 dirty follow-up。
 */
export class ReconcileQueue {
  private readonly pending = new Map<string, QueuedReconcile>();
  private readonly running = new Set<string>();
  private readonly maxConcurrency: number;
  private readonly execute: ReconcileQueueOptions["execute"];
  private readonly onError: ReconcileQueueOptions["onError"];
  private activeCount = 0;
  private closed = false;

  constructor(options: ReconcileQueueOptions) {
    const maxConcurrency = options.maxConcurrency ?? 1;
    if (!Number.isInteger(maxConcurrency) || maxConcurrency < 1) {
      throw new Error("maxConcurrency must be a positive integer");
    }
    this.maxConcurrency = maxConcurrency;
    this.execute = options.execute;
    this.onError = options.onError;
  }

  enqueue(key: ReconcileKey): Promise<void> {
    if (this.closed) {
      return Promise.reject(new Error("plugin Controller is closed"));
    }
    const id = reconcileKeyId(key);
    const existing = this.pending.get(id);
    if (existing) return existing.completion;

    const item = queuedReconcile(key);
    this.pending.set(id, item);
    this.drain();
    return item.completion;
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    const error = new Error("plugin Controller is closed");
    for (const item of this.pending.values()) item.reject(error);
    this.pending.clear();
  }

  private drain(): void {
    if (this.closed) return;
    while (this.activeCount < this.maxConcurrency) {
      const next = [...this.pending].find(([id]) => !this.running.has(id));
      if (!next) return;
      const [id, item] = next;
      this.pending.delete(id);
      this.running.add(id);
      this.activeCount += 1;
      void this.executeOne(id, item);
    }
  }

  private async executeOne(id: string, item: QueuedReconcile): Promise<void> {
    try {
      await this.execute(item.key);
      item.resolve();
    } catch (error) {
      item.reject(error);
      try {
        this.onError?.(item.key, error);
      } catch {
        // Queue completion must not be replaced by an observer failure.
      }
    } finally {
      this.running.delete(id);
      this.activeCount -= 1;
      this.drain();
    }
  }
}

/**
 * Manager 级动态唤醒队列。所有 Controller 共享一个 timer；持久真相仍在
 * PluginResource.metadata.nextReconcileAt，当前 Map 只负责本进程唤醒。
 */
export class ReconcileDueQueue {
  private readonly entries = new Map<string, DueReconcile>();
  private readonly now: () => Date;
  private readonly onDue: DueQueueOptions["onDue"];
  private timer?: ReturnType<typeof setTimeout>;

  constructor(options: DueQueueOptions) {
    this.now = options.now ?? (() => new Date());
    this.onDue = options.onDue;
  }

  schedule(key: ReconcileKey, dueAt: Date | null): void {
    const id = reconcileKeyId(key);
    if (dueAt === null) {
      if (this.entries.delete(id)) this.arm();
      return;
    }
    const dueAtMs = dueAt.getTime();
    if (Number.isNaN(dueAtMs)) throw new Error("reconcile due time must be a valid Date");
    const current = this.entries.get(id);
    if (current?.dueAtMs === dueAtMs) return;
    this.entries.set(id, { key, dueAtMs });
    this.arm();
  }

  removeScope(scope: ReconcileScope): void {
    let changed = false;
    for (const [id, entry] of this.entries) {
      if (!sameReconcileScope(entry.key, scope)) continue;
      this.entries.delete(id);
      changed = true;
    }
    if (changed) this.arm();
  }

  close(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    this.entries.clear();
  }

  private arm(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = undefined;
    let earliest = Number.POSITIVE_INFINITY;
    for (const entry of this.entries.values()) {
      earliest = Math.min(earliest, entry.dueAtMs);
    }
    if (!Number.isFinite(earliest)) return;

    const delay = Math.min(
      MAX_TIMER_DELAY_MS,
      Math.max(0, earliest - timestamp(this.now, "plugin due queue")),
    );
    this.timer = setTimeout(() => this.fire(), delay);
    this.timer.unref?.();
  }

  private fire(): void {
    this.timer = undefined;
    const nowMs = timestamp(this.now, "plugin due queue");
    const due: ReconcileKey[] = [];
    for (const [id, entry] of this.entries) {
      if (entry.dueAtMs > nowMs) continue;
      this.entries.delete(id);
      due.push(entry.key);
    }
    this.arm();
    for (const key of due) this.onDue(key);
  }
}
