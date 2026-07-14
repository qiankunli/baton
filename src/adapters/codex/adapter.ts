// Codex 接入：拉起 `codex app-server` 子进程（裸 `codex` 是交互式 TUI，headless 必须走这里），
// JSON-RPC over stdio，事件译成内部模型。方法集参考 tutti codex_appserver_adapter.go 与
// `codex app-server generate-json-schema` 的官方 schema（v0.143.0 验证）。见 docs/design.md §5.1。

import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";

import { newId } from "../../events/ids.ts";
import { closedTerminal } from "../normalize.ts";
import type {
  ContentBlock,
  DiffBlock,
  PermissionOption,
  PermissionRequest,
  QuestionPrompt,
  QuestionRequest,
  StopReason,
  ToolCallStatus,
} from "../../events/types.ts";
import { textOf } from "../../events/types.ts";
import type {
  AdapterCapabilities,
  AgentAdapter,
  EventSink,
  ModelOption,
  OpenOptions,
  PromptInput,
  PromptReceipt,
  ProviderSessionRef,
  RequestHandler,
  SteerReceipt,
  ApprovalRoute,
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
  /**
   * 本 turn 是否产生过任何可见产出（消息/思考/工具/计划/审批…）。completed 且零产出
   * 是异常（prompt 在进模型前被丢弃，如 UserPromptSubmit hook 拦截），不能静默当正常
   * end_turn——事故形态是用户看到 baton 回 idle 但消息像被吞掉。
   */
  sawOutput?: boolean;
  /** UserPromptSubmit/SessionStart hook 拦截信息：空回合的已知原因（hook/completed 通知报告） */
  hookBlock?: { source: string; reason?: string };
}

