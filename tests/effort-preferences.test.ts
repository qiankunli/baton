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

  test("remembers the latest explicit effort per HarnessTarget", () => {
    saveEffortPreference(root, "codex-a", "high");
    saveEffortPreference(root, "codex-b", "xhigh");

    expect(loadEffortPreferences(root)).toEqual({ "codex-a": "high", "codex-b": "xhigh" });
  });

  test("selecting default clears only that Target preference", () => {
    saveEffortPreference(root, "codex-a", "high");
    saveEffortPreference(root, "codex-b", "xhigh");
    saveEffortPreference(root, "codex-a", "default");

    expect(loadEffortPreferences(root)).toEqual({ "codex-b": "xhigh" });
  });
});
