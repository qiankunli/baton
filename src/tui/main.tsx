#!/usr/bin/env bun
// chat-first TUI：打开即聊天，体验对齐 claude/codex CLI。
// UI 层来自 chat-tui（github.com/qiankunli/chat-tui）：ChatShell 消费视图快照、回传 intents；
// baton 侧只有 BatonChatProtocol（runtime/store → 视图投影 + intents → runtime 操作）。
//   - 直接输入 → 发给当前 agent（默认 codex）
//   - /codex、/claude 直接选择输入目标；/model、/effort 分别配置后续 turn
//   - 切换 agent 时自动注入对方最新进展（buildCatchUpContext），无需手动搬运上下文
//   - @bs_xxx 引用其它 baton 会话；@ 不承担 harness 路由
// 用法：baton [--root <batonRoot>] [--cwd <dir>] [-c|--continue] [-s|--session <id>]
//       [--pick-session resume|fork]（bin.ts 内部 flag：先展示前置会话选择屏，选中才打开）

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { ChatShell } from "chat-tui";

import { ensureConfigFile, loadConfig } from "../config/config.ts";
import { openBatonSession, type OpenBatonSessionResult } from "../session/open.ts";
import { SessionStore } from "../store/store.ts";
import { BatonChatProtocol, CHAT_COMMANDS } from "./protocol.ts";
import { SessionPickerScreen } from "./session-picker.tsx";
import { batonTheme } from "./theme.ts";

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
const projectSessions = store.listSessions({ cwd: requestedCwd });

if (!process.stdout.isTTY) {
  console.error("baton tui requires a real terminal (TTY)");
  process.exit(1);
}

const pickArg = argValue("--pick-session");
const pickIntent = pickArg === "resume" || pickArg === "fork" ? pickArg : undefined;
// fork 无源可选是硬错误（对齐直通路径的提示），在 renderer 起来前干净地退出
if (pickIntent === "fork" && projectSessions.length === 0) {
  console.error(`no baton session to fork in ${requestedCwd} (run baton first, or pass a session id)`);
  process.exit(1);
}

// pick 模式推迟打开：选中哪个才锁哪个；其余入口保持"先开会话再起 renderer"，
// 打开失败（锁冲突等）在 raw mode 之前报错
const openedAtStartup: OpenBatonSessionResult | undefined = pickIntent
  ? undefined
  : openBatonSession(store, {
      cwd: requestedCwd,
      sessionId: argValueAny("--session", "-s"),
      continueLast: hasArg("--continue", "-c"),
    });

// Ctrl+C 由 ChatShell 接管（分层语义），不走 renderer 的直接退出。
// autoFocus=false：禁止鼠标点击把焦点从输入框抢走——点击 scrollbox 夺焦不触发 React
// 重渲染，focused prop 拉不回来，这是"操作久了输入框失焦"的主因。
const renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30, autoFocus: false });
// OpenTUI 默认透明背景不会擦除变空的 cell，滚动/重排后会残留上一帧字符。
renderer.setBackgroundColor(batonTheme.overlayBackground ?? "#24283b");
const root = createRoot(renderer);
const quit = (sessionId?: string) => {
  // OpenTUI owns raw mode and mouse tracking; restore both before process.exit,
  // whose forced exit does not run OpenTUI's beforeExit cleanup handler.
  renderer.destroy();
  if (sessionId) {
    console.log(`\nResume this session with:\nbaton resume ${sessionId}\n\nFork this session with:\nbaton fork ${sessionId}`);
  }
  process.exit(0);
};

function startChat(opened: OpenBatonSessionResult): void {
  const protocol = new BatonChatProtocol(store, config, opened, quit);
  root.render(
    <ChatShell
      protocol={protocol}
      commands={CHAT_COMMANDS}
      mentions={protocol.mentionCandidates}
      theme={batonTheme}
    />,
  );
}

function startFresh(): void {
  startChat(openBatonSession(store, { cwd: requestedCwd }));
}

if (openedAtStartup) {
  startChat(openedAtStartup);
} else if (projectSessions.length === 0) {
  startFresh(); // resume 无历史会话：与老的 --continue 语义一致，直接新开
} else {
  // session picker：Enter 打开 / fork，Esc/Ctrl+C 取消退出；打开失败回显错误并停留在列表。
  // 新会话只走显式入口，避免 Esc 误触把用户带到空 transcript。
  const intent = pickIntent as "resume" | "fork";
  const showPicker = (error?: string): void =>
    root.render(
      <SessionPickerScreen
        title={intent === "fork" ? "Fork a previous session" : "Resume a previous session"}
        actionLabel={intent}
        sessions={projectSessions}
        theme={batonTheme}
        error={error}
        onPick={(batonSessionId) => {
          try {
            if (intent === "fork") {
              // fork 落盘发生在选中之后：选错 / Esc 不产生副本。
              // cwd 用启动 baton 时的目录，picker 也只展示该 project 的源会话。
              const child = store.forkSession(batonSessionId, { cwd: requestedCwd });
              startChat(openBatonSession(store, { cwd: requestedCwd, sessionId: child.id }));
            } else {
              startChat(openBatonSession(store, { cwd: requestedCwd, sessionId: batonSessionId }));
            }
          } catch (err) {
            showPicker(err instanceof Error ? err.message : String(err));
          }
        }}
        onExit={quit}
      />,
    );
  showPicker();
}
