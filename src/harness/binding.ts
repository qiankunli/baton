import {
  isApprovalRoutable,
  isEffortConfigurable,
  isModelConfigurable,
  isNativeSessionIdentifiable,
  type ApprovalRoute,
  type EffortOption,
  type EventSink,
  type HarnessAdapter,
  type HarnessSessionRef,
  type ModelOption,
} from "../adapters/types.ts";
import type { SessionHandle } from "../store/store.ts";
import { createHarnessLaunchSnapshot, type HarnessTarget } from "./target.ts";

export interface HarnessBindingOptions {
  target: HarnessTarget;
  adapter: HarnessAdapter;
  session: SessionHandle;
  eventSink: EventSink;
  setupTurnId?: string;
  modelPreference?: string;
  effortPreference?: string;
}

/**
 * 一个 HarnessTarget 在当前 BatonSession 中的 live 绑定：
 * HarnessTarget ↔ Adapter ↔ HarnessSession。
 *
 * 绑定拥有启动、resume、配置恢复与关闭；Turn 调度、上下文注入和 Event 持久化仍由
 * Controller 负责。
 */
export class HarnessBinding {
  readonly target: HarnessTarget;
  readonly adapter: HarnessAdapter;
  ref?: HarnessSessionRef;
  /**
   * setup 阶段由哪个 driven turn 触发。无显式 turnId 的 setup Interaction 由
   * Controller 使用它归属到触发冷启动的 turn。
   */
  setupTurnId?: string;
  freshNative = true;

  private starting?: Promise<void>;
  private readonly session: SessionHandle;
  private readonly eventSink: EventSink;
  private readonly modelPreference?: string;
  private readonly effortPreference?: string;

  constructor(options: HarnessBindingOptions) {
    this.target = options.target;
    this.adapter = options.adapter;
    this.session = options.session;
    this.eventSink = options.eventSink;
    this.setupTurnId = options.setupTurnId;
    this.modelPreference = options.modelPreference;
    this.effortPreference = options.effortPreference;
  }

  get isStarting(): boolean {
    return Boolean(this.starting);
  }

  /**
   * 必须在 Controller 把 binding 放入索引后调用：Adapter.open 期间可能同步打开
   * Interaction，届时 Controller 需要先能按 HarnessTarget 找回本 binding。
   */
  start(): void {
    if (this.starting || this.ref) return;
    this.starting = this.open();
    // ensure() 可能晚一拍才 await；先消费 rejection 防止误报，真实错误仍由 ensure 抛出。
    void this.starting.catch(() => {});
  }

  async ensure(): Promise<void> {
    if (!this.starting) return;
    try {
      await this.starting;
    } finally {
      this.starting = undefined;
    }
  }

  async listModels(): Promise<ModelOption[]> {
    if (!this.ref || !isModelConfigurable(this.adapter)) {
      throw new Error(`${this.target.id} does not support /model`);
    }
    return this.adapter.listModels(this.ref);
  }

  async setModel(modelId: string | null): Promise<void> {
    if (!this.ref || !isModelConfigurable(this.adapter)) {
      throw new Error(`${this.target.id} does not support /model`);
    }
    await this.adapter.setModel(this.ref, modelId);
    const existing = this.session.meta.harnessSessions[this.target.id] ?? {
      harnessTargetId: this.target.id,
      harness: this.adapter.harness,
    };
    this.session.setHarnessSession(this.target.id, {
      ...existing,
      harnessTargetId: this.target.id,
      harness: this.adapter.harness,
      harnessSessionId: existing.harnessSessionId ?? this.nativeSessionId(),
      model: !modelId || modelId === "default" ? undefined : modelId,
    });
  }

  currentModel(): string | null {
    if (!this.ref || !isModelConfigurable(this.adapter)) {
      return this.preferredModel() ?? null;
    }
    return this.adapter.currentModel(this.ref);
  }

  async listEfforts(): Promise<EffortOption[]> {
    if (!this.ref || !isEffortConfigurable(this.adapter)) {
      throw new Error(`${this.target.id} does not support /effort`);
    }
    return this.adapter.listEfforts(this.ref);
  }

  async setEffort(effortId: string | null): Promise<void> {
    if (!this.ref || !isEffortConfigurable(this.adapter)) {
      throw new Error(`${this.target.id} does not support /effort`);
    }
    await this.adapter.setEffort(this.ref, effortId);
    const existing = this.session.meta.harnessSessions[this.target.id] ?? {
      harnessTargetId: this.target.id,
      harness: this.adapter.harness,
    };
    this.session.setHarnessSession(this.target.id, {
      ...existing,
      harnessTargetId: this.target.id,
      harness: this.adapter.harness,
      harnessSessionId: existing.harnessSessionId ?? this.nativeSessionId(),
      effort: !effortId || effortId === "default" ? undefined : effortId,
    });
  }

  currentEffort(): string | null {
    if (!this.ref || !isEffortConfigurable(this.adapter)) {
      return this.preferredEffort() ?? null;
    }
    return this.adapter.currentEffort(this.ref);
  }

  approvalRoute(): ApprovalRoute | null {
    if (!this.ref || !isApprovalRoutable(this.adapter)) return null;
    return this.adapter.approvalRoute(this.ref);
  }

  nativeSessionId(): string | undefined {
    if (!this.ref) return undefined;
    return isNativeSessionIdentifiable(this.adapter)
      ? this.adapter.nativeSessionId(this.ref)
      : this.ref.harnessSessionId;
  }

  async close(): Promise<void> {
    if (this.ref) await this.adapter.close(this.ref);
  }

  private preferredModel(): string | undefined {
    return this.session.meta.harnessSessions[this.target.id]?.model ?? this.modelPreference;
  }

  private preferredEffort(): string | undefined {
    return this.session.meta.harnessSessions[this.target.id]?.effort ?? this.effortPreference;
  }

  private async open(): Promise<void> {
    try {
      const existing = this.session.meta.harnessSessions[this.target.id];
      const modelAdapter = isModelConfigurable(this.adapter) ? this.adapter : undefined;
      const effortAdapter = isEffortConfigurable(this.adapter) ? this.adapter : undefined;
      const model = modelAdapter ? this.preferredModel() : undefined;
      const effort = effortAdapter ? this.preferredEffort() : undefined;
      const launchSnapshot = createHarnessLaunchSnapshot({
        target: this.target,
        harnessSessionKey: this.adapter.harness,
        cwd: this.session.meta.cwd,
        model,
        effort,
      });
      // open 前落下实际配置：即使进程在 spawn/initialize 期间崩溃，也能解释这次启动。
      this.session.setHarnessSession(this.target.id, {
        ...existing,
        harnessTargetId: this.target.id,
        harness: this.adapter.harness,
        launchSnapshot,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      });
      this.ref = await this.adapter.open(
        {
          cwd: this.session.meta.cwd,
          resumeSessionId: existing?.harnessSessionId,
        },
        this.eventSink,
      );
      this.freshNative = !this.ref.resumed;
      if (model) await modelAdapter?.setModel(this.ref, model);
      if (effort) await effortAdapter?.setEffort(this.ref, effort);
      this.session.setHarnessSession(this.target.id, {
        ...this.session.meta.harnessSessions[this.target.id],
        harnessTargetId: this.target.id,
        harness: this.adapter.harness,
        launchSnapshot,
        harnessSessionId: this.nativeSessionId(),
        syncedSeq: this.ref.resumed ? existing?.syncedSeq : 0,
        ...(model ? { model } : {}),
        ...(effort ? { effort } : {}),
      });
    } finally {
      this.setupTurnId = undefined;
    }
  }
}
