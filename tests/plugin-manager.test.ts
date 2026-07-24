import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  ReconcileKey,
  ReconcileScope,
} from "../src/plugin/controller.ts";
import { Manager } from "../src/plugin/manager.ts";
import { type Proposal, ProposalStore } from "../src/plugin/proposal.ts";
import { PluginResourceStore } from "../src/plugin/resource.ts";

interface Spec {
  value: string;
}

const roots: string[] = [];

function testRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "baton-plugin-manager-"));
  roots.push(root);
  return root;
}

function scope(pluginInstanceId: string, resourceKind: string = "ReqLoopRun"): ReconcileScope {
  return {
    batonSessionId: "bs_test",
    pluginInstanceId,
    resourceKind,
  };
}

function key(
  pluginInstanceId: string,
  resourceId: string,
  resourceKind: string = "ReqLoopRun",
): ReconcileKey {
  return {
    ...scope(pluginInstanceId, resourceKind),
    resourceId,
  };
}

function testSession(root: string): { id: string; dir: string } {
  return {
    id: "bs_test",
    dir: join(root, "projects", "project", "sessions", "bs_test"),
  };
}

function store(root: string, pluginInstanceId: string): PluginResourceStore {
  return new PluginResourceStore({
    session: testSession(root),
    pluginInstanceId,
  });
}

function proposalStore(root: string): ProposalStore {
  return new ProposalStore({
    session: testSession(root),
  });
}

