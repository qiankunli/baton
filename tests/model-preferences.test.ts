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

  test("remembers the latest explicit model per harness", () => {
    saveModelPreference(root, "claude", "sonnet");
    saveModelPreference(root, "codex", "gpt-5");

    expect(loadModelPreferences(root)).toEqual({ claude: "sonnet", codex: "gpt-5" });
  });

  test("selecting default clears only that harness preference", () => {
    saveModelPreference(root, "claude", "sonnet");
    saveModelPreference(root, "codex", "gpt-5");
    saveModelPreference(root, "claude", "default");

    expect(loadModelPreferences(root)).toEqual({ codex: "gpt-5" });
  });
});
