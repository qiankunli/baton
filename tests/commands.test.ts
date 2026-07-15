import { describe, expect, test } from "bun:test";
import { parseSlashCommand } from "chat-tui";

import { COMMANDS, parseProvider, parseProviderRoute } from "../src/commands/registry.ts";

// slash 解析实现在 chat-tui；这里锁的是"chat-tui 解析器 × baton 命令表"的组合行为。
describe("baton command registry", () => {
  test("parses direct provider commands and config arguments", () => {
    expect(parseSlashCommand("/claude", COMMANDS)).toEqual({ name: "claude", argument: "" });
    expect(parseSlashCommand("/codex", COMMANDS)).toEqual({ name: "codex", argument: "" });
    expect(parseSlashCommand("/codex fix this", COMMANDS)).toEqual({ name: "codex", argument: "fix this" });
    expect(parseSlashCommand("/claude review this", COMMANDS)).toEqual({ name: "claude", argument: "review this" });
    expect(parseSlashCommand("/model sonnet", COMMANDS)).toEqual({ name: "model", argument: "sonnet" });
    expect(parseSlashCommand("/effort high", COMMANDS)).toEqual({ name: "effort", argument: "high" });
    expect(parseSlashCommand("/compact", COMMANDS)).toEqual({ name: "compact", argument: "" });
    expect(parseSlashCommand("/sessions", COMMANDS)).toEqual({ name: "sessions", argument: "" });
    expect(parseSlashCommand("/status", COMMANDS)).toEqual({ name: "status", argument: "" });
    expect(parseSlashCommand("/new", COMMANDS)).toEqual({ name: "new", argument: "" });
  });

  test("accepts unique command prefixes", () => {
    expect(parseSlashCommand("/cl", COMMANDS)).toEqual({ name: "claude", argument: "" });
    expect(parseSlashCommand("/co", COMMANDS)).toBeNull();
    expect(parseSlashCommand("/cod", COMMANDS)).toEqual({ name: "codex", argument: "" });
    expect(parseSlashCommand("/com", COMMANDS)).toEqual({ name: "compact", argument: "" });
    expect(parseSlashCommand("/cla review this", COMMANDS)).toEqual({ name: "claude", argument: "review this" });
    expect(parseSlashCommand("/cod fix this", COMMANDS)).toEqual({ name: "codex", argument: "fix this" });
    expect(parseSlashCommand("/c", COMMANDS)).toBeNull();
    expect(parseSlashCommand("/m sonnet", COMMANDS)).toEqual({ name: "model", argument: "sonnet" });
    expect(parseSlashCommand("/ef high", COMMANDS)).toEqual({ name: "effort", argument: "high" });
    expect(parseSlashCommand("/e", COMMANDS)).toBeNull();
    expect(parseSlashCommand("/se", COMMANDS)).toEqual({ name: "sessions", argument: "" });
    expect(parseSlashCommand("/st", COMMANDS)).toEqual({ name: "status", argument: "" });
    expect(parseSlashCommand("/s", COMMANDS)).toBeNull();
  });

  test("does not retain /provider or consume unknown slash prompts", () => {
    expect(parseSlashCommand("/provider claude", COMMANDS)).toBeNull();
    expect(parseSlashCommand("/tmp/project", COMMANDS)).toBeNull();
  });

  test("routes provider aliases without registering them as slash commands", () => {
    expect(parseSlashCommand("/cc review this", COMMANDS)).toBeNull();
    expect(parseSlashCommand("/cx fix this", COMMANDS)).toBeNull();
    expect(COMMANDS.map((command) => command.name)).not.toContain("cc");
    expect(COMMANDS.map((command) => command.name)).not.toContain("cx");
    expect(parseProviderRoute("/cc  review this")).toEqual({
      kind: "matched",
      provider: "claude",
      message: "review this",
    });
    expect(parseProviderRoute("/cx fix this")).toEqual({ kind: "matched", provider: "codex", message: "fix this" });
    expect(parseProviderRoute("/cla review this")).toEqual({
      kind: "matched",
      provider: "claude",
      message: "review this",
    });
    expect(parseProviderRoute("/cod fix this")).toEqual({ kind: "matched", provider: "codex", message: "fix this" });
    expect(parseProviderRoute("/c ambiguous")).toEqual({
      kind: "ambiguous",
      token: "c",
      providers: ["codex", "claude"],
    });
  });

  test("currently bundled provider values are explicit", () => {
    expect(parseProvider("Claude")).toBe("claude");
    expect(parseProvider("codex")).toBe("codex");
    expect(parseProvider("cc")).toBe("claude");
    expect(parseProvider("cx")).toBe("codex");
    expect(parseProvider("other")).toBeNull();
  });
});
