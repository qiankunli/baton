#!/usr/bin/env bun
// chat-first TUI：打开即聊天，体验对齐 claude/codex CLI。
//   - 直接输入 → 发给当前 agent（默认 codex）
//   - /provider 选择输入目标；/model 配置当前 provider 后续 turn 的模型
//   - 切换 agent 时自动注入对方最新进展（buildCatchUpContext），无需手动搬运上下文
//   - @bs_xxx 引用其它 baton 会话；@ 不承担 provider 路由
// 用法：baton（或 bun src/tui/main.tsx）[--root <batonRoot>] [--cwd <dir>]

import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard } from "@opentui/react";
import { useCallback, useRef, useState, type ReactNode } from "react";

import { ClaudeAdapter } from "../adapters/claude/adapter.ts";
import { CodexAdapter } from "../adapters/codex/adapter.ts";
import { isModelConfigurable, type AgentAdapter, type ModelOption, type ProviderSessionRef } from "../adapters/types.ts";
import { parseCommand, parseProvider, PROVIDERS, type ProviderName } from "../commands/registry.ts";
import { ensureSettingsFile, loadSettings } from "../config/settings.ts";
import { buildCatchUpContext, expandMentions } from "../context/mention.ts";
import { newId } from "../events/ids.ts";
import type { PermissionRequest } from "../events/types.ts";
import { textOf } from "../events/types.ts";
import { applyEvent, emptySessionState, type SessionState } from "../store/reduce.ts";
import { SessionStore } from "../store/store.ts";
import { applyCompletion, buildCandidates, triggerAt } from "./completion.ts";
import { CTRL_C_CONFIRM_WINDOW_MS, ctrlCAction } from "./keys.ts";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const rootArg = argValue("--root");
ensureSettingsFile(rootArg);
const settings = loadSettings(rootArg);
const store = new SessionStore(rootArg);
const cwd = argValue("--cwd") ?? process.cwd();
// 打开即建会话——不要让用户先面对空 rail 和弹窗
const session = store.createSession({ cwd, title: `chat @ ${cwd}` });

const PROVIDER_LABEL: Record<string, string> = { codex: "codex", "claude-code": "claude" };

interface AgentSlot {
  adapter: AgentAdapter;
  ref?: ProviderSessionRef;
  starting?: Promise<void>;
  busy: boolean;
}

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

