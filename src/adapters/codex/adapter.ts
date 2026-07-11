// Codex 接入：拉起 `codex app-server` 子进程（裸 `codex` 是交互式 TUI，headless 必须走这里），
// JSON-RPC over stdio，事件译成内部模型。方法集参考 tutti codex_appserver_adapter.go 与
// `codex app-server generate-json-schema` 的官方 schema（v0.143.0 验证）。见 docs/design.md §5.1。

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { newId } from "../../events/ids.ts";
import type {
  ContentBlock,
  DiffBlock,
  PermissionOption,
  PromptBlock,
  QuestionPrompt,
  StopReason,
} from "../../events/types.ts";
import { textOf } from "../../events/types.ts";
import type {
  AdapterCapabilities,
  AgentAdapter,
  ApprovalHandler,
  EventSink,
  ModelOption,
  OpenOptions,
  PromptInput,
  PromptReceipt,
  ProviderSessionRef,
  QuestionHandler,
} from "../types.ts";
import { unsupportedPromptBlocks } from "../types.ts";
import { JsonRpcPeer } from "./jsonrpc.ts";

/**
 * 一次 turn/start 所属的 turn 状态（同 claude adapter 的 ClaudeTurn）：终态必须绑定
 * 所属 turn。fast-submit 下 turn/start 响应早回，但老版本 app-server 会阻塞到 turn
 * 结束才回——该响应/错误可能落在下一 turn 已 admission 之后，不能误杀新 turn。
 */
interface CodexTurn {
  turnId: string;
  /** 保证物理终态重复到达（响应与 turn/completed 通知都可能带终态）时只终结一次 */
  finalized: boolean;
}

interface ThreadRuntime {
  child: ChildProcessWithoutNullStreams;
  peer: JsonRpcPeer;
  threadId: string;
  sink?: EventSink;
  /** 最近一次 submit 的 baton turn id：迟到通知（tokenUsage 等）也用它标注信封 */
  turnId?: string;
  /** 当前被接受、尚未逻辑终结的 turn */
  activeTurn?: CodexTurn;
  codexTurnId?: string;
  /** 用户在 baton 中选择的模型；作为下一次 turn/start override。 */
  model?: string;
  /** 上次 tokenUsage.total 快照，差分成 usage_update 增量 */
  prevUsage?: { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number };
}

function codexModels(result: unknown): ModelOption[] {
  const data = (result as { data?: unknown[] })?.data;
  const models: ModelOption[] = [{ id: "default", label: "Default", description: "Use the Codex default model" }];
  if (!Array.isArray(data)) return models;
  for (const raw of data) {
    const model = raw as Record<string, unknown>;
    const id = String(model.id ?? model.model ?? "").trim();
    if (!id) continue;
    models.push({
      id,
      label: String(model.displayName ?? model.display_name ?? id),
      description: typeof model.description === "string" ? model.description : undefined,
    });
  }
  return models;
}

const APPROVAL_OPTIONS: PermissionOption[] = [
  { optionId: "accept", name: "Allow once", kind: "allow_once" },
  { optionId: "acceptForSession", name: "Allow for this session", kind: "allow_always" },
  { optionId: "decline", name: "Deny (agent continues)", kind: "reject_once" },
  { optionId: "cancel", name: "Deny and interrupt turn", kind: "reject_always" },
];

/** item.type → 内部 tool kind；agentMessage/reasoning/plan 不是 tool，单独处理 */
function toolKindOf(itemType: string): string {
  switch (itemType) {
    case "commandExecution":
      return "execute";
    case "fileChange":
      return "edit";
    case "webSearch":
      return "search";
    case "mcpToolCall":
    case "dynamicToolCall":
    case "collabAgentToolCall":
    default:
      return "other";
  }
}

function toolTitleOf(item: Record<string, unknown>): string {
  switch (item.type) {
    case "commandExecution":
      return String(item.command ?? "command");
    case "fileChange": {
      const changes = Array.isArray(item.changes) ? item.changes : [];
      const paths = changes.map((c) => String((c as Record<string, unknown>).path ?? "")).filter(Boolean);
      return paths.length ? `edit ${paths.join(", ")}` : "file change";
    }
    case "webSearch":
      return `search: ${String(item.query ?? "")}`;
    case "mcpToolCall":
      return `${String(item.server ?? "mcp")}.${String(item.tool ?? "tool")}`;
    case "dynamicToolCall":
      return String(item.tool ?? "tool");
    default:
      return String(item.type ?? "item");
  }
}

