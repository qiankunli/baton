#!/usr/bin/env bun
// chat-first TUI：打开即聊天，体验对齐 claude/codex CLI。
//   - 直接输入 → 发给当前 agent（默认 codex）
//   - /provider 选择输入目标；/model 配置当前 provider 后续 turn 的模型
//   - 切换 agent 时自动注入对方最新进展（buildCatchUpContext），无需手动搬运上下文
//   - @bs_xxx 引用其它 baton 会话；@ 不承担 provider 路由
// 用法：baton [--root <batonRoot>] [--cwd <dir>] [-c|--continue] [-s|--session <id>]

import { createCliRenderer, type TextareaOptions, type TextareaRenderable } from "@opentui/core";
import { createRoot, useKeyboard } from "@opentui/react";
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";

import { parseCommand, parseProvider, PROVIDERS, type ProviderName } from "../commands/registry.ts";
import { ensureConfigFile, loadConfig } from "../config/config.ts";
import { expandMentions } from "../context/mention.ts";
import type { PermissionRequest } from "../events/types.ts";
import { textOf } from "../events/types.ts";
import { applyEvent, emptySessionState, type SessionState } from "../store/reduce.ts";
import { openBatonSession } from "../session/open.ts";
import { BatonSessionRuntime } from "../session/runtime.ts";
import { createProviderAdapter, providerSessionKey } from "../providers/registry.ts";
import { SessionStore } from "../store/store.ts";
import { applyCompletion, buildCandidates, triggerAt } from "./completion.ts";
import { CTRL_C_CONFIRM_WINDOW_MS, ctrlCAction } from "./keys.ts";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function argValueAny(...flags: string[]): string | undefined {
  for (const flag of flags) {
    const value = argValue(flag);
    if (value !== undefined) return value;
  }
  return undefined;
}

function hasArg(...flags: string[]): boolean {
  return flags.some((flag) => process.argv.includes(flag));
}

const rootArg = argValue("--root");
ensureConfigFile(rootArg);
const config = loadConfig(rootArg);
const store = new SessionStore(rootArg);
const requestedCwd = argValue("--cwd") ?? process.cwd();
const opened = openBatonSession(store, {
  cwd: requestedCwd,
  sessionId: argValueAny("--session", "-s"),
  continueLast: hasArg("--continue", "-c"),
  title: `chat @ ${requestedCwd}`,
});
const PROVIDER_LABEL: Record<string, string> = { codex: "codex", "claude-code": "claude" };

// 对齐 chat CLI 习惯：Enter 发送；Shift+Enter / Option+Enter 换行。
// Shift+Enter 需要终端支持 kitty keyboard 协议才能与 Enter 区分；
// Ctrl+J 是任何终端都可用的换行兜底（走 textarea 默认的 linefeed→newline 绑定）。
const COMPOSER_KEY_BINDINGS: NonNullable<TextareaOptions["keyBindings"]> = [
  { name: "return", action: "submit" },
  { name: "kpenter", action: "submit" },
  { name: "return", shift: true, action: "newline" },
  { name: "kpenter", shift: true, action: "newline" },
  { name: "return", meta: true, action: "newline" },
  { name: "kpenter", meta: true, action: "newline" },
];

interface PendingApproval {
  request: PermissionRequest;
  resolve: (d: { optionId: string }) => void;
}

interface CommandPicker {
  title: string;
  options: Array<{ name: string; description: string; value: string }>;
  onSelect: (value: string) => void | Promise<void>;
}

interface StatusMessage {
  text: string;
  tone: "info" | "error";
}

function userVisibleText(text: string): string {
  return text.replace(/<baton-(context|sync)>[\s\S]*<\/baton-\1>\s*/g, "").trim();
}

function queuedPreviewText(text: string): string {
  const lines = userVisibleText(text).split("\n");
  const visible = lines.slice(0, 3).map((line, index) => `${index === 0 ? "  ↳ " : "    "}${line}`);
  if (lines.length > 3) visible.push("    …");
  return visible.join("\n");
}

