#!/usr/bin/env bun
// baton 统一命令入口（bun link 后全局可用）：
//   baton            交互式 TUI（默认）
//   baton tui        同上
//   baton repl       headless REPL（--agent codex|claude）
//   baton sessions   列出本机 baton 会话
//   baton help       帮助

import { SessionStore } from "../store/store.ts";

const HELP = `baton — terminal-native shared workspace for coding agents

用法:
  baton                 启动 TUI（^N 新会话，^R 插入 @会话引用，Tab 切焦点）
  baton repl [--agent codex|claude] [--cwd <dir>]   headless REPL
  baton sessions        列出会话（可在输入里用 @<id> 引用）
  baton help            本帮助

环境变量:
  BATON_CLAUDE_BIN      claude 可执行文件路径（如公司包装器 reclaude）
`;

const cmd = process.argv[2];

switch (cmd) {
  case undefined:
  case "tui":
    await import("../tui/main.tsx");
    break;
  case "repl":
    await import("./main.ts");
    break;
  case "sessions": {
    const store = new SessionStore();
    const sessions = store.listSessions();
    if (sessions.length === 0) {
      console.log("(还没有会话，先跑 baton 或 baton repl)");
      break;
    }
    for (const m of sessions) {
      const providers = Object.keys(m.providerSessions).join(",") || "-";
      console.log(`@${m.batonSessionId}  [${providers}]  ${m.title ?? ""}  (${m.createdAt})`);
    }
    break;
  }
  case "help":
  case "--help":
  case "-h":
    console.log(HELP);
    break;
  default:
    console.error(`未知命令: ${cmd}\n`);
    console.log(HELP);
    process.exit(1);
}
