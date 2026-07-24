import type { Reconciler } from "./controller.ts";
import type { PluginInstance } from "./instance.ts";

export interface ResourceContribution<TSpec, TStatus> {
  resourceKind: string;
  reconciler: Reconciler<TSpec, TStatus>;
  /** 同一种 Resource 内允许同时执行的不同对象数；默认 1。 */
  maxConcurrency?: number;
}

export interface PluginActivationContext {
  readonly instance: PluginInstance;
  registerResource<TSpec, TStatus>(
    contribution: ResourceContribution<TSpec, TStatus>,
  ): void;
  /** Connector、订阅等非 Resource 资源也归当前 Binding 统一关闭。 */
  onClose(cleanup: () => Promise<void> | void): void;
}

/**
 * 首期可信进程内 Package 的最小契约。Manifest、权限和配置 schema 随安装流程再扩展。
 */
export interface PluginPackage {
  readonly pluginId: string;
  readonly version: string;
  activate(context: PluginActivationContext): Promise<void> | void;
}

type ResourceRegistrar = <TSpec, TStatus>(
  contribution: ResourceContribution<TSpec, TStatus>,
) => () => void;

function nonEmpty(name: string, value: string): void {
  if (!value.trim()) throw new Error(`${name} must not be empty`);
}

export function pluginPackageKey(pluginId: string, version: string): string {
  return JSON.stringify([pluginId, version]);
}

export function validatePluginPackage(plugin: PluginPackage): void {
  nonEmpty("pluginId", plugin.pluginId);
  nonEmpty("plugin version", plugin.version);
  if (typeof plugin.activate !== "function") {
    throw new Error(`plugin Package ${plugin.pluginId}@${plugin.version} must provide activate()`);
  }
}

/**
 * PluginInstance 在当前进程中的一次临时绑定。所有注册按逆序关闭，支持激活失败整体回滚。
 */
export class PluginBinding implements PluginActivationContext {
  readonly instance: PluginInstance;
  private readonly register: ResourceRegistrar;
  private readonly cleanups: Array<() => Promise<void> | void> = [];
  private sealed = false;
  private closed = false;
  private closing?: Promise<void>;

  constructor(instance: PluginInstance, register: ResourceRegistrar) {
    this.instance = instance;
    this.register = register;
  }

  registerResource<TSpec, TStatus>(
    contribution: ResourceContribution<TSpec, TStatus>,
  ): void {
    this.assertRegistering();
    if (!contribution.resourceKind.trim()) {
      throw new Error("resourceKind must not be empty");
    }
    const close = this.register(contribution);
    this.cleanups.push(close);
  }

  onClose(cleanup: () => Promise<void> | void): void {
    this.assertRegistering();
    if (typeof cleanup !== "function") throw new Error("plugin cleanup must be a function");
    this.cleanups.push(cleanup);
  }

  completeActivation(): void {
    if (this.closed) throw new Error("plugin Binding is closed");
    this.sealed = true;
  }

  close(): Promise<void> {
    if (this.closing) return this.closing;
    this.closed = true;
    this.sealed = true;
    const closing = this.closeAll();
    this.closing = closing;
    return closing;
  }

  private assertRegistering(): void {
    if (this.closed) throw new Error("plugin Binding is closed");
    if (this.sealed) throw new Error("plugin Binding activation is complete");
  }

  private async closeAll(): Promise<void> {
    const errors: unknown[] = [];
    for (const cleanup of this.cleanups.reverse()) {
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    this.cleanups.length = 0;
    if (errors.length === 1) throw errors[0];
    if (errors.length > 1) throw new AggregateError(errors, "could not close plugin Binding");
  }
}
