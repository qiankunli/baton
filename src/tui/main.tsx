#!/usr/bin/env bun
// chat-first TUI：打开即聊天，体验对齐 claude/codex CLI。
//   - 直接输入 → 发给当前 agent（默认 codex）
//   - 消息以 @codex / @claude 开头 → 切换 agent 并发送；两个 agent 共用同一条时间线
//   - 切换 agent 时自动注入对方最新进展（buildCatchUpContext），无需手动搬运上下文
//   - @bs_xxx 引用其它 baton 会话（baton sessions 可查）；Esc 中断当前 turn；Ctrl+C 退出
// 用法：baton（或 bun src/tui/main.tsx）[--root <batonRoot>] [--cwd <dir>]

import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard } from "@opentui/react";
import { useCallback, useRef, useState, type ReactNode } from "react";

import { ClaudeAdapter } from "../adapters/claude/adapter.ts";
import { CodexAdapter } from "../adapters/codex/adapter.ts";
import type { AgentAdapter, ProviderSessionRef } from "../adapters/types.ts";
import { buildCatchUpContext, expandMentions } from "../context/mention.ts";
import { newId } from "../events/ids.ts";
import type { PermissionRequest } from "../events/types.ts";
import { textOf } from "../events/types.ts";
import { applyEvent, emptySessionState, type SessionState } from "../store/reduce.ts";
import { SessionStore } from "../store/store.ts";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const store = new SessionStore(argValue("--root"));
const cwd = argValue("--cwd") ?? process.cwd();
// 打开即建会话——不要让用户先面对空 rail 和弹窗
const session = store.createSession({ cwd, title: `chat @ ${cwd}` });

type AgentName = "codex" | "claude";
const AGENT_PREFIX = /^@(codex|claude)\b\s*/;
const PROVIDER_LABEL: Record<string, string> = { codex: "codex", "claude-code": "claude" };

interface AgentSlot {
  adapter: AgentAdapter;
  ref?: ProviderSessionRef;
  starting?: Promise<void>;
}

interface PendingApproval {
  request: PermissionRequest;
  resolve: (d: { optionId: string }) => void;
}

function App(): ReactNode {
  const slots = useRef(new Map<AgentName, AgentSlot>());
  const view = useRef<SessionState>(emptySessionState());
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);

  const [agent, setAgent] = useState<AgentName>("codex");
  const [draft, setDraft] = useState("");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);
  const [approval, setApproval] = useState<PendingApproval | null>(null);

  const approvalHandler = useCallback(
    (request: PermissionRequest) =>
      new Promise<{ optionId: string }>((resolve) => setApproval({ request, resolve })),
    [],
  );

  const ensureAgent = useCallback(
    async (name: AgentName): Promise<AgentSlot> => {
      let slot = slots.current.get(name);
      if (!slot) {
        const adapter: AgentAdapter =
          name === "claude" ? new ClaudeAdapter({ approvalHandler }) : new CodexAdapter({ approvalHandler });
        slot = { adapter };
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
        setStatus(`starting ${name}…`);
        bump();
        await slot.starting;
        slot.starting = undefined;
        setStatus(null);
      }
      return slot;
    },
    [approvalHandler, bump],
  );

  const send = useCallback(
    async (raw: string) => {
      const trimmed = raw.trim();
      if (!trimmed || busy) return;

      // @codex / @claude 前缀：切换目标 agent（并从消息里剥掉）
      let target = agent;
      let text = trimmed;
      const m = AGENT_PREFIX.exec(trimmed);
      if (m) {
        target = m[1] as AgentName;
        text = trimmed.slice(m[0].length).trim();
        setAgent(target);
        if (!text) {
          setDraft("");
          return; // 只切 agent 不发消息
        }
      }

      setDraft("");
      setBusy(true);
      setStatus(null);
      try {
        const slot = await ensureAgent(target);
        if (!slot.ref) throw new Error(`${target} 启动失败`);

        // 跨会话 @bs_ 引用 + 同会话跨 agent 自动补课，两类上下文都在发送时注入
        const { prompt } = expandMentions(store, text);
        const catchUp = buildCatchUpContext(session, slot.adapter.provider);
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
              provider: slot.adapter.provider,
              providerSessionId: nativeId,
            });
          }
        }
      } catch (err) {
        setStatus(err instanceof Error ? err.message : String(err));
      } finally {
        setBusy(false);
        bump();
      }
    },
    [agent, busy, ensureAgent, bump],
  );

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") process.exit(0);
    if (key.name === "escape" && busy) {
      const slot = slots.current.get(agent);
      if (slot?.ref) void slot.adapter.cancel(slot.ref);
    }
  });

  const v = view.current;
  const usageLine = `in:${v.usage.inputTokens} out:${v.usage.outputTokens}`;

  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      <scrollbox style={{ flexGrow: 1, paddingLeft: 1, paddingRight: 1 }} stickyScroll stickyStart="bottom" focused={false}>
        <text fg="#565f89">
          {`baton · session ${session.id}\n直接输入发给当前 agent；@codex / @claude 切换；@bs_xxx 引用其它会话（baton sessions 查看）\n`}
        </text>
        {v.timeline.map((item) => {
          if (item.type === "message") {
            const msg = v.messages.get(item.id);
            if (!msg) return null;
            if (msg.role === "thought") return null; // 思考流不进主时间线，保持清爽
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
            return <text key={item.id} fg="#e0af68">{`  ${mark} ${tc.title ?? item.id}`}</text>;
          }
          return null;
        })}
        {busy && <text fg="#565f89">{`\n${agent} 思考中… (Esc 中断)`}</text>}
      </scrollbox>

      <box title={`@${agent}${busy ? " · running" : ""}`} border borderColor={busy ? "#e0af68" : "#3b4261"} style={{ height: 3 }}>
        <input
          focused={!approval}
          value={draft}
          placeholder={`发给 ${agent}（@codex/@claude 切换 agent）`}
          onInput={setDraft}
          onSubmit={(val: string | object) => {
            if (typeof val === "string") void send(val);
          }}
        />
      </box>
      <box style={{ height: 1 }}>
        <text fg={status ? "#f7768e" : "#565f89"}>{status ?? `${usageLine}  turns:${v.turnSummaries.length}  cwd:${cwd}`}</text>
      </box>

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
                setApproval(null);
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
const renderer = await createCliRenderer({ exitOnCtrlC: true, targetFps: 30 });
createRoot(renderer).render(<App />);
