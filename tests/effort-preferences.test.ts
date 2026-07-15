import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  effortPreferencesPath,
  loadEffortPreferences,
  saveEffortPreference,
} from "../src/config/effort-preferences.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baton-effort-preferences-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("effort preferences", () => {
  test("stores runtime preferences under the state directory", () => {
    expect(effortPreferencesPath(root)).toBe(join(root, "state", "effort.json"));
  });

  test("remembers the latest explicit effort per provider", () => {
    saveEffortPreference(root, "claude", "high");
    saveEffortPreference(root, "codex", "xhigh");

    expect(loadEffortPreferences(root)).toEqual({ claude: "high", codex: "xhigh" });
  });

  test("selecting default clears only that provider preference", () => {
    saveEffortPreference(root, "claude", "high");
    saveEffortPreference(root, "codex", "xhigh");
    saveEffortPreference(root, "claude", "default");

    expect(loadEffortPreferences(root)).toEqual({ codex: "xhigh" });
  });
});
