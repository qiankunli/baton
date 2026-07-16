// Codex app-server 只提供 hooks/list，没有持久 trust 写接口。Baton 因而按 provider 保存
// 用户已审过的 hook 精确定义指纹；后续定义完全相同时自动启用，任一字段变化就重新询问。

import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import type { HookTrustCandidate } from "../events/types.ts";
import { batonRoot } from "./config.ts";

interface PersistedHookState {
  trust?: {
    providers?: Record<string, unknown>;
  };
}

export interface HookTrustStore {
  isTrusted(provider: string, hook: HookTrustCandidate): boolean;
  trust(provider: string, hooks: HookTrustCandidate[]): void;
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

function loadTrustedHooks(rootDir?: string): Record<string, Record<string, string>> {
  const path = hookStatePath(rootDir);
  if (!existsSync(path)) return {};
  try {
    const persisted = JSON.parse(readFileSync(path, "utf8")) as PersistedHookState;
    const savedProviders = persisted.trust?.providers;
    if (!savedProviders || typeof savedProviders !== "object") return {};
    const providers: Record<string, Record<string, string>> = {};
    for (const [provider, rawHooks] of Object.entries(savedProviders)) {
      if (!provider.trim() || !rawHooks || typeof rawHooks !== "object") continue;
      providers[provider] = Object.fromEntries(
        Object.entries(rawHooks as Record<string, unknown>).flatMap(([key, fingerprint]) =>
          key.trim() && typeof fingerprint === "string" && fingerprint.trim()
            ? [[key, fingerprint] as const]
            : [],
        ),
      );
    }
    return providers;
  } catch {
    return {};
  }
}

export class FileHookTrustStore implements HookTrustStore {
  constructor(private readonly rootDir?: string) {}

  isTrusted(provider: string, hook: HookTrustCandidate): boolean {
    return loadTrustedHooks(this.rootDir)[provider]?.[hook.key] === hookTrustFingerprint(hook);
  }

  trust(provider: string, hooks: HookTrustCandidate[]): void {
    const providers = loadTrustedHooks(this.rootDir);
    const trusted = (providers[provider] ??= {});
    for (const hook of hooks) trusted[hook.key] = hookTrustFingerprint(hook);

    const path = hookStatePath(this.rootDir);
    const temporary = `${path}.${process.pid}.tmp`;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(temporary, `${JSON.stringify({ trust: { providers } }, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  }
}
