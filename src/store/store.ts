// 会话存储：~/.baton/projects/<cwd 转义>/<id>/session.jsonl + session.log + meta.json。
// 与 Claude Code 一样按项目目录分组，方便按项目浏览与清理；项目目录名不可逆，
// 真相源仍是 meta.json 里的 cwd。session.jsonl 承载 BatonSession 的统一逻辑历史；
// ProviderSession 元数据只用于优先恢复 provider 私有状态，缺失时仍可从 BatonSession 重建上下文。

import {
  appendFileSync,
  closeSync,
  existsSync,
  mkdirSync,
  openSync,
  readFileSync,
  readSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  truncateSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import type { DiagnosticEntry } from "../diagnostics.ts";
import { diagnosticError } from "../diagnostics.ts";
import { newId } from "../events/ids.ts";
import {
  ENVELOPE_VERSION,
  textOf,
  type AnyEventEnvelope,
  type ContentBlock,
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
  /** 该 provider session 后续 turn 使用的推理强度；缺省表示 provider 默认值。 */
  effort?: string;
  /** provider 侧恢复所需的游标（如 Claude SDK resume cursor），语义归 adapter */
  resumeCursor?: string;
  /** 该原生会话已同步到的 BatonSession 事件序号。 */
  syncedSeq?: number;
  parentSessionId?: string;
}

/** fork 谱系：child 复制了哪个会话、复制到哪个事件水位（将来从消息 fork 时即边界）。 */
export interface SessionForkOrigin {
  batonSessionId: string;
  /** 源会话中被复制历史的最后一个事件 seq */
  throughSeq: number;
}

export interface SessionMeta {
  batonSessionId: string;
  /** Session 名称：可由用户显式指定；fork 未命名时由第一条 queue 补齐。 */
  title?: string;
  /** 第一条真实用户输入的紧凑预览，只写一次；供 resume/list/@ 发现会话。 */
  preview?: string;
  /** 会话名称之外的补充说明；fork session 用它快照来源会话。 */
  description?: string;
  cwd: string;
  createdAt: string;
  updatedAt?: string;
  providerSessions: Record<string, ProviderSessionMeta>;
  forkedFrom?: SessionForkOrigin;
}

/** 与 Claude Code 同规则：cwd 中非字母数字字符全部替换为 "-"，作为项目目录名。 */
export function projectDirName(cwd: string): string {
  return cwd.replace(/[^a-zA-Z0-9]/g, "-");
}

const SESSION_PREVIEW_MAX_CHARS = 100;
const SESSION_PREVIEW_SCAN_BYTES = 256 * 1024;

/** 对齐 Codex resume：取第一条有效用户输入的首个非空行，并做有界字符截断。 */
export function sessionPreview(text: string): string | undefined {
  const firstLine = stripBatonInjectedContext(text)
    .split(/\r?\n/)
    // chat-tui 的图片粘贴目前以本地路径进入文本；它是附件，不是可辨识的会话名称。
    .map((line) =>
      line
        .trim()
        .replace(/^\/\S+\.(?:avif|bmp|gif|jpe?g|png|tiff?|webp)(?:\s+|$)/i, "")
        .trim(),
    )
    .find(Boolean);
  if (!firstLine) return undefined;
  const chars = [...firstLine];
  return chars.length <= SESSION_PREVIEW_MAX_CHARS
    ? firstLine
    : `${chars.slice(0, SESSION_PREVIEW_MAX_CHARS - 3).join("")}...`;
}

/** 旧版本自动写入的标题不是用户命名，展示时应让位给 conversation preview。 */
function explicitSessionTitle(meta: SessionMeta): string | undefined {
  const title = meta.title?.trim();
  if (!title) return undefined;
  // 冻结的 legacy 集合：匹配的是历史版本写入的自动标题，刻意不从 provider registry
  // 派生——将来新增 provider 不会产生这种标题，跟随 registry 反而会误伤同名用户标题。
  const generated = ["chat", "codex", "claude", "claude-code"].flatMap((agent) => {
    const base = `${agent} @ ${meta.cwd}`;
    return [base, `${base} (fork)`];
  });
  return generated.includes(title) ? undefined : title;
}

export function sessionDisplayTitle(meta: SessionMeta): string {
  const explicitTitle = explicitSessionTitle(meta);
  if (meta.forkedFrom) {
    return explicitTitle ?? meta.description?.trim() ?? `fork: chat @ ${meta.cwd}`;
  }
  return explicitTitle ?? meta.preview?.trim() ?? `chat @ ${meta.cwd}`;
}

function previewFromSessionLog(dir: string): string | undefined {
  const path = join(dir, "session.jsonl");
  if (!existsSync(path)) return undefined;
  const fd = openSync(path, "r");
  try {
    const buffer = Buffer.alloc(SESSION_PREVIEW_SCAN_BYTES);
    const bytes = readSync(fd, buffer, 0, buffer.length, 0);
    const text = buffer.toString("utf8", 0, bytes);
    const lastNewline = text.lastIndexOf("\n");
    const complete = bytes < buffer.length ? text : lastNewline >= 0 ? text.slice(0, lastNewline) : "";
    for (const line of complete.split("\n")) {
      if (!line) continue;
      try {
        const event = JSON.parse(line) as AnyEventEnvelope;
        if (event.kind !== "user_message") continue;
        const payload = event.payload as { content?: ContentBlock[] };
        const preview = sessionPreview(textOf(payload.content ?? []));
        if (preview) return preview;
      } catch {
        // 有界扫描只用于旧会话的展示回填；单行损坏不应让整个 session picker 失败。
      }
    }
  } finally {
    closeSync(fd);
  }
  return undefined;
}

function withSessionPreview(dir: string, meta: SessionMeta): SessionMeta {
  if (meta.preview?.trim()) return meta;
  const preview = previewFromSessionLog(dir);
  return preview ? { ...meta, preview } : meta;
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
      const meta = withSessionPreview(dir, JSON.parse(readFileSync(metaPath, "utf8")) as SessionMeta);
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
          const meta = withSessionPreview(
            join(projectDir, name),
            JSON.parse(readFileSync(metaPath, "utf8")) as SessionMeta,
          );
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

  /**
   * Fork 一个 BatonSession：把 throughSeq（默认 head）之前的事件历史复制进新会话。
   * 复制的前缀与源是同一段逻辑历史（git-branch 语义）：seq 与 turn/message/toolCall ID
   * 原样保留，只换 batonSessionId——不做 ID remap（toolCallId 等本就是 provider 原生
   * ID，remap 只会破坏与 raw 的对照），谱系由 meta.forkedFrom 表达。
   * providerSessions 只保留 provider 与 model / effort 偏好：child 不得 resume 源的原生
   * ProviderSession（否则两个 BatonSession 会写进同一份 provider 历史）；child 首 turn
   * 由 runtime 走 fresh native + 全量补课（syncedSeq 缺省=0）重建上下文。
   * opts.cwd 支持跨 project fork：历史跟源走，project 归属跟 fork 发起位置走；
   * 缺省沿用源 cwd。
   */
  forkSession(
    sourceSessionId: string,
    opts: { title?: string; throughSeq?: number; cwd?: string } = {},
  ): SessionHandle {
    const source = this.openSession(sourceSessionId);
    const events = source
      .readEvents()
      .filter((ev) => opts.throughSeq === undefined || ev.seq <= opts.throughSeq);
    const id = newId("bs");
    // 落盘目录与 meta.cwd 必须同源：listSessions({cwd}) 按目录扫描，两者不一致会漏掉该会话
    const cwd = opts.cwd ?? source.meta.cwd;
    const dir = join(this.projectsDir(), projectDirName(cwd), id);
    mkdirSync(dir, { recursive: true });
    if (events.length > 0) {
      const lines = events.map((ev) => JSON.stringify({ ...ev, batonSessionId: id }));
      writeFileSync(join(dir, "session.jsonl"), `${lines.join("\n")}\n`);
    }
    const providerSessions: Record<string, ProviderSessionMeta> = {};
    for (const [key, ps] of Object.entries(source.meta.providerSessions)) {
      providerSessions[key] = {
        provider: ps.provider,
        ...(ps.model !== undefined ? { model: ps.model } : {}),
        ...(ps.effort !== undefined ? { effort: ps.effort } : {}),
      };
    }
    const now = new Date().toISOString();
    const sourceQuestion = source.meta.preview?.trim() ?? sessionDisplayTitle(source.meta);
    const meta: SessionMeta = {
      batonSessionId: id,
      title: opts.title,
      description: `fork: ${sourceQuestion}`,
      cwd,
      createdAt: now,
      updatedAt: now,
      providerSessions,
      forkedFrom: { batonSessionId: sourceSessionId, throughSeq: events.at(-1)?.seq ?? 0 },
    };
    writeMetaAtomic(dir, meta);
    return new SessionHandle(id, dir, meta);
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
  private listeners = new Set<(ev: AnyEventEnvelope) => void>();

  constructor(id: string, dir: string, meta: SessionMeta) {
    this.id = id;
    this.dir = dir;
    this.meta = meta;
  }

  /**
   * 订阅本 handle 的事件追加。事件流是唯一合并真相源，UI 投影必须从这里走
   * （而不是 per-turn 回调）——provider 自发回合（后台唤醒等）没有对应的
   * submit 调用，任何旁路投影通道都会漏掉它们。返回取消订阅函数。
   */
  subscribe(listener: (ev: AnyEventEnvelope) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private jsonlPath(): string {
    return join(this.dir, "session.jsonl");
  }

  private logPath(): string {
    return join(this.dir, "session.log");
  }

  /**
   * 本 run 的旁路诊断日志。日志失败必须静默：它服务排障，不能反向影响正典会话。
   */
  diagnostic(entry: DiagnosticEntry): void {
    try {
      appendFileSync(
        this.logPath(),
        `${JSON.stringify({
          ts: new Date().toISOString(),
          batonSessionId: this.id,
          ...entry,
        })}\n`,
      );
    } catch {
      // session 目录本身不可写时只能放弃；调用方仍按自己的错误语义继续或失败。
    }
  }

  private lockPath(): string {
    return join(this.dir, "lock");
  }

  /**
   * 会话独占锁（pid 文件）。存在的意义是给 crash recovery 提供写入前提：
   * "最后事件是 running"只有在没有活进程持有会话时才能断定为崩溃残留，
   * 否则往活会话里合成终态会污染它。不承担并发追加的完整保护。
   * 同进程重入直接通过，且不做引用计数——约定同一进程内一个 session 至多
   * 一个活 handle（TUI 单前台会话；将来 workspace runtime 由 session slot
   * 唯一性保证），进程内并发归上层，锁只管跨进程。
   */
  acquireLock(): void {
    const path = this.lockPath();
    // 每轮要么 O_EXCL 原子创建成功，要么排除一个失效持有者再试；
    // 不用 existsSync 预检查——检查与创建之间的窗口就是 TOCTOU。
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const fd = openSync(path, "wx");
        writeSync(fd, String(process.pid));
        closeSync(fd);
        return;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      }
      let holder: number;
      try {
        holder = Number(readFileSync(path, "utf8").trim());
      } catch {
        continue; // 持有者恰在此刻释放了锁，直接重试创建
      }
      if (holder === process.pid) return; // 同进程重入
      if (Number.isFinite(holder) && holder > 0 && pidAlive(holder)) {
        throw new Error(`baton session ${this.id} is in use by another baton process (pid ${holder})`);
      }
      rmSync(path, { force: true }); // 持有者已死（或锁内容损坏）：清除 stale 锁重试
    }
    throw new Error(`failed to acquire session lock for ${this.id} after retries`);
  }

  /** 只释放自己持有的锁；释放失败不阻塞退出（stale 锁由下次 acquire 的存活判定接管）。 */
  releaseLock(): void {
    try {
      const path = this.lockPath();
      if (existsSync(path) && readFileSync(path, "utf8").trim() === String(process.pid)) {
        rmSync(path);
      }
    } catch {
      // 见 docstring：宁可留 stale 锁也不在退出路径抛错
    }
  }

  /**
   * 崩溃残尾修复：上个进程在 append 中途死掉会留下无换行的半行。此时若直接追加，
   * 新事件会拼接在残片之后形成"中间坏行"，readEvents 对中间坏行抛错（末行残缺
   * 可容忍，中间坏行不可）——会话从此永久不可读。所以首次写入前必须把文件截断回
   * 最后一个完整换行。注意不能用"补一个换行"代替截断：那只会把残片固化成独立的
   * 中间坏行，照样抛错。残片写入 sidecar 留档审计（可能含半条有价值的事件）。
   * 只挂写路径：只读消费方（session picker、mention 展开）不应产生写副作用。
   * 残行的 seq 从未完整落盘，由下一条新事件复用，主文件内 seq 仍严格单调。
   */
  private repairTail(): void {
    const path = this.jsonlPath();
    if (!existsSync(path)) return;
    const buf = readFileSync(path);
    if (buf.length === 0 || buf[buf.length - 1] === 0x0a) return;
    const cut = buf.lastIndexOf(0x0a) + 1; // 文件里没有换行时为 0：整个文件都是残片
    writeFileSync(join(this.dir, `session.jsonl.partial-${Date.now()}`), buf.subarray(cut));
    truncateSync(path, cut);
  }

  /** 补齐 v/ts/seq/batonSessionId 并追加一行。seq 以文件为准（重开进程后继续单调）。 */
  append<K extends EventKind>(ev: NewEvent<K>): EventEnvelope<K> {
    if (this.nextSeq === undefined) {
      this.repairTail();
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
    const line = `${JSON.stringify(envelope)}\n`;
    try {
      appendFileSync(this.jsonlPath(), line);
    } catch (error) {
      this.diagnostic({
        level: "error",
        component: "store.session",
        message: "failed to append session.jsonl",
        error: diagnosticError(error),
      });
      throw error;
    }
    for (const listener of this.listeners) {
      try {
        listener(envelope as AnyEventEnvelope);
      } catch (error) {
        // 投影侧异常不能污染写入路径：事件已落盘，订阅者自己负责健壮性
        this.diagnostic({
          level: "error",
          component: "store.listener",
          message: "session event listener threw",
          error: diagnosticError(error),
          details: { seq: envelope.seq, kind: envelope.kind },
        });
      }
    }
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

  setPreviewIfEmpty(text: string): void {
    if (this.meta.preview?.trim()) return;
    const preview = sessionPreview(text);
    if (preview) this.updateMeta({ preview });
  }

  setTitleIfEmpty(text: string): void {
    if (this.meta.title?.trim()) return;
    const title = sessionPreview(text);
    if (title) this.updateMeta({ title });
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
      // per-turn 取值：输入虽已按 turnId 过滤，但显式按 turn 取让它对"过滤集混入
      // 他人终态"的任何未来变化免疫（无 turnId 的迟到终态只会进 lastStopReason）
      stopReason: (state.stopReasons.get(turnId) ?? state.lastStopReason) as StopReason | undefined,
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

/** kill(pid, 0) 探活：EPERM 表示进程存在但无权限发信号，同样算活。 */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
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
