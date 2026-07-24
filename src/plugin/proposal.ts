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
import type { ReconcileKey, ReconcileProposal } from "./controller.ts";

export type ProposalOutcome = "submitted" | "dismissed";

export interface ProposalResolution {
  readonly outcome: ProposalOutcome;
  readonly resolvedAt: string;
}

/**
 * Reconciler 建议给用户的持久文本草稿。resolution 缺省即待处理，不另造 pending 状态字段。
 */
export interface Proposal extends ReconcileProposal {
  readonly proposalId: string;
  readonly createdAt: string;
  readonly resolution?: ProposalResolution;
}

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
    left.resourceId === right.resourceId
  );
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
          current.basedOnGeneration !== owned.basedOnGeneration ||
          current.text !== owned.text
        ) {
          throw new Error(`plugin proposal identity collision: ${id}`);
        }
        return current;
      }
      const proposal: Proposal = {
        proposalId: id,
        key: owned.key,
        basedOnGeneration: owned.basedOnGeneration,
        text: owned.text,
        createdAt: this.timestamp(),
      };
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
    };
    for (const [name, value] of Object.entries(key)) assertPathSegment(name, value);
    if (key.batonSessionId !== this.batonSessionId) {
      throw new Error(
        `plugin proposal batonSessionId must be ${this.batonSessionId}, got ${key.batonSessionId}`,
      );
    }
    positiveInteger("basedOnGeneration", draft.basedOnGeneration);
    if (typeof draft.text !== "string" || !draft.text.trim()) {
      throw new Error("plugin proposal text must not be empty");
    }
    return Object.freeze({
      key: Object.freeze(key),
      basedOnGeneration: draft.basedOnGeneration,
      text: draft.text,
    });
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
      const proposal = value as Partial<Proposal>;
      if (proposal.proposalId !== expectedId) {
        throw new Error(`proposalId must be ${expectedId}`);
      }
      const draft = this.validateDraft({
        key: proposal.key as ReconcileKey,
        basedOnGeneration: proposal.basedOnGeneration as number,
        text: proposal.text as string,
      });
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
        proposalId: proposal.proposalId,
        ...draft,
        createdAt: proposal.createdAt,
        ...(resolution ? { resolution } : {}),
      };
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
