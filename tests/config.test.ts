import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  configPath,
  DEFAULT_CONFIG,
  ensureConfigFile,
  loadConfig,
} from "../src/config/config.ts";

let root: string;
let savedEnv: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baton-config-"));
  savedEnv = process.env.BATON_CLAUDE_BIN;
  delete process.env.BATON_CLAUDE_BIN;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.BATON_CLAUDE_BIN;
  else process.env.BATON_CLAUDE_BIN = savedEnv;
});

describe("config", () => {
  test("missing file yields defaults", () => {
    expect(loadConfig(root)).toEqual(DEFAULT_CONFIG);
  });

  test("ensureConfigFile creates defaults once and keeps user edits", () => {
    const path = ensureConfigFile(root);
    expect(path.endsWith("config.yaml")).toBe(true);
    expect(existsSync(path)).toBe(true);
    writeFileSync(path, "defaultAgent: claude\n");
    ensureConfigFile(root);
    expect(loadConfig(root).defaultAgent).toBe("claude");
  });

  test("partial file merges over defaults", () => {
    writeFileSync(configPath(root), "mentionBudgetChars: 8000\n");
    const config = loadConfig(root);
    expect(config.mentionBudgetChars).toBe(8000);
    expect(config.defaultAgent).toBe("codex");
    expect(config.codexCommand).toEqual(["codex", "app-server"]);
  });

  test("harness aliases are normalized to canonical ids", () => {
    writeFileSync(configPath(root), "defaultAgent: cc\n");
    expect(loadConfig(root).defaultAgent).toBe("claude");
  });

  test("invalid values fall back to defaults", () => {
    writeFileSync(configPath(root), "defaultAgent: gpt5\nmentionBudgetChars: -1\ncodexCommand: []\n");
    const config = loadConfig(root);
    expect(config.defaultAgent).toBe("codex");
    expect(config.mentionBudgetChars).toBe(DEFAULT_CONFIG.mentionBudgetChars);
    expect(config.codexCommand).toEqual(["codex", "app-server"]);
  });

  test("corrupt yaml falls back to defaults instead of throwing", () => {
    writeFileSync(configPath(root), "[not: yaml");
    expect(loadConfig(root)).toEqual(DEFAULT_CONFIG);
  });

  test("env BATON_CLAUDE_BIN overrides file", () => {
    writeFileSync(configPath(root), "claudeExecutable: /from/file\n");
    process.env.BATON_CLAUDE_BIN = "/from/env";
    expect(loadConfig(root).claudeExecutable).toBe("/from/env");
  });

  test("codexApprovalReviewer accepts known values only", () => {
    writeFileSync(configPath(root), "codexApprovalReviewer: auto_review\n");
    expect(loadConfig(root).codexApprovalReviewer).toBe("auto_review");
    writeFileSync(configPath(root), "codexApprovalReviewer: user\n");
    expect(loadConfig(root).codexApprovalReviewer).toBe("user");
  });

  // 缺省不下发 = 跟随 codex 自己的解析（config.toml / profile / 企业 requirements 照常
  // 生效，codex 自身默认就是 user）。baton 不替 codex 定审批的安全默认。
  test("an absent or unknown reviewer stays unset — codex decides for itself", () => {
    writeFileSync(configPath(root), "defaultAgent: codex\n");
    expect(loadConfig(root).codexApprovalReviewer).toBeUndefined();
    writeFileSync(configPath(root), "codexApprovalReviewer: yolo\n");
    expect(loadConfig(root).codexApprovalReviewer).toBeUndefined();
  });

  // config 不再推导生效值：它曾复刻 codex 的方言解析来喂 footer，但那必然算错——
  // 企业 requirements 能覆盖用户配置和启动参数。生效值只认 codex 回吐（approvalRoute）。
  test("config does not second-guess the effective reviewer from codexCommand", () => {
    writeFileSync(
      configPath(root),
      'codexApprovalReviewer: user\ncodexCommand: [codex, -c, \'approvals_reviewer="auto_review"\', app-server]\n',
    );
    expect(loadConfig(root).codexApprovalReviewer).toBe("user");
  });
});
