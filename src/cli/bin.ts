#!/usr/bin/env bun
// baton 统一命令入口（bun link 后全局可用）：
//   baton            交互式 TUI（默认）
//   baton tui        同上
//   baton repl       headless REPL（--agent codex|claude）
//   baton sessions   列出本机 baton 会话
//   baton version    显示版本
//   baton help       帮助

import packageJson from "../../package.json" with { type: "json" };

import { SessionStore } from "../store/store.ts";

const HELP = `baton — one durable terminal session across coding-agent providers

Usage:
  baton [--cwd <dir>] [-c|--continue] [-s|--session <id>]
                        start the chat TUI; creates a new BatonSession by default,
                        -c continues the latest session in the cwd, -s opens a
                        specific session; /provider switches provider
  baton repl [--agent codex|claude] [--cwd <dir>]   headless REPL
  baton sessions        list sessions (reference with @<id> in the input)
  baton version         show version (also --version / -V)
  baton help            this help

Config:
  ~/.baton/config.yaml      generated on first run; defaultAgent / claudeExecutable /
                            codexCommand / mentionBudgetChars / showThoughts
  BATON_CLAUDE_BIN          env var, takes precedence over claudeExecutable in config.yaml
`;

const cmd = process.argv[2];

switch (cmd) {
  case "version":
  case "--version":
  case "-V":
    console.log(`baton ${packageJson.version}`);
    process.exit(0);
  case "help":
  case "--help":
  case "-h":
    console.log(HELP);
    process.exit(0);
}

// 无子命令或直接跟 flag（如 baton --cwd x）都进 TUI；
// 注意不能在 import 后 exit——TUI 靠事件循环常驻
if (cmd === undefined || cmd === "tui" || cmd.startsWith("-")) {
  await import("../tui/main.tsx");
} else {
  await run(cmd);
}

async function run(command: string): Promise<void> {
  switch (command) {
    case "repl":
      await import("./main.ts");
      break;
    case "sessions": {
      const store = new SessionStore();
      const sessions = store.listSessions();
      if (sessions.length === 0) {
        console.log("(no sessions yet — run baton or baton repl first)");
        break;
      }
      for (const m of sessions) {
        const providers = Object.keys(m.providerSessions).join(",") || "-";
        console.log(`@${m.batonSessionId}  [${providers}]  ${m.title ?? ""}  (${m.createdAt})`);
      }
      break;
    }
    default:
      console.error(`Unknown command: ${command}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
