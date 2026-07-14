// 契约测试：capability descriptor 与可选能力接口必须一致（design §4.4）。
// 声明了 marker 就必须实现对应接口；反过来，接口尚未落地的能力不允许提前声明——
// descriptor 是给 runtime/UI 消费的事实，不是路线图。

import type { RequestHandler } from "../src/adapters/types.ts";
import { describe, expect, test } from "bun:test";

import { ClaudeAdapter } from "../src/adapters/claude/adapter.ts";
import { CodexAdapter } from "../src/adapters/codex/adapter.ts";
import type { AgentAdapter } from "../src/adapters/types.ts";

const requestHandler: RequestHandler = async (req) =>
  req.kind === "permission"
    ? { kind: "permission", requestId: req.requestId, optionId: "allow" }
    : { kind: "question", requestId: req.requestId, answers: {} };

const adapters: AgentAdapter[] = [
  new ClaudeAdapter({ requestHandler }),
  new CodexAdapter({ requestHandler }),
];

/**
 * capability path → 声明支持时 adapter 必须存在的方法。
 * 新可选接口落地时在此登记（Steerable/CommandDiscoverable/SessionConfigurable/Interactive…）。
 */
const CAPABILITY_CONTRACT: Record<string, string[]> = {
  steer: ["steer"],
  // 输入映射型能力：submit 原生承载 PromptInput.syncBlocks（side-channel 注入），
  // 无独立方法可查——行为由 watermark.test / adapter-model.test 钉住
  sync: [],
  commands: ["listCommands"],
  config: ["getConfig", "setConfig"],
  approvalRouting: ["approvalRoute"],
  "interactions.permission": ["respond"],
  "interactions.question": ["respond"],
  "interactions.elicitation": ["respond"],
};

function capabilityAt(adapter: AgentAdapter, path: string): unknown {
  let node: unknown = adapter.capabilities;
  for (const key of path.split(".")) {
    if (node === undefined || node === null || typeof node !== "object") return undefined;
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

/** 收集 capabilities 里所有声明的 marker 叶子路径 */
function declaredMarkers(node: unknown, prefix = ""): string[] {
  if (node === undefined || node === null || typeof node !== "object") return [];
  const record = node as Record<string, unknown>;
  if (record.supported === true) return [prefix];
  const out: string[] = [];
  for (const [key, value] of Object.entries(record)) {
    out.push(...declaredMarkers(value, prefix ? `${prefix}.${key}` : key));
  }
  return out;
}

describe("adapter capability contract", () => {
  for (const adapter of adapters) {
    test(`${adapter.provider}: 声明的 capability 必须有对应实现`, () => {
      for (const [path, methods] of Object.entries(CAPABILITY_CONTRACT)) {
        const marker = capabilityAt(adapter, path);
        if (marker === undefined) continue;
        expect((marker as { supported?: unknown }).supported).toBe(true);
        for (const method of methods) {
          expect(
            typeof (adapter as unknown as Record<string, unknown>)[method],
            `${adapter.provider} declares "${path}" but is missing ${method}()`,
          ).toBe("function");
        }
      }
    });

    test(`${adapter.provider}: marker 叶子必须是 { supported: true }，且不声明未登记的能力`, () => {
      // prompt.* 是纯输入映射声明，没有对应方法要求，从检查中排除
      const declared = declaredMarkers(adapter.capabilities).filter((p) => !p.startsWith("prompt"));
      for (const path of declared) {
        expect(
          CAPABILITY_CONTRACT[path],
          `${adapter.provider} declares unknown capability "${path}" — register it in CAPABILITY_CONTRACT with its required methods`,
        ).toBeDefined();
      }
    });
  }
});
