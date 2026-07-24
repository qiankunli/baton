import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";

import { withFileLock } from "../store/file-lock.ts";
import type { SessionHandle } from "../store/store.ts";
import {
  type ReconcileKey,
  type ReconcileProposal,
} from "./controller.ts";
import { reconcileResourceOwner } from "./reconcile-scope.ts";

export type ProposalOutcome = "submitted" | "dismissed";

export interface ProposalResolution {
  readonly outcome: ProposalOutcome;
  readonly resolvedAt: string;
}

/**
 * Reconciler 建议给用户的持久文本草稿。resolution 缺省即待处理，不另造 pending 状态字段。
 */
export type Proposal = ReconcileProposal & {
  readonly proposalId: string;
  readonly createdAt: string;
  readonly resolution?: ProposalResolution;
};

export interface ProposalStoreOptions {
  session: Pick<SessionHandle, "id" | "dir">;
  now?: () => Date;
}

const PATH_SEGMENT = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PROPOSAL_ID = /^pp_[0-9a-f]{64}$/;

function assertPathSegment(name: string, value: string): void {
  if (!PATH_SEGMENT.test(value) || value === "." || value === "..") {
    throw new Error(`${name} must be a non-empty stable identifier without path separators`);
  }
}

function positiveInteger(name: string, value: unknown): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < 1) {
    throw new Error(`${name} must be a positive integer`);
  }
}

