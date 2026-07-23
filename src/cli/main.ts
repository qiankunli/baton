#!/usr/bin/env bun
// headless REPL：无 TUI 先跑通链路——终端里与 codex / claude 对话，全部事件落 session.jsonl。
// 用法：bun src/cli/main.ts [--agent codex|claude] [--cwd <dir>] [--root <batonRoot>]
// claude 可执行文件用 BATON_CLAUDE_BIN 覆盖（如公司包装器 reclaude）。

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";

import {
  isNativeSessionIdentifiable,
  type InteractionHandler,
} from "../adapters/types.ts";
import { ensureConfigFile, loadConfig } from "../config/config.ts";
import { expandMentions } from "../context/mention.ts";
import { newId } from "../event/ids.ts";
import { createHarnessAdapter, defaultHarnessTarget, parseHarness } from "../harness/registry.ts";
import { createHarnessLaunchSnapshot } from "../harness/target.ts";
import type {
  InteractionDraft,
  InteractionResolution,
} from "../interaction/types.ts";
import { SessionStore, sessionDisplayTitle } from "../store/store.ts";

function argValue(flag: string): string | undefined {
  const i = process.argv.indexOf(flag);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

const rl = createInterface({ input: stdin, output: stdout });

// headless REPL 的 Interaction resolution：按 kind 渲染并返回严格配对的结果。
async function resolveInteraction(interaction: InteractionDraft): Promise<InteractionResolution> {
  if (interaction.kind === "permission") {
    stdout.write(`\n⚠ ${interaction.title}\n`);
    interaction.options.forEach((o, i) => stdout.write(`  ${i + 1}. ${o.name} [${o.optionId}]\n`));
    for (;;) {
      const answer = (await rl.question("approve> ")).trim();
      const byIndex = interaction.options[Number(answer) - 1];
      const byId = interaction.options.find((o) => o.optionId === answer);
      const chosen = byId ?? byIndex;
      if (chosen) return { kind: "permission", outcome: "selected", optionId: chosen.optionId };
      stdout.write("Enter an option number or optionId\n");
    }
  }
  if (interaction.kind === "hook_trust") {
    stdout.write(
      `\n⚠ Trust ${interaction.hooks.length} ${interaction.harnessName} hook${interaction.hooks.length === 1 ? "" : "s"}?\n`,
    );
    interaction.hooks.forEach((hook) => {
      stdout.write(`  - ${hook.pluginId ?? hook.source}: ${hook.sourcePath} [${hook.trustStatus}]\n`);
    });
    for (;;) {
      const answer = (await rl.question("trust current definitions? [y/N] ")).trim().toLowerCase();
      if (answer === "y" || answer === "yes") {
        return { kind: "hook_trust", outcome: "trusted" };
      }
      if (!answer || answer === "n" || answer === "no") {
        return { kind: "hook_trust", outcome: "skipped" };
      }
    }
  }
  const answers: Record<string, string[]> = {};
  for (const question of interaction.questions) {
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
  return { kind: "question", outcome: "answered", answers };
}

async function main(): Promise<void> {
  const rootArg = argValue("--root");
  ensureConfigFile(rootArg);
  const config = loadConfig(rootArg);
  const requested = argValue("--agent") ?? config.defaultAgent;
  // registry 全路径接管：不再手写 harness 分支（未知值以前静默落到 codex，现在显式报错）
  const agentName = parseHarness(requested);
  if (!agentName) {
    stdout.write(`unknown agent: ${requested}\n`);
    process.exit(1);
  }
  const cwd = argValue("--cwd") ?? process.cwd();
  const store = new SessionStore(rootArg);
  const session = store.createSession({ cwd });
  stdout.write(`baton session: ${session.id}\nlog: ${session.dir}/session.jsonl\n`);

  const target = defaultHarnessTarget(agentName);
  let adapterHarness = target.harness;
  const interactionHandler: InteractionHandler = async (draft, context) => {
    const interaction = {
      ...draft,
      interactionId: newId("ix"),
      requester: { type: "harness" as const, harnessTargetId: target.id },
    };
    session.append({
      kind: "interaction.opened",
      source: { type: "harness", harnessTargetId: target.id },
      harness: adapterHarness,
      harnessTargetId: target.id,
      ...(context?.turnId ? { turnId: context.turnId } : {}),
      ...(context?.raw !== undefined ? { raw: context.raw } : {}),
      payload: interaction,
    });
    const resolution = await resolveInteraction(draft);
    session.append({
      kind: "interaction.resolved",
      source: { type: "user" },
      harness: adapterHarness,
      harnessTargetId: target.id,
      ...(context?.turnId ? { turnId: context.turnId } : {}),
      payload: { interactionId: interaction.interactionId, resolution },
    });
    return resolution;
  };
  const adapter = createHarnessAdapter(target, {
    interactionHandler,
    diagnostic: (entry) => session.diagnostic(entry),
    config,
    rootDir: store.rootDir,
  });
  adapterHarness = adapter.harness;
  const launchSnapshot = createHarnessLaunchSnapshot({
    target,
    harnessSessionKey: adapter.harness,
    cwd,
  });
  session.setHarnessSession(target.id, {
    harnessTargetId: target.id,
    harness: adapter.harness,
    launchSnapshot,
  });

  // open 时绑定 session 级 sink；turn 完成以 idle 终态事件为准（design §4.1）
  let sawOutput = false;
  let turnDone: (() => void) | undefined;
  const ref = await adapter.open({ cwd }, (ev) => {
    session.append({
      ...ev,
      source: { type: "harness", harnessTargetId: target.id },
      harnessTargetId: target.id,
    });
    if (ev.kind === "agent_message_chunk" && ev.payload.content.type === "text") {
      if (!sawOutput) {
        stdout.write(`${adapter.harness}> `);
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
  session.setHarnessSession(target.id, {
    ...session.meta.harnessSessions[target.id],
    harnessTargetId: target.id,
    harness: adapter.harness,
    launchSnapshot,
    harnessSessionId: ref.harnessSessionId,
  });
  stdout.write(`${adapter.harness} session: ${ref.harnessSessionId}\nType to chat, /exit to quit\n\n`);

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
    // 用户输入的 owner 是驱动方（与 Controller 同责，design §4.1）：
    // user_message/running 由 REPL 落盘，adapter 只报告执行过程与终态
    session.append({
      kind: "user_message",
      source: { type: "user" },
      harness: adapter.harness,
      harnessTargetId: target.id,
      turnId,
      payload: { messageId, content: [{ type: "text", text: prompt }] },
    });
    session.append({
      kind: "state_update",
      source: { type: "baton" },
      harness: adapter.harness,
      harnessTargetId: target.id,
      turnId,
      payload: { state: "running" },
    });
    try {
      // submit 只确认接收；进展与终结经 open 时绑定的 sink 上报
      await adapter.submit(ref, { turnId, messageId, blocks: [{ type: "text", text: prompt }] });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      stdout.write(`\nerror: ${message}\n`);
      // user_message 已落盘：admission 失败也要有结局，不留无终态的半状态
      session.append({
        kind: "_baton_error_update",
        source: { type: "baton" },
        harness: adapter.harness,
        harnessTargetId: target.id,
        turnId,
        payload: { message, retryable: false },
      });
      session.append({
        kind: "state_update",
        source: { type: "baton" },
        harness: adapter.harness,
        harnessTargetId: target.id,
        turnId,
        payload: { state: "idle", stopReason: "error" },
      });
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
        session.setHarnessSession(target.id, {
          ...session.meta.harnessSessions[target.id],
          harnessTargetId: target.id,
          harness: adapter.harness,
          launchSnapshot,
          harnessSessionId: nativeId,
        });
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
