import { describe, expect, test } from "bun:test";
import { parseSlashCommand } from "chat-tui";

import { COMMANDS, parseHarness, parseHarnessRoute } from "../src/commands/registry.ts";

// slash 解析实现在 chat-tui；这里锁的是"chat-tui 解析器 × baton 命令表"的组合行为。
describe("baton command registry", () => {
  test("parses direct harness commands and config arguments", () => {
    expect(parseSlashCommand("/claude", COMMANDS)).toEqual({ name: "claude", argument: "" });
    expect(parseSlashCommand("/codex", COMMANDS)).toEqual({ name: "codex", argument: "" });
    expect(parseSlashCommand("/codex fix this", COMMANDS)).toEqual({ name: "codex", argument: "fix this" });
    expect(parseSlashCommand("/claude review this", COMMANDS)).toEqual({ name: "claude", argument: "review this" });
    expect(parseSlashCommand("/model sonnet", COMMANDS)).toEqual({ name: "model", argument: "sonnet" });
    expect(parseSlashCommand("/effort high", COMMANDS)).toEqual({ name: "effort", argument: "high" });
    expect(parseSlashCommand("/compact", COMMANDS)).toEqual({ name: "compact", argument: "" });
    expect(parseSlashCommand("/plugins", COMMANDS)).toEqual({ name: "plugins", argument: "" });
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

  test("does not retain /harness or consume unknown slash prompts", () => {
    expect(parseSlashCommand("/harness claude", COMMANDS)).toBeNull();
    expect(parseSlashCommand("/tmp/project", COMMANDS)).toBeNull();
  });

  test("routes harness aliases without registering them as slash commands", () => {
    expect(parseSlashCommand("/cc review this", COMMANDS)).toBeNull();
    expect(parseSlashCommand("/cx fix this", COMMANDS)).toBeNull();
    expect(COMMANDS.map((command) => command.name)).not.toContain("cc");
    expect(COMMANDS.map((command) => command.name)).not.toContain("cx");
    expect(parseHarnessRoute("/cc  review this")).toEqual({
      kind: "matched",
      harness: "claude",
      message: "review this",
    });
    expect(parseHarnessRoute("/cx fix this")).toEqual({ kind: "matched", harness: "codex", message: "fix this" });
    expect(parseHarnessRoute("/cla review this")).toEqual({
      kind: "matched",
      harness: "claude",
      message: "review this",
    });
    expect(parseHarnessRoute("/cod fix this")).toEqual({ kind: "matched", harness: "codex", message: "fix this" });
    expect(parseHarnessRoute("/c ambiguous")).toEqual({
      kind: "ambiguous",
      token: "c",
      harnesses: ["codex", "claude"],
    });
  });

  test("currently bundled harness values are explicit", () => {
    expect(parseHarness("Claude")).toBe("claude");
    expect(parseHarness("codex")).toBe("codex");
    expect(parseHarness("cc")).toBe("claude");
    expect(parseHarness("cx")).toBe("codex");
    expect(parseHarness("other")).toBeNull();
  });
});