function App(): ReactNode {
  const [session, setSession] = useState(opened.session);
  const view = useRef<SessionState>(opened.resumed ? opened.session.loadState() : emptySessionState());
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);

  const [agent, setAgent] = useState<ProviderName>(config.defaultAgent);
  const [draft, setDraft] = useState("");
  const composer = useRef<TextareaRenderable | null>(null);
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [picker, setPicker] = useState<CommandPicker | null>(null);
  const [suggIdx, setSuggIdx] = useState(0);
  const [suggDismissed, setSuggDismissed] = useState(false);
  const ctrlCArmedAt = useRef(0);

  const resetComposer = useCallback(() => {
    // textarea 自持内部 buffer，React 的 draft 只是镜像（供候选推导/按键分层用），两边都要清
    setDraft("");
    composer.current?.setText("");
  }, []);

  // 候选由输入实时推导（/ 行首=命令，@ =引用），无独立状态需要同步
  const trigger = triggerAt(draft);
  const approval = approvals[0] ?? null;
  const candidates =
    trigger && !suggDismissed && !approval && !picker
      ? buildCandidates(trigger, store.listSessions(), { excludeSessionId: session.id })
      : [];
  const sel = candidates.length ? Math.min(suggIdx, candidates.length - 1) : 0;

  // 焦点安全网：浮层都关闭时确保焦点回到输入框。focused prop 只在值变化时生效，
  // 覆盖不到"焦点被别处拿走但 prop 没变"的场景；focus() 对已聚焦者是 no-op，代价可忽略。
  useEffect(() => {
    if (!approval && !picker) composer.current?.focus();
  });

  const approvalHandler = useCallback(
    (request: PermissionRequest) =>
      new Promise<{ optionId: string }>((resolve) =>
        setApprovals((pending) => [...pending, { request, resolve }]),
      ),
    [],
  );

  const runtimeRef = useRef<{ sessionId: string; value: BatonSessionRuntime } | null>(null);
  if (runtimeRef.current?.sessionId !== session.id) {
    runtimeRef.current = { sessionId: session.id, value: new BatonSessionRuntime({
      session,
      mentionBudgetChars: config.mentionBudgetChars,
      createAdapter: (name) =>
        createProviderAdapter(name as ProviderName, { approvalHandler, config }),
      providerSessionKey: (name) => providerSessionKey(name as ProviderName),
      onStateChange: bump,
    }) };
  }
  const runtime = runtimeRef.current.value;

  const cancelRunningTurn = useCallback(() => {
    void runtime.cancelActive();
  }, [runtime]);

  /** 优雅退出：先关掉两个 agent 子进程再退（对应 /exit、双击 Ctrl+C、Ctrl+D） */
  const shutdown = useCallback(async () => {
    setStatus({ text: "正在退出…", tone: "info" });
    await runtime.close();
    process.exit(0);
  }, [runtime]);

  const configureModel = useCallback(
    async (target: ProviderName, model: { id: string; label: string }) => {
      await runtime.setModel(target, model.id);
      setStatus({ text: `${target} model: ${model.label}（从下一 turn 生效）`, tone: "info" });
    },
    [runtime],
  );

  const switchSession = useCallback(
    async (next: typeof session) => {
      if (runtime.isBusy || runtime.queueLength > 0) {
        throw new Error("当前 turn 结束后才能切换 BatonSession");
      }
      await runtime.close();
      view.current = next.loadState();
      setSession(next);
      setStatus({ text: `已打开 session ${next.id}`, tone: "info" });
    },
    [runtime],
  );

  const executeCommand = useCallback(
    async (name: "provider" | "model" | "sessions" | "new" | "exit", argument: string) => {
      if (name === "exit") {
        await shutdown();
        return;
      }
      if (name === "new") {
        if (argument) throw new Error("/new 不接受参数");
        const next = store.createSession({ cwd: session.meta.cwd, title: `chat @ ${session.meta.cwd}` });
        await switchSession(next);
        return;
      }
      if (name === "sessions") {
        if (argument) throw new Error("/sessions 不接受参数");
        const sessions = store.listSessions();
        setPicker({
          title: "选择 BatonSession",
          options: sessions.map((meta) => ({
            name: `${meta.batonSessionId === session.id ? "● " : ""}${meta.title ?? meta.batonSessionId}`,
            description: `${meta.cwd} · ${meta.updatedAt ?? meta.createdAt}`,
            value: meta.batonSessionId,
          })),
          onSelect: async (value) => {
            if (value === session.id) return;
            try {
              await switchSession(store.openSession(value));
            } catch (error) {
              setStatus({ text: error instanceof Error ? error.message : String(error), tone: "error" });
            }
          },
        });
        return;
      }
      if (name === "provider") {
        if (!argument) {
          setPicker({
            title: "选择 provider",
            options: PROVIDERS.map((provider) => ({ name: provider, description: `切换到 ${provider}`, value: provider })),
            onSelect: (value) => {
              const provider = parseProvider(value);
              if (provider) setAgent(provider);
            },
          });
          return;
        }
        const provider = parseProvider(argument);
        if (!provider) throw new Error(`未知 provider: ${argument}（可选 codex / claude）`);
        setAgent(provider);
        setStatus(null);
        return;
      }

      const target = agent;
      const models = await runtime.listModels(target);
      if (!argument) {
        setPicker({
          title: `选择 ${target} model`,
          options: models.map((model) => ({
            name: model.label,
            description: model.description ?? model.id,
            value: model.id,
          })),
          onSelect: async (value) => {
            const model = models.find((candidate) => candidate.id === value);
            if (!model) return;
            try {
              await configureModel(target, model);
            } catch (error) {
              setStatus({ text: error instanceof Error ? error.message : String(error), tone: "error" });
            }
          },
        });
        return;
      }
      const normalized = argument.toLowerCase();
      const model = models.find(
        (candidate) => candidate.id.toLowerCase() === normalized || candidate.label.toLowerCase() === normalized,
      );
      if (!model) throw new Error(`${target} 未知 model: ${argument}`);
      await configureModel(target, model);
    },
    [agent, configureModel, runtime, session, shutdown, switchSession],
  );

  const send = useCallback(
    async (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed) return;
      const command = parseCommand(trimmed);
      if (command) {
        resetComposer();
        try {
          await executeCommand(command.definition.name, command.argument);
        } catch (error) {
          setStatus({ text: error instanceof Error ? error.message : String(error), tone: "error" });
        }
        return;
      }

      const target = agent;
      resetComposer();
      setStatus(null);
      try {
        const { prompt } = expandMentions(store, trimmed, config.mentionBudgetChars);
        const wasBusy = runtime.isBusy || runtime.queueLength > 0;
        if (wasBusy) setStatus({ text: `${target} turn 已排队`, tone: "info" });
        const outcome = await runtime.submit(target, [{ type: "text", text: prompt }], (envelope) => {
          applyEvent(view.current, envelope);
          bump();
        });
        if (outcome === "completed") {
          setStatus((current) => (current?.tone === "error" ? current : null));
        }
      } catch (err) {
        setStatus({ text: err instanceof Error ? err.message : String(err), tone: "error" });
      }
    },
    [agent, bump, executeCommand, resetComposer, runtime],
  );

  const runningProviders = runtime.activeProvider ? [runtime.activeProvider] : [];
  const queuedTurns = runtime.queuedTurns;
  const selectedBusy = runtime.activeProvider === agent;
  const selectedModel = runtime.currentModel(agent) ?? "default";

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      // TUI 惯例：Ctrl+C 是"打断"不是"退出"——跑着中断、有输入清空、空闲二次确认
      const action = ctrlCAction({ busy: runningProviders.length > 0, hasDraft: draft !== "", armedAt: ctrlCArmedAt.current, now: Date.now() });
      if (action === "cancel-turn") cancelRunningTurn();
      else if (action === "clear-draft") {
        resetComposer();
        setSuggIdx(0);
      } else if (action === "exit") void shutdown();
      else {
        ctrlCArmedAt.current = Date.now();
        setStatus({ text: "再按一次 Ctrl+C 退出", tone: "info" });
        setTimeout(
          () => setStatus((current) => (current?.text === "再按一次 Ctrl+C 退出" ? null : current)),
          CTRL_C_CONFIRM_WINDOW_MS + 100,
        );
      }
      return;
    }
    if (key.ctrl && key.name === "d") {
      // shell 习惯：空输入时 EOF 即退出
      if (!draft && runningProviders.length === 0) void shutdown();
      return;
    }
    if (key.name === "escape" && picker && !approval) {
      key.preventDefault();
      setPicker(null);
      return;
    }
    if (candidates.length > 0 && ["down", "up", "tab", "escape"].includes(key.name)) {
      // 候选浮层：↑/↓ 选择，Tab 补全（Enter 保留"发送"语义），Esc 关闭
      // 全局 handler 先于聚焦 renderable 执行；preventDefault 阻止 textarea 把 ↑/↓/Tab 当编辑键
      key.preventDefault();
      if (key.name === "down") setSuggIdx((i) => (i + 1) % candidates.length);
      else if (key.name === "up") setSuggIdx((i) => (i - 1 + candidates.length) % candidates.length);
      else if (key.name === "tab" && trigger) {
        const chosen = candidates[sel];
        if (chosen) {
          const next = applyCompletion(draft, trigger, chosen);
          setDraft(next);
          composer.current?.setText(next);
          composer.current?.gotoBufferEnd();
          setSuggIdx(0);
        }
      } else if (key.name === "escape") setSuggDismissed(true);
      return;
    }
    if (key.name === "up" && !draft && !approval && !picker) {
      const recalled = runtime.recallLatestQueued();
      if (recalled) {
        key.preventDefault();
        const text = userVisibleText(textOf(recalled.blocks));
        setDraft(text);
        composer.current?.setText(text);
        composer.current?.gotoBufferEnd();
        const provider = parseProvider(recalled.provider);
        if (provider) setAgent(provider);
        setStatus({ text: `已撤回 ${recalled.provider} 的排队消息，可继续编辑`, tone: "info" });
        return;
      }
    }
    if (key.name === "escape" && runningProviders.length > 0) cancelRunningTurn();
  });

  const v = view.current;
  const cwd = session.meta.cwd;
  const usageLine = `in:${v.usage.inputTokens} out:${v.usage.outputTokens}`;
  // 输入区随内容长高（上限 6 行）；浮层锚点跟着输入框顶部走（+1 是底部状态行）
  const composerHeight = Math.min(6, draft.split("\n").length) + 2;
  const overlayBottom = composerHeight + 1;

  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      <scrollbox style={{ flexGrow: 1, paddingLeft: 1, paddingRight: 1 }} stickyScroll stickyStart="bottom" focused={false}>
        <text fg="#565f89">
          {`baton · session ${session.id}\n直接输入发给当前 provider；/provider 切换，/sessions 打开会话，@bs_xxx 引用其它会话\n`}
        </text>
        {v.timeline.map((item) => {
          if (item.type === "message") {
            const msg = v.messages.get(item.id);
            if (!msg) return null;
            if (msg.role === "thought") {
              // 思考过程：dim 展示中间推理（config.showThoughts 可关）
              if (!config.showThoughts) return null;
              const text = textOf(msg.content).trim();
              if (!text) return null;
              return (
                <text key={item.id} fg="#565f89">
                  {`\n∴ ${text}`}
                </text>
              );
            }
            const label = msg.role === "user" ? "you" : (PROVIDER_LABEL[msg.provider ?? ""] ?? msg.provider ?? "agent");
            const color = msg.role === "user" ? "#7aa2f7" : label === "codex" ? "#9ece6a" : "#bb9af7";
            const body = msg.role === "user" ? userVisibleText(textOf(msg.content)) : textOf(msg.content);
            return (
              <text key={item.id}>
                <span fg={color}>{`\n${label}> `}</span>
                {body}
              </text>
            );
          }
          if (item.type === "tool_call") {
            const tc = v.toolCalls.get(item.id);
            if (!tc) return null;
            const mark = tc.status === "completed" ? "✓" : tc.status === "failed" ? "✗" : "⋯";
            const lines = [`  ${mark} ${tc.title ?? item.id}`];
            for (const block of tc.content) {
              if (block.type === "diff") {
                for (const ch of (block as { changes: Array<{ operation: string; path: string }> }).changes) {
                  lines.push(`      ± ${ch.operation} ${ch.path}`);
                }
              }
            }
            if (tc.status === "in_progress") {
              // 运行中的命令：展示输出尾巴（最近 3 行），完成后收起保持时间线干净
              const tail = textOf(tc.content).split("\n").filter(Boolean).slice(-3);
              for (const l of tail) lines.push(`      │ ${l.slice(0, 120)}`);
            }
            return <text key={item.id} fg="#e0af68">{lines.join("\n")}</text>;
          }
          if (item.type === "plan") {
            const plan = v.plans.get(item.id);
            if (!plan) return null;
            const markOf = (s: string) => (s === "completed" ? "☑" : s === "in_progress" ? "◐" : "☐");
            return (
              <text key={item.id} fg="#7dcfff">
                {`\n  计划\n${plan.entries.map((e) => `  ${markOf(e.status)} ${e.content}`).join("\n")}`}
              </text>
            );
          }
          return null;
        })}
        {runningProviders.map((provider) => (
          <text key={provider} fg="#565f89">{`\n${provider} 思考中… (Esc 中断)`}</text>
        ))}
      </scrollbox>

      {queuedTurns.length > 0 && (
        <box style={{ flexDirection: "column", flexShrink: 0, paddingLeft: 1, paddingRight: 1 }}>
          <text>• 排队的后续消息</text>
          {queuedTurns.map((turn) => (
            <text key={turn.id} fg="#565f89">
              {`${queuedPreviewText(textOf(turn.blocks))}  [${turn.provider}]`}
            </text>
          ))}
          <text fg="#565f89">↑ 编辑最后一条排队消息</text>
        </box>
      )}

      <box
        title={`provider:${agent} · model:${selectedModel}${selectedBusy ? " · running" : ""}`}
        border
        borderColor={selectedBusy ? "#e0af68" : "#3b4261"}
        style={{ height: composerHeight }}
      >
        <textarea
          ref={composer}
          focused={!approval && !picker}
          placeholder={`发给 ${agent}（/ 命令，@ 引用，Ctrl+J 换行）`}
          cursorStyle={{ style: "line", blinking: true }}
          keyBindings={COMPOSER_KEY_BINDINGS}
          style={{ flexGrow: 1 }}
          onContentChange={() => {
            setDraft(composer.current?.plainText ?? "");
            setSuggDismissed(false);
            setSuggIdx(0);
          }}
          onSubmit={() => {
            // textarea 的 submit 事件不带值，从内部 buffer 读
            void send(composer.current?.plainText ?? "");
          }}
        />
      </box>
      {candidates.length > 0 && (
        <box
          border
          borderColor="#3b4261"
          title="候选 (Tab 补全 · ↑↓ 选择 · Esc 关闭)"
          style={{ position: "absolute", left: 2, bottom: overlayBottom, width: 60, height: candidates.length + 2, zIndex: 150, flexDirection: "column" }}
        >
          {candidates.map((c, i) => (
            <text key={c.insert} fg={i === sel ? "#7aa2f7" : "#a9b1d6"}>
              {`${i === sel ? "▸ " : "  "}${c.label}  ${c.detail}`}
            </text>
          ))}
        </box>
      )}
      <box style={{ height: 1 }}>
        <text fg={status?.tone === "error" ? "#f7768e" : status ? "#7aa2f7" : "#565f89"}>
          {status?.text ?? `${usageLine}  turns:${v.turnSummaries.length}  queue:${runtime.queueLength}  cwd:${cwd}`}
        </text>
      </box>

      {picker && !approval && (
        <box
          title={picker.title}
          border
          borderColor="#7aa2f7"
          // 对齐 claude code 习惯：命令弹窗紧贴输入框上方（同 @ 候选框的锚定方式），不悬在屏幕顶部
          style={{ position: "absolute", left: 2, bottom: overlayBottom, width: 72, height: Math.min(18, picker.options.length * 2 + 2), zIndex: 190, flexDirection: "column" }}
        >
          <select
            focused
            style={{ flexGrow: 1 }}
            options={picker.options}
            onSelect={(_i: number, opt: { name: string; description: string; value?: unknown } | null) => {
              if (!opt) return;
              setPicker(null);
              void picker.onSelect(String(opt.value));
            }}
          />
        </box>
      )}

      {approval && (
        <box
          title="需要你的批准"
          border
          borderColor="#e0af68"
          // 同 picker：紧贴输入框上方，视线不用离开输入区
          style={{ position: "absolute", left: 2, bottom: overlayBottom, width: 72, height: 10, zIndex: 200, flexDirection: "column" }}
        >
          <text>{approval.request.title}</text>
          <select
            focused
            style={{ flexGrow: 1 }}
            options={approval.request.options.map((o) => ({ name: o.name, description: o.kind, value: o.optionId }))}
            onSelect={(_i: number, opt: { name: string; description: string; value?: unknown } | null) => {
              if (opt) {
                approval.resolve({ optionId: String(opt.value) });
                setApprovals((pending) => pending.slice(1));
              }
            }}
          />
        </box>
      )}
    </box>
  );
}

if (!process.stdout.isTTY) {
  console.error("baton tui 需要在真实终端（TTY）里运行");
  process.exit(1);
}
// Ctrl+C 自己接管（分层语义，见 keys.ts），不走 renderer 的直接退出。
// autoFocus=false：禁止鼠标点击把焦点从输入框抢走——点击 scrollbox 夺焦不触发 React
// 重渲染，focused prop 拉不回来，这是"操作久了输入框失焦"的主因。
const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30, autoFocus: false });
createRoot(renderer).render(<App />);
