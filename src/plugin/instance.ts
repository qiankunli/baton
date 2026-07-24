import { isDeepStrictEqual } from "node:util";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { newId } from "../event/ids.ts";
import { withFileLock } from "../store/file-lock.ts";
import type { SessionHandle } from "../store/store.ts";

export type PluginConfig = Record<string, unknown>;

export interface PluginInstance {
  readonly pluginInstanceId: string;
  readonly batonSessionId: string;
  readonly pluginId: string;
  readonly packageVersion: string;
  readonly enabled: boolean;
  readonly config: Readonly<PluginConfig>;
  readonly createdAt: string;
  readonly updatedAt: string;
}

export interface CreatePluginInstance {
  pluginInstanceId?: string;
  pluginId: string;
  packageVersion: string;
  enabled?: boolean;
  config?: PluginConfig;
}

export interface PluginInstanceStoreOptions {
  session: Pick<SessionHandle, "id" | "dir">;
  now?: () => Date;
}

const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertPathSegment(name: string, value: string): void {
  if (!PATH_SEGMENT.test(value) || value === "." || value === "..") {
    throw new Error(`${name} must be a non-empty stable identifier without path separators`);
  }
}

function nonEmptyString(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must not be empty`);
  }
}

function isoTimestamp(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || Number.isNaN(Date.parse(value))) {
    throw new Error(`${name} must be an ISO timestamp`);
  }
}

function jsonObject<T>(name: string, value: T): T {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object`);
  }
  let text: string;
  try {
    text = JSON.stringify(value);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`${name} must contain only JSON values: ${detail}`);
  }
  const parsed = JSON.parse(text) as unknown;
  if (!isDeepStrictEqual(value, parsed)) {
    throw new Error(`${name} must contain only lossless JSON values`);
  }
  return parsed as T;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.${Math.random()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

/**
 * BatonSession 内 Plugin 配置身份的事实来源。Resource、Proposal 等运行数据仍由各自 Store 管理。
 */
export class PluginInstanceStore {
  readonly batonSessionId: string;
  readonly session: Readonly<Pick<SessionHandle, "id" | "dir">>;
  private readonly now: () => Date;

  constructor(options: PluginInstanceStoreOptions) {
    assertPathSegment("batonSessionId", options.session.id);
    this.session = Object.freeze({
      id: options.session.id,
      dir: options.session.dir,
    });
    this.batonSessionId = options.session.id;
    this.now = options.now ?? (() => new Date());
  }

  create(input: CreatePluginInstance): PluginInstance {
    const pluginInstanceId = input.pluginInstanceId ?? newId("pi");
    assertPathSegment("pluginInstanceId", pluginInstanceId);
    nonEmptyString("pluginId", input.pluginId);
    nonEmptyString("packageVersion", input.packageVersion);
    if (input.enabled !== undefined && typeof input.enabled !== "boolean") {
      throw new Error("enabled must be a boolean");
    }
    const config = jsonObject("config", input.config ?? {});
    const path = this.instancePath(pluginInstanceId);
    return withFileLock(path, () => {
      if (existsSync(path)) {
        throw new Error(`plugin instance already exists: ${pluginInstanceId}`);
      }
      const timestamp = this.timestamp();
      const instance: PluginInstance = {
        pluginInstanceId,
        batonSessionId: this.batonSessionId,
        pluginId: input.pluginId,
        packageVersion: input.packageVersion,
        enabled: input.enabled ?? true,
        config,
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      writeJsonAtomic(path, instance);
      return deepFreeze(instance);
    });
  }

  get(pluginInstanceId: string): PluginInstance {
    assertPathSegment("pluginInstanceId", pluginInstanceId);
    return this.readInstance(this.instancePath(pluginInstanceId), pluginInstanceId);
  }

  list(): PluginInstance[] {
    const directory = this.pluginsDir();
    if (!existsSync(directory)) return [];
    const instances: PluginInstance[] = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const path = this.instancePath(entry.name);
      if (!existsSync(path)) continue;
      assertPathSegment("pluginInstanceId", entry.name);
      instances.push(this.readInstance(path, entry.name));
    }
    return instances.sort((left, right) =>
      left.pluginInstanceId.localeCompare(right.pluginInstanceId),
    );
  }

  setEnabled(pluginInstanceId: string, enabled: boolean): PluginInstance {
    if (typeof enabled !== "boolean") throw new Error("enabled must be a boolean");
    return this.update(pluginInstanceId, (current) =>
      current.enabled === enabled ? current : { ...current, enabled },
    );
  }

  replaceConfig(pluginInstanceId: string, config: PluginConfig): PluginInstance {
    const nextConfig = jsonObject("config", config);
    return this.update(pluginInstanceId, (current) =>
      isDeepStrictEqual(current.config, nextConfig)
        ? current
        : { ...current, config: nextConfig },
    );
  }

  private update(
    pluginInstanceId: string,
    mutate: (current: PluginInstance) => PluginInstance,
  ): PluginInstance {
    assertPathSegment("pluginInstanceId", pluginInstanceId);
    const path = this.instancePath(pluginInstanceId);
    return withFileLock(path, () => {
      const current = this.readInstance(path, pluginInstanceId);
      const changed = mutate(current);
      if (changed === current) return current;
      const next = {
        ...changed,
        updatedAt: this.timestamp(),
      };
      writeJsonAtomic(path, next);
      return deepFreeze(next);
    });
  }

  private readInstance(path: string, expectedId: string): PluginInstance {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`plugin instance not found: ${expectedId}`);
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`could not read plugin instance ${path}: ${detail}`);
    }
    try {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("root must be a JSON object");
      }
      const instance = value as Partial<PluginInstance>;
      if (instance.pluginInstanceId !== expectedId) {
        throw new Error(`pluginInstanceId must be ${expectedId}`);
      }
      if (instance.batonSessionId !== this.batonSessionId) {
        throw new Error(`batonSessionId must be ${this.batonSessionId}`);
      }
      nonEmptyString("pluginId", instance.pluginId);
      nonEmptyString("packageVersion", instance.packageVersion);
      if (typeof instance.enabled !== "boolean") {
        throw new Error("enabled must be a boolean");
      }
      const config = jsonObject("config", instance.config as PluginConfig);
      isoTimestamp("createdAt", instance.createdAt);
      isoTimestamp("updatedAt", instance.updatedAt);
      return deepFreeze({
        pluginInstanceId: instance.pluginInstanceId,
        batonSessionId: instance.batonSessionId,
        pluginId: instance.pluginId,
        packageVersion: instance.packageVersion,
        enabled: instance.enabled,
        config,
        createdAt: instance.createdAt,
        updatedAt: instance.updatedAt,
      });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`invalid plugin instance ${path}: ${detail}`);
    }
  }

  private timestamp(): string {
    const now = this.now();
    if (Number.isNaN(now.getTime())) {
      throw new Error("PluginInstanceStore now() returned an invalid Date");
    }
    return now.toISOString();
  }

  private pluginsDir(): string {
    return join(this.session.dir, "plugins");
  }

  private instancePath(pluginInstanceId: string): string {
    return join(this.pluginsDir(), pluginInstanceId, "instance.json");
  }
}