interface ThreadRuntime {
  child: ChildProcessWithoutNullStreams;
  peer: JsonRpcPeer;
  threadId: string;
  /** codex 回吐的生效审批路由（权威）；null = 本次没问出来，投影据此静默。 */
  approvalRoute: ApprovalRoute | null;
  sink?: EventSink;
  /** 最近一次 submit 的 baton turn id：迟到通知（tokenUsage 等）也用它标注信封 */
  turnId?: string;
  /** 当前被接受、尚未逻辑终结的 turn */
  activeTurn?: CodexTurn;
  codexTurnId?: string;
  /**
   * cancel 早于 codexTurnId 就位（fast-submit 后 turn/start 响应与 turn/started
   * 通知都未回）时挂起的取消意图；id 就位后由 flushPendingCancel 补发 interrupt。
   * 没有它，这个窗口内的 cancel 会被静默丢弃——runtime 宽限期到点合成"已取消"
   * 并推进队列，而原生 codex turn 仍在继续跑。
   */
  pendingCancel?: boolean;
  /** 用户在 baton 中选择的模型；作为下一次 turn/start override。 */
  model?: string;
  /** 上次 tokenUsage.total 快照，差分成 usage_update 增量 */
  prevUsage?: { inputTokens: number; cachedInputTokens: number; outputTokens: number; reasoningOutputTokens: number };
  /**
   * 收到过 requestApproval 的 item：declined 终态的对账依据——某 item 被拒但从未
   * 问过 baton，说明有 provider 侧策略（如 auto-review）替用户做了决定，必须显式
   * 提示而不是静默渲染。启动参数注入（codexLaunchCommand）防已知配置，这里防未知。
   */
  approvalSeenItemIds?: Set<string>;
  /** 收到权威 auto-review 回执的 item：避免 declined 终态再触发旧的启发式旁路告警。 */
  autoReviewedItemIds?: Set<string>;
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

// codex CommandExecutionApprovalDecision / FileChangeApprovalDecision 的字符串成员。
// 注意 cancel 的 "deny + 中断 turn"：中断属于 Control 轴，不是更强的拒绝范围——
// 两轴上它与 decline 同为 (reject, once)，差别只由 name 承载。
const FALLBACK_APPROVAL_OPTIONS: PermissionOption[] = [
  { optionId: "accept", name: "Allow once", polarity: "allow", lifetime: "once" },
  {
    optionId: "acceptForSession",
    name: "Allow for this session",
    polarity: "allow",
    lifetime: "session",
  },
  { optionId: "decline", name: "Deny (agent continues)", polarity: "reject", lifetime: "once" },
  { optionId: "cancel", name: "Deny and interrupt turn", polarity: "reject", lifetime: "once" },
];

interface CodexApprovalChoice {
  option: PermissionOption;
  /** Codex wire decision；结构化方言只停留在 adapter 边界。 */
  decision: unknown;
}

function simpleApprovalChoice(decision: string): CodexApprovalChoice | undefined {
  const option = FALLBACK_APPROVAL_OPTIONS.find((candidate) => candidate.optionId === decision);
  return option ? { option, decision } : undefined;
}

function structuredApprovalChoice(decision: unknown, index: number): CodexApprovalChoice | undefined {
  if (!decision || typeof decision !== "object") return undefined;
  const record = decision as Record<string, unknown>;
  if (record.acceptWithExecpolicyAmendment !== undefined) {
    const payload = record.acceptWithExecpolicyAmendment as Record<string, unknown>;
    const amendment = payload?.execpolicy_amendment;
    const prefix = Array.isArray(amendment) ? amendment.map(String).join(" ") : "this command prefix";
    return {
      option: {
        optionId: `acceptWithExecpolicyAmendment:${index}`,
        // 作用对象（命令前缀）只能进 name：它是 codex 方言，两轴表达不了。
        name: `Allow and remember: ${prefix}`,
        polarity: "allow",
        lifetime: "persistent",
      },
      decision,
    };
  }
  if (record.applyNetworkPolicyAmendment !== undefined) {
    const payload = record.applyNetworkPolicyAmendment as Record<string, unknown>;
    const amendment = payload?.network_policy_amendment as Record<string, unknown> | undefined;
    // action 可以是 deny——codex 会提议"永久拉黑某 host"。它与 allow 同为 amendment，
    // 但极性相反；当成 allow 渲染会让最危险的选项长得最安全（曾经如此）。
    const deny = String(amendment?.action ?? "allow") === "deny";
    const verb = deny ? "Deny" : "Allow";
    const target = amendment?.host ? String(amendment.host) : "this network rule";
    return {
      option: {
        optionId: `applyNetworkPolicyAmendment:${index}`,
        name: `${verb} and remember: ${target}`,
        polarity: deny ? "reject" : "allow",
        lifetime: "persistent",
      },
      decision,
    };
  }
  return undefined;
}

/**
 * Codex 给出精确候选时逐项映射；缺字段（老版本）或**一项都认不出**时退回稳定四选项。
 *
 * 后半条是要害：availableDecisions 非空但全部不认识（codex 改了 decision 名、加了第三种
 * amendment），逐项映射会得到空数组 → 审批卡零选项 → 用户无从作答，turn 永久挂起。
 * 认不出就退回一定能作答的集合，宁可少一个精确选项也不能失去应答能力（不变量 #2）。
 */
export function codexApprovalChoices(params: Record<string, unknown>): CodexApprovalChoice[] {
  const available = params.availableDecisions;
  const fallback = () => FALLBACK_APPROVAL_OPTIONS.map((option) => ({ option, decision: option.optionId }));
  if (!Array.isArray(available) || available.length === 0) return fallback();
  const choices = available.flatMap((decision, index) => {
    const choice =
      typeof decision === "string"
        ? simpleApprovalChoice(decision)
        : structuredApprovalChoice(decision, index);
    return choice ? [choice] : [];
  });
  return choices.length > 0 ? choices : fallback();
}

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

/**
 * codex item 终态 → 内部 ToolCallStatus，白名单式（走 closedTerminal 统一纪律）：只有名单上
 * 的值有明确待遇，未知终态一律悲观归 failed；status 缺失按 completed（item/completed 方法名
 * 本身即完成语义，缺字段不是词汇漂移）。
 */
const CODEX_TERMINAL_STATUS: Record<string, ToolCallStatus> = {
  completed: "completed",
  failed: "failed",
  declined: "declined",
};

export function codexToolTerminalStatus(rawStatus: unknown): ToolCallStatus {
  return closedTerminal(rawStatus, CODEX_TERMINAL_STATUS, "failed", "completed");
}

/**
 * codex auto-review 终态 → 内部 ApprovalReviewUpdate.decision（闭合三态）。在 adapter 边界收口：
 * 未知 / 空（含 UNSTABLE 的 inProgress 混入 completed）一律保守归 aborted（投影呈 failed），
 * 绝不乐观当 approved。闭合值进事件流后，reduce / 投影不再面对开放 decision。
 */
const CODEX_REVIEW_DECISION: Record<string, "approved" | "denied" | "aborted"> = {
  approved: "approved",
  denied: "denied",
  aborted: "aborted",
};

/**
 * 审批路由**不由 baton 定默认**：`thread/start` 原生收 `approvalsReviewer`，缺省
 * （undefined）就交给 codex 自己解析——config.toml、profile、企业 requirements 全部照常
 * 生效，baton 与 codex 天然一致。codex 自己的默认是 `user`（且 guardian feature 开着
 * 也不变），baton 没有比上游更激进的理由。用户显式配了才传，作为 opt-in 委托。
 *
 * 曾经的做法是往 argv 注入 `-c approvals_reviewer=...`：既覆盖了用户的 codex 配置，
 * 又反推不出生效值——企业 requirements（allowed_approvals_reviewers）能把注入的值打回，
 * 让 footer 撒谎。生效值只认 thread/start|resume 响应的回吐（见 approvalRoute）。
 */
export function codexLaunchCommand(command?: string[]): string[] {
  return command && command.length > 0 ? [...command] : ["codex", "app-server"];
}

/** codex 方言 → 归一路由。未知取值不猜（不变量 #2）。 */
function approvalRouteOf(reviewer: unknown): ApprovalRoute | null {
  if (reviewer === "user") return "user";
  // guardian_subagent 是 auto_review 的 wire alias（codex ApprovalsReviewer serde alias）
  if (reviewer === "auto_review" || reviewer === "guardian_subagent") return "delegated";
  return null;
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
  requestHandler: RequestHandler;
  /** 缺省由 auto-review 审批；显式 user 时请求进入 Baton TUI。 */
  approvalReviewer?: "user" | "auto_review";
  /** 覆盖二进制，测试用 */
  command?: string[];
}

/**
 * 启动期请求（initialize / thread resume/start）的显式超时：这些请求发生在 turn 提交
 * 之前，卡死会永久占住全局 turn 队列（preparing 状态的可取消性也依赖它兜底退出）。
 * turn/start 刻意不设——老版本 app-server 会合法地阻塞到 turn 结束。
 */
const STARTUP_REQUEST_TIMEOUT_MS = 30_000;

/**
 * 计入"turn 有产出"的事件 kind（空回合判定，见 CodexTurn.sawOutput）。
 * usage/state 等记账类事件不算产出；`_baton_run_status`（compaction 等运行阶段）算——
 * 纯 compaction turn 合法无消息产出，不应误报空回合。
 */
const OUTPUT_EVENT_KINDS: ReadonlySet<string> = new Set([
  "agent_message",
  "agent_message_chunk",
  "agent_thought",
  "agent_thought_chunk",
  "tool_call_update",
  "tool_call_content_chunk",
  "plan_update",
  "permission_request",
  "question_request",
  "_baton_run_status",
]);

interface CodexThreadPeer {
  request(method: string, params?: unknown, opts?: { timeoutMs?: number }): Promise<unknown>;
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

/** thread/start|resume 响应回吐的生效 reviewer（非可选字段）；缺失只降级为"不知道"。 */
function routeFrom(response: unknown): ApprovalRoute | null {
  const record = response && typeof response === "object" ? (response as Record<string, unknown>) : {};
  return approvalRouteOf(record.approvalsReviewer);
}

/**
 * 恢复优先；原生 thread 已丢失时新建，BatonSession 会在宿主层补齐历史。
 *
 * `approvalsReviewer` 只在用户显式配置时下发；resume 时同样如此——codex 会把 reviewer
 * 随 thread 持久化，不传就沿用该 thread 原有的选择（thread_resume_preserves_persisted_
 * approvals_reviewer）。响应回吐的才是生效值：企业 requirements 可能把请求值打回。
 */
export async function openCodexThread(
  peer: CodexThreadPeer,
  opts: { cwd: string; resumeSessionId?: string; approvalReviewer?: "user" | "auto_review" },
): Promise<{ threadId: string; resumed: boolean; route: ApprovalRoute | null }> {
  const reviewer = opts.approvalReviewer ? { approvalsReviewer: opts.approvalReviewer } : {};
  if (opts.resumeSessionId) {
    try {
      const response = await peer.request(
        "thread/resume",
        { threadId: opts.resumeSessionId, ...reviewer },
        { timeoutMs: STARTUP_REQUEST_TIMEOUT_MS },
      );
      return {
        threadId: threadIdFrom(response, "thread/resume"),
        resumed: true,
        route: routeFrom(response),
      };
    } catch (error) {
      if (!missingThread(error)) throw error;
    }
  }

  const response = await peer.request(
    "thread/start",
    { cwd: opts.cwd, ...reviewer },
    { timeoutMs: STARTUP_REQUEST_TIMEOUT_MS },
  );
  return { threadId: threadIdFrom(response, "thread/start"), resumed: false, route: routeFrom(response) };
}

export class CodexAdapter implements AgentAdapter {
  readonly provider = "codex";
  // 当前 adapter 最终只发送 text（design.md §3.1）；可选能力接口落地并验证后才声明
  // 对应 marker——契约测试钉住"声明支持就必须实现对应接口"。
  // sync：catch-up 走 turn/start.additionalContext（experimental API，initialize 已声明
  // experimentalApi）。曾用 thread/inject_items 注入独立 user message，但那会污染 codex
  // 原生历史（rollout 里出现无对应回合的悬空 user message）；additionalContext 由 codex
  // 以 contextual fragment 形态随本 turn 入史，且不过 UserPromptSubmit hook。
  readonly capabilities: AdapterCapabilities = {
    prompt: {},
    steer: { supported: true },
    sync: { supported: true },
    approvalRouting: { supported: true },
  };
  private threads = new Map<string, ThreadRuntime>();

