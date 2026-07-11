// Claude Code 接入：官方 Agent SDK 进程内直调（TS 宿主不需要 tutti 那样的 sidecar）。
// SDK 以子进程拉起 claude CLI；可执行文件可换成公司包装器（BATON_CLAUDE_BIN），
// 凭证零持有，复用本机登录态。见 docs/design.md §5.1。

import { query, type Options, type PermissionResult, type Query, type SDKMessage } from "@anthropic-ai/claude-agent-sdk";

import { newId } from "../../events/ids.ts";
import type { ContentBlock, DiffBlock, PermissionOption, PlanEntry, PromptBlock } from "../../events/types.ts";
import { textOf } from "../../events/types.ts";
import type {
  AdapterCapabilities,
  AgentAdapter,
  ApprovalHandler,
  EventSink,
  ModelOption,
  PromptOptions,
  ProviderSessionRef,
  StartOptions,
} from "../types.ts";

const APPROVAL_OPTIONS: PermissionOption[] = [
  { optionId: "allow", name: "Allow once", kind: "allow_once" },
  { optionId: "deny", name: "Deny", kind: "reject_once" },
];

/** Claude 工具名 → 内部 tool kind */
export function claudeToolKind(toolName: string): string {
  switch (toolName) {
    case "Read":
    case "NotebookRead":
      return "read";
    case "Edit":
    case "Write":
    case "MultiEdit":
    case "NotebookEdit":
      return "edit";
    case "Bash":
    case "BashOutput":
    case "KillShell":
      return "execute";
    case "Grep":
    case "Glob":
      return "search";
    case "WebFetch":
    case "WebSearch":
      return "fetch";
    default:
      return "other";
  }
}

/** 工具调用的一行标题：工具名 + 最有辨识度的入参 */
export function claudeToolTitle(toolName: string, input: Record<string, unknown>): string {
  const detail =
    input.command ?? input.file_path ?? input.pattern ?? input.url ?? input.query ?? input.description;
  return detail !== undefined ? `${toolName}: ${String(detail)}` : toolName;
}

/** TodoWrite 入参 → 统一 plan entries（最大公约数规范：计划一律走 plan_update） */
export function todoWritePlan(input: Record<string, unknown>): PlanEntry[] {
  const todos = (Array.isArray(input.todos) ? input.todos : []) as Array<Record<string, unknown>>;
  return todos.map((t) => ({
    content: String(t.content ?? ""),
    priority: "medium",
    status: t.status === "in_progress" || t.status === "completed" ? (t.status as string) : "pending",
  }));
}

/** 编辑类工具入参 → 统一 diff 内容块；非编辑类返回 null */
export function claudeToolDiff(toolName: string, input: Record<string, unknown>): DiffBlock | null {
  const path = String(input.file_path ?? input.notebook_path ?? "");
  if (!path) return null;
  switch (toolName) {
    case "Write":
      return { type: "diff", changes: [{ operation: "add", path }] };
    case "Edit": {
      const patch = `--- ${path}\n- ${String(input.old_string ?? "")}\n+ ${String(input.new_string ?? "")}`;
      return { type: "diff", changes: [{ operation: "modify", path }], patch: patch.slice(0, 4000) };
    }
    case "MultiEdit": {
      const edits = (Array.isArray(input.edits) ? input.edits : []) as Array<Record<string, unknown>>;
      const patch = edits
        .map((e) => `- ${String(e.old_string ?? "")}\n+ ${String(e.new_string ?? "")}`)
        .join("\n");
      return { type: "diff", changes: [{ operation: "modify", path }], patch: `--- ${path}\n${patch}`.slice(0, 4000) };
    }
    case "NotebookEdit":
      return { type: "diff", changes: [{ operation: "modify", path }] };
    default:
      return null;
  }
}

function claudeToolResultBlocks(result: unknown): ContentBlock[] {
  if (typeof result === "string") return result ? [{ type: "text", text: result }] : [];
  if (!Array.isArray(result)) return [];
  return result.flatMap((raw) => {
    const block = raw as Record<string, unknown>;
    return block.type === "text" && typeof block.text === "string"
      ? [{ type: "text", text: block.text }]
      : [];
  });
}

