import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BATON_TURN_RESOURCE_KIND,
  BuiltinResourceProjection,
} from "../src/plugin/builtin.ts";
import { PluginInstanceStore } from "../src/plugin/instance.ts";
import { Manager } from "../src/plugin/manager.ts";
import type { PluginPackage } from "../src/plugin/package.ts";
import { ProposalStore } from "../src/plugin/proposal.ts";
import { SessionStore, type SessionHandle } from "../src/store/store.ts";

const roots: string[] = [];

function testSession(): SessionHandle {
  const root = mkdtempSync(join(tmpdir(), "baton-plugin-builtin-"));
  roots.push(root);
  return new SessionStore(root).createSession({
    cwd: join(root, "project"),
  });
}

function appendTurn(
  session: SessionHandle,
  turnId: string,
  userText: string,
) {
  return session.append({
    kind: "_baton_turn_summary",
    source: { type: "baton" },
    harness: "codex",
    harnessTargetId: "codex_default",
    turnId,
    payload: {
      turnId,
      userText,
      agentText: `answer to ${userText}`,
      toolCalls: [],
    },
  });
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((onResolve) => {
    resolve = onResolve;
  });
  return { promise, resolve };
}

async function waitFor(
  predicate: () => boolean,
  timeoutMs: number = 1_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error("timed out waiting for condition");
    await Bun.sleep(5);
  }
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("Baton Builtin Resources", () => {
  test("projects completed turns from ledger replay and live events as frozen snapshots", () => {
    const session = testSession();
    const replayed = appendTurn(session, "t_replayed", "existing question");
    const projection = new BuiltinResourceProjection({ session });

    const existing = projection.get(BATON_TURN_RESOURCE_KIND, "t_replayed");
    expect(existing.metadata).toEqual({
      batonSessionId: session.id,
      resourceId: "t_replayed",
      revision: replayed.seq,
      sourceEventId: replayed.eventId,
      observedAt: replayed.ts,
    });
    expect(existing.data).toMatchObject({
      turnId: "t_replayed",
      userText: "existing question",
      harness: "codex",
      harnessTargetId: "codex_default",
    });
    expect(Object.isFrozen(existing)).toBe(true);
    expect(Object.isFrozen(existing.metadata)).toBe(true);
    expect(Object.isFrozen(existing.data)).toBe(true);

    const observed: string[] = [];
    projection.subscribe((resource) => {
      observed.push(resource.metadata.resourceId);
    });
    appendTurn(session, "t_live", "new question");

    expect(observed).toEqual(["t_live"]);
    expect(
      projection
        .list(BATON_TURN_RESOURCE_KIND)
        .map((resource) => resource.metadata.resourceId),
    ).toEqual(["t_replayed", "t_live"]);
    projection.close();
  });

  test("lets a Plugin watch turns and produce revision-based Proposals", async () => {
    const session = testSession();
    const firstEvent = appendTurn(session, "t_existing", "which harness?");
    const instances = new PluginInstanceStore({ session });
    const proposals = new ProposalStore({ session });
    instances.create({
      pluginInstanceId: "router_default",
      pluginId: "example/router",
      packageVersion: "1.0.0",
    });
    const reconciled: string[] = [];
    const surfaced: string[] = [];
    const plugin: PluginPackage = {
      pluginId: "example/router",
      version: "1.0.0",
      activate(context) {
        context.watchBuiltinResource({
          resourceKind: BATON_TURN_RESOURCE_KIND,
          reconciler: {
            async reconcile({ resource }) {
              reconciled.push(resource.metadata.resourceId);
              return {
                proposedInput: {
                  text: `Route: ${resource.data.userText}`,
                },
              };
            },
          },
        });
      },
    };
    const manager = new Manager({
      session,
      instances,
      proposals,
      packages: [plugin],
      onProposal(proposal) {
        surfaced.push(proposal.text);
      },
    });

    await manager.start();
    await waitFor(() => surfaced.length === 1);
    const first = manager.listPendingProposals()[0];
    expect(first).toMatchObject({
      key: {
        batonSessionId: session.id,
        pluginInstanceId: "router_default",
        resourceOwner: "baton",
        resourceKind: BATON_TURN_RESOURCE_KIND,
        resourceId: "t_existing",
      },
      basedOnRevision: firstEvent.seq,
      text: "Route: which harness?",
    });

    appendTurn(session, "t_live", "continue with codex");
    await waitFor(() => surfaced.length === 2);
    expect(reconciled).toEqual(["t_existing", "t_live"]);
    expect(surfaced).toEqual([
      "Route: which harness?",
      "Route: continue with codex",
    ]);

    await manager.deactivateInstance("router_default");
    appendTurn(session, "t_after_close", "should not run");
    await Bun.sleep(20);
    expect(reconciled).toEqual(["t_existing", "t_live"]);
    await manager.close();
  });

  test("retries a failed Builtin reconcile through the shared due queue", async () => {
    const session = testSession();
    appendTurn(session, "t_retry", "retry me");
    const instances = new PluginInstanceStore({ session });
    const proposals = new ProposalStore({ session });
    instances.create({
      pluginInstanceId: "router_default",
      pluginId: "example/router",
      packageVersion: "1.0.0",
    });
    let runs = 0;
    const attempts: number[] = [];
    const manager = new Manager({
      session,
      instances,
      proposals,
      retryBackoff: { initialDelayMs: 10, maxDelayMs: 10 },
      packages: [{
        pluginId: "example/router",
        version: "1.0.0",
        activate(context) {
          context.watchBuiltinResource({
            resourceKind: BATON_TURN_RESOURCE_KIND,
            reconciler: {
              async reconcile() {
                runs += 1;
                if (runs === 1) throw new Error("temporary failure");
              },
            },
          });
        },
      }],
      onProposal() {},
      onReconcileError(failure) {
        attempts.push(failure.attempt);
      },
    });

    await manager.start();
    await waitFor(() => runs === 2);
    expect(attempts).toEqual([1]);
    await manager.close();
  });

  test("does not run a Builtin watch before its Binding activation completes", async () => {
    const session = testSession();
    appendTurn(session, "t_waiting", "wait for activation");
    const instances = new PluginInstanceStore({ session });
    const proposals = new ProposalStore({ session });
    instances.create({
      pluginInstanceId: "router_default",
      pluginId: "example/router",
      packageVersion: "1.0.0",
    });
    const registered = deferred();
    const finishActivation = deferred();
    let runs = 0;
    const manager = new Manager({
      session,
      instances,
      proposals,
      packages: [{
        pluginId: "example/router",
        version: "1.0.0",
        async activate(context) {
          context.watchBuiltinResource({
            resourceKind: BATON_TURN_RESOURCE_KIND,
            reconciler: {
              async reconcile() {
                runs += 1;
              },
            },
          });
          registered.resolve();
          await finishActivation.promise;
        },
      }],
      onProposal() {},
    });

    const starting = manager.start();
    await registered.promise;
    await Bun.sleep(20);
    expect(runs).toBe(0);

    finishActivation.resolve();
    await starting;
    await waitFor(() => runs === 1);
    await manager.close();
  });
});
