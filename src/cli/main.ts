#!/usr/bin/env bun
// headless REPL：无 TUI 先跑通链路——终端里与 codex / claude 对话，全部事件落 session.jsonl。
// 用法：bun src/cli/main.ts [--agent codex|claude] [--cwd <dir>] [--root <batonRoot>]
// claude 可执行文件用 BATON_CLAUDE_BIN 覆盖（如公司包装器 reclaude）。

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { ClaudeAdapter } from "../adapters/claude/adapter.ts";
import { CodexAdapter } from "../adapters/codex/adapter.ts";
import type { AgentAdapter } from "../adapters/types.ts";
import { ensureConfigFile, loadConfig } from "../config/config.ts";
import { expandMentions } from "../context/mention.ts";
import { newId } from "../events/ids.ts";
import type { PermissionRequest } from "../events/types.ts";
import { SessionStore } from "../store/store.ts";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const rl = createInterface({ input: stdin, output: stdout });

async function askApproval(req: PermissionRequest): Promise<{ optionId: string }> {
  stdout.write(`\n⚠ ${req.title}\n`);
  req.options.forEach((o, i) => stdout.write(`  ${i + 1}. ${o.name} [${o.optionId}]\n`));
  for (;;) {
    const answer = (await rl.question("approve> ")).trim();
    const byIndex = req.options[Number(answer) - 1];
    const byId = req.options.find((o) => o.optionId === answer);
    const chosen = byId ?? byIndex;
    if (chosen) return { optionId: chosen.optionId };
    stdout.write("输入序号或 optionId\n");
  }
}

async function main(): Promise<void> {
  const rootArg = argValue("--root");
  ensureConfigFile(rootArg);
  const config = loadConfig(rootArg);
  const agentName = argValue("--agent") ?? config.defaultAgent;
  const cwd = argValue("--cwd") ?? process.cwd();
  const store = new SessionStore(rootArg);
  const session = store.createSession({ cwd, title: `${agentName} @ ${cwd}` });
  stdout.write(`baton session: ${session.id}\nlog: ${session.dir}/session.jsonl\n`);

  const adapter: AgentAdapter =
    agentName === "claude"
      ? new ClaudeAdapter({ approvalHandler: askApproval, executablePath: config.claudeExecutable })
      : new CodexAdapter({ approvalHandler: askApproval, command: config.codexCommand });
  const ref = await adapter.start({ cwd });
  session.setProviderSession(adapter.provider, { provider: adapter.provider, providerSessionId: ref.providerSessionId });
  stdout.write(`${adapter.provider} session: ${ref.providerSessionId}\n输入内容开始对话，/exit 退出\n\n`);

  for (;;) {
    const line = (await rl.question("you> ")).trim();
    if (!line) continue;
    if (line === "/exit") break;
    if (line === "/sessions") {
      for (const m of store.listSessions()) {
        stdout.write(`  @${m.batonSessionId}  ${m.title ?? ""}\n`);
      }
      continue;
    }

    // @bs_xxx 急切展开：把被引用会话的紧凑摘要拼进 prompt（design §5.6）
    const { prompt, mentions } = expandMentions(store, line, config.mentionBudgetChars);
    if (mentions.length) stdout.write(`(已注入 ${mentions.length} 个会话的上下文摘要)\n`);

    const turnId = newId("t");
    let sawOutput = false;
    try {
      await adapter.prompt(
        ref,
        [{ type: "text", text: prompt }],
        (ev) => {
          session.append(ev);
          if (ev.kind === "agent_message_chunk" && ev.payload.content.type === "text") {
            if (!sawOutput) {
              stdout.write(`${adapter.provider}> `);
              sawOutput = true;
            }
            stdout.write((ev.payload.content as { text: string }).text);
          } else if (ev.kind === "tool_call_update" && ev.payload.title) {
            stdout.write(`\n[tool:${ev.payload.status ?? ""}] ${ev.payload.title}\n`);
          }
        },
        { turnId },
      );
    } catch (err) {
      stdout.write(`\nerror: ${err instanceof Error ? err.message : String(err)}\n`);
      continue;
    }
    const summary = session.summarizeTurn(turnId);
    // Claude 的原生 session id 首轮结束才拿得到，回填 meta 以支持将来 resume
    if (adapter instanceof ClaudeAdapter) {
      const nativeId = adapter.nativeSessionId(ref);
      if (nativeId) {
        session.setProviderSession(adapter.provider, { provider: adapter.provider, providerSessionId: nativeId });
      }
    }
    stdout.write(`\n— turn done (${summary.stopReason ?? "?"}, in:${summary.usage?.inputTokens ?? 0} out:${summary.usage?.outputTokens ?? 0})\n\n`);
  }

  await adapter.close(ref);
  rl.close();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