interface ClaudeRuntime {
  cwd: string;
  env?: Record<string, string>;
  /** SDK 的 session_id，首个 turn 的 init 消息里拿到；resume 靠它 */
  claudeSessionId?: string;
  activeQuery?: Query;
  /** 用户主动中断时，SDK 会以 error result 结束消息流；该错误应归一成 cancelled。 */
  cancelRequested: boolean;
  /** 当前正在流式输出的 assistant 消息的内部 messageId（chunk 与最终 upsert 共用） */
  streamMessageId?: string;
  /** 用户在 baton 中选择的模型；只在下一次 query 创建时生效。 */
  model?: string;
  models?: ModelOption[];
  /** 已归一成 plan_update 的 tool_use id：其 tool_result 也要跳过，避免时间线出现重复工具卡 */
  suppressedToolIds: Set<string>;
}

const CLAUDE_FALLBACK_MODELS: ModelOption[] = [
  { id: "default", label: "Default", description: "Use the Claude Code default model" },
  { id: "sonnet", label: "Sonnet" },
  { id: "opus", label: "Opus" },
  { id: "haiku", label: "Haiku" },
];

function claudeModels(models: Array<{ value: string; displayName: string; description?: string }>): ModelOption[] {
  return [
    CLAUDE_FALLBACK_MODELS[0] as ModelOption,
    ...models.map((model) => ({
      id: model.value,
      label: model.displayName,
      description: model.description,
    })),
  ];
}

export interface ClaudeAdapterOptions {
  approvalHandler: ApprovalHandler;
  /** claude 可执行文件路径；默认 BATON_CLAUDE_BIN 环境变量，再默认交给 SDK 自己找 */
  executablePath?: string;
}

export class ClaudeAdapter implements AgentAdapter {
  readonly provider = "claude-code";
  // 当前 adapter 最终只发送 text（design.md §3.1）；可选能力接口落地并验证后才声明
  // 对应 marker——契约测试钉住"声明支持就必须实现对应接口"。
  readonly capabilities: AdapterCapabilities = { prompt: {} };
  private sessions = new Map<string, ClaudeRuntime>();

  constructor(private options: ClaudeAdapterOptions) {}

  /** SDK 无独立"启动"步骤：session 在首个 prompt 时创建，这里只登记运行时 */
  async start(opts: StartOptions): Promise<ProviderSessionRef> {
    const id = newId("ps");
    this.sessions.set(id, {
      cwd: opts.cwd,
      env: opts.env,
      claudeSessionId: opts.resumeSessionId,
      cancelRequested: false,
      suppressedToolIds: new Set(),
    });
    return { provider: this.provider, providerSessionId: id, resumed: Boolean(opts.resumeSessionId) };
  }

  /** 拿 Claude 原生 session id（宿主存入 meta 以支持将来 resume） */
  nativeSessionId(ref: ProviderSessionRef): string | undefined {
    return this.sessions.get(ref.providerSessionId)?.claudeSessionId;
  }

  async listModels(ref: ProviderSessionRef): Promise<ModelOption[]> {
    const rt = this.mustSession(ref);
    if (rt.activeQuery) {
      try {
        rt.models = claudeModels(await rt.activeQuery.supportedModels());
      } catch {
        // 首个 query 尚未完成 initialize 时允许退回稳定别名，picker 不应阻塞发送链路。
      }
    }
    return rt.models ?? CLAUDE_FALLBACK_MODELS;
  }

  async setModel(ref: ProviderSessionRef, modelId: string | null): Promise<void> {
    const rt = this.mustSession(ref);
    rt.model = !modelId || modelId === "default" ? undefined : modelId;
  }

  currentModel(ref: ProviderSessionRef): string | null {
    return this.mustSession(ref).model ?? null;
  }

