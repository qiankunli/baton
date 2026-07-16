import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, test } from "bun:test";

import {
  CodexAdapter,
  codexCommandWithHookTrustBypass,
} from "../src/adapters/codex/adapter.ts";
import {
  FileHookTrustStore,
  hookTrustFingerprint,
  hookStatePath,
  type HookTrustStore,
} from "../src/config/hook.ts";
import type { AnyNewEvent, HookTrustCandidate } from "../src/events/types.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function candidate(overrides: Partial<HookTrustCandidate> = {}): HookTrustCandidate {
  return {
    key: "devloop:pre_tool_use:0",
    source: "plugin",
    sourcePath: "/plugins/devloop/hooks.codex.json",
    trustStatus: "modified",
    command: "/plugins/devloop/pretool.py",
    matcher: "Bash",
    pluginId: "devloop@devloop",
    currentHash: "sha256:one",
    ...overrides,
  };
}

describe("persisted hook trust", () => {
  test("stores exact definitions under state/hook.json and asks again after hash changes", () => {
    const root = mkdtempSync(join(tmpdir(), "baton-hook-trust-"));
    roots.push(root);
    const store = new FileHookTrustStore(root);
    const hook = candidate();

    expect(store.isTrusted("codex", hook)).toBe(false);
    store.trust("codex", [hook]);
    expect(store.isTrusted("codex", hook)).toBe(true);
    expect(store.isTrusted("codex", candidate({ currentHash: "sha256:two" }))).toBe(false);
    expect(hookStatePath(root)).toBe(join(root, "state", "hook.json"));
    expect(JSON.parse(readFileSync(hookStatePath(root), "utf8"))).toEqual({
      trust: { providers: { codex: { [hook.key]: "sha256:one" } } },
    });
  });

  test("falls back to a stable Baton fingerprint when Codex omits currentHash", () => {
    const one = candidate({ currentHash: undefined });
    const same = candidate({ currentHash: undefined });
    const changed = candidate({ currentHash: undefined, command: "/plugins/devloop/changed.py" });
    expect(hookTrustFingerprint(one)).toBe(hookTrustFingerprint(same));
    expect(hookTrustFingerprint(one)).not.toBe(hookTrustFingerprint(changed));
  });
});

class MemoryHookTrustStore implements HookTrustStore {
  private trusted = new Map<string, string>();
  isTrusted(provider: string, hook: HookTrustCandidate): boolean {
    return this.trusted.get(`${provider}:${hook.key}`) === hookTrustFingerprint(hook);
  }
  trust(provider: string, hooks: HookTrustCandidate[]): void {
    for (const hook of hooks) this.trusted.set(`${provider}:${hook.key}`, hookTrustFingerprint(hook));
  }
}

describe("Codex hook trust provider interaction", () => {
  test("places the official bypass flag before the app-server subcommand", () => {
    expect(codexCommandWithHookTrustBypass(["codex", "-c", "foo=true", "app-server", "--stdio"])).toEqual([
      "codex",
      "-c",
      "foo=true",
      "--dangerously-bypass-hook-trust",
      "app-server",
      "--stdio",
    ]);
  });

  test("asks once, persists the exact hash, then auto-enables with a visible notice", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-hook-trust-provider-"));
    roots.push(root);
    const launches = join(root, "launches.log");
    const script = `
      require("node:fs").appendFileSync(${JSON.stringify(launches)}, "launch\\n");
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin });
      const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\\n");
      rl.on("line", (line) => {
        const msg = JSON.parse(line);
        if (msg.method === "initialize") send({ id: msg.id, result: {} });
        else if (msg.method === "hooks/list") send({ id: msg.id, result: { data: [{ cwd: "/repo", warnings: [], errors: [], hooks: [{
          key: "devloop:pre_tool_use:0", source: "plugin", sourcePath: "/plugins/devloop/hooks.codex.json",
          trustStatus: "modified", enabled: true, command: "/plugins/devloop/pretool.py", matcher: "Bash",
          pluginId: "devloop@devloop", currentHash: "sha256:one"
        }] }] } });
        else if (msg.method === "thread/start") send({ id: msg.id, result: { thread: { id: "thread" } } });
      });
    `;
    const command = ["bun", "-e", script, "app-server"];
    const trust = new MemoryHookTrustStore();
    const firstEvents: AnyNewEvent[] = [];
    let questions = 0;
    const first = new CodexAdapter({
      command,
      hookTrustStore: trust,
      requestHandler: async (request) => {
        questions++;
        if (request.kind !== "hook_trust") throw new Error(`unexpected request ${request.kind}`);
        return { kind: "hook_trust", requestId: request.requestId, decision: "trust" };
      },
    });
    const firstRef = await first.open({ cwd: "/tmp" }, (event) => firstEvents.push(event));
    expect(firstRef.providerSessionId).toBe("thread");
    expect(readFileSync(launches, "utf8").trim().split("\n")).toHaveLength(2);
    expect(questions).toBe(1);
    expect(firstEvents.map((event) => event.kind)).toEqual(["hook_trust_request", "hook_trust_resolved"]);
    await first.close(firstRef);

    const secondEvents: AnyNewEvent[] = [];
    const second = new CodexAdapter({
      command,
      hookTrustStore: trust,
      requestHandler: async (request) => {
        throw new Error(`should not ask again: ${request.kind}`);
      },
    });
    const secondRef = await second.open({ cwd: "/tmp" }, (event) => secondEvents.push(event));
    expect(secondRef.providerSessionId).toBe("thread");
    expect(readFileSync(launches, "utf8").trim().split("\n")).toHaveLength(4);
    expect(secondEvents.some((event) => event.kind === "hook_trust_request")).toBe(false);
    expect(secondEvents.find((event) => event.kind === "_baton_notice")?.payload).toMatchObject({
      title: "Enabled previously trusted Codex hooks",
      detail: "devloop@devloop",
    });
    await second.close(secondRef);
  });
});
