// ~/.baton/settings.json：用户级配置。优先级 env > settings.json > 默认值。
// 首次运行自动生成默认文件，用户直接编辑即可（ensureSettingsFile）。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface BatonSettings {
  /** 打开 TUI / REPL 时的默认 agent */
  defaultAgent: "codex" | "claude";
  /** claude 可执行文件路径（如公司包装器 reclaude）；env BATON_CLAUDE_BIN 优先 */
  claudeExecutable?: string;
  /** codex 启动命令（headless 必须是 app-server 形态） */
  codexCommand: string[];
  /** @ 引用与跨 agent 补课注入的摘要预算（字符） */
  mentionBudgetChars: number;
  /** 是否在时间线里显示 agent 的思考过程（reasoning 流） */
  showThoughts: boolean;
}

export const DEFAULT_SETTINGS: BatonSettings = {
  defaultAgent: "codex",
  codexCommand: ["codex", "app-server"],
  mentionBudgetChars: 4096,
  showThoughts: true,
};

export function batonRoot(rootDir?: string): string {
  return rootDir ?? join(homedir(), ".baton");
}

export function settingsPath(rootDir?: string): string {
  return join(batonRoot(rootDir), "settings.json");
}

/** 不存在则写入默认配置，返回文件路径。只在入口调用一次，load 本身无副作用。 */
export function ensureSettingsFile(rootDir?: string): string {
  const path = settingsPath(rootDir);
  if (!existsSync(path)) {
    mkdirSync(batonRoot(rootDir), { recursive: true });
    writeFileSync(path, `${JSON.stringify(DEFAULT_SETTINGS, null, 2)}\n`);
  }
  return path;
}

export function loadSettings(rootDir?: string): BatonSettings {
  let fromFile: Partial<BatonSettings> = {};
  const path = settingsPath(rootDir);
  if (existsSync(path)) {
    try {
      fromFile = JSON.parse(readFileSync(path, "utf8")) as Partial<BatonSettings>;
    } catch {
      // 配置损坏时按默认跑，不让入口崩掉；用户改坏 JSON 是常见操作
      fromFile = {};
    }
  }
  const merged: BatonSettings = {
    ...DEFAULT_SETTINGS,
    ...fromFile,
    codexCommand:
      Array.isArray(fromFile.codexCommand) && fromFile.codexCommand.length > 0
        ? fromFile.codexCommand
        : DEFAULT_SETTINGS.codexCommand,
  };
  if (merged.defaultAgent !== "codex" && merged.defaultAgent !== "claude") {
    merged.defaultAgent = DEFAULT_SETTINGS.defaultAgent;
  }
  if (!Number.isFinite(merged.mentionBudgetChars) || merged.mentionBudgetChars <= 0) {
    merged.mentionBudgetChars = DEFAULT_SETTINGS.mentionBudgetChars;
  }
  if (typeof merged.showThoughts !== "boolean") {
    merged.showThoughts = DEFAULT_SETTINGS.showThoughts;
  }
  // env 覆盖：机器相关路径优先走环境变量（也方便一次性切换测试）
  if (process.env.BATON_CLAUDE_BIN) merged.claudeExecutable = process.env.BATON_CLAUDE_BIN;
  return merged;
}
