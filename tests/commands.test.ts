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
    expect(parseCommand("/sessions")).toMatchObject({
      definition: { name: "sessions", scope: "baton", runPolicy: "idle" },
      argument: "",
    });
    expect(parseCommand("/new")).toMatchObject({
      definition: { name: "new", scope: "baton", runPolicy: "idle" },
      argument: "",
    });
  });

  test("accepts unique command prefixes", () => {
    expect(parseCommand("/pro claude")).toMatchObject({
      definition: { name: "provider" },
      argument: "claude",
    });
    expect(parseCommand("/m sonnet")).toMatchObject({
      definition: { name: "model" },
      argument: "sonnet",
    });
    expect(parseCommand("/s")).toMatchObject({
      definition: { name: "sessions" },
      argument: "",
    });
  });

  test("does not retain old provider aliases or consume unknown slash prompts", () => {
    expect(parseCommand("/claude")).toBeNull();
    expect(parseCommand("/codex hello")).toBeNull();
    expect(parseCommand("/tmp/project")).toBeNull();
  });

  test("currently bundled provider values are explicit", () => {
    expect(parseProvider("Claude")).toBe("claude");
    expect(parseProvider("codex")).toBe("codex");
    expect(parseProvider("other")).toBeNull();
  });
});