  async prompt(
    ref: ProviderSessionRef,
    blocks: PromptBlock[],
    sink: EventSink,
    opts: PromptOptions,
  ): Promise<void> {
    const rt = this.sessions.get(ref.providerSessionId);
    if (!rt) throw new Error(`unknown claude session: ${ref.providerSessionId}`);

    const emit: EventSink = (ev) =>
      sink({ ...ev, provider: this.provider, providerSessionId: rt.claudeSessionId, turnId: opts.turnId });

    emit({ kind: "user_message", provider: this.provider, payload: { messageId: newId("m"), content: blocks } });
    emit({ kind: "state_update", provider: this.provider, payload: { state: "running" } });

    const executable = this.options.executablePath ?? process.env.BATON_CLAUDE_BIN;
    const sdkOptions: Options = {
      cwd: rt.cwd,
      env: { ...(process.env as Record<string, string>), ...rt.env },
      resume: rt.claudeSessionId,
      includePartialMessages: true,
      ...(rt.model ? { model: rt.model } : {}),
      ...(executable ? { pathToClaudeCodeExecutable: executable } : {}),
      canUseTool: (toolName, input, meta) => this.handleCanUseTool(emit, toolName, input, meta.title),
    };

    const q = query({ prompt: textOf(blocks), options: sdkOptions });
    rt.activeQuery = q;
    rt.cancelRequested = false;
    void q
      .initializationResult()
      .then((result) => {
        rt.models = claudeModels(result.models);
      })
      .catch(() => {});
    try {
      for await (const msg of q) {
        this.handleMessage(rt, emit, msg);
      }
    } catch (error) {
      if (!rt.cancelRequested) throw error;
      emit({
        kind: "state_update",
        provider: this.provider,
        payload: { state: "idle", stopReason: "cancelled" },
      });
    } finally {
      rt.activeQuery = undefined;
      rt.cancelRequested = false;
      rt.streamMessageId = undefined;
    }
  }

  async cancel(ref: ProviderSessionRef): Promise<void> {
    const rt = this.sessions.get(ref.providerSessionId);
    if (!rt?.activeQuery) return;
    rt.cancelRequested = true;
    // interrupt 与消息流会被 SDK 同时结束；最终状态由 prompt() 的消费路径收口。
    await rt.activeQuery.interrupt().catch(() => {});
  }

  async close(ref: ProviderSessionRef): Promise<void> {
    const rt = this.sessions.get(ref.providerSessionId);
    if (!rt) return;
    this.sessions.delete(ref.providerSessionId);
    await rt.activeQuery?.interrupt().catch(() => {});
  }

  private mustSession(ref: ProviderSessionRef): ClaudeRuntime {
    const rt = this.sessions.get(ref.providerSessionId);
    if (!rt) throw new Error(`unknown claude session: ${ref.providerSessionId}`);
    return rt;
  }

  private async handleCanUseTool(
    emit: EventSink,
    toolName: string,
    input: Record<string, unknown>,
    promptTitle: string | undefined,
  ): Promise<PermissionResult> {
    const request = {
      requestId: newId("ar"),
      title: promptTitle ?? claudeToolTitle(toolName, input),
      options: APPROVAL_OPTIONS,
    };
    emit({ kind: "permission_request", provider: this.provider, payload: request });
    const decision = await this.options.approvalHandler(request);
    emit({
      kind: "permission_resolved",
      provider: this.provider,
      payload: { requestId: request.requestId, outcome: "selected", optionId: decision.optionId },
    });
    if (decision.optionId === "allow") return { behavior: "allow", updatedInput: input };
    return { behavior: "deny", message: "denied by baton user" };
  }

