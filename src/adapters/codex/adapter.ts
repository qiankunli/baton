// Codex 接入：拉起 `codex app-server` 子进程（裸 `codex` 是交互式 TUI，headless 必须走这里），
// JSON-RPC over stdio，事件译成内部模型。方法集参考 tutti codex_appserver_adapter.go 与
// `codex app-server generate-json-schema` 的官方 schema（v0.143.0 验证）。见 docs/design.md §5.1。

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { newId } from "../../events/ids.ts";
import type { ContentBlock, DiffBlock, PermissionOption, StopReason } from "../../events/types.ts";
import { textOf } from "../../events/types.ts";
import type {
  AgentAdapter,
  ApprovalHandler,
  EventSink,
  ModelOption,
  PromptOptions,
  ProviderSessionRef,
  StartOptions,
} from "../types.ts";
import { JsonRpcPeer } from "./jsonrpc.ts";

interface ThreadRuntime {
  child: ChildProcessWithoutNullStreams;
  peer: JsonRpcPeer;
  threadId: string;
  sink?: EventSink;
  turnId?: string;
  codexTurnId?: string;
  /** 用户在 baton 中选择的模型；作为下一次 turn/start override。 */
  model?: string;
  turnDone?: { resolve: () => void; reject: (e: Error) => void };
  /** 上次 tokenUsage.total 快照，差分成 usage_update 增量 */
  prevUsage?: { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number };
}

function codexModels(result: unknown): ModelOption[] {
  const data = (result as { data?: unknown[] })?.data;
  const models: ModelOption[] = [{ id: "default", label: "Default", description: "使用 Codex 默认模型" }];
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

/** fileChange item → 统一 diff 内容块（changes: {path, kind: add|delete|update, diff}[]） */
function fileChangeDiff(item: Record<string, unknown>): DiffBlock {
  const changes = (Array.isArray(item.changes) ? item.changes : []) as Array<Record<string, unknown>>;
  return {
    type: "diff",
    changes: changes.map((c) => ({
      operation: c.kind === "update" ? "modify" : String(c.kind ?? "modify"),
      path: String(c.path ?? ""),
    })),
    patch: changes.map((c) => String(c.diff ?? "")).filter(Boolean).join("\n") || undefined,
  };
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
  /** 覆盖二进制，测试用 */
  command?: string[];
}

export class CodexAdapter implements AgentAdapter {
  readonly provider = "codex";
  private threads = new Map<string, ThreadRuntime>();

  constructor(private options: CodexAdapterOptions) {}

  async start(opts: StartOptions): Promise<ProviderSessionRef> {
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
    child.on("close", (code) => peer.close(`codex app-server exited (${code})`));

    const rt: ThreadRuntime = { child, peer, threadId: "" };
    peer.onNotification((method, params) => this.handleNotification(rt, method, params));
    peer.onServerRequest((method, params) => this.handleServerRequest(rt, method, params));

    await peer.request("initialize", {
      clientInfo: { name: "baton", version: "0.0.1", title: "baton" },
    });
    peer.notify("initialized", {});

    const startResp = (await peer.request("thread/start", { cwd: opts.cwd })) as {
      thread?: { id?: string };
    };
    const threadId = startResp.thread?.id;
    if (!threadId) throw new Error("codex thread/start returned no thread id");
    rt.threadId = threadId;
    this.threads.set(threadId, rt);
    return { provider: this.provider, providerSessionId: threadId };
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

  async prompt(
    ref: ProviderSessionRef,
    blocks: ContentBlock[],
    sink: EventSink,
    opts: PromptOptions,
  ): Promise<void> {
    const rt = this.mustThread(ref);
    rt.sink = sink;
    rt.turnId = opts.turnId;

    sink({
      kind: "user_message",
      provider: this.provider,
      providerSessionId: rt.threadId,
      turnId: opts.turnId,
      payload: { messageId: newId("m"), content: blocks },
    });
    sink({
      kind: "state_update",
      provider: this.provider,
      providerSessionId: rt.threadId,
      turnId: opts.turnId,
      payload: { state: "running" },
    });

    const done = new Promise<void>((resolve, reject) => {
      rt.turnDone = { resolve, reject };
    });
    // fast-submit：turn/start 的响应立即返回 status=inProgress 的 Turn（旧版本才会阻塞到结束）。
    // 因此响应只用于拿 codex turn id 和捕获终态；正常结束以 turn/completed 通知为准。
    void rt.peer
      .request("turn/start", {
        threadId: rt.threadId,
        input: [{ type: "text", text: textOf(blocks) }],
        ...(rt.model ? { model: rt.model } : {}),
        // 不显式开启则 codex 不发 item/reasoning/* 通知，中间过程对用户不可见
        summary: "auto",
      })
      .then((resp) => {
        const turn = (resp as { turn?: { id?: string; status?: string } }).turn;
        if (turn?.id) rt.codexTurnId = String(turn.id);
        const status = turn?.status;
        if (status && status !== "inProgress" && status !== "queued") {
          this.finishTurn(rt, status);
        }
      })
      .catch((err) => {
        rt.turnDone?.reject(err instanceof Error ? err : new Error(String(err)));
        rt.turnDone = undefined;
      });
    await done;
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
    rt.child.kill();
  }

  private mustThread(ref: ProviderSessionRef): ThreadRuntime {
    const rt = this.threads.get(ref.providerSessionId);
    if (!rt) throw new Error(`unknown codex thread: ${ref.providerSessionId}`);
    return rt;
  }

  private emit(rt: ThreadRuntime, ev: Parameters<EventSink>[0], raw?: unknown): void {
    rt.sink?.({ ...ev, provider: this.provider, providerSessionId: rt.threadId, turnId: rt.turnId, raw });
  }

  private finishTurn(rt: ThreadRuntime, turnStatus: string): void {
    if (!rt.turnDone) return; // turn/completed 通知与 turn/start 响应谁先到都行，只结一次
    this.emit(rt, {
      kind: "state_update",
      provider: this.provider,
      payload: { state: "idle", stopReason: stopReasonOf(turnStatus) },
    });
    rt.turnDone.resolve();
    rt.turnDone = undefined;
    rt.codexTurnId = undefined;
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
      case "item/reasoning/summaryTextDelta":
        this.emit(
          rt,
          {
            kind: "agent_thought_chunk",
            provider: this.provider,
            payload: { messageId: String(p.itemId), content: { type: "text", text: String(p.delta) } },
          },
          params,
        );
        break;
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
          // completed 的 reasoning item 带全文 summary：整消息 upsert 覆盖 delta 累积
          if (method === "item/completed") {
            const summaryArr = Array.isArray(item.summary) ? (item.summary as string[]) : [];
            const full = summaryArr.join("\n").trim();
            if (full) {
              this.emit(
                rt,
                {
                  kind: "agent_thought",
                  provider: this.provider,
                  payload: { messageId: String(item.id), content: [{ type: "text", text: full }] },
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
                // 文件改动统一成 diff 内容块（最大公约数规范，见 design §5.2）
                content: itemType === "fileChange" ? [fileChangeDiff(item)] : undefined,
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
        this.finishTurn(rt, String(turn.status ?? "completed"));
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
