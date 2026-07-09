import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  DEFAULT_SETTINGS,
  ensureSettingsFile,
  loadSettings,
  settingsPath,
} from "../src/config/settings.ts";

let root: string;
let savedEnv: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baton-settings-"));
  savedEnv = process.env.BATON_CLAUDE_BIN;
  delete process.env.BATON_CLAUDE_BIN;
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  if (savedEnv === undefined) delete process.env.BATON_CLAUDE_BIN;
  else process.env.BATON_CLAUDE_BIN = savedEnv;
});

describe("settings", () => {
  test("missing file yields defaults", () => {
    expect(loadSettings(root)).toEqual(DEFAULT_SETTINGS);
  });

  test("ensureSettingsFile creates defaults once, keeps user edits", () => {
    const path = ensureSettingsFile(root);
    expect(existsSync(path)).toBe(true);
    writeFileSync(path, JSON.stringify({ defaultAgent: "claude" }));
    ensureSettingsFile(root); // 已存在：不覆盖
    expect(loadSettings(root).defaultAgent).toBe("claude");
  });

  test("partial file merges over defaults", () => {
    writeFileSync(settingsPath(root), JSON.stringify({ mentionBudgetChars: 8000 }));
    const s = loadSettings(root);
    expect(s.mentionBudgetChars).toBe(8000);
    expect(s.defaultAgent).toBe("codex");
    expect(s.codexCommand).toEqual(["codex", "app-server"]);
  });

  test("invalid values fall back to defaults", () => {
    writeFileSync(
      settingsPath(root),
      JSON.stringify({ defaultAgent: "gpt5", mentionBudgetChars: -1, codexCommand: [] }),
    );
    const s = loadSettings(root);
    expect(s.defaultAgent).toBe("codex");
    expect(s.mentionBudgetChars).toBe(DEFAULT_SETTINGS.mentionBudgetChars);
    expect(s.codexCommand).toEqual(["codex", "app-server"]);
  });

  test("corrupt json falls back to defaults instead of throwing", () => {
    writeFileSync(settingsPath(root), "{not json");
    expect(loadSettings(root)).toEqual(DEFAULT_SETTINGS);
  });

  test("env BATON_CLAUDE_BIN overrides file", () => {
    writeFileSync(settingsPath(root), JSON.stringify({ claudeExecutable: "/from/file" }));
    process.env.BATON_CLAUDE_BIN = "/from/env";
    expect(loadSettings(root).claudeExecutable).toBe("/from/env");
  });
});
