import { describe, expect, test } from "bun:test";

import { DEFAULT_CONFIG } from "../src/config/config.ts";
import {
  createProviderAdapter,
  parseProvider,
  PROVIDER_REGISTRY,
  PROVIDERS,
  providerDefinitionFor,
  providerSessionKey,
  providerShortName,
} from "../src/providers/registry.ts";
import { agentColorFor } from "../src/tui/theme.ts";

const approvalHandler = async () => ({ optionId: "deny" });

describe("provider registry", () => {
  test("registers the first bundled providers and their native session keys", () => {
    expect(PROVIDERS).toEqual(["codex", "claude"]);
    expect(providerSessionKey("codex")).toBe("codex");
    expect(providerSessionKey("claude")).toBe("claude-code");
  });

  test("constructs adapters without putting provider branches in the TUI or session runtime", () => {
    const options = { approvalHandler, config: DEFAULT_CONFIG };
    expect(createProviderAdapter("codex", options).provider).toBe("codex");
    expect(createProviderAdapter("claude", options).provider).toBe("claude-code");
  });

  test("normalizes canonical id and wire key to one definition (三套命名空间的唯一汇合点)", () => {
    // 用户侧 "claude" 与事件/持久化侧 "claude-code" 归到同一个 definition
    expect(providerDefinitionFor("claude")).toBe(providerDefinitionFor("claude-code"));
    expect(providerDefinitionFor("claude")?.id).toBe("claude");
    expect(providerDefinitionFor("codex")?.sessionKey).toBe("codex");
    // provider 是开放扩展点：未知输入不 throw
    expect(providerDefinitionFor("unknown-agent")).toBeUndefined();
  });

  test("shortName drives both timeline author and color key; unknown passes through", () => {
    expect(providerShortName("claude-code")).toBe("claude");
    expect(providerShortName("claude")).toBe("claude");
    expect(providerShortName("codex")).toBe("codex");
    expect(providerShortName("some-new-agent")).toBe("some-new-agent");
    // 认色从 registry 派生：不再靠注释约定 theme 与 label 两处一致
    for (const definition of PROVIDER_REGISTRY) {
      expect(agentColorFor(definition.shortName)).toBe(definition.color);
    }
  });

  test("parseProvider accepts canonical ids only (wire key 不是用户词汇)", () => {
    expect(parseProvider("claude")).toBe("claude");
    expect(parseProvider(" CODEX ")).toBe("codex");
    expect(parseProvider("claude-code")).toBeNull();
    expect(parseProvider("gpt")).toBeNull();
  });
});