function createResource(
  resources: PluginResourceStore,
  resourceKind: string,
  resourceId: string,
): void {
  resources.create<Spec>({
    kind: resourceKind,
    resourceId,
    spec: { value: resourceId },
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("plugin Manager", () => {
  test("routes many Plugin instances through one globally bounded capacity", async () => {
    const root = testRoot();
    const reqloopStore = store(root, "reqloop_default");
    const deployStore = store(root, "deploy_default");
    createResource(reqloopStore, "ReqLoopRun", "run_1");
    createResource(deployStore, "Deployment", "deployment_1");
    const gate = deferred();
    const started: string[] = [];
    const proposals: Proposal[] = [];
    const persisted = proposalStore(root);
    const manager = new Manager({
      maxTotalConcurrency: 1,
      proposals: persisted,
      onProposal(proposal) {
        expect(persisted.get(proposal.proposalId)).toEqual(proposal);
        proposals.push(proposal);
      },
    });
    manager.registerController<Spec, Record<string, never>>({
      store: reqloopStore,
      resourceKind: "ReqLoopRun",
      reconciler: {
        async reconcile(context) {
          started.push(context.resource.metadata.pluginInstanceId);
          await gate.promise;
          return { proposedInput: { text: "Review requirement" } };
        },
      },
    });
    manager.registerController<Spec, Record<string, never>>({
      store: deployStore,
      resourceKind: "Deployment",
      reconciler: {
        async reconcile(context) {
          started.push(context.resource.metadata.pluginInstanceId);
        },
      },
    });

    const first = manager.enqueue(key("reqloop_default", "run_1"));
    const second = manager.enqueue(key("deploy_default", "deployment_1", "Deployment"));
    await Promise.resolve();
    expect(started).toEqual(["reqloop_default"]);

    gate.resolve();
    await Promise.all([first, second]);
    expect(started).toEqual(["reqloop_default", "deploy_default"]);
    expect(proposals.map((proposal) => proposal.text)).toEqual(["Review requirement"]);
  });

  test("rejects duplicate scopes and an unregistered route", async () => {
    const root = testRoot();
    const resources = store(root, "reqloop_default");
    const definition = {
      store: resources,
      resourceKind: "ReqLoopRun",
      reconciler: { async reconcile() {} },
    };
    const manager = new Manager({ proposals: proposalStore(root), onProposal() {} });
    manager.registerController(definition);

    expect(() => manager.registerController(definition)).toThrow(
      "plugin Controller already registered for bs_test/reqloop_default/ReqLoopRun",
    );
    await expect(manager.enqueue(key("missing", "run_1"))).rejects.toThrow(
      "no plugin Controller registered for bs_test/missing/ReqLoopRun",
    );
  });

  test("registration close is idempotent and removes only its Controller", async () => {
    const root = testRoot();
    const resources = store(root, "reqloop_default");
    createResource(resources, "ReqLoopRun", "run_1");
    const manager = new Manager({ proposals: proposalStore(root), onProposal() {} });
    const registration = manager.registerController({
      store: resources,
      resourceKind: "ReqLoopRun",
      reconciler: { async reconcile() {} },
    });

    await expect(manager.enqueue(key("reqloop_default", "run_1"))).resolves.toBeUndefined();
    registration.close();
    registration.close();
    await expect(manager.enqueue(key("reqloop_default", "run_1"))).rejects.toThrow(
      "no plugin Controller registered for bs_test/reqloop_default/ReqLoopRun",
    );
  });

  test("keeps per-Controller concurrency independent under the global limit", async () => {
    const root = testRoot();
    const reqloopStore = store(root, "reqloop_default");
    const deployStore = store(root, "deploy_default");
    createResource(reqloopStore, "ReqLoopRun", "run_1");
    createResource(reqloopStore, "ReqLoopRun", "run_2");
    createResource(deployStore, "Deployment", "deployment_1");
    const gate = deferred();
    const started: string[] = [];
    const manager = new Manager({
      maxTotalConcurrency: 2,
      proposals: proposalStore(root),
      onProposal() {},
    });
    manager.registerController<Spec, Record<string, never>>({
      store: reqloopStore,
      resourceKind: "ReqLoopRun",
      maxConcurrency: 1,
      reconciler: {
        async reconcile(context) {
          started.push(
            `${context.resource.metadata.pluginInstanceId}/${context.resource.metadata.resourceId}`,
          );
          await gate.promise;
        },
      },
    });
    manager.registerController<Spec, Record<string, never>>({
      store: deployStore,
      resourceKind: "Deployment",
      maxConcurrency: 1,
      reconciler: {
        async reconcile(context) {
          started.push(
            `${context.resource.metadata.pluginInstanceId}/${context.resource.metadata.resourceId}`,
          );
          await gate.promise;
        },
      },
    });

    const reqloopFirst = manager.enqueue(key("reqloop_default", "run_1"));
    const reqloopSecond = manager.enqueue(key("reqloop_default", "run_2"));
    const deployment = manager.enqueue(
      key("deploy_default", "deployment_1", "Deployment"),
    );
    await Promise.resolve();
    await Promise.resolve();
    expect(started).toEqual([
      "reqloop_default/run_1",
      "deploy_default/deployment_1",
    ]);

    gate.resolve();
    await Promise.all([reqloopFirst, reqloopSecond, deployment]);
    expect(started).toEqual([
      "reqloop_default/run_1",
      "deploy_default/deployment_1",
      "reqloop_default/run_2",
    ]);
  });

  test("validates total capacity", () => {
    const root = testRoot();
    expect(
      () =>
        new Manager({
          maxTotalConcurrency: 0,
          proposals: proposalStore(root),
          onProposal() {},
        }),
    ).toThrow(
      "maxTotalConcurrency must be a positive integer",
    );
  });

  test("does not surface the same Proposal again after the user resolves it", async () => {
    const root = testRoot();
    const resources = store(root, "reqloop_default");
    createResource(resources, "ReqLoopRun", "run_1");
    const surfaced: Proposal[] = [];
    const manager = new Manager({
      proposals: proposalStore(root),
      onProposal(proposal) {
        surfaced.push(proposal);
      },
    });
    manager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceKind: "ReqLoopRun",
      reconciler: {
        async reconcile() {
          return { proposedInput: { text: "Review requirement" } };
        },
      },
    });

    await manager.enqueue(key("reqloop_default", "run_1"));
    expect(surfaced).toHaveLength(1);
    const proposal = surfaced[0] as Proposal;
    expect(manager.resolveProposal(proposal.proposalId, "dismissed").resolution?.outcome).toBe(
      "dismissed",
    );

    await manager.enqueue(key("reqloop_default", "run_1"));
    expect(surfaced).toHaveLength(1);
    expect(manager.listPendingProposals()).toEqual([]);
  });

  test("restores pending Proposals on start and can retry a failed projection", async () => {
    const root = testRoot();
    const persisted = proposalStore(root);
    const pending = persisted.record({
      key: key("reqloop_default", "run_1"),
      basedOnGeneration: 1,
      text: "Review requirement",
    });
    let shouldFail = true;
    const surfaced: Proposal[] = [];
    const manager = new Manager({
      proposals: persisted,
      onProposal(proposal) {
        if (shouldFail) throw new Error("view unavailable");
        surfaced.push(proposal);
      },
    });

    await expect(manager.start()).rejects.toThrow("view unavailable");
    shouldFail = false;
    await manager.start();
    await manager.start();

    expect(surfaced).toEqual([pending]);
  });
});
