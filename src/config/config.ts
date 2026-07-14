// ~/.baton/config.yaml：用户级配置。优先级 env > config.yaml > 默认值。
// 首次运行自动生成默认文件，用户直接编辑即可。

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { parse, stringify } from "yaml";

import { parseProvider, type ProviderName } from "../providers/ids.ts";

export interface BatonConfig {
  /** 打开 TUI / REPL 时的默认 agent（canonical provider id） */
  defaultAgent: ProviderName;
  /** claude 可执行文件路径（如公司包装器 reclaude）；env BATON_CLAUDE_BIN 优先 */
  claudeExecutable?: string;
  /** codex 启动命令（headless 必须是 app-server 形态） */
  codexCommand: string[];
  /**
   * codex 审批人（approvals_reviewer）。缺省 = baton 强制 "auto_review"，由 reviewer
   * 处理越界审批并留下回执；显式设为 "user" 才回到 TUI 人工审批。见
   * docs/approval-lifecycle.md。用户命令里已写死则不受此项影响。
   */
  codexApprovalReviewer?: "user" | "auto_review";
  /** @ 引用与同会话 provider 同步的摘要预算（字符） */
  mentionBudgetChars: number;
  /** 是否在时间线里显示 agent 的思考过程（reasoning 流） */
  showThoughts: boolean;
}

export const DEFAULT_CONFIG: BatonConfig = {
  defaultAgent: "codex",
  codexCommand: ["codex", "app-server"],
  codexApprovalReviewer: "auto_review",
  mentionBudgetChars: 4096,
  showThoughts: true,
};

export function batonRoot(rootDir?: string): string {
  return rootDir ?? join(homedir(), ".baton");
}

export function configPath(rootDir?: string): string {
  return join(batonRoot(rootDir), "config.yaml");
}

function commandApprovalReviewer(command: string[]): "user" | "auto_review" | undefined {
  const override = command.find((arg) => arg.includes("approvals_reviewer"));
  if (!override) return undefined;
  if (/approvals_reviewer\s*=\s*["']?(auto_review|guardian_subagent)/.test(override)) return "auto_review";
  if (/approvals_reviewer\s*=\s*["']?user/.test(override)) return "user";
  return undefined;
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
      ? (parseProvider(merged.defaultAgent) ?? DEFAULT_CONFIG.defaultAgent)
      : DEFAULT_CONFIG.defaultAgent;
  if (!Number.isFinite(merged.mentionBudgetChars) || merged.mentionBudgetChars <= 0) {
    merged.mentionBudgetChars = DEFAULT_CONFIG.mentionBudgetChars;
  }
  if (typeof merged.showThoughts !== "boolean") {
    merged.showThoughts = DEFAULT_CONFIG.showThoughts;
  }
  // 只接受已知取值，其余回到 baton 默认 reviewer，避免 wire 与 Agent Status 认知不一致。
  const configuredReviewer =
    merged.codexApprovalReviewer === "auto_review" || merged.codexApprovalReviewer === "user"
      ? merged.codexApprovalReviewer
      : DEFAULT_CONFIG.codexApprovalReviewer;
  // codexCommand 是更底层的显式逃生口；投影也必须拿到实际生效值，避免 footer 误报委托状态。
  merged.codexApprovalReviewer = merged.codexCommand.some((arg) => arg.includes("approvals_reviewer"))
    ? commandApprovalReviewer(merged.codexCommand)
    : configuredReviewer;
  if (process.env.BATON_CLAUDE_BIN) merged.claudeExecutable = process.env.BATON_CLAUDE_BIN;
  return merged;
}
