import { describe, expect, test } from "bun:test";

import { parseCommand, parseProvider } from "../src/commands/registry.ts";

describe("baton command registry", () => {
  test("parses provider and model commands with arguments", () => {
    expect(parseCommand("/provider claude")).toMatchObject({
      definition: { name: "provider", scope: "baton", runPolicy: "always" },
      argument: "claude",
    });
    expect(parseCommand("/model sonnet")).toMatchObject({
      definition: { name: "model", scope: "provider", runPolicy: "always" },
      argument: "sonnet",
    });
  });

  test("does not retain old provider aliases or consume unknown slash prompts", () => {
    expect(parseCommand("/claude")).toBeNull();
    expect(parseCommand("/codex hello")).toBeNull();
    expect(parseCommand("/tmp/project")).toBeNull();
  });

  test("provider values are explicit and closed", () => {
    expect(parseProvider("Claude")).toBe("claude");
    expect(parseProvider("codex")).toBe("codex");
    expect(parseProvider("other")).toBeNull();
  });
});
