// /effort 与 /model 一样是用户级运行偏好，不改写 config.yaml。session 自己已有的
// effort 优先；这里仅让新 BatonSession / 新进程沿用各 HarnessTarget 最近一次显式选择。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { batonRoot } from "./config.ts";

interface PersistedEffortPreferences {
  efforts?: Record<string, unknown>;
}

export function effortPreferencesPath(rootDir?: string): string {
  return join(batonRoot(rootDir), "state", "effort.json");
}

export function loadEffortPreferences(rootDir?: string): Record<string, string> {
  const path = effortPreferencesPath(rootDir);
  if (!existsSync(path)) return {};
  try {
    const persisted = JSON.parse(readFileSync(path, "utf8")) as PersistedEffortPreferences;
    if (!persisted.efforts || typeof persisted.efforts !== "object") return {};
    return Object.fromEntries(
      Object.entries(persisted.efforts).flatMap(([harnessTargetId, effort]) =>
        harnessTargetId.trim() && typeof effort === "string" && effort.trim() && effort !== "default"
          ? [[harnessTargetId, effort] as const]
          : [],
      ),
    );
  } catch {
    return {};
  }
}

/** `default` 表示重新跟随 Harness，因此删除该 Target 的持久偏好。 */
export function saveEffortPreference(rootDir: string, harnessTargetId: string, effort: string): void {
  const efforts = loadEffortPreferences(rootDir);
  if (!effort || effort === "default") delete efforts[harnessTargetId];
  else efforts[harnessTargetId] = effort;

  const path = effortPreferencesPath(rootDir);
  const temporary = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(temporary, `${JSON.stringify({ efforts }, null, 2)}\n`);
  renameSync(temporary, path);
}
