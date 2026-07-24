// Codex app-server 只提供 hooks/list，没有持久 trust 写接口。Baton 因而按 HarnessTarget
// 保存用户已审过的 hook 精确定义指纹；定义或执行目标变化时都重新询问。

import { createHash } from "node:crypto";
import {
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { HookTrustCandidate } from "../interaction/types.ts";
import { withFileLock } from "../store/file-lock.ts";
import { batonRoot } from "./config.ts";

interface PersistedHookState extends Record<string, unknown> {
  trust?: unknown;
}

export interface HookTrustStore {
  isTrusted(hook: HookTrustCandidate): boolean;
  trust(hooks: HookTrustCandidate[]): void;
  /** 读取失败时 fail closed，同时把可见诊断交给 adapter 投影。 */
  takeWarnings?(): string[];
}

export function hookStatePath(rootDir?: string): string {
  return join(batonRoot(rootDir), "state", "hook.json");
}

/** currentHash 是 Codex 对完整 hook definition 的权威指纹；缺失时用同字段稳定降级。 */
export function hookTrustFingerprint(hook: HookTrustCandidate): string {
  if (hook.currentHash?.trim()) return hook.currentHash;
  return `baton-sha256:${createHash("sha256")
    .update(
      JSON.stringify({
        key: hook.key,
        source: hook.source,
        sourcePath: hook.sourcePath,
        command: hook.command,
        matcher: hook.matcher ?? null,
        pluginId: hook.pluginId ?? null,
        handlerType: hook.handlerType ?? null,
        timeoutSec: hook.timeoutSec ?? null,
        statusMessage: hook.statusMessage ?? null,
      }),
    )
    .digest("hex")}`;
}

interface LoadedHookState {
  state: PersistedHookState;
  error?: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function loadHookState(rootDir?: string): LoadedHookState {
  const path = hookStatePath(rootDir);
  try {
    const parsed = JSON.parse(readFileSync(path, "utf8")) as unknown;
    if (!isRecord(parsed)) return { state: {}, error: `${path} must contain a JSON object` };
    if (parsed.trust !== undefined && !isRecord(parsed.trust)) {
      return { state: parsed, error: `${path} field trust must be a JSON object` };
    }
    if (isRecord(parsed.trust) && parsed.trust.targets !== undefined && !isRecord(parsed.trust.targets)) {
      return { state: parsed, error: `${path} field trust.targets must be a JSON object` };
    }
    return { state: parsed };
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { state: {} };
    const detail = error instanceof Error ? error.message : String(error);
    return { state: {}, error: `could not read ${path}: ${detail}` };
  }
}

function trustedHooks(state: PersistedHookState): Record<string, Record<string, string>> {
  const trust = isRecord(state.trust) ? state.trust : {};
  const savedTargets = isRecord(trust.targets) ? trust.targets : {};
  const targets: Record<string, Record<string, string>> = {};
  for (const [harnessTargetId, rawHooks] of Object.entries(savedTargets)) {
    if (!harnessTargetId.trim() || !isRecord(rawHooks)) continue;
    targets[harnessTargetId] = Object.fromEntries(
      Object.entries(rawHooks).flatMap(([key, fingerprint]) =>
        key.trim() && typeof fingerprint === "string" && fingerprint.trim()
          ? [[key, fingerprint] as const]
          : [],
      ),
    );
  }
  return targets;
}

export class FileHookTrustStore implements HookTrustStore {
  private readonly warnings = new Set<string>();

  constructor(
    private readonly harnessTargetId: string,
    private readonly rootDir?: string,
  ) {}

  isTrusted(hook: HookTrustCandidate): boolean {
    const loaded = loadHookState(this.rootDir);
    if (loaded.error) {
      this.warnings.add(loaded.error);
      return false;
    }
    return trustedHooks(loaded.state)[this.harnessTargetId]?.[hook.key] === hookTrustFingerprint(hook);
  }

  takeWarnings(): string[] {
    const warnings = [...this.warnings];
    this.warnings.clear();
    return warnings;
  }

  trust(hooks: HookTrustCandidate[]): void {
    const path = hookStatePath(this.rootDir);
    withFileLock(path, () => {
      const loaded = loadHookState(this.rootDir);
      if (loaded.error) throw new Error(`Cannot update hook trust: ${loaded.error}`);
      const state = loaded.state;
      const trust = isRecord(state.trust) ? state.trust : {};
      const targets = isRecord(trust.targets) ? trust.targets : {};
      const savedTarget = targets[this.harnessTargetId];
      const existing = isRecord(savedTarget) ? savedTarget : {};
      const trusted = { ...existing };
      for (const hook of hooks) trusted[hook.key] = hookTrustFingerprint(hook);

      const next: PersistedHookState = {
        ...state,
        trust: { ...trust, targets: { ...targets, [this.harnessTargetId]: trusted } },
      };
      const temporary = `${path}.${process.pid}.tmp`;
      try {
        writeFileSync(temporary, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 });
        renameSync(temporary, path);
      } finally {
        rmSync(temporary, { force: true });
      }
    });
  }
}
