import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Manager } from "../src/plugin/manager.ts";
import { PluginInstanceStore } from "../src/plugin/instance.ts";
import type {
  PluginActivationContext,
  PluginPackage,
} from "../src/plugin/package.ts";
import { ProposalStore } from "../src/plugin/proposal.ts";
import { PluginResourceStore } from "../src/plugin/resource.ts";

const roots: string[] = [];

function testRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "baton-plugin-package-"));
  roots.push(root);
  return root;
}

function testSession(root: string): { id: string; dir: string } {
  return {
    id: "bs_test",
    dir: join(root, "projects", "project", "sessions", "bs_test"),
  };
}

function stores(root: string): {
  instances: PluginInstanceStore;
  proposals: ProposalStore;
} {
  const session = testSession(root);
  return {
    instances: new PluginInstanceStore({ session }),
    proposals: new ProposalStore({ session }),
  };
}

function resourceStore(root: string, pluginInstanceId: string): PluginResourceStore {
  return new PluginResourceStore({
    session: testSession(root),
    pluginInstanceId,
  });
}

function key(pluginInstanceId: string, resourceId: string) {
  return {
    batonSessionId: "bs_test",
    pluginInstanceId,
    resourceKind: "ReqLoopRun",
    resourceId,
  };
}

function reqloopPackage(
  activate: PluginPackage["activate"],
): PluginPackage {
  return {
    pluginId: "qiankun/reqloop",
    version: "1.2.0",
    activate,
  };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Plugin Package lifecycle", () => {
  test("restores enabled instances and scopes Resource registration to each instance", async () => {
    const root = testRoot();
    const { instances, proposals } = stores(root);
    for (const pluginInstanceId of ["reqloop_a", "reqloop_b"]) {
      instances.create({
        pluginInstanceId,
        pluginId: "qiankun/reqloop",
        packageVersion: "1.2.0",
      });
      resourceStore(root, pluginInstanceId).create({
        kind: "ReqLoopRun",
        resourceId: "run_1",
        spec: { requirement: pluginInstanceId },
      });
    }
    instances.create({
      pluginInstanceId: "reqloop_disabled",
      pluginId: "qiankun/reqloop",
      packageVersion: "1.2.0",
      enabled: false,
    });
    const activated: string[] = [];
    const reconciled: string[] = [];
    const manager = new Manager({
      instances,
      proposals,
      packages: [
        reqloopPackage((context) => {
          activated.push(context.instance.pluginInstanceId);
          context.registerResource({
            resourceKind: "ReqLoopRun",
            reconciler: {
              async reconcile({ resource }) {
                reconciled.push(resource.metadata.pluginInstanceId);
              },
            },
          });
        }),
      ],
      onProposal() {},
    });

    await manager.start();
    expect(activated).toEqual(["reqloop_a", "reqloop_b"]);
    expect(manager.isInstanceActive("reqloop_a")).toBe(true);
    expect(manager.isInstanceActive("reqloop_b")).toBe(true);
    expect(manager.isInstanceActive("reqloop_disabled")).toBe(false);

    await Promise.all([
      manager.enqueue(key("reqloop_a", "run_1")),
      manager.enqueue(key("reqloop_b", "run_1")),
    ]);
    expect(reconciled.sort()).toEqual(["reqloop_a", "reqloop_b"]);
    await manager.close();
  });

  test("deactivation closes registrations and custom cleanup in reverse order", async () => {
    const root = testRoot();
    const { instances, proposals } = stores(root);
    instances.create({
      pluginInstanceId: "reqloop_default",
      pluginId: "qiankun/reqloop",
      packageVersion: "1.2.0",
    });
    const closed: string[] = [];
    const manager = new Manager({
      instances,
      proposals,
      packages: [
        reqloopPackage((context) => {
          context.onClose(() => {
            closed.push("connector");
          });
          context.registerResource({
            resourceKind: "ReqLoopRun",
            reconciler: { async reconcile() {} },
          });
          context.onClose(() => {
            closed.push("subscription");
          });
        }),
      ],
      onProposal() {},
    });

    await manager.activateInstance("reqloop_default");
    await manager.deactivateInstance("reqloop_default");
    await manager.deactivateInstance("reqloop_default");

    expect(closed).toEqual(["subscription", "connector"]);
    expect(manager.isInstanceActive("reqloop_default")).toBe(false);
    await expect(manager.enqueue(key("reqloop_default", "run_1"))).rejects.toThrow(
      "no plugin Controller registered",
    );
    await manager.close();
  });

  test("rolls back a partially activated Binding", async () => {
    const root = testRoot();
    const { instances, proposals } = stores(root);
    instances.create({
      pluginInstanceId: "reqloop_default",
      pluginId: "qiankun/reqloop",
      packageVersion: "1.2.0",
    });
    const closed: string[] = [];
    const manager = new Manager({
      instances,
      proposals,
      packages: [
        reqloopPackage((context) => {
          context.onClose(() => {
            closed.push("connector");
          });
          context.registerResource({
            resourceKind: "ReqLoopRun",
            reconciler: { async reconcile() {} },
          });
          throw new Error("activation failed");
        }),
      ],
      onProposal() {},
    });

    await expect(manager.activateInstance("reqloop_default")).rejects.toThrow(
      "activation failed",
    );
    expect(closed).toEqual(["connector"]);
    expect(manager.isInstanceActive("reqloop_default")).toBe(false);
    await expect(manager.enqueue(key("reqloop_default", "run_1"))).rejects.toThrow(
      "no plugin Controller registered",
    );
    await manager.close();
  });

  test("rejects disabled or unavailable package versions", async () => {
    const root = testRoot();
    const { instances, proposals } = stores(root);
    instances.create({
      pluginInstanceId: "disabled",
      pluginId: "qiankun/reqloop",
      packageVersion: "1.2.0",
      enabled: false,
    });
    instances.create({
      pluginInstanceId: "missing",
      pluginId: "qiankun/reqloop",
      packageVersion: "2.0.0",
    });
    const manager = new Manager({
      instances,
      proposals,
      packages: [reqloopPackage(() => {})],
      onProposal() {},
    });

    await expect(manager.activateInstance("disabled")).rejects.toThrow(
      "plugin Instance is disabled: disabled",
    );
    await expect(manager.activateInstance("missing")).rejects.toThrow(
      "plugin Package is unavailable: qiankun/reqloop@2.0.0",
    );
    await manager.close();
  });

  test("seals activation and rejects duplicate Package identities", async () => {
    const root = testRoot();
    const { instances, proposals } = stores(root);
    instances.create({
      pluginInstanceId: "reqloop_default",
      pluginId: "qiankun/reqloop",
      packageVersion: "1.2.0",
    });
    let captured: PluginActivationContext | undefined;
    const plugin = reqloopPackage((context) => {
      captured = context;
    });
    const manager = new Manager({
      instances,
      proposals,
      packages: [plugin],
      onProposal() {},
    });
    await manager.activateInstance("reqloop_default");

    expect(() =>
      captured?.registerResource({
        resourceKind: "LateResource",
        reconciler: { async reconcile() {} },
      }),
    ).toThrow("plugin Binding activation is complete");
    expect(
      () =>
        new Manager({
          instances,
          proposals,
          packages: [plugin, plugin],
          onProposal() {},
        }),
    ).toThrow("plugin Package already registered: qiankun/reqloop@1.2.0");
    await manager.close();
  });

  test("Manager close is idempotent and tears down active Bindings", async () => {
    const root = testRoot();
    const { instances, proposals } = stores(root);
    instances.create({
      pluginInstanceId: "reqloop_default",
      pluginId: "qiankun/reqloop",
      packageVersion: "1.2.0",
    });
    let cleanups = 0;
    const manager = new Manager({
      instances,
      proposals,
      packages: [
        reqloopPackage((context) => {
          context.onClose(() => {
            cleanups += 1;
          });
          context.registerResource({
            resourceKind: "ReqLoopRun",
            reconciler: { async reconcile() {} },
          });
        }),
      ],
      onProposal() {},
    });
    await manager.start();

    await manager.close();
    await manager.close();

    expect(cleanups).toBe(1);
    expect(manager.isInstanceActive("reqloop_default")).toBe(false);
    await expect(manager.enqueue(key("reqloop_default", "run_1"))).rejects.toThrow(
      "plugin Manager is closed",
    );
    await expect(manager.start()).rejects.toThrow("plugin Manager is closed");
  });

  test("requires Instance and Proposal stores to own the same BatonSession", () => {
    const root = testRoot();
    const { proposals } = stores(root);
    const instances = new PluginInstanceStore({
      session: {
        id: "bs_other",
        dir: join(root, "projects", "project", "sessions", "bs_other"),
      },
    });

    expect(
      () =>
        new Manager({
          instances,
          proposals,
          onProposal() {},
        }),
    ).toThrow("plugin InstanceStore and ProposalStore must own the same BatonSession");
  });

  test("startup isolates one Instance activation failure from other Plugins", async () => {
    const root = testRoot();
    const { instances, proposals } = stores(root);
    for (const pluginInstanceId of ["broken", "healthy"]) {
      instances.create({
        pluginInstanceId,
        pluginId: "qiankun/reqloop",
        packageVersion: "1.2.0",
      });
    }
    const failures: Array<{ pluginInstanceId: string; error: unknown }> = [];
    const manager = new Manager({
      instances,
      proposals,
      packages: [
        reqloopPackage((context) => {
          if (context.instance.pluginInstanceId === "broken") {
            throw new Error("connector config is invalid");
          }
          context.registerResource({
            resourceKind: "ReqLoopRun",
            reconciler: { async reconcile() {} },
          });
        }),
      ],
      onProposal() {},
      onActivationError(failure) {
        failures.push(failure);
      },
    });

    await manager.start();

    expect(manager.isInstanceActive("broken")).toBe(false);
    expect(manager.isInstanceActive("healthy")).toBe(true);
    expect(failures).toHaveLength(1);
    expect(failures[0]?.pluginInstanceId).toBe("broken");
    expect((failures[0]?.error as Error).message).toBe("connector config is invalid");
    await manager.close();
  });
});
