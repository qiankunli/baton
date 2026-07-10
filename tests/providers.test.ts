import { describe, expect, test } from "bun:test";

import { DEFAULT_CONFIG } from "../src/config/config.ts";
import {
  createProviderAdapter,
  PROVIDERS,
  providerSessionKey,
} from "../src/providers/registry.ts";

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
});
