#!/usr/bin/env bun
// M3 TUI（opentui/react）：左侧会话 rail、主区消息流（sticky 滚动）、底部 composer、审批模态。
// 用法：bun src/tui/main.tsx [--root <batonRoot>] [--cwd <dir>]
// 快捷键：Tab 切焦点（rail/composer）、Ctrl+N 新建会话、Ctrl+R 插入 @会话引用、Ctrl+C 退出。

import { createCliRenderer } from "@opentui/core";
import { createRoot, useKeyboard } from "@opentui/react";
import { useCallback, useRef, useState, type ReactNode } from "react";

import { ClaudeAdapter } from "../adapters/claude/adapter.ts";
import { CodexAdapter } from "../adapters/codex/adapter.ts";
import type { AgentAdapter, ProviderSessionRef } from "../adapters/types.ts";
import { expandMentions } from "../context/mention.ts";
import { newId } from "../events/ids.ts";
import type { PermissionRequest } from "../events/types.ts";
import { textOf } from "../events/types.ts";
import { applyEvent, emptySessionState, type SessionState } from "../store/reduce.ts";
import { SessionStore, type SessionHandle } from "../store/store.ts";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const store = new SessionStore(argValue("--root"));
const defaultCwd = argValue("--cwd") ?? process.cwd();

interface Runtime {
  agent: string;
  handle: SessionHandle;
  adapter: AgentAdapter;
  ref?: ProviderSessionRef;
  view: SessionState;
  busy: boolean;
}

interface PendingApproval {
  request: PermissionRequest;
  resolve: (d: { optionId: string }) => void;
}

/** 对齐 @opentui/core 的 SelectOption：description 必填 */
interface SelOpt {
  name: string;
  description: string;
  value?: unknown;
}

const AGENT_CHOICES: SelOpt[] = [
  { name: "codex", description: "OpenAI Codex (app-server)", value: "codex" },
  { name: "claude", description: "Claude Code (Agent SDK)", value: "claude" },
];

