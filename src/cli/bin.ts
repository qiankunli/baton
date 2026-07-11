#!/usr/bin/env bun
// baton 统一命令入口（bun link 后全局可用）：
//   baton            交互式 TUI（默认）
//   baton tui        同上
//   baton repl       headless REPL（--agent codex|claude）
//   baton resume     继续 BatonSession（无参 = cwd 最近一个，同 -c）
//   baton fork       fork BatonSession 并进入新会话
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
  baton resume [bs_xxx] resume a BatonSession in the TUI; without an id continues
                        the latest session in the cwd (starts fresh if none)
  baton fork [bs_xxx]   fork a BatonSession (full-history copy, fresh provider
                        sessions) and open the fork; defaults to the latest in cwd
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

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

/** 子命令后的首个位置参数（跳过 flag 及其值），如 `baton fork bs_xxx --cwd /x` 的 bs_xxx */
function positionalAfterCommand(): string | undefined {
  const flagsWithValue = new Set(["--cwd", "--root", "--session", "-s"]);
  for (let i = 3; i < process.argv.length; i++) {
    const token = process.argv[i] as string;
    if (token.startsWith("-")) {
      if (flagsWithValue.has(token)) i++;
      continue;
    }
    return token;
  }
  return undefined;
}

async function run(command: string): Promise<void> {
  switch (command) {
    case "repl":
      await import("./main.ts");
      break;
    // resume/fork 都转译成 TUI 入口已支持的 flags 再进 TUI，
    // 打开语义（锁、crash recovery）统一收在 openBatonSession，不在这里分叉
    case "resume": {
      const id = positionalAfterCommand();
      process.argv.push(...(id ? ["--session", id] : ["--continue"]));
      await import("../tui/main.tsx");
      break;
    }
    case "fork": {
      const store = new SessionStore(argValue("--root"));
      const cwd = argValue("--cwd") ?? process.cwd();
      const sourceId = positionalAfterCommand() ?? store.listSessions({ cwd })[0]?.batonSessionId;
      if (!sourceId) {
        console.error(`no baton session to fork in ${cwd} (run baton first, or pass a session id)`);
        process.exit(1);
      }
      let childId: string;
      try {
        childId = store.forkSession(sourceId).id;
        console.log(`forked ${sourceId} → ${childId}`);
      } catch (err) {
        console.error(err instanceof Error ? err.message : String(err));
        process.exit(1);
      }
      // fork 本身是纯存储操作：无 TTY（管道/CI）时创建成功即成功退出，
      // 不能先落盘再因 TUI 起不来 exit 1——重试会制造一堆多余的 fork
      if (!process.stdout.isTTY) {
        console.log(`open it with: baton resume ${childId}`);
        break;
      }
      process.argv.push("--session", childId);
      await import("../tui/main.tsx");
      break;
    }
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