  constructor(private options: CodexAdapterOptions) {}

  async open(opts: OpenOptions, sink: EventSink): Promise<ProviderSessionRef> {
    const [cmd, ...args] = codexLaunchCommand(this.options.command);
    const child = spawn(cmd as string, args, {
      cwd: opts.cwd,
      // 继承 HOME 等本机环境：凭证零持有，复用 ~/.codex 登录态（design §5.1）
      env: { ...process.env, ...opts.env },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const peer = new JsonRpcPeer((line) => child.stdin.write(line));
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => peer.feed(chunk));

    const rt: ThreadRuntime = { child, peer, threadId: "", approvalRoute: null, sink };
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

    await peer.request(
      "initialize",
      {
        clientInfo: { name: "baton", version: "0.0.1", title: "baton" },
        capabilities: { experimentalApi: true },
      },
      { timeoutMs: STARTUP_REQUEST_TIMEOUT_MS },
    );
    peer.notify("initialized", {});

    const opened = await openCodexThread(peer, { ...opts, approvalReviewer: this.options.approvalReviewer });
    const threadId = opened.threadId;
    rt.threadId = threadId;
    rt.approvalRoute = opened.route;
    this.threads.set(threadId, rt);
    return { provider: this.provider, providerSessionId: threadId, resumed: opened.resumed };
  }

  /** ApprovalRoutable：报告 codex 回吐的生效路由，而非 baton 请求的值（企业策略可能打回）。 */
  approvalRoute(ref: ProviderSessionRef): ApprovalRoute | null {
    return this.threads.get(ref.providerSessionId)?.approvalRoute ?? null;
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
    // user_message / state_update(running) 由 runtime 在出队时落盘（用户输入是 BatonSession
    // 的事实，且入参 blocks 可能含 <baton-sync> prepend，不能进正典历史）；adapter 只在
    // steer 成功时补 delivery:"steer" 的用户消息。

    // 跨 provider catch-up 随本 turn 送达：additionalContext 按 key 的 contextual
    // fragment（untrusted → user 语义）在 codex 侧与 prompt 同回合入史。admission 失败
    // 即未送达，runtime 水位不动、下次重注入（PromptInput.syncBlocks 契约）。
    const syncText = input.syncBlocks?.length ? textOf(input.syncBlocks) : undefined;
    // fast-submit：turn/start 的响应立即返回 status=inProgress 的 Turn（旧版本才会阻塞到结束）。
    // 因此响应只用于拿 codex turn id 和捕获终态；正常结束以 turn/completed 通知为准。
    void rt.peer
      .request("turn/start", {
        threadId: rt.threadId,
        input: [{ type: "text", text: textOf(input.blocks) }],
        ...(syncText ? { additionalContext: { "baton-sync": { value: syncText, kind: "untrusted" } } } : {}),
        ...(rt.model ? { model: rt.model } : {}),
        // 不显式开启则 codex 不发 item/reasoning/* 通知，中间过程对用户不可见
        summary: "auto",
      })
      .then((resp) => {
        const started = (resp as { turn?: { id?: string; status?: string } }).turn;
        // 迟到响应（老版本阻塞到 turn 结束才回）可能落在下一 turn 已开始之后：
        // 只在自己仍是 active turn 时才写共享的 codexTurnId
        if (started?.id && rt.activeTurn === turn) {
          rt.codexTurnId = String(started.id);
          this.flushPendingCancel(rt);
        }
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

  /**
   * same-turn steer：映射原生 `turn/steer`（Steerable，design §4.3）。入参 expectedTurnId
   * 是 baton turn id，wire 上换成 codex turn id；成功不产生新 `turn/started`，输入在
   * 当前 turn 的下一个安全边界被消费。stale turn、codex 侧拒绝（review/compact 等特殊
   * turn）与 wire 失败都归 rejected 交 runtime 降级——rejected 路径不发任何事件。
   */
  async steer(ref: ProviderSessionRef, input: PromptInput, expectedTurnId: string): Promise<SteerReceipt> {
    const rt = this.mustThread(ref);
    const turn = rt.activeTurn;
    // race 防线：用户提交时看到的 turn 已终结，或 codex turn id 尚未就位（turn/start
    // 响应未回），都无法把输入安全钉到目标 turn——拒绝而不是注入错误的 turn。
    if (!turn || turn.finalized || turn.turnId !== expectedTurnId || !rt.codexTurnId) {
      return { effective: "rejected" };
    }
    const unsupported = unsupportedPromptBlocks(input.blocks, this.capabilities);
    if (unsupported.length) {
      throw new Error(`codex adapter does not support prompt block type(s): ${unsupported.join(", ")}`);
    }
    try {
      await rt.peer.request("turn/steer", {
        threadId: rt.threadId,
        expectedTurnId: rt.codexTurnId,
        input: [{ type: "text", text: textOf(input.blocks) }],
      });
    } catch {
      return { effective: "rejected" };
    }
    // codex 已按 expectedTurnId 校验通过：消息确定进入该 turn，用户消息绑定原 turn 落盘
    this.emit(
      rt,
      {
        kind: "user_message",
        provider: this.provider,
        payload: { messageId: input.messageId, content: input.blocks, delivery: "steer" },
      },
      undefined,
      turn,
    );
    return { effective: "steer" };
  }

  async cancel(ref: ProviderSessionRef): Promise<void> {
    const rt = this.mustThread(ref);
    const turn = rt.activeTurn;
    if (!turn || turn.finalized) return;
    if (!rt.codexTurnId) {
      // fast-submit 窗口：codex turn id 尚未回，此刻无法定向 interrupt。记下意图，
      // id 就位后补发；即便补发失败，runtime 的 cancel 宽限期兜底仍会合成终态。
      rt.pendingCancel = true;
      return;
    }
    await rt.peer.request("turn/interrupt", { threadId: rt.threadId, turnId: rt.codexTurnId });
  }

  /** cancel 早于 codex turn id 就位时的补发：fire-and-forget，失败由 runtime 宽限期兜底 */
  private flushPendingCancel(rt: ThreadRuntime): void {
    if (!rt.pendingCancel || !rt.codexTurnId) return;
    rt.pendingCancel = false;
    void rt.peer.request("turn/interrupt", { threadId: rt.threadId, turnId: rt.codexTurnId }).catch(() => {});
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
    // 空回合判定的记账点：任何可见产出都经过这里，集中标记比在各通知分支手工标记可靠
    const owner = turn ?? rt.activeTurn;
    if (owner && !owner.finalized && OUTPUT_EVENT_KINDS.has(ev.kind)) owner.sawOutput = true;
    rt.sink?.({ ...ev, provider: this.provider, providerSessionId: rt.threadId, turnId: turn?.turnId ?? rt.turnId, raw });
  }

  /**
   * 每个 turn 只发一次逻辑终态；turn/completed 通知、turn/start 响应终态、transport 失败谁先到都行。
   * 只允许终结传入的 turn（同 claude adapter）：上一 turn 的迟到终态不能误杀已开始的下一 turn。
   */
  private finishTurn(rt: ThreadRuntime, turn: CodexTurn | undefined, turnStatus: string): void {
    if (!turn || turn.finalized) return;
    turn.finalized = true;
    // 空回合显式上报：completed 但没有任何可见产出，说明 prompt 在进模型前被丢弃
    // （codex core 对 hook 拦截等路径静默 return，prompt 也不进原生 history）。
    // 事故：bs_01KXCNW0WVA11NZH2F8FKTCJ5E 连续空回合被静默当正常 end_turn，表现为"吞消息"。
    if (turnStatus === "completed" && !turn.sawOutput) {
      const hookBlock = turn.hookBlock;
      this.emit(
        rt,
        {
          kind: "_baton_notice",
          provider: this.provider,
          payload: {
            level: "warning",
            title: "Codex returned an empty turn (no output)",
            detail: hookBlock
              ? `prompt blocked by hook ${hookBlock.source}${hookBlock.reason ? `: ${hookBlock.reason}` : ""}`
              : "prompt was likely dropped before reaching the model (e.g. blocked by a UserPromptSubmit hook) and is not part of the codex thread history",
          },
        },
        undefined,
        turn,
      );
    }
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
      rt.pendingCancel = undefined; // turn 已终结，挂起的取消意图随之失效
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
        this.flushPendingCancel(rt);
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
        } else if (itemType === "contextCompaction") {
          // 运行阶段不是工具调用（无输入输出契约，不占工具卡），归一成 run status（design §5.2/§5.9）
          this.emit(
            rt,
            {
              kind: "_baton_run_status",
              provider: this.provider,
              payload:
                method === "item/started"
                  ? { phase: "compacting", title: "Compacting context…" }
                  : { phase: null },
            },
            params,
          );
        } else if (itemType) {
          const status = method === "item/started" ? "in_progress" : codexToolTerminalStatus(item.status);
          // 对账：declined 却从未向 baton 发过 requestApproval → 决策权被 provider 侧
          // 策略（auto-review 等）截走了，用户全程不知情。显式提示，不静默渲染。
          if (
            status === "declined" &&
            !rt.approvalSeenItemIds?.has(String(item.id)) &&
            !rt.autoReviewedItemIds?.has(String(item.id))
          ) {
            this.emit(
              rt,
              {
                kind: "_baton_notice",
                provider: this.provider,
                payload: {
                  level: "warning",
                  title: "Approval bypassed by provider-side policy",
                  detail: `codex declined "${toolTitleOf(item)}" without asking you — check approvals_reviewer / auto-review in codex config`,
                },
              },
              params,
            );
          }
          this.emit(
            rt,
            {
              kind: "tool_call_update",
              provider: this.provider,
              payload: {
                toolCallId: String(item.id),
                title: toolTitleOf(item),
                kind: toolKindOf(itemType),
                status,
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
      case "item/autoApprovalReview/started":
      case "item/autoApprovalReview/completed": {
        // UNSTABLE wire shape：所有字段都在 adapter 边界容错，原始 params 仍随 envelope.raw 保留。
        const review = (p.review ?? {}) as Record<string, unknown>;
        const action = (p.action ?? {}) as Record<string, unknown>;
        // `== null` 同时挡 undefined 与 null：UNSTABLE wire 显式送 null 时 String(null) 会造出
        // 假 id "null"，把回执挂到不存在的工具卡上（§3.3：UNSTABLE 字段一律按可选、缺失容忍）。
        const targetItemId = p.targetItemId == null ? undefined : String(p.targetItemId);
        if (targetItemId) (rt.autoReviewedItemIds ??= new Set()).add(targetItemId);
        // 一等回执只在**终态**铸造：started 只驱动运行相位（见下方 run_status），completed 才落一条
        // 带独立 reviewId 的审计回执（kernel.md §6）。这样无需关联 started/completed，无 target /
        // 同一操作多次决策都各自成条。codex 不给 review 自身 id，reviewId 由 adapter 铸。
        if (method.endsWith("/completed")) {
          const decision = closedTerminal(review.status, CODEX_REVIEW_DECISION, "aborted");
          this.emit(
            rt,
            {
              kind: "approval_review_update",
              provider: this.provider,
              payload: {
                reviewId: newId("arv"),
                ...(targetItemId ? { toolCallId: targetItemId } : {}),
                decision,
                ...(review.riskLevel !== undefined ? { riskLevel: String(review.riskLevel) } : {}),
                ...(review.userAuthorization !== undefined
                  ? { userAuthorization: String(review.userAuthorization) }
                  : {}),
                ...(review.rationale !== undefined ? { rationale: String(review.rationale) } : {}),
                ...(action.type !== undefined ? { actionType: String(action.type) } : {}),
              },
            },
            params,
          );
        }
        this.emit(
          rt,
          {
            kind: "_baton_run_status",
            provider: this.provider,
            payload: method.endsWith("/started")
              ? { phase: "reviewing_approval", title: "Reviewing approval…" }
              : { phase: null },
          },
          params,
        );
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
      case "hook/completed": {
        // 只关心会吞掉整个 turn 的拦截：UserPromptSubmit / SessionStart 被 block 时
        // codex core 静默空结束（prompt 不进 history、无任何 error 事件），block 原因只在
        // 这条通知里。其余 hook 事件（stop/preToolUse…）的 block 是流程控制语义，不上报。
        const run = (p.run ?? {}) as Record<string, unknown>;
        const status = String(run.status ?? "");
        const eventName = String(run.eventName ?? "");
        if (
          (status !== "blocked" && status !== "stopped") ||
          (eventName !== "userPromptSubmit" && eventName !== "sessionStart")
        ) {
          break;
        }
        const entries = (Array.isArray(run.entries) ? run.entries : []) as Array<Record<string, unknown>>;
        const reason =
          entries.map((entry) => String(entry.text ?? "")).filter(Boolean).join("; ") ||
          (run.statusMessage ? String(run.statusMessage) : "") ||
          undefined;
        const source = String(run.sourcePath ?? "unknown hook");
        if (rt.activeTurn && !rt.activeTurn.finalized) rt.activeTurn.hookBlock = { source, reason };
        this.emit(
          rt,
          {
            kind: "_baton_notice",
            provider: this.provider,
            payload: {
              level: "warning",
              title: `Codex ${eventName} hook blocked the prompt`,
              detail: reason ? `${source}: ${reason}` : source,
            },
          },
          params,
        );
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
        // 登记"问过 baton"的 item：declined 对账（见 approvalSeenItemIds）以此判定
        // 拒绝是否出自用户之手。v1 两代方法用 callId 指代 item，一并登记。
        for (const idField of [p.itemId, p.callId]) {
          if (idField === undefined) continue;
          (rt.approvalSeenItemIds ??= new Set()).add(String(idField));
        }
        const requestId = String(p.approvalId ?? p.itemId ?? p.callId ?? newId("ar"));
        const presentation = approvalPresentationOf(method, p);
        const choices = codexApprovalChoices(p);
        const request: PermissionRequest = {
          kind: "permission",
          requestId,
          ...presentation,
          toolCallId: p.itemId !== undefined ? String(p.itemId) : undefined,
          options: choices.map((choice) => choice.option),
        };
        this.emit(rt, { kind: "permission_request", provider: this.provider, payload: request }, params);
        const response = await this.options.requestHandler(request);
        if (response.kind === "cancelled") {
          // turn 被打断，request 随之收口：留痕 cancelled，回 codex "cancel"（Deny and interrupt turn）
          this.emit(
            rt,
            { kind: "permission_resolved", provider: this.provider, payload: { requestId, outcome: "cancelled" } },
            params,
          );
          return { decision: "cancel" };
        }
        // response 按 requestId 路由回来，kind 必配对 permission；意外不配保守拒绝（空 optionId 非 allow）
        const optionId = response.kind === "permission" ? response.optionId : "";
        this.emit(rt, {
          kind: "permission_resolved",
          provider: this.provider,
          payload: { requestId, outcome: "selected", optionId },
        });
        return { decision: choices.find((choice) => choice.option.optionId === optionId)?.decision ?? optionId };
      }
      case "item/tool/requestUserInput": {
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
        const request: QuestionRequest = {
          kind: "question",
          requestId: String(p.itemId ?? newId("qr")),
          questions,
        };
        this.emit(rt, { kind: "question_request", provider: this.provider, payload: request }, params);
        const response = await this.options.requestHandler(request);
        if (response.kind === "cancelled") {
          this.emit(
            rt,
            {
              kind: "question_resolved",
              provider: this.provider,
              payload: { requestId: request.requestId, outcome: "cancelled" },
            },
            params,
          );
          return { answers: {} };
        }
        const decisionAnswers = response.kind === "question" ? response.answers : {};
        this.emit(rt, {
          kind: "question_resolved",
          provider: this.provider,
          payload: { requestId: request.requestId, outcome: "answered", answers: decisionAnswers },
        });
        return {
          answers: Object.fromEntries(
            Object.entries(decisionAnswers).map(([questionId, answers]) => [questionId, { answers }]),
          ),
        };
      }
      default:
        throw new Error(`unsupported server request: ${method}`);
    }
  }
}

function approvalPresentationOf(
  method: string,
  p: Record<string, unknown>,
): { title: string; description?: string } {
  if (method === "item/commandExecution/requestApproval" || method === "execCommandApproval") {
    return {
      title: "Run command?",
      description: String(p.command ?? p.reason ?? "(see details)"),
    };
  }
  if (method === "item/fileChange/requestApproval" || method === "applyPatchApproval") {
    return { title: "Apply file changes?" };
  }
  return { title: "Codex requests permission" };
}