function isoTimestamp(name: string, value: unknown): asserts value is string {
  if (typeof value !== "string" || !value || Number.isNaN(Date.parse(value))) {
    throw new Error(`${name} must be an ISO timestamp`);
  }
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function proposalId(proposal: ReconcileProposal): string {
  const textDigest = sha256(proposal.text);
  if (proposal.basedOnGeneration !== undefined) {
    // 保留首版 PluginResource Proposal 的稳定身份，升级后已有文件仍可校验。
    return `pp_${sha256(
      JSON.stringify([
        proposal.key.batonSessionId,
        proposal.key.pluginInstanceId,
        proposal.key.resourceKind,
        proposal.key.resourceId,
        proposal.basedOnGeneration,
        textDigest,
      ]),
    )}`;
  }
  return `pp_${sha256(
    JSON.stringify([
      proposal.key.batonSessionId,
      proposal.key.pluginInstanceId,
      "baton",
      proposal.key.resourceKind,
      proposal.key.resourceId,
      proposal.basedOnRevision,
      textDigest,
    ]),
  )}`;
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.${Math.random()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function sameKey(left: ReconcileKey, right: ReconcileKey): boolean {
  return (
    left.batonSessionId === right.batonSessionId &&
    left.pluginInstanceId === right.pluginInstanceId &&
    left.resourceKind === right.resourceKind &&
    left.resourceId === right.resourceId &&
    reconcileResourceOwner(left) === reconcileResourceOwner(right)
  );
}

function sameBasis(left: ReconcileProposal, right: ReconcileProposal): boolean {
  return (
    left.basedOnGeneration === right.basedOnGeneration &&
    left.basedOnRevision === right.basedOnRevision
  );
}

interface SerializedProposal {
  proposalId?: unknown;
  key?: unknown;
  basedOnGeneration?: unknown;
  basedOnRevision?: unknown;
  text?: unknown;
  createdAt?: unknown;
  resolution?: {
    outcome?: unknown;
    resolvedAt?: unknown;
  };
}

export class ProposalStore {
  readonly batonSessionId: string;
  readonly session: Readonly<Pick<SessionHandle, "id" | "dir">>;
  private readonly sessionDir: string;
  private readonly now: () => Date;

  constructor(options: ProposalStoreOptions) {
    assertPathSegment("batonSessionId", options.session.id);
    this.session = Object.freeze({
      id: options.session.id,
      dir: options.session.dir,
    });
    this.sessionDir = this.session.dir;
    this.batonSessionId = options.session.id;
    this.now = options.now ?? (() => new Date());
  }

  /**
   * 以稳定身份幂等记录 Proposal。相同 Resource generation 和文本只会得到同一个对象。
   */
  record(draft: ReconcileProposal): Proposal {
    const owned = this.validateDraft(draft);
    const id = proposalId(owned);
    const path = this.proposalPath(owned.key.pluginInstanceId, id);
    return withFileLock(path, () => {
      if (existsSync(path)) {
        const current = this.readProposal(path, id);
        if (
          !sameKey(current.key, owned.key) ||
          !sameBasis(current, owned) ||
          current.text !== owned.text
        ) {
          throw new Error(`plugin proposal identity collision: ${id}`);
        }
        return current;
      }
      const proposal = {
        proposalId: id,
        ...owned,
        createdAt: this.timestamp(),
      } as Proposal;
      writeJsonAtomic(path, proposal);
      return proposal;
    });
  }

  get(proposalId: string): Proposal {
    this.assertProposalId(proposalId);
    return this.readProposal(this.findProposalPath(proposalId), proposalId);
  }

  listPending(): Proposal[] {
    const pluginsDir = join(this.sessionDir, "plugins");
    if (!existsSync(pluginsDir)) return [];
    const proposals: Proposal[] = [];
    for (const plugin of readdirSync(pluginsDir, { withFileTypes: true })) {
      if (!plugin.isDirectory()) continue;
      const directory = this.proposalsDir(plugin.name);
      if (!existsSync(directory)) continue;
      for (const entry of readdirSync(directory, { withFileTypes: true })) {
        if (!entry.isFile() || !entry.name.endsWith(".json")) continue;
        const id = entry.name.slice(0, -".json".length);
        this.assertProposalId(id);
        const proposal = this.readProposal(join(directory, entry.name), id);
        if (!proposal.resolution) proposals.push(proposal);
      }
    }
    return proposals.sort(
      (left, right) =>
        left.createdAt.localeCompare(right.createdAt) ||
        left.proposalId.localeCompare(right.proposalId),
    );
  }

  /**
   * Proposal 只允许首次终结；重复处理返回最先持久化的 resolution。
   */
  resolve(proposalId: string, outcome: ProposalOutcome): Proposal {
    this.assertProposalId(proposalId);
    if (outcome !== "submitted" && outcome !== "dismissed") {
      throw new Error(`plugin proposal outcome is invalid: ${String(outcome)}`);
    }
    const path = this.findProposalPath(proposalId);
    return withFileLock(path, () => {
      const current = this.readProposal(path, proposalId);
      if (current.resolution) return current;
      const proposal: Proposal = {
        ...current,
        resolution: {
          outcome,
          resolvedAt: this.timestamp(),
        },
      };
      writeJsonAtomic(path, proposal);
      return proposal;
    });
  }

  private validateDraft(draft: ReconcileProposal): ReconcileProposal {
    const key = {
      batonSessionId: draft.key.batonSessionId,
      pluginInstanceId: draft.key.pluginInstanceId,
      resourceKind: draft.key.resourceKind,
      resourceId: draft.key.resourceId,
      ...(draft.key.resourceOwner === undefined
        ? {}
        : { resourceOwner: draft.key.resourceOwner }),
    };
    for (const [name, value] of Object.entries({
      batonSessionId: key.batonSessionId,
      pluginInstanceId: key.pluginInstanceId,
      resourceKind: key.resourceKind,
      resourceId: key.resourceId,
    })) {
      assertPathSegment(name, value);
    }
    if (key.batonSessionId !== this.batonSessionId) {
      throw new Error(
        `plugin proposal batonSessionId must be ${this.batonSessionId}, got ${key.batonSessionId}`,
      );
    }
    const owner = reconcileResourceOwner(key);
    if (owner === "plugin") {
      positiveInteger("basedOnGeneration", draft.basedOnGeneration);
      if (draft.basedOnRevision !== undefined) {
        throw new Error("PluginResource proposal must not set basedOnRevision");
      }
    } else {
      positiveInteger("basedOnRevision", draft.basedOnRevision);
      if (draft.basedOnGeneration !== undefined) {
        throw new Error("Builtin Resource proposal must not set basedOnGeneration");
      }
    }
    if (typeof draft.text !== "string" || !draft.text.trim()) {
      throw new Error("plugin proposal text must not be empty");
    }
    const owned = {
      key: Object.freeze(key),
      text: draft.text,
      ...(owner === "plugin"
        ? { basedOnGeneration: draft.basedOnGeneration }
        : { basedOnRevision: draft.basedOnRevision }),
    } as ReconcileProposal;
    return Object.freeze(owned);
  }

  private readProposal(path: string, expectedId: string): Proposal {
    let value: unknown;
    try {
      value = JSON.parse(readFileSync(path, "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new Error(`plugin proposal not found: ${expectedId}`);
      }
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`could not read plugin proposal ${path}: ${detail}`);
    }
    try {
      if (!value || typeof value !== "object" || Array.isArray(value)) {
        throw new Error("root must be a JSON object");
      }
      const proposal = value as SerializedProposal;
      if (proposal.proposalId !== expectedId) {
        throw new Error(`proposalId must be ${expectedId}`);
      }
      const rawDraft = {
        key: proposal.key as ReconcileKey,
        text: proposal.text as string,
        ...(proposal.basedOnGeneration === undefined
          ? {}
          : { basedOnGeneration: proposal.basedOnGeneration as number }),
        ...(proposal.basedOnRevision === undefined
          ? {}
          : { basedOnRevision: proposal.basedOnRevision as number }),
      } as ReconcileProposal;
      const draft = this.validateDraft(rawDraft);
      if (proposal.proposalId !== proposalId(draft)) {
        throw new Error("proposalId does not match proposal content");
      }
      isoTimestamp("createdAt", proposal.createdAt);
      let resolution: ProposalResolution | undefined;
      if (proposal.resolution !== undefined) {
        if (
          !proposal.resolution ||
          (proposal.resolution.outcome !== "submitted" &&
            proposal.resolution.outcome !== "dismissed")
        ) {
          throw new Error("resolution outcome must be submitted or dismissed");
        }
        isoTimestamp("resolvedAt", proposal.resolution.resolvedAt);
        resolution = {
          outcome: proposal.resolution.outcome,
          resolvedAt: proposal.resolution.resolvedAt,
        };
      }
      return {
        proposalId: proposal.proposalId as string,
        ...draft,
        createdAt: proposal.createdAt as string,
        ...(resolution ? { resolution } : {}),
      } as Proposal;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`invalid plugin proposal ${path}: ${detail}`);
    }
  }

  private timestamp(): string {
    const now = this.now();
    if (Number.isNaN(now.getTime())) {
      throw new Error("ProposalStore now() returned an invalid Date");
    }
    return now.toISOString();
  }

  private proposalsDir(pluginInstanceId: string): string {
    return join(this.sessionDir, "plugins", pluginInstanceId, "proposals");
  }

  private proposalPath(pluginInstanceId: string, proposalId: string): string {
    return join(this.proposalsDir(pluginInstanceId), `${proposalId}.json`);
  }

  private findProposalPath(proposalId: string): string {
    const pluginsDir = join(this.sessionDir, "plugins");
    if (existsSync(pluginsDir)) {
      for (const plugin of readdirSync(pluginsDir, { withFileTypes: true })) {
        if (!plugin.isDirectory()) continue;
        const path = this.proposalPath(plugin.name, proposalId);
        if (existsSync(path)) return path;
      }
    }
    throw new Error(`plugin proposal not found: ${proposalId}`);
  }

  private assertProposalId(proposalId: string): void {
    if (!PROPOSAL_ID.test(proposalId)) {
      throw new Error(`invalid plugin proposal id: ${proposalId}`);
    }
  }
}