function fileChangeKind(change: Record<string, unknown>): string {
  if (typeof change.kind === "string") return change.kind;
  const kind = change.kind as Record<string, unknown> | undefined;
  return typeof kind?.type === "string" ? kind.type : "update";
}

function unifiedFilePatch(change: Record<string, unknown>): string {
  const path = String(change.path ?? "");
  const source = String(change.diff ?? "").replace(/\n$/, "");
  if (!source) return "";
  if (source.startsWith("--- ")) return source;

  const kind = fileChangeKind(change);
  if (kind === "add" || kind === "delete") {
    const lines = source.split("\n");
    const oldPath = kind === "add" ? "/dev/null" : path;
    const newPath = kind === "delete" ? "/dev/null" : path;
    const range = kind === "add" ? `-0,0 +1,${lines.length}` : `-1,${lines.length} +0,0`;
    const marker = kind === "add" ? "+" : "-";
    return `--- ${oldPath}\n+++ ${newPath}\n@@ ${range} @@\n${lines.map((line) => `${marker}${line}`).join("\n")}`;
  }

  return `--- ${path}\n+++ ${path}\n${source}`;
}

/** Codex fileChange → 每个文件一个 OpenTUI 可解析的 unified diff。 */
function fileChangeDiffs(item: Record<string, unknown>): DiffBlock[] {
  const changes = (Array.isArray(item.changes) ? item.changes : []) as Array<Record<string, unknown>>;
  return changes.map((change) => ({
    type: "diff",
    changes: [
      {
        operation: fileChangeKind(change) === "update" ? "modify" : fileChangeKind(change),
        path: String(change.path ?? ""),
      },
    ],
    patch: unifiedFilePatch(change) || undefined,
  }));
}

/** completed item 是工具输出的自愈点：即使 outputDelta 缺失，也能回填完整命令结果。 */
function completedToolContent(itemType: string, item: Record<string, unknown>): ContentBlock[] | undefined {
  if (itemType === "fileChange") return fileChangeDiffs(item);
  if (itemType === "commandExecution" && typeof item.aggregatedOutput === "string") {
    return item.aggregatedOutput ? [{ type: "text", text: item.aggregatedOutput }] : [];
  }
  return undefined;
}

function stopReasonOf(turnStatus: string): StopReason {
  switch (turnStatus) {
    case "completed":
      return "end_turn";
    case "interrupted":
      return "cancelled";
    default:
      return turnStatus; // 开放联合：failed 等原样透传
  }
}

export interface CodexAdapterOptions {
  approvalHandler: ApprovalHandler;
  questionHandler?: QuestionHandler;
  /** 覆盖二进制，测试用 */
  command?: string[];
}

interface CodexThreadPeer {
  request(method: string, params?: unknown): Promise<unknown>;
}

function threadIdFrom(response: unknown, method: string): string {
  const threadId = (response as { thread?: { id?: string } })?.thread?.id;
  if (!threadId) throw new Error(`codex ${method} returned no thread id`);
  return threadId;
}

function missingThread(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /thread.*not found|no rollout found|session.*not found/i.test(message);
}

/** 恢复优先；原生 thread 已丢失时新建，BatonSession 会在宿主层补齐历史。 */
export async function openCodexThread(
  peer: CodexThreadPeer,
  opts: { cwd: string; resumeSessionId?: string },
): Promise<{ threadId: string; resumed: boolean }> {
  if (opts.resumeSessionId) {
    try {
      const response = await peer.request("thread/resume", { threadId: opts.resumeSessionId });
      return { threadId: threadIdFrom(response, "thread/resume"), resumed: true };
    } catch (error) {
      if (!missingThread(error)) throw error;
    }
  }

  const response = await peer.request("thread/start", { cwd: opts.cwd });
  return { threadId: threadIdFrom(response, "thread/start"), resumed: false };
}

