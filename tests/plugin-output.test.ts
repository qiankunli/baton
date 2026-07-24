import { describe, expect, test } from "bun:test";

import { validatePluginOutput } from "../src/plugin/output.ts";

describe("PluginOutput", () => {
  test("accepts the Baton-owned proposed-input kind", () => {
    expect(() =>
      validatePluginOutput({
        kind: "proposed-input",
        text: "Continue the task.",
      }),
    ).not.toThrow();
  });

  test("rejects unknown kinds and empty proposed input", () => {
    expect(() =>
      validatePluginOutput({ kind: "custom-output", text: "anything" }),
    ).toThrow("unsupported PluginOutput kind");
    expect(() =>
      validatePluginOutput({ kind: "proposed-input", text: " " }),
    ).toThrow("proposed-input text must not be empty");
  });
});
