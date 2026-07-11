#!/usr/bin/env bun
// chat-first TUI：打开即聊天，体验对齐 claude/codex CLI。
// UI 层来自 chat-tui（github.com/qiankunli/chat-tui）：ChatShell 消费视图快照、回传 intents；
// baton 侧只有 BatonChatProtocol（runtime/store → 视图投影 + intents → runtime 操作）。
//   - 直接输入 → 发给当前 agent（默认 codex）
//   - /provider 选择输入目标；/model 配置当前 provider 后续 turn 的模型
//   - 切换 agent 时自动注入对方最新进展（buildCatchUpContext），无需手动搬运上下文
//   - @bs_xxx 引用其它 baton 会话；@ 不承担 provider 路由
// 用法：baton [--root <batonRoot>] [--cwd <dir>] [-c|--continue] [-s|--session <id>]

import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { ChatShell } from "chat-tui";

import { ensureConfigFile, loadConfig } from "../config/config.ts";
import { openBatonSession } from "../session/open.ts";
import { SessionStore } from "../store/store.ts";
import { BatonChatProtocol, CHAT_COMMANDS } from "./protocol.ts";
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
const opened = openBatonSession(store, {
  cwd: requestedCwd,
  sessionId: argValueAny("--session", "-s"),
  continueLast: hasArg("--continue", "-c"),
  title: `chat @ ${requestedCwd}`,
});

if (!process.stdout.isTTY) {
  console.error("baton tui requires a real terminal (TTY)");
  process.exit(1);
}
let renderer: Awaited<ReturnType<typeof createCliRenderer>> | undefined;
const protocol = new BatonChatProtocol(store, config, opened, () => {
  // OpenTUI owns raw mode and mouse tracking; restore both before process.exit,
  // whose forced exit does not run OpenTUI's beforeExit cleanup handler.
  renderer?.destroy();
  process.exit(0);
});
// Ctrl+C 由 ChatShell 接管（分层语义），不走 renderer 的直接退出。
// autoFocus=false：禁止鼠标点击把焦点从输入框抢走——点击 scrollbox 夺焦不触发 React
// 重渲染，focused prop 拉不回来，这是"操作久了输入框失焦"的主因。
renderer = await createCliRenderer({ exitOnCtrlC: false, targetFps: 30, autoFocus: false });
createRoot(renderer).render(
  <ChatShell
    protocol={protocol}
    commands={CHAT_COMMANDS}
    mentions={protocol.mentionCandidates}
    theme={batonTheme}
  />,
);