function App(): ReactNode {
  const slots = useRef(new Map<ProviderName, AgentSlot>());
  const view = useRef<SessionState>(emptySessionState());
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);

  const [agent, setAgent] = useState<ProviderName>(settings.defaultAgent);
  const [draft, setDraft] = useState("");
  const [composerVersion, setComposerVersion] = useState(0);
  const [status, setStatus] = useState<StatusMessage | null>(null);
  const [approvals, setApprovals] = useState<PendingApproval[]>([]);
  const [picker, setPicker] = useState<CommandPicker | null>(null);
  const [suggIdx, setSuggIdx] = useState(0);
  const [suggDismissed, setSuggDismissed] = useState(false);
  const ctrlCArmedAt = useRef(0);

  const resetComposer = useCallback(() => {
    setDraft("");
    // OpenTUI InputRenderable owns an internal buffer; focus moving to a picker can
    // otherwise preserve the submitted command even after React state is cleared.
    setComposerVersion((version) => version + 1);
  }, []);

  // 候选由输入实时推导（/ 行首=命令，@ =引用），无独立状态需要同步
  const trigger = triggerAt(draft);
  const approval = approvals[0] ?? null;
  const candidates =
    trigger && !suggDismissed && !approval && !picker
      ? buildCandidates(trigger, store.listSessions(), { excludeSessionId: session.id })
      : [];
  const sel = candidates.length ? Math.min(suggIdx, candidates.length - 1) : 0;

  const approvalHandler = useCallback(
    (request: PermissionRequest) =>
      new Promise<{ optionId: string }>((resolve) =>
        setApprovals((pending) => [...pending, { request, resolve }]),
      ),
    [],
  );

  const ensureAgent = useCallback(
    async (name: ProviderName): Promise<AgentSlot> => {
      let slot = slots.current.get(name);
      if (!slot) {
        const adapter: AgentAdapter =
          name === "claude"
            ? new ClaudeAdapter({ approvalHandler, executablePath: settings.claudeExecutable })
            : new CodexAdapter({ approvalHandler, command: settings.codexCommand });
        slot = { adapter, busy: false };
        slots.current.set(name, slot);
        slot.starting = (async () => {
          slot.ref = await adapter.start({ cwd });
          session.setProviderSession(adapter.provider, {
            provider: adapter.provider,
            providerSessionId: slot.ref.providerSessionId,
          });
        })();
      }
      if (slot.starting) {
        setStatus({ text: `starting ${name}…`, tone: "info" });
        bump();
        try {
          await slot.starting;
          setStatus(null);
        } catch (error) {
          slots.current.delete(name);
          throw error;
        } finally {
          slot.starting = undefined;
        }
      }
      return slot;
    },
    [approvalHandler, bump],
  );

  const cancelRunningTurn = useCallback(() => {
    const selected = slots.current.get(agent);
    const slot = selected?.busy ? selected : [...slots.current.values()].find((candidate) => candidate.busy);
    if (slot?.ref) void slot.adapter.cancel(slot.ref);
  }, [agent]);

  /** 优雅退出：先关掉两个 agent 子进程再退（对应 /exit、双击 Ctrl+C、Ctrl+D） */
  const shutdown = useCallback(async () => {
    setStatus({ text: "正在退出…", tone: "info" });
    for (const slot of slots.current.values()) {
      if (slot.ref) await slot.adapter.close(slot.ref).catch(() => {});
    }
    process.exit(0);
  }, []);

  const configureModel = useCallback(
    async (target: ProviderName, slot: AgentSlot, model: ModelOption) => {
      if (!slot.ref || !isModelConfigurable(slot.adapter)) {
        throw new Error(`${target} 不支持 /model`);
      }
      await slot.adapter.setModel(slot.ref, model.id);
      const key = slot.adapter.provider;
      const existing = session.meta.providerSessions[key] ?? { provider: key };
      session.setProviderSession(key, {
        ...existing,
        provider: key,
        providerSessionId: existing.providerSessionId ?? slot.ref.providerSessionId,
        model: model.id === "default" ? undefined : model.id,
      });
      setStatus({ text: `${target} model: ${model.label}（从下一 turn 生效）`, tone: "info" });
      bump();
    },
    [bump],
  );

  const executeCommand = useCallback(
    async (name: "provider" | "model" | "exit", argument: string) => {
      if (name === "exit") {
        await shutdown();
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
      const slot = await ensureAgent(target);
      if (!slot.ref || !isModelConfigurable(slot.adapter)) throw new Error(`${target} 不支持 /model`);
      const models = await slot.adapter.listModels(slot.ref);
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
              await configureModel(target, slot, model);
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
      await configureModel(target, slot, model);
    },
    [agent, configureModel, ensureAgent, shutdown],
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
      let slot: AgentSlot | undefined;
      let startedTurn = false;
      try {
        slot = await ensureAgent(target);
        if (!slot.ref) throw new Error(`${target} 启动失败`);
        if (slot.busy) throw new Error(`${target} 仍在运行，请切换 provider 或等待当前 turn 结束`);
        slot.busy = true;
        startedTurn = true;
        bump();

        // 跨会话 @bs_ 引用 + 同会话跨 agent 自动补课，两类上下文都在发送时注入
        const { prompt } = expandMentions(store, trimmed, settings.mentionBudgetChars);
        const catchUp = buildCatchUpContext(session, slot.adapter.provider, settings.mentionBudgetChars);
        const finalPrompt = catchUp ? `<baton-sync>\n${catchUp}\n</baton-sync>\n\n${prompt}` : prompt;

        const turnId = newId("t");
        await slot.adapter.prompt(
          slot.ref,
          [{ type: "text", text: finalPrompt }],
          (ev) => {
            const envelope = session.append(ev);
            applyEvent(view.current, envelope as Parameters<typeof applyEvent>[1]);
            bump();
          },
          { turnId },
        );
        session.summarizeTurn(turnId);
        if (slot.adapter instanceof ClaudeAdapter) {
          const nativeId = slot.adapter.nativeSessionId(slot.ref);
          if (nativeId) {
            session.setProviderSession(slot.adapter.provider, {
              ...session.meta.providerSessions[slot.adapter.provider],
              provider: slot.adapter.provider,
              providerSessionId: nativeId,
            });
          }
        }
      } catch (err) {
        setStatus({ text: err instanceof Error ? err.message : String(err), tone: "error" });
      } finally {
        if (slot && startedTurn) slot.busy = false;
        bump();
      }
    },
    [agent, ensureAgent, bump, executeCommand, resetComposer],
  );

  const runningProviders = [...slots.current.entries()]
    .filter(([, slot]) => slot.busy)
    .map(([provider]) => provider);
  const selectedSlot = slots.current.get(agent);
  const selectedBusy = selectedSlot?.busy ?? false;
  const selectedModel =
    selectedSlot?.ref && isModelConfigurable(selectedSlot.adapter)
      ? (selectedSlot.adapter.currentModel(selectedSlot.ref) ?? "default")
      : "default";

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") {
      // TUI 惯例：Ctrl+C 是"打断"不是"退出"——跑着中断、有输入清空、空闲二次确认
      const action = ctrlCAction({ busy: runningProviders.length > 0, hasDraft: draft !== "", armedAt: ctrlCArmedAt.current, now: Date.now() });
      if (action === "cancel-turn") cancelRunningTurn();
      else if (action === "clear-draft") {
        setDraft("");
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
    if (candidates.length > 0) {
      // 候选浮层：↑/↓ 选择，Tab 补全（Enter 保留"发送"语义），Esc 关闭
      if (key.name === "down") setSuggIdx((i) => (i + 1) % candidates.length);
      else if (key.name === "up") setSuggIdx((i) => (i - 1 + candidates.length) % candidates.length);
      else if (key.name === "tab" && trigger) {
        const chosen = candidates[sel];
        if (chosen) {
          setDraft(applyCompletion(draft, trigger, chosen));
          setSuggIdx(0);
        }
      } else if (key.name === "escape") setSuggDismissed(true);
      return;
    }
    if (key.name === "escape" && runningProviders.length > 0) cancelRunningTurn();
  });

  const v = view.current;
  const usageLine = `in:${v.usage.inputTokens} out:${v.usage.outputTokens}`;

  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      <scrollbox style={{ flexGrow: 1, paddingLeft: 1, paddingRight: 1 }} stickyScroll stickyStart="bottom" focused={false}>
        <text fg="#565f89">
          {`baton · session ${session.id}\n直接输入发给当前 provider；/provider 切换，/model 选模型，@bs_xxx 引用其它会话\n`}
        </text>
        {v.timeline.map((item) => {
          if (item.type === "message") {
            const msg = v.messages.get(item.id);
            if (!msg) return null;
            if (msg.role === "thought") {
              // 思考过程：dim 展示中间推理（settings.showThoughts 可关）
              if (!settings.showThoughts) return null;
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
            const body = msg.role === "user" ? textOf(msg.content).replace(/<baton-(context|sync)>[\s\S]*<\/baton-\1>\s*/g, "") : textOf(msg.content);
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

      <box
        title={`provider:${agent} · model:${selectedModel}${selectedBusy ? " · running" : ""}`}
        border
        borderColor={selectedBusy ? "#e0af68" : "#3b4261"}
        style={{ height: 3 }}
      >
        <input
          key={composerVersion}
          focused={!approval && !picker}
          value={draft}
          placeholder={`发给 ${agent}（/ 命令，@ 引用）`}
          onInput={(v: string) => {
            setDraft(v);
            setSuggDismissed(false);
            setSuggIdx(0);
          }}
          onSubmit={(val: string | object) => {
            if (typeof val === "string") void send(val);
          }}
        />
      </box>
      {candidates.length > 0 && (
        <box
          border
          borderColor="#3b4261"
          title="候选 (Tab 补全 · ↑↓ 选择 · Esc 关闭)"
          style={{ position: "absolute", left: 2, bottom: 4, width: 60, height: candidates.length + 2, zIndex: 150, flexDirection: "column" }}
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
          {status?.text ?? `${usageLine}  turns:${v.turnSummaries.length}  cwd:${cwd}`}
        </text>
      </box>

      {picker && !approval && (
        <box
          title={picker.title}
          border
          borderColor="#7aa2f7"
          style={{ position: "absolute", left: 4, top: 2, width: 72, height: Math.min(18, picker.options.length * 2 + 2), zIndex: 190, flexDirection: "column" }}
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
          style={{ position: "absolute", left: 4, top: 2, width: 72, height: 10, zIndex: 200, flexDirection: "column" }}
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
// Ctrl+C 自己接管（分层语义，见 keys.ts），不走 renderer 的直接退出
const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30 });
createRoot(renderer).render(<App />);
