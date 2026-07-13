import { describe, expect, test } from "bun:test";
import { parseSlashCommand } from "chat-tui";

import { COMMANDS, parseProvider } from "../src/commands/registry.ts";

// slash 解析实现在 chat-tui；这里锁的是"chat-tui 解析器 × baton 命令表"的组合行为。
describe("baton command registry", () => {
  test("parses direct provider commands and model arguments", () => {
    expect(parseSlashCommand("/claude", COMMANDS)).toEqual({ name: "claude", argument: "" });
    expect(parseSlashCommand("/codex", COMMANDS)).toEqual({ name: "codex", argument: "" });
    expect(parseSlashCommand("/model sonnet", COMMANDS)).toEqual({ name: "model", argument: "sonnet" });
    expect(parseSlashCommand("/sessions", COMMANDS)).toEqual({ name: "sessions", argument: "" });
    expect(parseSlashCommand("/status", COMMANDS)).toEqual({ name: "status", argument: "" });
    expect(parseSlashCommand("/new", COMMANDS)).toEqual({ name: "new", argument: "" });
  });

  test("accepts unique command prefixes", () => {
    expect(parseSlashCommand("/cl", COMMANDS)).toEqual({ name: "claude", argument: "" });
    expect(parseSlashCommand("/co", COMMANDS)).toEqual({ name: "codex", argument: "" });
    expect(parseSlashCommand("/c", COMMANDS)).toBeNull();
    expect(parseSlashCommand("/m sonnet", COMMANDS)).toEqual({ name: "model", argument: "sonnet" });
    expect(parseSlashCommand("/se", COMMANDS)).toEqual({ name: "sessions", argument: "" });
    expect(parseSlashCommand("/st", COMMANDS)).toEqual({ name: "status", argument: "" });
    expect(parseSlashCommand("/s", COMMANDS)).toBeNull();
  });

  test("does not retain /provider or consume unknown slash prompts", () => {
    expect(parseSlashCommand("/provider claude", COMMANDS)).toBeNull();
    expect(parseSlashCommand("/tmp/project", COMMANDS)).toBeNull();
  });

  test("currently bundled provider values are explicit", () => {
    expect(parseProvider("Claude")).toBe("claude");
    expect(parseProvider("codex")).toBe("codex");
    expect(parseProvider("other")).toBeNull();
  });
});
