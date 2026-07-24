import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { PluginInstanceStore } from "../src/plugin/instance.ts";

const roots: string[] = [];

function testRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "baton-plugin-instance-"));
  roots.push(root);
  return root;
}

function testSession(root: string): { id: string; dir: string } {
  return {
    id: "bs_test",
    dir: join(root, "projects", "project", "sessions", "bs_test"),
  };
}

function store(root: string, now?: () => Date): PluginInstanceStore {
  return new PluginInstanceStore({ session: testSession(root), now });
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("PluginInstanceStore", () => {
  test("persists a session-owned package configuration", () => {
    const root = testRoot();
    const instances = store(root);
    const created = instances.create({
      pluginId: "qiankun/reqloop",
      packageVersion: "1.2.0",
      config: { project: "baton" },
    });

    expect(created.pluginInstanceId).toMatch(/^pi_/);
    expect(created).toMatchObject({
      batonSessionId: "bs_test",
      pluginId: "qiankun/reqloop",
      packageVersion: "1.2.0",
      enabled: true,
      config: { project: "baton" },
    });
    expect(instances.get(created.pluginInstanceId)).toEqual(created);
    expect(instances.list()).toEqual([created]);

    const path = join(
      testSession(root).dir,
      "plugins",
      created.pluginInstanceId,
      "instance.json",
    );
    expect(existsSync(path)).toBe(true);
    expect(readFileSync(path, "utf8")).toContain('"pluginId": "qiankun/reqloop"');
  });

  test("updates enabled and config without changing package identity", () => {
    const timestamps = [
      new Date("2026-07-24T01:00:00.000Z"),
      new Date("2026-07-24T02:00:00.000Z"),
      new Date("2026-07-24T03:00:00.000Z"),
    ];
    const instances = store(testRoot(), () => timestamps.shift() as Date);
    const created = instances.create({
      pluginInstanceId: "reqloop_default",
      pluginId: "qiankun/reqloop",
      packageVersion: "1.2.0",
    });
    const disabled = instances.setEnabled("reqloop_default", false);
    const configured = instances.replaceConfig("reqloop_default", { project: "baton" });

    expect(disabled.enabled).toBe(false);
    expect(configured).toMatchObject({
      pluginInstanceId: created.pluginInstanceId,
      pluginId: created.pluginId,
      packageVersion: created.packageVersion,
      enabled: false,
      config: { project: "baton" },
      createdAt: created.createdAt,
      updatedAt: "2026-07-24T03:00:00.000Z",
    });
  });

  test("does not rewrite no-op updates", () => {
    const instances = store(testRoot(), () => new Date("2026-07-24T01:00:00.000Z"));
    const created = instances.create({
      pluginInstanceId: "reqloop_default",
      pluginId: "qiankun/reqloop",
      packageVersion: "1.2.0",
      config: { project: "baton" },
    });

    expect(instances.setEnabled("reqloop_default", true)).toEqual(created);
    expect(instances.replaceConfig("reqloop_default", { project: "baton" })).toEqual(created);
  });

  test("rejects duplicate, unsafe, and non-JSON values", () => {
    const root = testRoot();
    const instances = store(root);
    instances.create({
      pluginInstanceId: "reqloop_default",
      pluginId: "qiankun/reqloop",
      packageVersion: "1.2.0",
    });

    expect(() =>
      instances.create({
        pluginInstanceId: "reqloop_default",
        pluginId: "qiankun/reqloop",
        packageVersion: "1.2.0",
      }),
    ).toThrow("plugin instance already exists: reqloop_default");
    expect(() =>
      instances.create({
        pluginInstanceId: "../escape",
        pluginId: "qiankun/reqloop",
        packageVersion: "1.2.0",
      }),
    ).toThrow("pluginInstanceId");
    expect(() =>
      instances.create({
        pluginId: "qiankun/reqloop",
        packageVersion: "1.2.0",
        config: { project: undefined },
      }),
    ).toThrow("config must contain only lossless JSON values");
  });

  test("ignores resource-only directories and reports corrupt instance identity", () => {
    const root = testRoot();
    const session = testSession(root);
    mkdirSync(join(session.dir, "plugins", "legacy", "resources"), { recursive: true });
    const path = join(session.dir, "plugins", "reqloop_default", "instance.json");
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(
      path,
      JSON.stringify({
        pluginInstanceId: "another",
        batonSessionId: "bs_test",
        pluginId: "qiankun/reqloop",
        packageVersion: "1.2.0",
        enabled: true,
        config: {},
        createdAt: "2026-07-24T01:00:00.000Z",
        updatedAt: "2026-07-24T01:00:00.000Z",
      }),
    );

    expect(() => store(root).list()).toThrow(
      `invalid plugin instance ${path}: pluginInstanceId must be reqloop_default`,
    );
  });
});
