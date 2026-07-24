import { describe, expect, test } from "bun:test";

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { SessionStore } from "../src/store/store.ts";

const repoRoot = join(import.meta.dir, "..");

describe("baton sessions", () => {
  test("lists only sessions from the requested project", () => {
    const root = mkdtempSync(join(tmpdir(), "baton-cli-project-sessions-"));
    try {
      const store = new SessionStore(root);
      const current = store.createSession({ cwd: "/repo" });
      const other = store.createSession({ cwd: "/other" });

      const result = Bun.spawnSync(
        [process.execPath, "src/cli/bin.ts", "sessions", "--root", root, "--cwd", "/repo"],
        { cwd: repoRoot, stdout: "pipe", stderr: "pipe" },
      );
      const output = result.stdout.toString();

      expect(result.exitCode).toBe(0);
      expect(output).toContain(current.id);
      expect(output).not.toContain(other.id);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("baton plugins", () => {
  test("registers a Marketplace and installs a Package", () => {
    const root = mkdtempSync(join(tmpdir(), "baton-cli-plugins-"));
    const marketplace = mkdtempSync(join(tmpdir(), "baton-cli-marketplace-"));
    try {
      mkdirSync(join(marketplace, ".baton-plugin"), { recursive: true });
      writeFileSync(
        join(marketplace, ".baton-plugin", "marketplace.json"),
        JSON.stringify({
          name: "reqloop",
          plugins: [{ pluginId: "qiankun/requirement-loop", source: "./requirement-loop" }],
        }),
      );
      mkdirSync(join(marketplace, "requirement-loop", ".baton-plugin"), {
        recursive: true,
      });
      mkdirSync(join(marketplace, "requirement-loop", "src"), { recursive: true });
      writeFileSync(
        join(marketplace, "requirement-loop", ".baton-plugin", "plugin.json"),
        JSON.stringify({
          manifestVersion: 1,
          pluginId: "qiankun/requirement-loop",
          version: "0.1.0",
          entry: "./src/index.ts",
        }),
      );
      writeFileSync(
        join(marketplace, "requirement-loop", "src", "index.ts"),
        "export default { pluginId: 'qiankun/requirement-loop', version: '0.1.0', activate() {} };\n",
      );

      const added = runCli([
        "plugins",
        "marketplace",
        "add",
        marketplace,
        "--root",
        root,
      ]);
      expect(added.exitCode).toBe(0);
      expect(added.stdout.toString()).toContain("added marketplace reqloop");

      const available = runCli(["plugins", "available", "--root", root]);
      expect(available.exitCode).toBe(0);
      expect(available.stdout.toString()).toContain(
        "qiankun/requirement-loop@0.1.0  reqloop",
      );

      const installed = runCli([
        "plugins",
        "install",
        "qiankun/requirement-loop",
        "--root",
        root,
      ]);
      expect(installed.exitCode).toBe(0);
      expect(installed.stdout.toString()).toContain(
        "installed qiankun/requirement-loop@0.1.0",
      );

      const listed = runCli(["plugins", "list", "--root", root]);
      expect(listed.exitCode).toBe(0);
      expect(listed.stdout.toString()).toContain(
        "qiankun/requirement-loop@0.1.0  from reqloop",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
      rmSync(marketplace, { recursive: true, force: true });
    }
  });
});

function runCli(args: string[]) {
  return Bun.spawnSync([process.execPath, "src/cli/bin.ts", ...args], {
    cwd: repoRoot,
    stdout: "pipe",
    stderr: "pipe",
  });
}
