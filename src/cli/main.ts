#!/usr/bin/env bun
// headless REPL：无 TUI 先跑通链路——终端里与 codex / claude 对话，全部事件落 session.jsonl。
// 用法：bun src/cli/main.ts [--agent codex|claude] [--cwd <dir>] [--root <batonRoot>]
// claude 可执行文件用 BATON_CLAUDE_BIN 覆盖（如公司包装器 reclaude）。

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import { isNativeSessionIdentifiable } from "../adapters/types.ts";
import type { InteractionResponse } from "../adapters/types.ts";
import { ensureConfigFile, loadConfig } from "../config/config.ts";
import { expandMentions } from "../context/mention.ts";
import { newId } from "../events/ids.ts";
import type { InteractionRequest } from "../events/types.ts";
import { createProviderAdapter, parseProvider } from "../providers/registry.ts";
import { SessionStore, sessionDisplayTitle } from "../store/store.ts";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const rl = createInterface({ input: stdin, output: stdout });

// 统一的 request 应答（headless REPL）：按 kind 分派，返回 kind 配对的 InteractionResponse。
async function askRequest(req: InteractionRequest): Promise<InteractionResponse> {
  if (req.kind === "permission") {
    stdout.write(`\n⚠ ${req.title}\n`);
    req.options.forEach((o, i) => stdout.write(`  ${i + 1}. ${o.name} [${o.optionId}]\n`));
    for (;;) {
      const answer = (await rl.question("approve> ")).trim();
      const byIndex = req.options[Number(answer) - 1];
      const byId = req.options.find((o) => o.optionId === answer);
      const chosen = byId ?? byIndex;
      if (chosen) return { kind: "permission", requestId: req.requestId, optionId: chosen.optionId };
      stdout.write("Enter an option number or optionId\n");
    }
  }
  if (req.kind === "hook_trust") {
    stdout.write(`\n⚠ Trust ${req.hooks.length} ${req.providerName} hook${req.hooks.length === 1 ? "" : "s"}?\n`);
    req.hooks.forEach((hook) => {
      stdout.write(`  - ${hook.pluginId ?? hook.source}: ${hook.sourcePath} [${hook.trustStatus}]\n`);
    });
    for (;;) {
      const answer = (await rl.question("trust current definitions? [y/N] ")).trim().toLowerCase();
      if (answer === "y" || answer === "yes") {
        return { kind: "hook_trust", requestId: req.requestId, decision: "trust" };
      }
      if (!answer || answer === "n" || answer === "no") {
        return { kind: "hook_trust", requestId: req.requestId, decision: "skip" };
      }
    }
  }
  const answers: Record<string, string[]> = {};
  for (const question of req.questions) {
    stdout.write(`\n? ${question.header}: ${question.question}\n`);
    question.options?.forEach((option, index) =>
      stdout.write(`  ${index + 1}. ${option.label} — ${option.description}\n`),
    );
    const suffix = question.multiSelect ? " (comma-separated choices)" : "";
    const answer = (await rl.question(`answer${suffix}> `)).trim();
    const values = question.multiSelect ? answer.split(",").map((value) => value.trim()).filter(Boolean) : [answer];
    answers[question.questionId] = values.map((value) => {
      const option = question.options?.[Number(value) - 1];
      return option?.label ?? value;
    });
  }
  return { kind: "question", requestId: req.requestId, answers };
}

