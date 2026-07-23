// /model 是用户级运行偏好，不改写手工维护的 config.yaml。按 harness 记住最近一次
// 显式选择，让新 BatonSession / 新进程沿用；session 自己已有的 model 仍优先。

import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

import { batonRoot } from "./config.ts";

interface PersistedModelPreferences {
  models?: Record<string, unknown>;
}

export function modelPreferencesPath(rootDir?: string): string {
  return join(batonRoot(rootDir), "state", "model.json");
}

export function loadModelPreferences(rootDir?: string): Record<string, string> {
  const path = modelPreferencesPath(rootDir);
  if (!existsSync(path)) return {};
  try {
    const persisted = JSON.parse(readFileSync(path, "utf8")) as PersistedModelPreferences;
    if (!persisted.models || typeof persisted.models !== "object") return {};
    return Object.fromEntries(
      Object.entries(persisted.models).flatMap(([harness, model]) =>
        harness.trim() && typeof model === "string" && model.trim() && model !== "default"
          ? [[harness, model] as const]
          : [],
      ),
    );
  } catch {
    return {};
  }
}

/** `default` 表示重新跟随 harness，因此删除该 harness 的持久偏好。 */
export function saveModelPreference(rootDir: string, harness: string, model: string): void {
  const models = loadModelPreferences(rootDir);
  if (!model || model === "default") delete models[harness];
  else models[harness] = model;

  const path = modelPreferencesPath(rootDir);
  const temporary = `${path}.${process.pid}.tmp`;
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(temporary, `${JSON.stringify({ models }, null, 2)}\n`);
  renameSync(temporary, path);
}
