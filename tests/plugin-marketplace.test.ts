import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { MarketplaceRegistry } from "../src/plugin/marketplace/index.ts";

const roots: string[] = [];

function testRoot(prefix: string): string {
  const root = mkdtempSync(join(tmpdir(), prefix));
  roots.push(root);
  return root;
}

function writeJson(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`);
}

function createMarketplace(
  root: string,
  options: {
    name?: string;
    pluginId?: string;
    manifestPluginId?: string;
    source?: string;
    version?: string;
  } = {},
): { pluginDir: string; entryPath: string } {
  const name = options.name ?? "reqloop";
  const pluginId = options.pluginId ?? "qiankun/requirement-loop";
  const source = options.source ?? "./requirement-loop";
  writeJson(join(root, ".baton-plugin", "marketplace.json"), {
    name,
    description: "Requirement Loop plugins",
    plugins: [{ pluginId, source }],
  });
  const pluginDir = join(root, "requirement-loop");
  const entryPath = join(pluginDir, "src", "index.ts");
  writeJson(join(pluginDir, ".baton-plugin", "plugin.json"), {
    manifestVersion: 1,
    pluginId: options.manifestPluginId ?? pluginId,
    version: options.version ?? "0.1.0",
    entry: "./src/index.ts",
    displayName: "Requirement Loop",
  });
  mkdirSync(join(pluginDir, "src"), { recursive: true });
  writeFileSync(
    entryPath,
    `export default {
  pluginId: ${JSON.stringify(options.manifestPluginId ?? pluginId)},
  version: ${JSON.stringify(options.version ?? "0.1.0")},
  activate() {},
};
`,
  );
  return { pluginDir, entryPath };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Plugin Marketplace", () => {
  test("registers, discovers, installs, and loads a local Marketplace Package", async () => {
    const marketplaceRoot = testRoot("baton-marketplace-source-");
    const batonRoot = testRoot("baton-marketplace-data-");
    const { pluginDir } = createMarketplace(marketplaceRoot);
    mkdirSync(join(pluginDir, "node_modules", "ignored"), { recursive: true });
    writeFileSync(join(pluginDir, "node_modules", "ignored", "index.js"), "ignored");
    mkdirSync(join(pluginDir, ".git"), { recursive: true });
    writeFileSync(join(pluginDir, ".git", "HEAD"), "ignored");
    const now = new Date("2026-07-24T10:00:00.000Z");
    const registry = new MarketplaceRegistry({
      rootDir: batonRoot,
      now: () => now,
    });

    const registered = await registry.add(marketplaceRoot);
    expect(registered.name).toBe("reqloop");
    const canonicalMarketplaceRoot = realpathSync(marketplaceRoot);
    expect(registered.source).toEqual({ kind: "local", path: canonicalMarketplaceRoot });

    const available = registry.available();
    expect(available).toHaveLength(1);
    expect(available[0]?.manifest).toMatchObject({
      pluginId: "qiankun/requirement-loop",
      version: "0.1.0",
      displayName: "Requirement Loop",
    });

    const installed = registry.install("qiankun/requirement-loop");
    expect(installed.alreadyInstalled).toBe(false);
    expect(installed.packageDir).toContain(
      join("plugins", "packages", "qiankun%2Frequirement-loop", "0.1.0"),
    );
    expect(installed.provenance).toEqual({
      marketplace: "reqloop",
      installedAt: now.toISOString(),
      marketplaceSource: { kind: "local", path: canonicalMarketplaceRoot },
    });
    expect(existsSync(join(installed.packageDir, "src", "index.ts"))).toBe(true);
    expect(existsSync(join(installed.packageDir, "node_modules"))).toBe(false);
    expect(existsSync(join(installed.packageDir, ".git"))).toBe(false);

    const plugin = await registry.load("qiankun/requirement-loop", "0.1.0");
    expect(plugin.pluginId).toBe("qiankun/requirement-loop");
    expect(plugin.version).toBe("0.1.0");
    expect(typeof plugin.activate).toBe("function");
  });

  test("does not overwrite an installed Package version when local source changes", async () => {
    const marketplaceRoot = testRoot("baton-marketplace-source-");
    const batonRoot = testRoot("baton-marketplace-data-");
    const { entryPath } = createMarketplace(marketplaceRoot);
    const registry = new MarketplaceRegistry({ rootDir: batonRoot });
    await registry.add(marketplaceRoot);

    const first = registry.install("qiankun/requirement-loop");
    writeFileSync(entryPath, "throw new Error('mutated source');\n");
    const second = registry.install("qiankun/requirement-loop");

    expect(second.alreadyInstalled).toBe(true);
    expect(readFileSync(join(first.packageDir, "src", "index.ts"), "utf8")).not.toContain(
      "mutated source",
    );
  });

  test("rejects Package path escape and catalog/manifest identity drift", async () => {
    const escapedRoot = testRoot("baton-marketplace-escape-");
    const escapedData = testRoot("baton-marketplace-data-");
    createMarketplace(escapedRoot, { source: "../outside" });
    const escapedRegistry = new MarketplaceRegistry({ rootDir: escapedData });
    await escapedRegistry.add(escapedRoot);
    expect(() => escapedRegistry.available()).toThrow("must stay inside");

    const driftRoot = testRoot("baton-marketplace-drift-");
    const driftData = testRoot("baton-marketplace-data-");
    createMarketplace(driftRoot, { manifestPluginId: "other/requirement-loop" });
    const driftRegistry = new MarketplaceRegistry({ rootDir: driftData });
    await driftRegistry.add(driftRoot);
    expect(() => driftRegistry.available()).toThrow(
      "does not match Package manifest other/requirement-loop",
    );
  });

  test("clones and pins a Git Marketplace", async () => {
    const marketplaceRoot = testRoot("baton-marketplace-git-source-");
    const batonRoot = testRoot("baton-marketplace-data-");
    createMarketplace(marketplaceRoot);
    for (const args of [
      ["init", "--quiet"],
      ["add", "."],
      [
        "-c",
        "user.name=Baton Test",
        "-c",
        "user.email=baton@example.com",
        "commit",
        "--quiet",
        "-m",
        "initial",
      ],
    ]) {
      const result = Bun.spawnSync(["git", ...args], {
        cwd: marketplaceRoot,
        stdout: "pipe",
        stderr: "pipe",
      });
      expect(result.exitCode, result.stderr.toString()).toBe(0);
    }
    const revision = Bun.spawnSync(["git", "rev-parse", "HEAD"], {
      cwd: marketplaceRoot,
      stdout: "pipe",
    }).stdout.toString().trim();
    const registry = new MarketplaceRegistry({ rootDir: batonRoot });

    const registered = await registry.add(pathToGitUrl(marketplaceRoot));

    expect(registered.source).toEqual({
      kind: "git",
      url: pathToGitUrl(marketplaceRoot),
      revision,
    });
    expect(registered.rootDir).toBe(join(batonRoot, "plugins", "marketplaces", "reqloop"));
    expect(registry.available()).toHaveLength(1);
  });
});

function pathToGitUrl(path: string): string {
  return `file://${path}`;
}
