import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PluginResourceStore } from "../src/plugin/resource.ts";

const roots: string[] = [];

function testRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "baton-plugin-resource-"));
  roots.push(root);
  return root;
}

function testSession(root: string): { id: string; dir: string } {
  return {
    id: "bs_test",
    dir: join(root, "projects", "project", "sessions", "bs_test"),
  };
}

function store(root: string): PluginResourceStore {
  return new PluginResourceStore({
    session: testSession(root),
    pluginInstanceId: "reqloop_default",
  });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("PluginResourceStore", () => {
  test("creates a resource in its BatonSession and plugin instance scope", () => {
    const root = testRoot();
    const resources = store(root);
    const created = resources.create({
      kind: "ReqLoopRun",
      spec: { requirement: "ship it" },
      status: { phase: "pending" },
    });

    expect(created.metadata.resourceId).toMatch(/^pr_/);
    expect(created.metadata).toMatchObject({
      batonSessionId: "bs_test",
      pluginInstanceId: "reqloop_default",
      generation: 1,
      resourceVersion: 1,
    });
    expect(resources.get("ReqLoopRun", created.metadata.resourceId)).toEqual(created);
    expect(resources.list()).toEqual([created]);
    expect(resources.list("OtherKind")).toEqual([]);

    const path = join(
      root,
      "projects",
      "project",
      "sessions",
      "bs_test",
      "plugins",
      "reqloop_default",
      "resources",
      "ReqLoopRun",
      `${created.metadata.resourceId}.json`,
    );
    expect(existsSync(path)).toBe(true);
  });

  test("spec changes generation while status and schedule changes do not", () => {
    const resources = store(testRoot());
    const created = resources.create({
      kind: "ReqLoopRun",
      resourceId: "run_1",
      spec: { requirement: "draft" },
      status: { phase: "pending", evidence: "keep" },
    });

    const spec = resources.replaceSpec("ReqLoopRun", "run_1", { requirement: "approved" });
    expect(spec.metadata.generation).toBe(2);
    expect(spec.metadata.resourceVersion).toBe(2);

    const status = resources.patchStatus("ReqLoopRun", "run_1", {
      phase: "running",
      evidence: null,
    });
    expect(status.metadata.generation).toBe(2);
    expect(status.metadata.resourceVersion).toBe(3);
    expect(status.status).toEqual({ phase: "running", evidence: null });

    const due = new Date("2026-07-25T01:02:03.000Z");
    const scheduled = resources.setNextReconcileAt("ReqLoopRun", "run_1", due);
    expect(scheduled.metadata.generation).toBe(2);
    expect(scheduled.metadata.resourceVersion).toBe(4);
    expect(scheduled.metadata.nextReconcileAt).toBe(due.toISOString());

    const cleared = resources.setNextReconcileAt("ReqLoopRun", "run_1", null);
    expect(cleared.metadata.generation).toBe(2);
    expect(cleared.metadata.resourceVersion).toBe(5);
    expect(cleared.metadata.nextReconcileAt).toBeUndefined();
    expect(created.metadata.generation).toBe(1);
  });

  test("no-op updates do not advance resourceVersion", () => {
    const resources = store(testRoot());
    resources.create({
      kind: "ReqLoopRun",
      resourceId: "run_1",
      spec: { requirement: "same" },
      status: { phase: "pending" },
    });

    expect(
      resources.replaceSpec("ReqLoopRun", "run_1", { requirement: "same" }).metadata
        .resourceVersion,
    ).toBe(1);
    expect(
      resources.patchStatus("ReqLoopRun", "run_1", { phase: "pending" }).metadata.resourceVersion,
    ).toBe(1);
    expect(resources.setNextReconcileAt("ReqLoopRun", "run_1", null).metadata.resourceVersion).toBe(
      1,
    );
  });

  test("checks expected resourceVersion inside the write lock", () => {
    const resources = store(testRoot());
    resources.create({
      kind: "ReqLoopRun",
      resourceId: "run_1",
      spec: { requirement: "draft" },
    });
    resources.patchStatus("ReqLoopRun", "run_1", { phase: "running" });

    expect(() =>
      resources.replaceSpec(
        "ReqLoopRun",
        "run_1",
        { requirement: "stale writer" },
        { expectedResourceVersion: 1 },
      ),
    ).toThrow("plugin resource version conflict: expected 1, current 2");
  });

  test("rejects unsafe identities and values that cannot round-trip as JSON", () => {
    const root = testRoot();
    expect(
      () =>
        new PluginResourceStore({
          session: { id: "../escape", dir: root },
          pluginInstanceId: "reqloop_default",
        }),
    ).toThrow("batonSessionId");

    const resources = store(root);
    expect(() =>
      resources.create({
        kind: "ReqLoopRun",
        resourceId: "run_1",
        spec: { requirement: undefined },
      }),
    ).toThrow("spec must contain only lossless JSON values");
  });

  test("reports corrupt or wrongly scoped persisted resources", () => {
    const root = testRoot();
    const path = join(
      root,
      "projects",
      "project",
      "sessions",
      "bs_test",
      "plugins",
      "reqloop_default",
      "resources",
      "ReqLoopRun",
      "run_1.json",
    );
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        kind: "ReqLoopRun",
        metadata: {
          resourceId: "run_1",
          batonSessionId: "bs_another",
          pluginInstanceId: "reqloop_default",
          generation: 1,
          resourceVersion: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        spec: {},
        status: {},
      }),
    );

    expect(() => store(root).get("ReqLoopRun", "run_1")).toThrow(
      `invalid plugin resource ${path}: batonSessionId must be bs_test`,
    );
    expect(readFileSync(path, "utf8")).toContain("bs_another");
  });
});
