// 会话存储：~/.baton/projects/<cwd 转义>/<id>/session.jsonl + meta.json。
// 与 Claude Code 一样按项目目录分组，方便按项目浏览与清理；项目目录名不可逆，
// 真相源仍是 meta.json 里的 cwd。session.jsonl 承载 BatonSession 的统一逻辑历史；
// ProviderSession 元数据只用于优先恢复 provider 私有状态，缺失时仍可从 BatonSession 重建上下文。

import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { newId } from "../events/ids.ts";
import {
  ENVELOPE_VERSION,
  textOf,
  type AnyEventEnvelope,
  type EventEnvelope,
  type EventKind,
  type NewEvent,
  type StopReason,
  type TurnSummary,
  type TurnSummaryToolCall,
  type UsageUpdate,
} from "../events/types.ts";
import { reduceEvents, type SessionState } from "./reduce.ts";

export interface ProviderSessionMeta {
  provider: string;
  providerSessionId?: string;
  /** 该 provider session 后续 turn 使用的模型；缺省表示 provider 默认值。 */
  model?: string;
  /** provider 侧恢复所需的游标（如 Claude SDK resume cursor），语义归 adapter */
  resumeCursor?: string;
  /** 该原生会话已同步到的 BatonSession 事件序号。 */
  syncedSeq?: number;
  parentSessionId?: string;
}

export interface SessionMeta {
  batonSessionId: string;
  title?: string;
  cwd: string;
  createdAt: string;
  updatedAt?: string;
  providerSessions: Record<string, ProviderSessionMeta>;
}

/** 与 Claude Code 同规则：cwd 中非字母数字字符全部替换为 "-"，作为项目目录名。 */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

export class SessionStore {
  readonly rootDir: string;
  private legacyMigrated = false;

  constructor(rootDir?: string) {
    this.rootDir = rootDir ?? join(homedir(), ".baton");
  }

  private projectsDir(): string {
    return join(this.rootDir, "projects");
  }

  /**
   * 旧布局（~/.baton/sessions/<id>）一次性迁移到按项目分组的新布局。
   * meta 缺失或损坏的目录原地保留，不阻塞正常使用。
   */
  private migrateLegacySessions(): void {
    if (this.legacyMigrated) return;
    this.legacyMigrated = true;
    const legacyDir = join(this.rootDir, "sessions");
    if (!existsSync(legacyDir)) return;
    for (const name of readdirSync(legacyDir)) {
      const metaPath = join(legacyDir, name, "meta.json");
      if (!existsSync(metaPath)) continue;
      try {
        const meta = JSON.parse(readFileSync(metaPath, "utf8")) as SessionMeta;
        const projectDir = join(this.projectsDir(), projectDirName(meta.cwd));
        mkdirSync(projectDir, { recursive: true });
        renameSync(join(legacyDir, name), join(projectDir, name));
      } catch {
        // 留在原目录，避免把无法解析的会话搬到错误的项目下
      }
    }
    try {
      rmdirSync(legacyDir); // 仅当已清空时成功
    } catch {
      // 还有残留（损坏会话），保留旧目录
    }
  }

  createSession(opts: { cwd: string; title?: string }): SessionHandle {
    this.migrateLegacySessions();
    const id = newId("bs");
    const dir = join(this.projectsDir(), projectDirName(opts.cwd), id);
    mkdirSync(dir, { recursive: true });
    const meta: SessionMeta = {
      batonSessionId: id,
      title: opts.title,
      cwd: opts.cwd,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      providerSessions: {},
    };
    writeMetaAtomic(dir, meta);
    return new SessionHandle(id, dir, meta);
  }

  /** 会话 ID 全局唯一，打开时不要求提供 cwd，跨项目扫描定位（@ 引用可指向任意项目的会话）。 */
  openSession(id: string): SessionHandle {
    this.migrateLegacySessions();
    for (const projectDir of this.listProjectDirs()) {
      const dir = join(projectDir, id);
      const metaPath = join(dir, "meta.json");
      if (!existsSync(metaPath)) continue;
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as SessionMeta;
      return new SessionHandle(id, dir, meta);
    }
    throw new Error(`baton session not found: ${id}`);
  }

  listSessions(opts: { cwd?: string } = {}): SessionMeta[] {
    this.migrateLegacySessions();
    // 指定 cwd 时只扫对应项目目录；但目录名转义不可逆（可能撞名），仍以 meta.cwd 精确过滤。
    const projectDirs =
      opts.cwd !== undefined
        ? [join(this.projectsDir(), projectDirName(opts.cwd))]
        : this.listProjectDirs();
    const out: SessionMeta[] = [];
    for (const projectDir of projectDirs) {
      if (!existsSync(projectDir)) continue;
      for (const name of readdirSync(projectDir)) {
        const metaPath = join(projectDir, name, "meta.json");
        if (!existsSync(metaPath)) continue;
        try {
          const meta = JSON.parse(readFileSync(metaPath, "utf8")) as SessionMeta;
          if (opts.cwd !== undefined && meta.cwd !== opts.cwd) continue;
          out.push(meta);
        } catch {
          // 损坏的 meta 不阻塞列表
        }
      }
    }
    out.sort((a, b) => (b.updatedAt ?? b.createdAt).localeCompare(a.updatedAt ?? a.createdAt));
    return out;
  }

  private listProjectDirs(): string[] {
    const dir = this.projectsDir();
    if (!existsSync(dir)) return [];
    return readdirSync(dir).map((name) => join(dir, name));
  }
}

function writeMetaAtomic(dir: string, meta: SessionMeta): void {
  const tmp = join(dir, "meta.json.tmp");
  writeFileSync(tmp, JSON.stringify(meta, null, 2));
  renameSync(tmp, join(dir, "meta.json"));
}

