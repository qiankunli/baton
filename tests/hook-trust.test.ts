import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

  test("preserves unrelated hook settings and trust fields when adding a provider", () => {
    const root = mkdtempSync(join(tmpdir(), "baton-hook-state-preserve-"));
    roots.push(root);
    const path = hookStatePath(root);
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(
      path,
      `${JSON.stringify({
        display: { showStatus: true },
        trust: { policy: "exact", providers: { claude: { existing: "sha256:claude" } } },
      })}\n`,
    );

    new FileHookTrustStore(root).trust("codex", [candidate()]);

    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual({
      display: { showStatus: true },
      trust: {
        policy: "exact",
        providers: {
          claude: { existing: "sha256:claude" },
          codex: { [candidate().key]: "sha256:one" },
        },
      },
    });
  });

  test("fails closed with a visible warning and does not overwrite malformed state", () => {
    const root = mkdtempSync(join(tmpdir(), "baton-hook-state-corrupt-"));
    roots.push(root);
    const path = hookStatePath(root);
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(path, "{not json\n");
    const store = new FileHookTrustStore(root);

    expect(store.isTrusted("codex", candidate())).toBe(false);
    expect(store.takeWarnings()).toEqual([expect.stringContaining(`could not read ${path}`)]);
    expect(() => store.trust("codex", [candidate()])).toThrow(/Cannot update hook trust/);
    expect(readFileSync(path, "utf8")).toBe("{not json\n");
  });

  test("recovers a hook state lock left by a dead process", () => {
    const root = mkdtempSync(join(tmpdir(), "baton-hook-state-stale-lock-"));
    roots.push(root);
    const path = hookStatePath(root);
    mkdirSync(join(root, "state"), { recursive: true });
    writeFileSync(`${path}.lock`, "999999999:stale");

    new FileHookTrustStore(root).trust("codex", [candidate()]);

    expect(existsSync(`${path}.lock`)).toBe(false);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      trust: { providers: { codex: { [candidate().key]: "sha256:one" } } },
    });
  });

  test("serializes concurrent processes without losing either update", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-hook-state-concurrent-"));
    roots.push(root);
    const path = hookStatePath(root);
    const holderScript = `
      const fs = require("node:fs");
      const path = ${JSON.stringify(path)};
      fs.mkdirSync(require("node:path").dirname(path), { recursive: true });
      fs.writeFileSync(path + ".lock", process.pid + ":holder", { flag: "wx" });
      process.stdout.write("locked\\n");
      setTimeout(() => {
        fs.writeFileSync(path, JSON.stringify({ display: { compact: true } }) + "\\n");
        fs.rmSync(path + ".lock");
      }, 50);
    `;
    const holder = Bun.spawn([process.execPath, "-e", holderScript], { stdout: "pipe", stderr: "pipe" });
    const reader = holder.stdout.getReader();
    const ready = await reader.read();
    reader.releaseLock();
    expect(new TextDecoder().decode(ready.value)).toContain("locked");

    new FileHookTrustStore(root).trust("codex", [candidate()]);

    expect(await holder.exited).toBe(0);
    expect(JSON.parse(readFileSync(path, "utf8"))).toMatchObject({
      display: { compact: true },
      trust: { providers: { codex: { [candidate().key]: "sha256:one" } } },
    });
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
        }, {
          key: "devloop:post_tool_use:0", source: "plugin", sourcePath: "/plugins/devloop/hooks.codex.json",
          trustStatus: "modified", enabled: true, command: "/plugins/devloop/posttool.py",
          pluginId: "devloop@devloop", currentHash: "sha256:two"
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
      title: "Enabled 2 previously trusted Codex hooks",
      detail: "devloop@devloop (2 hooks)",
    });
    await second.close(secondRef);
  });

  test("resolves the request and kills the startup process when persistence fails", async () => {
    const root = mkdtempSync(join(tmpdir(), "baton-hook-trust-write-failure-"));
    roots.push(root);
    const killed = join(root, "killed.log");
    const script = `
      const fs = require("node:fs");
      process.on("SIGTERM", () => { fs.appendFileSync(${JSON.stringify(killed)}, "killed\\n"); process.exit(0); });
      const readline = require("node:readline");
      const rl = readline.createInterface({ input: process.stdin });
      const send = (o) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...o }) + "\\n");
      rl.on("line", (line) => {
        const msg = JSON.parse(line);
        if (msg.method === "initialize") send({ id: msg.id, result: {} });
        else if (msg.method === "hooks/list") send({ id: msg.id, result: { data: [{ hooks: [{
          key: "devloop:pre_tool_use:0", source: "plugin", sourcePath: "/plugins/devloop/hooks.codex.json",
          trustStatus: "modified", enabled: true, command: "/plugins/devloop/pretool.py", currentHash: "sha256:one"
        }] }] } });
      });
    `;
    const failingStore: HookTrustStore = {
      isTrusted: () => false,
      takeWarnings: () => ["could not read /tmp/hook.json: permission denied"],
      trust: () => {
        throw new Error("disk full");
      },
    };
    const events: AnyNewEvent[] = [];
    const adapter = new CodexAdapter({
      command: ["bun", "-e", script, "app-server"],
      hookTrustStore: failingStore,
      requestHandler: async (request) => ({
        kind: "hook_trust",
        requestId: request.requestId,
        decision: "trust",
      }),
    });

    await expect(adapter.open({ cwd: "/tmp" }, (event) => events.push(event))).rejects.toThrow("disk full");
    for (let attempt = 0; attempt < 20 && !existsSync(killed); attempt++) await Bun.sleep(5);

    expect(readFileSync(killed, "utf8")).toBe("killed\n");
    expect(events.filter((event) => event.kind === "hook_trust_resolved")).toHaveLength(1);
    expect(events.find((event) => event.kind === "hook_trust_resolved")?.payload).toMatchObject({
      outcome: "failed",
    });
    expect(events.find((event) => event.kind === "_baton_notice")?.payload).toMatchObject({
      level: "warning",
      title: "Could not load saved hook trust",
      detail: expect.stringContaining("permission denied"),
    });
  });
});
