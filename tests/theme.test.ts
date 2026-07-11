import { describe, expect, test } from "bun:test";

import { defaultTheme } from "chat-tui";

import { agentColorFor, batonTheme } from "../src/tui/theme.ts";

describe("agentColorFor", () => {
  test("known providers get fixed, distinct colors", () => {
    const claude = agentColorFor("claude");
    const codex = agentColorFor("codex");
    expect(claude).not.toBe(codex);
    // 认色也要区别于 user 蓝与默认 agent 紫，否则视觉上仍分不开三方
    expect([defaultTheme.user, defaultTheme.agent]).not.toContain(claude);
    expect([defaultTheme.user, defaultTheme.agent]).not.toContain(codex);
  });

  test("unknown providers get a stable color from the fallback pool", () => {
    const first = agentColorFor("gemini");
    expect(agentColorFor("gemini")).toBe(first); // 同名稳定
    expect(first).toMatch(/^#[0-9a-f]{6}$/i);
  });

  test("batonTheme wires the hook on top of defaultTheme", () => {
    expect(batonTheme.agentColorFor?.("claude")).toBe(agentColorFor("claude"));
    expect(batonTheme.user).toBe(defaultTheme.user);
  });
});