export class CodexAdapter implements AgentAdapter {
  readonly provider = "codex";
  // 当前 adapter 最终只发送 text（design.md §3.1）；可选能力接口落地并验证后才声明
  // 对应 marker——契约测试钉住"声明支持就必须实现对应接口"。
  readonly capabilities: AdapterCapabilities = { prompt: {} };
  private threads = new Map<string, ThreadRuntime>();

  constructor(private options: CodexAdapterOptions) {}

  async open(opts: OpenOptions, sink: EventSink): Promise<ProviderSessionRef> {
    const [cmd, ...args] = this.options.command ?? ["codex", "app-server"];
    const child = spawn(cmd as string, args, {
      cwd: opts.cwd,
      // 继承 HOME 等本机环境：凭证零持有，复用 ~/.codex 登录态（design §5.1）
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const peer = new JsonRpcPeer((line) => child.stdin.write(line));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => peer.feed(chunk));

    const rt: ThreadRuntime = { child, peer, threadId: "", sink };
    // transport 终结 = 该 session 所有在途工作的终结点：pending request 全部 reject，
    // 活跃 turn 必须在此合成终态，否则 runtime 永远等不到 idle（design §4.1 终态保证）。
    child.on("close", (code) => {
      peer.close(`codex app-server exited (${code})`);
      this.failTurn(rt, rt.activeTurn, `codex app-server exited (code ${code})`);
    });
    child.on("error", (error) => {
      peer.close(`codex app-server spawn error: ${error.message}`);
      this.failTurn(rt, rt.activeTurn, `codex app-server error: ${error.message}`);
    });
    peer.onNotification((method, params) => this.handleNotification(rt, method, params));
    peer.onServerRequest((method, params) => this.handleServerRequest(rt, method, params));

    await peer.request("initialize", {
      clientInfo: { name: "baton", version: "0.0.1", title: "baton" },
      capabilities: { experimentalApi: true },
    });
    peer.notify("initialized", {});

    const opened = await openCodexThread(peer, opts);
    const threadId = opened.threadId;
    rt.threadId = threadId;
    this.threads.set(threadId, rt);
    return { provider: this.provider, providerSessionId: threadId, resumed: opened.resumed };
  }

  async syncContext(ref: ProviderSessionRef, blocks: PromptBlock[]): Promise<void> {
    const rt = this.mustThread(ref);
    await rt.peer.request("thread/inject_items", {
      threadId: rt.threadId,
      items: [
        {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: textOf(blocks) }],
        },
      ],
    });
  }

  async listModels(ref: ProviderSessionRef): Promise<ModelOption[]> {
    const rt = this.mustThread(ref);
    return codexModels(await rt.peer.request("model/list", { limit: 200 }));
  }

  async setModel(ref: ProviderSessionRef, modelId: string | null): Promise<void> {
    const rt = this.mustThread(ref);
    rt.model = !modelId || modelId === "default" ? undefined : modelId;
  }

  currentModel(ref: ProviderSessionRef): string | null {
    return this.mustThread(ref).model ?? null;
  }

  /** submit 只做 admission 并发出 turn/start；进展与终结全部经通知/终态合成路径报告 */
  async submit(ref: ProviderSessionRef, input: PromptInput): Promise<PromptReceipt> {
    const rt = this.mustThread(ref);
    if (rt.activeTurn && !rt.activeTurn.finalized) {
      throw new Error(`codex turn ${rt.activeTurn.turnId} still active; steer/parallel prompt unsupported`);
    }
    const unsupported = unsupportedPromptBlocks(input.blocks, this.capabilities);
    if (unsupported.length) {
      throw new Error(`codex adapter does not support prompt block type(s): ${unsupported.join(", ")}`);
    }

    const turn: CodexTurn = { turnId: input.turnId, finalized: false };
    rt.turnId = input.turnId;
    rt.activeTurn = turn;

    this.emit(rt, {
      kind: "user_message",
      provider: this.provider,
      payload: { messageId: input.messageId, content: input.blocks },
    });
    this.emit(rt, { kind: "state_update", provider: this.provider, payload: { state: "running" } });

    // fast-submit：turn/start 的响应立即返回 status=inProgress 的 Turn（旧版本才会阻塞到结束）。
    // 因此响应只用于拿 codex turn id 和捕获终态；正常结束以 turn/completed 通知为准。
    void rt.peer
      .request("turn/start", {
        threadId: rt.threadId,
        input: [{ type: "text", text: textOf(input.blocks) }],
        ...(rt.model ? { model: rt.model } : {}),
        // 不显式开启则 codex 不发 item/reasoning/* 通知，中间过程对用户不可见
        summary: "auto",
      })
      .then((resp) => {
        const started = (resp as { turn?: { id?: string; status?: string } }).turn;
        // 迟到响应（老版本阻塞到 turn 结束才回）可能落在下一 turn 已开始之后：
        // 只在自己仍是 active turn 时才写共享的 codexTurnId
        if (started?.id && rt.activeTurn === turn) rt.codexTurnId = String(started.id);
        const status = started?.status;
        if (status && status !== "inProgress" && status !== "queued") {
          this.finishTurn(rt, turn, status);
        }
      })
      .catch((err) => {
        this.failTurn(rt, turn, err instanceof Error ? err.message : String(err));
      });
    return { accepted: true };
  }

  async cancel(ref: ProviderSessionRef): Promise<void> {
    const rt = this.mustThread(ref);
    if (!rt.codexTurnId) return;
    await rt.peer.request("turn/interrupt", { threadId: rt.threadId, turnId: rt.codexTurnId });
  }

  async close(ref: ProviderSessionRef): Promise<void> {
    const rt = this.threads.get(ref.providerSessionId);
    if (!rt) return;
    this.threads.delete(ref.providerSessionId);
    // 宿主主动关闭：活跃 turn 读作 cancelled；先终结再 kill，child close 回调就不会再合成 failed
    this.finishTurn(rt, rt.activeTurn, "interrupted");
    rt.child.kill();
  }

  private mustThread(ref: ProviderSessionRef): ThreadRuntime {
    const rt = this.threads.get(ref.providerSessionId);
    if (!rt) throw new Error(`unknown codex thread: ${ref.providerSessionId}`);
    return rt;
  }

  /** 信封补齐。turn 终态类发射显式传所属 turn：迟到终态不能盖上共享 rt.turnId（已是最新 turn 的 id） */
  private emit(rt: ThreadRuntime, ev: Parameters<EventSink>[0], raw?: unknown, turn?: CodexTurn): void {
    rt.sink?.({ ...ev, provider: this.provider, providerSessionId: rt.threadId, turnId: turn?.turnId ?? rt.turnId, raw });
  }

  /**
   * 每个 turn 只发一次逻辑终态；turn/completed 通知、turn/start 响应终态、transport 失败谁先到都行。
   * 只允许终结传入的 turn（同 claude adapter）：上一 turn 的迟到终态不能误杀已开始的下一 turn。
   */
  private finishTurn(rt: ThreadRuntime, turn: CodexTurn | undefined, turnStatus: string): void {
    if (!turn || turn.finalized) return;
    turn.finalized = true;
    this.emit(
      rt,
      {
        kind: "state_update",
        provider: this.provider,
        payload: { state: "idle", stopReason: stopReasonOf(turnStatus) },
      },
      undefined,
      turn,
    );
    if (rt.activeTurn === turn) {
      rt.activeTurn = undefined;
      rt.codexTurnId = undefined;
    }
  }

  /** 错误路径终态：先留结构化 error，再合成 idle（design §4.9） */
  private failTurn(rt: ThreadRuntime, turn: CodexTurn | undefined, message: string): void {
    if (!turn || turn.finalized) return;
    this.emit(rt, { kind: "_baton_error_update", provider: this.provider, payload: { message } }, undefined, turn);
    this.finishTurn(rt, turn, "failed");
  }

  private handleNotification(rt: ThreadRuntime, method: string, params: unknown): void {
    const p = (params ?? {}) as Record<string, unknown>;
    if (p.threadId !== undefined && p.threadId !== rt.threadId) return;

    switch (method) {
      case "turn/started": {
        const turn = p.turn as Record<string, unknown> | undefined;
        rt.codexTurnId = turn ? String(turn.id) : undefined;
        break;
      }
      case "item/agentMessage/delta":
        this.emit(
          rt,
          {
            kind: "agent_message_chunk",
            provider: this.provider,
            payload: { messageId: String(p.itemId), content: { type: "text", text: String(p.delta) } },
          },
          params,
        );
        break;
      case "item/reasoning/textDelta":
      case "item/reasoning/summaryTextDelta": {
        const messageId =
          method === "item/reasoning/summaryTextDelta" && p.summaryIndex !== undefined
            ? `${String(p.itemId)}:summary:${String(p.summaryIndex)}`
            : String(p.itemId);
        this.emit(
          rt,
          {
            kind: "agent_thought_chunk",
            provider: this.provider,
            payload: { messageId, content: { type: "text", text: String(p.delta) } },
          },
          params,
        );
        break;
      }
      case "item/started":
      case "item/completed": {
        const item = (p.item ?? {}) as Record<string, unknown>;
        const itemType = String(item.type ?? "");
        if (itemType === "agentMessage") {
          // completed 携带全文：整消息 upsert 纠正 delta 累积（乱序/丢包时的自愈点）
          if (method === "item/completed") {
            this.emit(
              rt,
              {
                kind: "agent_message",
                provider: this.provider,
                payload: { messageId: String(item.id), content: [{ type: "text", text: String(item.text ?? "") }] },
              },
              params,
            );
          }
        } else if (itemType === "reasoning") {
          // summary part 是 Codex TUI 的展示边界；保留它，避免多个中间状态挤进同一块。
          if (method === "item/completed") {
            const summaryArr = Array.isArray(item.summary) ? (item.summary as string[]) : [];
            for (const [index, summary] of summaryArr.entries()) {
              const full = String(summary).trim();
              if (!full) continue;
              this.emit(
                rt,
                {
                  kind: "agent_thought",
                  provider: this.provider,
                  payload: {
                    messageId: `${String(item.id)}:summary:${index}`,
                    content: [{ type: "text", text: full }],
                  },
                },
                params,
              );
            }
          }
        } else if (itemType === "userMessage" || itemType === "plan") {
          // userMessage 由 prompt() 侧发；plan 走 turn/plan/updated
        } else if (itemType) {
          this.emit(
            rt,
            {
              kind: "tool_call_update",
              provider: this.provider,
              payload: {
                toolCallId: String(item.id),
                title: toolTitleOf(item),
                kind: toolKindOf(itemType),
                status:
                  method === "item/started"
                    ? "in_progress"
                    : String(item.status ?? "") === "failed"
                      ? "failed"
                      : "completed",
                // completed 携带的完整结果覆盖流式 chunk，兼作 outputDelta 丢失时的自愈点。
                content:
                  method === "item/completed"
                    ? completedToolContent(itemType, item)
                    : itemType === "fileChange"
                      ? fileChangeDiffs(item)
                      : undefined,
                rawInput: method === "item/started" ? item : undefined,
                rawOutput: method === "item/completed" ? item : undefined,
              },
            },
            params,
          );
        }
        break;
      }
      case "item/commandExecution/outputDelta":
        // 命令实时输出 → 统一的工具输出流
        this.emit(
          rt,
          {
            kind: "tool_call_content_chunk",
            provider: this.provider,
            payload: { toolCallId: String(p.itemId), content: { type: "text", text: String(p.delta) } },
          },
          params,
        );
        break;
      case "turn/plan/updated": {
        const entries = (Array.isArray(p.plan) ? p.plan : []).map((e) => {
          const entry = e as Record<string, unknown>;
          return {
            content: String(entry.step ?? entry.content ?? ""),
            priority: "medium",
            status: String(entry.status ?? "pending"),
          };
        });
        this.emit(
          rt,
          { kind: "plan_update", provider: this.provider, payload: { planId: `pl_${rt.codexTurnId ?? "turn"}`, entries } },
          params,
        );
        break;
      }
      case "thread/tokenUsage/updated": {
        const usage = (p.tokenUsage ?? {}) as Record<string, unknown>;
        const total = (usage.total ?? {}) as Record<string, number>;
        const prev = rt.prevUsage ?? { inputTokens: 0, cachedInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0 };
        const cur = {
          inputTokens: total.inputTokens ?? 0,
          cachedInputTokens: total.cachedInputTokens ?? 0,
          outputTokens: total.outputTokens ?? 0,
          reasoningOutputTokens: total.reasoningOutputTokens ?? 0,
        };
        rt.prevUsage = cur;
        const delta = {
          inputTokens: Math.max(0, cur.inputTokens - prev.inputTokens),
          cacheReadTokens: Math.max(0, cur.cachedInputTokens - prev.cachedInputTokens),
          outputTokens: Math.max(0, cur.outputTokens - prev.outputTokens),
          reasoningTokens: Math.max(0, cur.reasoningOutputTokens - prev.reasoningOutputTokens),
        };
        if (delta.inputTokens || delta.outputTokens || delta.cacheReadTokens || delta.reasoningTokens) {
          this.emit(rt, { kind: "usage_update", provider: this.provider, payload: delta }, params);
        }
        break;
      }
      case "turn/completed": {
        const turn = (p.turn ?? {}) as Record<string, unknown>;
        // 通知流单连接有序：此刻的 activeTurn 就是该通知所属的 turn
        this.finishTurn(rt, rt.activeTurn, String(turn.status ?? "completed"));
        break;
      }
      default:
        break; // 其余通知 M1 不消费
    }
  }

  private async handleServerRequest(rt: ThreadRuntime, method: string, params: unknown): Promise<unknown> {
    const p = (params ?? {}) as Record<string, unknown>;
    switch (method) {
      // v2 与 v1 两代审批请求都回 {decision}
      case "item/commandExecution/requestApproval":
      case "item/fileChange/requestApproval":
      case "item/permissions/requestApproval":
      case "execCommandApproval":
      case "applyPatchApproval": {
        const requestId = String(p.approvalId ?? p.itemId ?? p.callId ?? newId("ar"));
        const title = approvalTitleOf(method, p);
        const request = {
          requestId,
          title,
          toolCallId: p.itemId !== undefined ? String(p.itemId) : undefined,
          options: APPROVAL_OPTIONS,
        };
        this.emit(rt, { kind: "permission_request", provider: this.provider, payload: request }, params);
        const decision = await this.options.approvalHandler(request);
        this.emit(rt, {
          kind: "permission_resolved",
          provider: this.provider,
          payload: { requestId, outcome: "selected", optionId: decision.optionId },
        });
        return { decision: decision.optionId };
      }
      case "item/tool/requestUserInput": {
        if (!this.options.questionHandler) throw new Error("baton question handler unavailable");
        const source = Array.isArray(p.questions) ? p.questions : [];
        const questions: QuestionPrompt[] = source.map((value, index) => {
          const question = (value ?? {}) as Record<string, unknown>;
          return {
            questionId: String(question.id ?? `q${index}`),
            header: String(question.header ?? `Question ${index + 1}`),
            question: String(question.question ?? ""),
            options: Array.isArray(question.options)
              ? question.options.map((option) => {
                  const item = (option ?? {}) as Record<string, unknown>;
                  return { label: String(item.label ?? ""), description: String(item.description ?? "") };
                })
              : undefined,
            allowOther: question.isOther === true,
            secret: question.isSecret === true,
          };
        });
        const request = {
          requestId: String(p.itemId ?? newId("qr")),
          questions,
        };
        this.emit(rt, { kind: "question_request", provider: this.provider, payload: request }, params);
        const decision = await this.options.questionHandler(request);
        this.emit(rt, {
          kind: "question_resolved",
          provider: this.provider,
          payload: { requestId: request.requestId, outcome: "answered", answers: decision.answers },
        });
        return {
          answers: Object.fromEntries(
            Object.entries(decision.answers).map(([questionId, answers]) => [questionId, { answers }]),
          ),
        };
      }
      default:
        throw new Error(`unsupported server request: ${method}`);
    }
  }
}

function approvalTitleOf(method: string, p: Record<string, unknown>): string {
  if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
    return `Run command: ${String(p.command ?? p.reason ?? "(see details)")}`;
  }
  if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
    return "Apply file changes?";
  }
  return "Codex requests permission";
}
