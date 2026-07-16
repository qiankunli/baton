// Codex app-server 只提供 hooks/list，没有持久 trust 写接口。Baton 因而按 provider 保存
// 用户已审过的 hook 精确定义指纹；后续定义完全相同时自动启用，任一字段变化就重新询问。

import { createHash } from "node:crypto";
import {
  closeSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { dirname, join } from "node:path";

import type { HookTrustCandidate } from "../events/types.ts";
import { batonRoot } from "./config.ts";

interface PersistedHookState extends Record<string, unknown> {
  trust?: unknown;
}

export interface HookTrustStore {
  isTrusted(provider: string, hook: HookTrustCandidate): boolean;
  trust(provider: string, hooks: HookTrustCandidate[]): void;
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
    if (isRecord(parsed.trust) && parsed.trust.providers !== undefined && !isRecord(parsed.trust.providers)) {
      return { state: parsed, error: `${path} field trust.providers must be a JSON object` };
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
  const savedProviders = isRecord(trust.providers) ? trust.providers : {};
  const providers: Record<string, Record<string, string>> = {};
  for (const [provider, rawHooks] of Object.entries(savedProviders)) {
    if (!provider.trim() || !isRecord(rawHooks)) continue;
    providers[provider] = Object.fromEntries(
      Object.entries(rawHooks).flatMap(([key, fingerprint]) =>
        key.trim() && typeof fingerprint === "string" && fingerprint.trim()
          ? [[key, fingerprint] as const]
          : [],
      ),
    );
  }
  return providers;
}

const LOCK_WAIT_ARRAY = new Int32Array(new SharedArrayBuffer(4));
const LOCK_TIMEOUT_MS = 1_000;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

function removeStaleLock(lockPath: string): void {
  let observed: string;
  try {
    observed = readFileSync(lockPath, "utf8");
  } catch {
    return;
  }
  const holder = Number(observed.split(":", 1)[0]);
  if (Number.isFinite(holder) && holder > 0 && pidAlive(holder)) return;
  try {
    // 只删仍是刚才所见内容的 stale lock，避免释放与新持有者创建之间的竞态。
    if (readFileSync(lockPath, "utf8") === observed) rmSync(lockPath);
  } catch {
    // 持有者恰好释放或另一写者已接管，下一轮重试即可。
  }
}

function withHookStateLock<T>(path: string, update: () => T): T {
  const lockPath = `${path}.lock`;
  const token = `${process.pid}:${Date.now()}:${Math.random()}`;
  const deadline = Date.now() + LOCK_TIMEOUT_MS;
  mkdirSync(dirname(path), { recursive: true });
  for (;;) {
    let created = false;
    try {
      const fd = openSync(lockPath, "wx", 0o600);
      created = true;
      try {
        writeSync(fd, token);
      } finally {
        closeSync(fd);
      }
      break;
    } catch (error) {
      if (created) {
        try {
          rmSync(lockPath);
        } catch {
          // 原始写锁错误更有诊断价值；残锁会按 pid 规则回收。
        }
      }
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      removeStaleLock(lockPath);
      if (Date.now() >= deadline) throw new Error(`timed out waiting to update ${path}`);
      Atomics.wait(LOCK_WAIT_ARRAY, 0, 0, 10);
    }
  }
  try {
    return update();
  } finally {
    try {
      if (readFileSync(lockPath, "utf8") === token) rmSync(lockPath);
    } catch {
      // 写结果已经原子落盘；锁清理失败由下一位写者按 pid 回收。
    }
  }
}

export class FileHookTrustStore implements HookTrustStore {
  private readonly warnings = new Set<string>();

  constructor(private readonly rootDir?: string) {}

  isTrusted(provider: string, hook: HookTrustCandidate): boolean {
    const loaded = loadHookState(this.rootDir);
    if (loaded.error) {
      this.warnings.add(loaded.error);
      return false;
    }
    return trustedHooks(loaded.state)[provider]?.[hook.key] === hookTrustFingerprint(hook);
  }

  takeWarnings(): string[] {
    const warnings = [...this.warnings];
    this.warnings.clear();
    return warnings;
  }

  trust(provider: string, hooks: HookTrustCandidate[]): void {
    const path = hookStatePath(this.rootDir);
    withHookStateLock(path, () => {
      const loaded = loadHookState(this.rootDir);
      if (loaded.error) throw new Error(`Cannot update hook trust: ${loaded.error}`);
      const state = loaded.state;
      const trust = isRecord(state.trust) ? state.trust : {};
      const providers = isRecord(trust.providers) ? trust.providers : {};
      const existing = isRecord(providers[provider]) ? providers[provider] : {};
      const trusted = { ...existing };
      for (const hook of hooks) trusted[hook.key] = hookTrustFingerprint(hook);

      const next: PersistedHookState = {
        ...state,
        trust: { ...trust, providers: { ...providers, [provider]: trusted } },
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
