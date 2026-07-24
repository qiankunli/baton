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
import { basename, dirname, join } from "node:path";

import { newId } from "../event/ids.ts";
import { withAsyncFileLock, withFileLock } from "../store/file-lock.ts";
import type { SessionHandle } from "../store/store.ts";

export interface PluginResourceMetadata {
  resourceId: string;
  batonSessionId: string;
  pluginInstanceId: string;
  generation: number;
  resourceVersion: number;
  createdAt: string;
  updatedAt: string;
  /** Baton 持久化的单次唤醒时间；到期后是否继续调度仍由下一次 reconcile 决定。 */
  nextReconcileAt?: string;
}

export interface PluginResource<TSpec = Record<string, unknown>, TStatus = Record<string, unknown>> {
  kind: string;
  metadata: PluginResourceMetadata;
  spec: TSpec;
  status: TStatus;
}

export interface PluginResourceStoreOptions {
  session: Pick<SessionHandle, "id" | "dir">;
  pluginInstanceId: string;
}

interface MutationOptions {
  expectedResourceVersion?: number;
}

interface CreateResource<TSpec, TStatus> {
  kind: string;
  resourceId?: string;
  spec: TSpec;
  status?: TStatus;
}

const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

function assertPathSegment(name: string, value: string): void {
  if (!PATH_SEGMENT.test(value) || value === "." || value === "..") {
    throw new Error(`${name} must be a non-empty stable identifier without path separators`);
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

function positiveInteger(name: string, value: unknown): asserts value is number {
  if (!Number.isInteger(value) || (value as number) < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function isoTimestamp(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || Number.isNaN(Date.parse(value))) {
    throw new Error(`${name} must be an ISO timestamp`);
  }
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

export class PluginResourceStore {
  private readonly sessionDir: string;
  readonly batonSessionId: string;
  readonly pluginInstanceId: string;

  constructor(options: PluginResourceStoreOptions) {
    assertPathSegment("batonSessionId", options.session.id);
    assertPathSegment("pluginInstanceId", options.pluginInstanceId);
    this.sessionDir = options.session.dir;
    this.batonSessionId = options.session.id;
    this.pluginInstanceId = options.pluginInstanceId;
  }

  create<TSpec, TStatus = Record<string, unknown>>(
    input: CreateResource<TSpec, TStatus>,
  ): PluginResource<TSpec, TStatus> {
    assertPathSegment("kind", input.kind);
    const resourceId = input.resourceId ?? newId("pr");
    assertPathSegment("resourceId", resourceId);
    const path = this.resourcePath(input.kind, resourceId);
    return withFileLock(path, () => {
      if (existsSync(path)) {
        throw new Error(`plugin resource already exists: ${input.kind}/${resourceId}`);
      }
      const now = new Date().toISOString();
      const resource: PluginResource<TSpec, TStatus> = {
        kind: input.kind,
        metadata: {
          resourceId,
          batonSessionId: this.batonSessionId,
          pluginInstanceId: this.pluginInstanceId,
          generation: 1,
          resourceVersion: 1,
          createdAt: now,
          updatedAt: now,
        },
        spec: jsonObject("spec", input.spec),
        status: jsonObject("status", input.status ?? ({} as TStatus)),
      };
      writeJsonAtomic(path, resource);
      return resource;
    });
  }

  get<TSpec = Record<string, unknown>, TStatus = Record<string, unknown>>(
    kind: string,
    resourceId: string,
  ): PluginResource<TSpec, TStatus> {
    assertPathSegment("kind", kind);
    assertPathSegment("resourceId", resourceId);
    return this.readResource<TSpec, TStatus>(kind, resourceId);
  }

  list<TSpec = Record<string, unknown>, TStatus = Record<string, unknown>>(
    kind?: string,
  ): PluginResource<TSpec, TStatus>[] {
    if (kind !== undefined) assertPathSegment("kind", kind);
    const kindsDir = this.resourcesDir();
    if (!existsSync(kindsDir)) return [];
    const kinds =
      kind === undefined
        ? readdirSync(kindsDir, { withFileTypes: true })
            .filter((entry) => entry.isDirectory())
            .map((entry) => entry.name)
        : [kind];
    const resources: PluginResource<TSpec, TStatus>[] = [];
    for (const resourceKind of kinds) {
      const kindDir = join(kindsDir, resourceKind);
      if (!existsSync(kindDir)) continue;
      for (const entry of readdirSync(kindDir, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        resources.push(
          this.readResource<TSpec, TStatus>(resourceKind, basename(entry.name, ".json")),
        );
      }
    }
    return resources.sort(
      (left, right) =>
        left.kind.localeCompare(right.kind) ||
        left.metadata.resourceId.localeCompare(right.metadata.resourceId),
    );
  }

  replaceSpec<TSpec, TStatus = Record<string, unknown>>(
    kind: string,
    resourceId: string,
    spec: TSpec,
    options: MutationOptions = {},
  ): PluginResource<TSpec, TStatus> {
    const nextSpec = jsonObject("spec", spec);
    return this.mutate<TSpec, TStatus>(kind, resourceId, options, (current) => {
      if (isDeepStrictEqual(current.spec, nextSpec)) return current;
      return {
        ...current,
        metadata: {
          ...current.metadata,
          generation: current.metadata.generation + 1,
          resourceVersion: current.metadata.resourceVersion + 1,
          updatedAt: new Date().toISOString(),
        },
        spec: nextSpec,
      };
    });
  }

  patchStatus<TSpec = Record<string, unknown>, TStatus = Record<string, unknown>>(
    kind: string,
    resourceId: string,
    patch: Partial<TStatus>,
    options: MutationOptions = {},
  ): PluginResource<TSpec, TStatus> {
    const statusPatch = jsonObject("status patch", patch);
    return this.mutate<TSpec, TStatus>(kind, resourceId, options, (current) => {
      const status = { ...current.status, ...statusPatch };
      if (isDeepStrictEqual(current.status, status)) return current;
      return {
        ...current,
        metadata: {
          ...current.metadata,
          resourceVersion: current.metadata.resourceVersion + 1,
          updatedAt: new Date().toISOString(),
        },
        status,
      };
    });
  }

  setNextReconcileAt<TSpec = Record<string, unknown>, TStatus = Record<string, unknown>>(
    kind: string,
    resourceId: string,
    next: Date | null,
    options: MutationOptions = {},
  ): PluginResource<TSpec, TStatus> {
    if (next && Number.isNaN(next.getTime())) throw new Error("nextReconcileAt must be a valid Date");
    const nextReconcileAt = next?.toISOString();
    return this.mutate<TSpec, TStatus>(kind, resourceId, options, (current) => {
      if (current.metadata.nextReconcileAt === nextReconcileAt) return current;
      const metadata = { ...current.metadata };
      if (nextReconcileAt === undefined) delete metadata.nextReconcileAt;
      else metadata.nextReconcileAt = nextReconcileAt;
      metadata.resourceVersion += 1;
      metadata.updatedAt = new Date().toISOString();
      return { ...current, metadata };
    });
  }

  /**
   * 只串行化同一 Resource 的 Reconciler，不阻止用户并发更新 spec。
   * Controller 仍须用 resourceVersion 拒绝基于旧 snapshot 的 status 或调度写入。
   */
  withReconcileLock<T>(
    kind: string,
    resourceId: string,
    reconcile: () => Promise<T>,
  ): Promise<T> {
    assertPathSegment("kind", kind);
    assertPathSegment("resourceId", resourceId);
    return withAsyncFileLock(`${this.resourcePath(kind, resourceId)}.reconcile`, reconcile);
  }

  private mutate<TSpec, TStatus>(
    kind: string,
    resourceId: string,
    options: MutationOptions,
    update: (current: PluginResource<TSpec, TStatus>) => PluginResource<TSpec, TStatus>,
  ): PluginResource<TSpec, TStatus> {
    assertPathSegment("kind", kind);
    assertPathSegment("resourceId", resourceId);
    const path = this.resourcePath(kind, resourceId);
    return withFileLock(path, () => {
      const current = this.readResource<TSpec, TStatus>(kind, resourceId);
      if (
        options.expectedResourceVersion !== undefined &&
        options.expectedResourceVersion !== current.metadata.resourceVersion
      ) {
        throw new Error(
          `plugin resource version conflict: expected ${options.expectedResourceVersion}, current ${current.metadata.resourceVersion}`,
        );
      }
      const next = update(current);
      if (!isDeepStrictEqual(current, next)) writeJsonAtomic(path, next);
      return next;
    });
  }

  private readResource<TSpec, TStatus>(
    kind: string,
    resourceId: string,
  ): PluginResource<TSpec, TStatus> {
    const path = this.resourcePath(kind, resourceId);
    let parsed: unknown;
    try {
      parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`plugin resource not found: ${kind}/${resourceId}`);
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`could not read plugin resource ${path}: ${detail}`);
    }
    return this.validateResource<TSpec, TStatus>(path, kind, resourceId, parsed);
  }

  private validateResource<TSpec, TStatus>(
    path: string,
    kind: string,
    resourceId: string,
    value: unknown,
  ): PluginResource<TSpec, TStatus> {
    try {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("root must be a JSON object");
      }
      const resource = value as Partial<PluginResource<TSpec, TStatus>>;
      if (resource.kind !== kind) throw new Error(`kind must be ${kind}`);
      const metadata = resource.metadata;
      if (!metadata || typeof metadata !== "object") throw new Error("metadata must be an object");
      if (metadata.resourceId !== resourceId) throw new Error(`resourceId must be ${resourceId}`);
      if (metadata.batonSessionId !== this.batonSessionId) {
        throw new Error(`batonSessionId must be ${this.batonSessionId}`);
      }
      if (metadata.pluginInstanceId !== this.pluginInstanceId) {
        throw new Error(`pluginInstanceId must be ${this.pluginInstanceId}`);
      }
      positiveInteger("metadata.generation", metadata.generation);
      positiveInteger("metadata.resourceVersion", metadata.resourceVersion);
      isoTimestamp("metadata.createdAt", metadata.createdAt);
      isoTimestamp("metadata.updatedAt", metadata.updatedAt);
      if (metadata.nextReconcileAt !== undefined) {
        isoTimestamp("metadata.nextReconcileAt", metadata.nextReconcileAt);
      }
      jsonObject("spec", resource.spec);
      jsonObject("status", resource.status);
      return resource as PluginResource<TSpec, TStatus>;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`invalid plugin resource ${path}: ${detail}`);
    }
  }

  private resourcesDir(): string {
    return join(
      this.sessionDir,
      "plugins",
      this.pluginInstanceId,
      "resources",
    );
  }

  private resourcePath(kind: string, resourceId: string): string {
    return join(this.resourcesDir(), kind, `${resourceId}.json`);
  }
}
