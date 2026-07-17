import { describe, expect, test } from "bun:test";

import { mkdtempSync, rmSync } from "node:fs";
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
