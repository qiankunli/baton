import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  loadModelPreferences,
  modelPreferencesPath,
  saveModelPreference,
} from "../src/config/model-preferences.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baton-model-preferences-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("model preferences", () => {
  test("stores runtime preferences under the state directory", () => {
    expect(modelPreferencesPath(root)).toBe(join(root, "state", "model.json"));
  });

  test("remembers the latest explicit model per HarnessTarget", () => {
    saveModelPreference(root, "codex-a", "gpt-5");
    saveModelPreference(root, "codex-b", "gpt-5-mini");

    expect(loadModelPreferences(root)).toEqual({ "codex-a": "gpt-5", "codex-b": "gpt-5-mini" });
  });

  test("selecting default clears only that Target preference", () => {
    saveModelPreference(root, "codex-a", "gpt-5");
    saveModelPreference(root, "codex-b", "gpt-5-mini");
    saveModelPreference(root, "codex-a", "default");

    expect(loadModelPreferences(root)).toEqual({ "codex-b": "gpt-5-mini" });
  });
});
