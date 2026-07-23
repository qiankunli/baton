// ~/.baton/config.yaml：用户级配置。优先级 env > config.yaml > 默认值。
// 首次运行自动生成默认文件，用户直接编辑即可。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parse, stringify } from "yaml";

import { parseHarness, type HarnessName } from "../harness/ids.ts";

export interface BatonConfig {
  /** 打开 TUI / REPL 时的默认 agent（canonical harness id） */
  defaultAgent: HarnessName;
  /** claude 可执行文件路径（如公司包装器 reclaude）；env BATON_CLAUDE_BIN 优先 */
  claudeExecutable?: string;
  /** codex 启动命令（headless 必须是 app-server 形态） */
  codexCommand: string[];
  /**
   * codex 审批人（approvals_reviewer）。**缺省不设 = 跟随 codex 自己的解析**
   * （~/.codex/config.toml、profile、企业 requirements 照常生效，codex 自身默认是 user）。
   * 显式设了才作为 thread/start 参数下发，是一次 opt-in 覆盖。
   * baton 不替 codex 定审批的安全默认。见 docs/approval-lifecycle.md。
   */
  codexApprovalReviewer?: "user" | "auto_review";
  /** @ 引用与同会话 harness 同步的摘要预算（字符） */
  mentionBudgetChars: number;
  /** 是否在时间线里显示 agent 的思考过程（reasoning 流） */
  showThoughts: boolean;
}

// codexApprovalReviewer 有意不列：缺省就是"不下发、跟随 codex"。
export const DEFAULT_CONFIG: BatonConfig = {
  defaultAgent: "codex",
  codexCommand: ["codex", "app-server"],
  mentionBudgetChars: 4096,
  showThoughts: true,
};

export function batonRoot(rootDir?: string): string {
  return rootDir ?? join(homedir(), ".baton");
}

export function configPath(rootDir?: string): string {
  return join(batonRoot(rootDir), "config.yaml");
}

/** 不存在则写入默认配置，返回文件路径。只在入口调用一次，load 本身无副作用。 */
export function ensureConfigFile(rootDir?: string): string {
  const path = configPath(rootDir);
  if (!existsSync(path)) {
    mkdirSync(batonRoot(rootDir), { recursive: true });
    writeFileSync(path, stringify(DEFAULT_CONFIG));
  }
  return path;
}

export function loadConfig(rootDir?: string): BatonConfig {
  let fromFile: Partial<BatonConfig> = {};
  const path = configPath(rootDir);
  if (existsSync(path)) {
    try {
      fromFile = (parse(readFileSync(path, "utf8")) ?? {}) as Partial<BatonConfig>;
    } catch {
      fromFile = {};
    }
  }
  const merged: BatonConfig = {
    ...DEFAULT_CONFIG,
    ...fromFile,
    codexCommand:
      Array.isArray(fromFile.codexCommand) && fromFile.codexCommand.length > 0
        ? fromFile.codexCommand
        : DEFAULT_CONFIG.codexCommand,
  };
  merged.defaultAgent =
    typeof merged.defaultAgent === "string"
      ? (parseHarness(merged.defaultAgent) ?? DEFAULT_CONFIG.defaultAgent)
      : DEFAULT_CONFIG.defaultAgent;
  if (!Number.isFinite(merged.mentionBudgetChars) || merged.mentionBudgetChars <= 0) {
    merged.mentionBudgetChars = DEFAULT_CONFIG.mentionBudgetChars;
  }
  if (typeof merged.showThoughts !== "boolean") {
    merged.showThoughts = DEFAULT_CONFIG.showThoughts;
  }
  // 只接受已知取值；其余（含缺省）落回 undefined = 不下发、跟随 codex 自己的解析。
  // 这里**不推导生效值**：曾经为了让 footer 准确，config 复刻了一遍 codex 的方言解析，
  // 但那必然算错——企业 requirements 能覆盖用户配置和启动参数。生效值只由 codex 回吐，
  // 见 CodexAdapter.approvalRoute。
  if (merged.codexApprovalReviewer !== "auto_review" && merged.codexApprovalReviewer !== "user") {
    merged.codexApprovalReviewer = undefined;
  }
  if (process.env.BATON_CLAUDE_BIN) merged.claudeExecutable = process.env.BATON_CLAUDE_BIN;
  return merged;
}