async function main(): Promise<void> {
  const rootArg = argValue("--root");
  ensureConfigFile(rootArg);
  const config = loadConfig(rootArg);
  const requested = argValue("--agent") ?? config.defaultAgent;
  // registry 全路径接管：不再手写 provider 分支（未知值以前静默落到 codex，现在显式报错）
  const agentName = parseProvider(requested);
  if (!agentName) {
    stdout.write(`unknown agent: ${requested}\n`);
    process.exit(1);
  }
  const cwd = argValue("--cwd") ?? process.cwd();
  const store = new SessionStore(rootArg);
  const session = store.createSession({ cwd });
  stdout.write(`baton session: ${session.id}\nlog: ${session.dir}/session.jsonl\n`);

  const adapter = createProviderAdapter(agentName, {
    requestHandler: askRequest,
    diagnostic: (entry) => session.diagnostic(entry),
    config,
    rootDir: store.rootDir,
  });

  // open 时绑定 session 级 sink；turn 完成以 idle 终态事件为准（design §4.1）
  let sawOutput = false;
  let turnDone: (() => void) | undefined;
  const ref = await adapter.open({ cwd }, (ev) => {
    session.append(ev);
    if (ev.kind === "agent_message_chunk" && ev.payload.content.type === "text") {
      if (!sawOutput) {
        stdout.write(`${adapter.provider}> `);
        sawOutput = true;
      }
      stdout.write((ev.payload.content as { text: string }).text);
    } else if (ev.kind === "tool_call_update" && ev.payload.title) {
      stdout.write(`\n[tool:${ev.payload.status ?? ""}] ${ev.payload.title}\n`);
    } else if (ev.kind === "_baton_error_update") {
      stdout.write(`\nerror: ${ev.payload.message}\n`);
    }
    if (ev.kind === "state_update" && ev.payload.state === "idle") turnDone?.();
  });
  session.setProviderSession(adapter.provider, { provider: adapter.provider, providerSessionId: ref.providerSessionId });
  stdout.write(`${adapter.provider} session: ${ref.providerSessionId}\nType to chat, /exit to quit\n\n`);

  for (;;) {
    const line = (await rl.question("you> ")).trim();
    if (!line) continue;
    if (line === "/exit") break;
    if (line === "/sessions") {
      for (const m of store.listSessions({ cwd })) {
        stdout.write(`  @${m.batonSessionId}  ${sessionDisplayTitle(m)}\n`);
      }
      continue;
    }

    // @bs_xxx 急切展开：把被引用会话的紧凑摘要拼进 prompt（design §5.6）
    session.setPreviewIfEmpty(line);
    const { prompt, mentions } = expandMentions(store, line, config.mentionBudgetChars);
    if (mentions.length) stdout.write(`(injected context summaries from ${mentions.length} session(s))\n`);

    const turnId = newId("t");
    const messageId = newId("m");
    sawOutput = false;
    const done = new Promise<void>((resolve) => {
      turnDone = resolve;
    });
    // 用户输入的 owner 是驱动方（与 BatonSessionRuntime 同责，design §4.1）：
    // user_message/running 由 REPL 落盘，adapter 只报告执行过程与终态
    session.append({
      kind: "user_message",
      provider: adapter.provider,
      turnId,
      payload: { messageId, content: [{ type: "text", text: prompt }] },
    });
    session.append({ kind: "state_update", provider: adapter.provider, turnId, payload: { state: "running" } });
    try {
      // submit 只确认接收；进展与终结经 open 时绑定的 sink 上报
      await adapter.submit(ref, { turnId, messageId, blocks: [{ type: "text", text: prompt }] });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stdout.write(`\nerror: ${message}\n`);
      // user_message 已落盘：admission 失败也要有结局，不留无终态的半状态
      session.append({ kind: "_baton_error_update", provider: adapter.provider, turnId, payload: { message, retryable: false } });
      session.append({ kind: "state_update", provider: adapter.provider, turnId, payload: { state: "idle", stopReason: "error" } });
      continue;
    }
    await done;
    turnDone = undefined;
    const summary = session.summarizeTurn(turnId);
    // 原生 session id 可能首轮结束才拿得到（claude），回填 meta 以支持将来 resume；
    // 按能力接口判定而不是 instanceof——registry 接管后 CLI 不再 import 具体 adapter
    if (isNativeSessionIdentifiable(adapter)) {
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
