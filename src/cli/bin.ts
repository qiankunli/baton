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

用法:
  baton [--cwd <dir>] [-c|--continue] [-s|--session <id>]
                        启动聊天 TUI；默认新建 BatonSession，-c 继续当前目录
                        最近会话，-s 打开指定会话；/provider 切换 provider
  baton repl [--agent codex|claude] [--cwd <dir>]   headless REPL
  baton sessions        列出会话（可在输入里用 @<id> 引用）
  baton version         显示版本（也支持 --version / -V）
  baton help            本帮助

配置:
  ~/.baton/config.yaml      首次运行自动生成；defaultAgent / claudeExecutable /
                            codexCommand / mentionBudgetChars / showThoughts
  BATON_CLAUDE_BIN          环境变量，优先级高于 config.yaml 的 claudeExecutable
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
        console.log("(还没有会话，先跑 baton 或 baton repl)");
        break;
      }
      for (const m of sessions) {
        const providers = Object.keys(m.providerSessions).join(",") || "-";
        console.log(`@${m.batonSessionId}  [${providers}]  ${m.title ?? ""}  (${m.createdAt})`);
      }
      break;
    }
    default:
      console.error(`未知命令: ${command}\n`);
      console.log(HELP);
      process.exit(1);
  }
}
