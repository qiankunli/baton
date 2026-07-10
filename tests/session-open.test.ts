import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { openBatonSession } from "../src/session/open.ts";
import { SessionStore } from "../src/store/store.ts";

let root: string;
let store: SessionStore;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baton-open-"));
  store = new SessionStore(root);
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("openBatonSession", () => {
  test("creates a new session by default", () => {
    const result = openBatonSession(store, { cwd: "/repo", title: "chat" });
    expect(result.resumed).toBe(false);
    expect(result.session.meta.cwd).toBe("/repo");
  });

  test("opens an explicit session and keeps its cwd", () => {
    const existing = store.createSession({ cwd: "/original" });
    const result = openBatonSession(store, { cwd: "/ignored", sessionId: existing.id });
    expect(result.resumed).toBe(true);
    expect(result.session.id).toBe(existing.id);
    expect(result.session.meta.cwd).toBe("/original");
  });

  test("continues the most recently active session in the cwd", () => {
    const older = store.createSession({ cwd: "/repo" });
    older.updateMeta({ updatedAt: "2026-01-01T00:00:00.000Z" });
    const newer = store.createSession({ cwd: "/repo" });
    newer.updateMeta({ updatedAt: "2026-01-02T00:00:00.000Z" });
    store.createSession({ cwd: "/other" }).updateMeta({ updatedAt: "2026-01-03T00:00:00.000Z" });

    const result = openBatonSession(store, { cwd: "/repo", continueLast: true });
    expect(result.resumed).toBe(true);
    expect(result.session.id).toBe(newer.id);
  });

  test("continue creates a session when the cwd has no history", () => {
    const result = openBatonSession(store, { cwd: "/empty", continueLast: true });
    expect(result.resumed).toBe(false);
    expect(result.session.meta.cwd).toBe("/empty");
  });

  test("rejects conflicting selectors", () => {
    expect(() =>
      openBatonSession(store, { cwd: "/repo", sessionId: "bs_x", continueLast: true }),
    ).toThrow(/不能同时使用/);
  });
});
