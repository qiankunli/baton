import type { InteractionHandler } from "../src/adapters/types.ts";
import { describe, expect, test } from "bun:test";

import { DEFAULT_CONFIG } from "../src/config/config.ts";
import {
  createHarnessAdapter,
  defaultHarnessTarget,
  parseHarness,
  HARNESS_REGISTRY,
  HARNESSES,
  harnessDefinitionFor,
  harnessSessionKey,
  harnessShortName,
} from "../src/harness/registry.ts";
import { agentColorFor } from "../src/tui/theme.ts";

const interactionHandler: InteractionHandler = async (req) =>
  req.kind === "permission"
    ? { kind: "permission", outcome: "selected", optionId: "deny" }
    : { kind: "question", outcome: "answered", answers: {} };

describe("harness registry", () => {
  test("registers the first bundled harnesses and their native session keys", () => {
    expect(HARNESSES).toEqual(["codex", "claude"]);
    expect(HARNESS_REGISTRY.find((harness) => harness.id === "codex")?.aliases).toEqual(["cx"]);
    expect(HARNESS_REGISTRY.find((harness) => harness.id === "claude")?.aliases).toEqual(["cc"]);
    expect(harnessSessionKey("codex")).toBe("codex");
    expect(harnessSessionKey("claude")).toBe("claude-code");
  });

  test("constructs adapters without putting harness branches in the TUI or session controller", () => {
    const options = { interactionHandler, config: DEFAULT_CONFIG };
    expect(createHarnessAdapter({ id: "codex-a", harness: "codex" }, options).harness).toBe("codex");
    expect(createHarnessAdapter({ id: "claude-a", harness: "claude" }, options).harness).toBe("claude-code");
  });

  test("maps current commands to explicit default HarnessTargets", () => {
    expect(defaultHarnessTarget("codex")).toEqual({ id: "codex", harness: "codex" });
    expect(defaultHarnessTarget("claude")).toEqual({ id: "claude", harness: "claude" });
  });

  test("normalizes canonical id and wire key to one definition (三套命名空间的唯一汇合点)", () => {
    // 用户侧 "claude" 与事件/持久化侧 "claude-code" 归到同一个 definition
    expect(harnessDefinitionFor("claude")).toBe(harnessDefinitionFor("claude-code"));
    expect(harnessDefinitionFor("cc")).toBe(harnessDefinitionFor("claude"));
    expect(harnessDefinitionFor("claude")?.id).toBe("claude");
    expect(harnessDefinitionFor("codex")?.sessionKey).toBe("codex");
    // harness 是开放扩展点：未知输入不 throw
    expect(harnessDefinitionFor("unknown-agent")).toBeUndefined();
  });

  test("shortName drives both timeline author and color key; unknown passes through", () => {
    expect(harnessShortName("claude-code")).toBe("claude");
    expect(harnessShortName("claude")).toBe("claude");
    expect(harnessShortName("codex")).toBe("codex");
    expect(harnessShortName("some-new-agent")).toBe("some-new-agent");
    // 认色从 registry 派生：不再靠注释约定 theme 与 label 两处一致
    for (const definition of HARNESS_REGISTRY) {
      expect(agentColorFor(definition.shortName)).toBe(definition.color);
    }
  });

  test("parseHarness accepts canonical ids and user aliases (wire key 不是用户词汇)", () => {
    expect(parseHarness("claude")).toBe("claude");
    expect(parseHarness(" CODEX ")).toBe("codex");
    expect(parseHarness("cc")).toBe("claude");
    expect(parseHarness("CX")).toBe("codex");
    expect(parseHarness("claude-code")).toBeNull();
    expect(parseHarness("gpt")).toBeNull();
  });
});
