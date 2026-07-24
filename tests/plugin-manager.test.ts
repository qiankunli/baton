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

async function waitFor(predicate: () => boolean, timeoutMs: number = 1_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(5);
  }
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
        async reconcile(_baton, resource) {
          started.push(resource.metadata.pluginInstanceId);
          await gate.promise;
          return {
            output: {
              kind: "proposed-input",
              text: "Review requirement",
            },
          };
        },
      },
    });
    manager.registerController<Spec, Record<string, never>>({
      store: deployStore,
      resourceKind: "Deployment",
      reconciler: {
        async reconcile(_baton, resource) {
          started.push(resource.metadata.pluginInstanceId);
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

  test("registration close prevents work still waiting for global capacity", async () => {
    const root = testRoot();
    const firstStore = store(root, "reqloop_default");
    const waitingStore = store(root, "deploy_default");
    createResource(firstStore, "ReqLoopRun", "run_1");
    createResource(waitingStore, "Deployment", "deployment_1");
    const gate = deferred();
    let waitingRuns = 0;
    const manager = new Manager({
      maxTotalConcurrency: 1,
      proposals: proposalStore(root),
      onProposal() {},
    });
    manager.registerController<Spec, Record<string, never>>({
      store: firstStore,
      resourceKind: "ReqLoopRun",
      reconciler: {
        async reconcile() {
          await gate.promise;
        },
      },
    });
    const waitingRegistration = manager.registerController<Spec, Record<string, never>>({
      store: waitingStore,
      resourceKind: "Deployment",
      reconciler: {
        async reconcile() {
          waitingRuns += 1;
        },
      },
    });

    const running = manager.enqueue(key("reqloop_default", "run_1"));
    const waiting = manager.enqueue(
      key("deploy_default", "deployment_1", "Deployment"),
    );
    await Promise.resolve();
    waitingRegistration.close();
    const waitingResult = waiting.then(
      () => undefined,
      (error: unknown) => error,
    );
    gate.resolve();

    await expect(running).resolves.toBeUndefined();
    const waitingError = await waitingResult;
    expect(waitingError).toBeInstanceOf(Error);
    expect((waitingError as Error).message).toBe("plugin Controller is closed");
    expect(waitingRuns).toBe(0);
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
        async reconcile(_baton, resource) {
          started.push(
            `${resource.metadata.pluginInstanceId}/${resource.metadata.resourceId}`,
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
        async reconcile(_baton, resource) {
          started.push(
            `${resource.metadata.pluginInstanceId}/${resource.metadata.resourceId}`,
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
    expect(
      () =>
        new Manager({
          proposals: proposalStore(root),
          onProposal() {},
          retryBackoff: { initialDelayMs: 0 },
        }),
    ).toThrow("retryBackoff.initialDelayMs must be a positive integer");
    expect(
      () =>
        new Manager({
          proposals: proposalStore(root),
          onProposal() {},
          retryBackoff: { initialDelayMs: 20, maxDelayMs: 10 },
        }),
    ).toThrow("retryBackoff.maxDelayMs must be at least initialDelayMs");
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
          return {
            output: {
              kind: "proposed-input",
              text: "Review requirement",
            },
          };
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

  test("restores expired and future reconcile times when the Manager starts", async () => {
    const root = testRoot();
    const resources = store(root, "reqloop_default");
    createResource(resources, "ReqLoopRun", "expired");
    createResource(resources, "ReqLoopRun", "future");
    const now = Date.now();
    resources.setNextReconcileAt("ReqLoopRun", "expired", new Date(now - 1_000));
    resources.setNextReconcileAt("ReqLoopRun", "future", new Date(now + 100));
    const runs: string[] = [];
    const manager = new Manager({
      proposals: proposalStore(root),
      onProposal() {},
    });
    const registration = manager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceKind: "ReqLoopRun",
      reconciler: {
        async reconcile(_baton, resource) {
          runs.push(resource.metadata.resourceId);
        },
      },
    });

    await manager.start();
    await waitFor(() => runs.includes("expired"));
    expect(runs).toEqual(["expired"]);
    await waitFor(() => runs.includes("future"));
    expect(runs).toEqual(["expired", "future"]);
    expect(resources.get("ReqLoopRun", "expired").metadata.nextReconcileAt).toBeUndefined();
    expect(resources.get("ReqLoopRun", "future").metadata.nextReconcileAt).toBeUndefined();
    registration.close();
  });

  test("turns requeueAfter into another reconcile and replaces the persisted due time", async () => {
    const root = testRoot();
    const resources = store(root, "reqloop_default");
    createResource(resources, "ReqLoopRun", "run_1");
    let runs = 0;
    const manager = new Manager({
      proposals: proposalStore(root),
      onProposal() {},
    });
    const registration = manager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceKind: "ReqLoopRun",
      reconciler: {
        async reconcile() {
          runs += 1;
          if (runs === 1) return { requeueAfterMs: 20 };
        },
      },
    });

    await manager.start();
    await manager.enqueue(key("reqloop_default", "run_1"));
    expect(resources.get("ReqLoopRun", "run_1").metadata.nextReconcileAt).toBeDefined();
    await waitFor(() => runs === 2);
    expect(resources.get("ReqLoopRun", "run_1").metadata.nextReconcileAt).toBeUndefined();
    registration.close();
  });

  test("persists error backoff so another Manager can recover the retry", async () => {
    const root = testRoot();
    const resources = store(root, "reqloop_default");
    createResource(resources, "ReqLoopRun", "run_1");
    const failures: Array<{ attempt: number; nextRetryAt?: string }> = [];
    const firstManager = new Manager({
      proposals: proposalStore(root),
      onProposal() {},
      retryBackoff: { initialDelayMs: 30, maxDelayMs: 60 },
      onReconcileError(failure) {
        failures.push({
          attempt: failure.attempt,
          nextRetryAt: failure.nextRetryAt,
        });
      },
    });
    const firstRegistration = firstManager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceKind: "ReqLoopRun",
      reconciler: {
        async reconcile() {
          throw new Error("connector unavailable");
        },
      },
    });

    await expect(firstManager.enqueue(key("reqloop_default", "run_1"))).rejects.toThrow(
      "connector unavailable",
    );
    expect(failures).toEqual([{ attempt: 1, nextRetryAt: expect.any(String) }]);
    expect(resources.get("ReqLoopRun", "run_1").metadata.nextReconcileAt).toBe(
      failures[0]?.nextRetryAt,
    );
    firstRegistration.close();

    let recoveredRuns = 0;
    const recoveredManager = new Manager({
      proposals: proposalStore(root),
      onProposal() {},
    });
    const recoveredRegistration = recoveredManager.registerController<
      Spec,
      Record<string, never>
    >({
      store: resources,
      resourceKind: "ReqLoopRun",
      reconciler: {
        async reconcile() {
          recoveredRuns += 1;
        },
      },
    });
    await recoveredManager.start();
    await waitFor(() => recoveredRuns === 1);
    expect(resources.get("ReqLoopRun", "run_1").metadata.nextReconcileAt).toBeUndefined();
    recoveredRegistration.close();
  });

  test("backs off repeated failures per key and resets the attempt after success", async () => {
    const root = testRoot();
    const resources = store(root, "reqloop_default");
    createResource(resources, "ReqLoopRun", "run_1");
    let runs = 0;
    let failNext = false;
    const attempts: number[] = [];
    const manager = new Manager({
      proposals: proposalStore(root),
      onProposal() {},
      retryBackoff: { initialDelayMs: 10, maxDelayMs: 20 },
      onReconcileError(failure) {
        attempts.push(failure.attempt);
      },
    });
    const registration = manager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceKind: "ReqLoopRun",
      reconciler: {
        async reconcile() {
          runs += 1;
          if (runs <= 2 || failNext) {
            failNext = false;
            throw new Error("transient connector failure");
          }
        },
      },
    });

    await manager.start();
    await expect(manager.enqueue(key("reqloop_default", "run_1"))).rejects.toThrow(
      "transient connector failure",
    );
    await waitFor(() => runs === 3);
    expect(attempts).toEqual([1, 2]);

    failNext = true;
    await expect(manager.enqueue(key("reqloop_default", "run_1"))).rejects.toThrow(
      "transient connector failure",
    );
    expect(attempts).toEqual([1, 2, 1]);
    await waitFor(() => runs === 5);
    registration.close();
  });

  test("registration close cancels its future reconcile wake-ups", async () => {
    const root = testRoot();
    const resources = store(root, "reqloop_default");
    createResource(resources, "ReqLoopRun", "run_1");
    resources.setNextReconcileAt(
      "ReqLoopRun",
      "run_1",
      new Date(Date.now() + 50),
    );
    let runs = 0;
    const manager = new Manager({
      proposals: proposalStore(root),
      onProposal() {},
    });
    const registration = manager.registerController<Spec, Record<string, never>>({
      store: resources,
      resourceKind: "ReqLoopRun",
      reconciler: {
        async reconcile() {
          runs += 1;
        },
      },
    });

    await manager.start();
    registration.close();
    await Bun.sleep(80);
    expect(runs).toBe(0);
  });
});