export class SessionHandle {
  readonly id: string;
  readonly dir: string;
  meta: SessionMeta;
  private nextSeq: number | undefined;

  constructor(id: string, dir: string, meta: SessionMeta) {
    this.id = id;
    this.dir = dir;
    this.meta = meta;
  }

  private jsonlPath(): string {
    return join(this.dir, "session.jsonl");
  }

  /** 补齐 v/ts/seq/batonSessionId 并追加一行。seq 以文件为准（重开进程后继续单调）。 */
  append<K extends EventKind>(ev: NewEvent<K>): EventEnvelope<K> {
    if (this.nextSeq === undefined) {
      const events = this.readEvents();
      const last = events[events.length - 1];
      this.nextSeq = (last?.seq ?? 0) + 1;
    }
    const envelope: EventEnvelope<K> = {
      v: ENVELOPE_VERSION,
      ts: new Date().toISOString(),
      seq: this.nextSeq++,
      batonSessionId: this.id,
      ...ev,
    };
    appendFileSync(this.jsonlPath(), `${JSON.stringify(envelope)}\n`);
    return envelope;
  }

  /**
   * 读全部事件。末行允许不完整（崩溃时写了半行），静默丢弃；
   * 中间行损坏说明文件被外部破坏，直接抛错而不是悄悄跳过。
   */
  readEvents(): AnyEventEnvelope[] {
    const path = this.jsonlPath();
    if (!existsSync(path)) return [];
    const lines = readFileSync(path, "utf8").split("\n");
    const out: AnyEventEnvelope[] = [];
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i] as string;
      if (line === "") continue;
      try {
        out.push(JSON.parse(line) as AnyEventEnvelope);
      } catch (err) {
        const isLast = lines.slice(i + 1).every((l) => l === "");
        if (isLast) break;
        throw new Error(`corrupt session.jsonl at line ${i + 1} in ${path}: ${err}`);
      }
    }
    return out;
  }

  loadState(): SessionState {
    return reduceEvents(this.readEvents());
  }

  updateMeta(patch: Partial<Omit<SessionMeta, "batonSessionId">>): void {
    this.meta = { ...this.meta, ...patch };
    writeMetaAtomic(this.dir, this.meta);
  }

  setProviderSession(key: string, ps: ProviderSessionMeta): void {
    this.meta.providerSessions = { ...this.meta.providerSessions, [key]: ps };
    writeMetaAtomic(this.dir, this.meta);
  }

  /**
   * 汇总一个 turn 并落盘 _baton_turn_summary 事件。
   * 幂等：同一 turnId 已有 summary 时直接返回已有的，不重复追加。
   */
  summarizeTurn(turnId: string): TurnSummary {
    return this.summarizeTurnEvent(turnId).payload;
  }

  /** 与 summarizeTurn 相同，但返回 envelope，供 live reducer 消费实际落盘事件。 */
  summarizeTurnEvent(turnId: string): EventEnvelope<"_baton_turn_summary"> {
    const events = this.readEvents();
    const existing = events.find(
      (e): e is EventEnvelope<"_baton_turn_summary"> =>
        e.kind === "_baton_turn_summary" && e.payload.turnId === turnId,
    );
    if (existing) return existing;

    const turnEvents = events.filter((e) => e.turnId === turnId);
    if (turnEvents.length === 0) {
      throw new Error(`no events for turn ${turnId} in session ${this.id}`);
    }
    const state = reduceEvents(turnEvents);

    // 自动注入块保留在原始事件里供审计，但不能进入摘要后再次被下一棒递归放大。
    const userText = stripBatonInjectedContext(joinMessages(state, "user"));
    const agentText = joinMessages(state, "agent");
    const toolCalls: TurnSummaryToolCall[] = [...state.toolCalls.values()].map((tc) => ({
      toolCallId: tc.toolCallId,
      title: tc.title,
      kind: tc.kind,
      status: tc.status,
    }));
    const usage: UsageUpdate | undefined =
      state.usage.inputTokens || state.usage.outputTokens
        ? {
            inputTokens: state.usage.inputTokens,
            outputTokens: state.usage.outputTokens,
            cacheReadTokens: state.usage.cacheReadTokens,
            cacheWriteTokens: state.usage.cacheWriteTokens,
            reasoningTokens: state.usage.reasoningTokens,
            isEstimated: state.usage.hasEstimated,
          }
        : undefined;

    const summary: TurnSummary = {
      turnId,
      stopReason: state.lastStopReason as StopReason | undefined,
      userText: userText || undefined,
      agentText: agentText || undefined,
      toolCalls,
      usage,
      startedAt: turnEvents[0]?.ts,
      endedAt: turnEvents[turnEvents.length - 1]?.ts,
    };
    const provider = turnEvents[0]?.provider ?? "baton";
    const event = this.append({ kind: "_baton_turn_summary", payload: summary, provider, turnId }) as EventEnvelope<"_baton_turn_summary">;
    this.updateMeta({ updatedAt: summary.endedAt ?? new Date().toISOString() });
    return event;
  }
}

function joinMessages(state: SessionState, role: "user" | "agent"): string {
  const parts: string[] = [];
  for (const item of state.timeline) {
    if (item.type !== "message") continue;
    const msg = state.messages.get(item.id);
    if (msg && msg.role === role) {
      const text = textOf(msg.content);
      if (text) parts.push(text);
    }
  }
  return parts.join("\n");
}

function stripBatonInjectedContext(text: string): string {
  return text.replace(/<baton-(context|sync)>[\s\S]*?<\/baton-\1>\s*/g, "").trim();
}