function App(): ReactNode {
  const runtimes = useRef(new Map<string, Runtime>());
  const [, setTick] = useState(0);
  const bump = useCallback(() => setTick((t) => t + 1), []);

  const [activeId, setActiveId] = useState<string | null>(null);
  const [focus, setFocus] = useState<"rail" | "composer">("composer");
  const [draft, setDraft] = useState("");
  const [approval, setApproval] = useState<PendingApproval | null>(null);
  const [newSessionOpen, setNewSessionOpen] = useState(runtimes.current.size === 0);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const approvalHandler = useCallback(
    (request: PermissionRequest) =>
      new Promise<{ optionId: string }>((resolve) => setApproval({ request, resolve })),
    [],
  );

  const createSession = useCallback(
    async (agent: string) => {
      const handle = store.createSession({ cwd: defaultCwd, title: `${agent} @ ${defaultCwd}` });
      const adapter: AgentAdapter =
        agent === "claude" ? new ClaudeAdapter({ approvalHandler }) : new CodexAdapter({ approvalHandler });
      const rt: Runtime = { agent, handle, adapter, view: emptySessionState(), busy: false };
      runtimes.current.set(handle.id, rt);
      setActiveId(handle.id);
      setFocus("composer");
      bump();
      try {
        rt.ref = await adapter.start({ cwd: defaultCwd });
        handle.setProviderSession(adapter.provider, {
          provider: adapter.provider,
          providerSessionId: rt.ref.providerSessionId,
        });
      } catch (err) {
        setError(`start ${agent} failed: ${err instanceof Error ? err.message : String(err)}`);
      }
      bump();
    },
    [approvalHandler, bump],
  );

  const send = useCallback(
    async (text: string) => {
      const trimmed = text.trim();
      if (!trimmed || !activeId) return;
      const rt = runtimes.current.get(activeId);
      if (!rt || !rt.ref || rt.busy) return;
      setDraft("");
      setError(null);
      rt.busy = true;
      const { prompt } = expandMentions(store, trimmed);
      const turnId = newId("t");
      try {
        await rt.adapter.prompt(
          rt.ref,
          [{ type: "text", text: prompt }],
          (ev) => {
            const envelope = rt.handle.append(ev);
            applyEvent(rt.view, envelope as Parameters<typeof applyEvent>[1]);
            bump();
          },
          { turnId },
        );
        rt.handle.summarizeTurn(turnId);
        if (rt.adapter instanceof ClaudeAdapter) {
          const nativeId = rt.adapter.nativeSessionId(rt.ref);
          if (nativeId) {
            rt.handle.setProviderSession(rt.adapter.provider, {
              provider: rt.adapter.provider,
              providerSessionId: nativeId,
            });
          }
        }
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
      } finally {
        rt.busy = false;
        bump();
      }
    },
    [activeId, bump],
  );

  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") process.exit(0);
    if (approval || newSessionOpen || pickerOpen) {
      if (key.name === "escape") {
        setNewSessionOpen(false);
        setPickerOpen(false);
      }
      return;
    }
    if (key.name === "tab") setFocus((f) => (f === "rail" ? "composer" : "rail"));
    if (key.ctrl && key.name === "n") setNewSessionOpen(true);
    if (key.ctrl && key.name === "r") setPickerOpen(true);
  });

  const sessionOptions: SelOpt[] = [...runtimes.current.values()].map((rt) => ({
    name: `${rt.busy ? "● " : ""}${rt.agent}: ${rt.handle.meta.title ?? rt.handle.id}`,
    description: rt.handle.id,
    value: rt.handle.id,
  }));
  const active = activeId ? runtimes.current.get(activeId) : undefined;
  const view = active?.view;

  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      <box style={{ flexDirection: "row", flexGrow: 1 }}>
        <box
          title="sessions (^N new)"
          border
          style={{ flexBasis: 32, flexShrink: 0, flexDirection: "column" }}
        >
          <select
            focused={focus === "rail" && !approval && !newSessionOpen && !pickerOpen}
            options={sessionOptions}
            onSelect={(_i: number, opt: SelOpt | null) => {
              if (opt) {
                setActiveId(String(opt.value));
                setFocus("composer");
              }
            }}
          />
        </box>
        <box style={{ flexGrow: 1, flexDirection: "column" }}>
          <scrollbox style={{ flexGrow: 1 }} stickyScroll stickyStart="bottom">
            {view ? (
              view.timeline.map((item) => {
                if (item.type === "message") {
                  const msg = view.messages.get(item.id);
                  if (!msg) return null;
                  const label = msg.role === "user" ? "you" : msg.role === "thought" ? "…" : active?.agent;
                  const color = msg.role === "user" ? "#7aa2f7" : msg.role === "thought" ? "#565f89" : "#9ece6a";
                  return (
                    <text key={item.id}>
                      <span fg={color}>{`${label}> `}</span>
                      {textOf(msg.content)}
                    </text>
                  );
                }
                if (item.type === "tool_call") {
                  const tc = view.toolCalls.get(item.id);
                  if (!tc) return null;
                  const mark = tc.status === "completed" ? "✓" : tc.status === "failed" ? "✗" : "⋯";
                  return <text key={item.id} fg="#e0af68">{`  ${mark} [${tc.kind ?? "tool"}] ${tc.title ?? item.id}`}</text>;
                }
                return null;
              })
            ) : (
              <text fg="#565f89">Ctrl+N 新建会话开始；Ctrl+R 引用其它会话；Tab 切换焦点</text>
            )}
          </scrollbox>
          <box title={active ? `${active.agent}${active.busy ? " (running)" : ""}` : "composer"} border style={{ height: 3 }}>
            <input
              focused={focus === "composer" && !approval && !newSessionOpen && !pickerOpen}
              value={draft}
              placeholder="输入消息，@bs_xxx 引用其它会话…"
              onInput={setDraft}
              onSubmit={(v: string | object) => {
                if (typeof v === "string") void send(v);
              }}
            />
          </box>
        </box>
      </box>
      <box style={{ height: 1, flexDirection: "row" }}>
        <text fg={error ? "#f7768e" : "#565f89"}>
          {error ??
            (view
              ? `state:${view.runState}  tokens in:${view.usage.inputTokens} out:${view.usage.outputTokens}  turns:${view.turnSummaries.length}`
              : "baton")}
        </text>
      </box>

      {newSessionOpen && (
        <box
          title="new session"
          border
          style={{ position: "absolute", left: 10, top: 4, width: 44, height: 6, zIndex: 100 }}
        >
          <select
            focused
            options={AGENT_CHOICES}
            onSelect={(_i: number, opt: SelOpt | null) => {
              setNewSessionOpen(false);
              if (opt) void createSession(String(opt.value));
            }}
          />
        </box>
      )}

      {pickerOpen && (
        <box
          title="引用哪个会话？"
          border
          style={{ position: "absolute", left: 10, top: 4, width: 60, height: 8, zIndex: 100 }}
        >
          <select
            focused
            options={sessionOptions}
            onSelect={(_i: number, opt: SelOpt | null) => {
              setPickerOpen(false);
              if (opt) setDraft((d) => `${d}@${String(opt.value)} `);
              setFocus("composer");
            }}
          />
        </box>
      )}

      {approval && (
        <box
          title="approval required"
          border
          borderColor="#e0af68"
          style={{ position: "absolute", left: 6, top: 3, width: 70, height: 9, zIndex: 200 }}
        >
          <text>{approval.request.title}</text>
          <select
            focused
            options={approval.request.options.map(
              (o): SelOpt => ({ name: o.name, description: o.kind, value: o.optionId }),
            )}
            onSelect={(_i: number, opt: SelOpt | null) => {
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