  private handleMessage(rt: ClaudeRuntime, emit: EventSink, msg: SDKMessage): void {
    switch (msg.type) {
      case "system":
        if (msg.subtype === "init") rt.claudeSessionId = msg.session_id;
        break;
      case "stream_event": {
        // 子 agent（parent_tool_use_id 非空）的流式输出不进主时间线，内容随 tool result 汇总
        if (msg.parent_tool_use_id) break;
        const event = msg.event as { type: string; delta?: { type: string; text?: string; thinking?: string } };
        if (event.type === "message_start") {
          rt.streamMessageId = newId("m");
        } else if (event.type === "content_block_delta" && event.delta) {
          const messageId = rt.streamMessageId ?? (rt.streamMessageId = newId("m"));
          if (event.delta.type === "text_delta" && event.delta.text) {
            emit({
              kind: "agent_message_chunk",
              provider: this.provider,
              payload: { messageId, content: { type: "text", text: event.delta.text } },
              raw: msg,
            });
          } else if (event.delta.type === "thinking_delta" && event.delta.thinking) {
            emit({
              kind: "agent_thought_chunk",
              provider: this.provider,
              payload: { messageId: `${messageId}_thought`, content: { type: "text", text: event.delta.thinking } },
              raw: msg,
            });
          }
        }
        break;
      }
      case "assistant": {
        const blocks = (msg.message.content ?? []) as unknown as Array<Record<string, unknown>>;
        const texts = blocks
          .filter((b) => b.type === "text")
          .map((b) => String(b.text ?? ""))
          .join("");
        if (texts && !msg.parent_tool_use_id) {
          // 全文 upsert 覆盖 chunk 累积（同一 messageId），之后开新消息
          const messageId = rt.streamMessageId ?? newId("m");
          rt.streamMessageId = undefined;
          emit({
            kind: "agent_message",
            provider: this.provider,
            payload: { messageId, content: [{ type: "text", text: texts }] },
            raw: msg,
          });
        }
        for (const b of blocks) {
          if (b.type !== "tool_use") continue;
          const toolName = String(b.name);
          const input = (b.input ?? {}) as Record<string, unknown>;
          // TodoWrite 归一成 plan_update（计划不是工具调用，是头等中间过程）
          if (toolName === "TodoWrite") {
            rt.suppressedToolIds.add(String(b.id));
            emit({
              kind: "plan_update",
              provider: this.provider,
              payload: { planId: `pl_${rt.claudeSessionId ?? "claude"}`, entries: todoWritePlan(input) },
              raw: msg,
            });
            continue;
          }
          const diff = claudeToolDiff(toolName, input);
          emit({
            kind: "tool_call_update",
            provider: this.provider,
            payload: {
              toolCallId: String(b.id),
              title: claudeToolTitle(toolName, input),
              kind: claudeToolKind(toolName),
              status: "in_progress",
              content: diff ? [diff] : undefined,
              rawInput: input,
            },
            raw: msg,
          });
        }
        break;
      }
      case "user": {
        const content = msg.message.content;
        if (!Array.isArray(content)) break;
        for (const b of content as unknown as Array<Record<string, unknown>>) {
          if (b.type !== "tool_result") continue;
          // 已归一成 plan_update 的调用不再出工具卡（首见 upsert 会凭空造出一张）
          if (rt.suppressedToolIds.has(String(b.tool_use_id))) continue;
          emit({
            kind: "tool_call_update",
            provider: this.provider,
            payload: {
              toolCallId: String(b.tool_use_id),
              status: b.is_error ? "failed" : "completed",
              rawOutput: b.content,
            },
            raw: msg,
          });
          for (const output of claudeToolResultBlocks(b.content)) {
            emit({
              kind: "tool_call_content_chunk",
              provider: this.provider,
              payload: { toolCallId: String(b.tool_use_id), content: output },
              raw: msg,
            });
          }
        }
        break;
      }
      case "result": {
        const usage = msg.usage;
        if (usage) {
          emit({
            kind: "usage_update",
            provider: this.provider,
            payload: {
              inputTokens: usage.input_tokens ?? 0,
              outputTokens: usage.output_tokens ?? 0,
              cacheReadTokens: usage.cache_read_input_tokens ?? 0,
              cacheWriteTokens: usage.cache_creation_input_tokens ?? 0,
            },
            raw: msg,
          });
        }
        emit({
          kind: "state_update",
          provider: this.provider,
          payload: {
            state: "idle",
            stopReason: msg.subtype === "success" ? "end_turn" : msg.subtype,
          },
          raw: msg,
        });
        break;
      }
      default:
        break; // 其余系统消息 M2 不消费
    }
  }
}
