// 单通道视图通知契约（kernel.md §2 不变量 #1：单通道真相——一切经
// event → append → broadcast → reduce → projection，不允许第二条投影通道）。
//
// 回归背景（PR #112）：普通流式事件曾同时走两条通知——session.append 的事件流广播
// （投影订阅）+ runtime onAdapterEvent 末尾的 changed()（onStateChange），导致每个
// streaming chunk 触发两次完整 view 重建。修复删掉了 onAdapterEvent 末尾的 changed()，
// 但这条"哪类变更走哪条通知通道"的分工只靠 runtime.ts 里的一行注释守着——任何人
// 顺手加回 changed() 就会无声复发（双重建只是性能劣化，UI 不出错，肉眼看不出来）。
// 本测试把它钉成契约：普通流式事件到达时，订阅方收到的通知恰好一次。
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import type {
  AdapterCapabilities,
  AgentAdapter,
  EventSink,
  OpenOptions,
  PromptInput,
  PromptReceipt,
  ProviderSessionRef,
} from "../src/adapters/types.ts";
import type { AnyNewEvent } from "../src/events/types.ts";
import { BatonSessionRuntime } from "../src/session/runtime.ts";
import { SessionStore, type SessionHandle } from "../src/store/store.ts";

let root: string;
let store: SessionStore;
let session: SessionHandle;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "baton-notify-"));
  store = new SessionStore(root);
  session = store.createSession({ cwd: "/repo" });
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

/**
 * submit 后挂起、由测试显式驱动事件的 fake adapter（形态参考
 * provider-initiated-turn.test.ts 的 WakingAdapter）：admission 通过即暴露
 * sink/turnId，流式事件与终态都由测试经 emit 逐个注入。
 */
class StreamingAdapter implements AgentAdapter {
  readonly provider = "claude-code";
  readonly capabilities: AdapterCapabilities = { prompt: {} };
  sink?: EventSink;
  turnId?: string;
  private admitted!: () => void;
  /** submit 已受理（sink / turnId 就绪）；测试据此开始注入流式事件 */
  readonly admission = new Promise<void>((resolve) => {
    this.admitted = resolve;
  });

  async open(_opts: OpenOptions, sink: EventSink): Promise<ProviderSessionRef> {
    this.sink = sink;
    return { provider: this.provider, providerSessionId: "streaming-ref", resumed: false };
  }

  async submit(_ref: ProviderSessionRef, input: PromptInput): Promise<PromptReceipt> {
    this.turnId = input.turnId;
    this.admitted();
    return { accepted: true };
  }

  /** 模拟 provider 在 turn 运行中经同一 sink 上报一个事件（走 runtime.onAdapterEvent） */
  emit(ev: AnyNewEvent): void {
    this.sink?.(ev);
  }

  async cancel(_ref: ProviderSessionRef): Promise<void> {}
  async close(_ref: ProviderSessionRef): Promise<void> {}
}

// ---- 契约：普通流式事件 → 恰好一次视图通知 ----
// 参数化覆盖 turn 运行中最高频的三类中间过程事件；对每一个事件断言"恰好 1"：
// 0 = 事件到不了投影（丢更新，provider-initiated-turn.test.ts 钉住的那半边）；
// 2 = append 广播之外又走了 runtime onStateChange（#112 的双重建回归，这半边归本文件）。

describe("single-channel view notification per streaming event", () => {
  const cases: Array<{ name: string; event: (turnId: string) => AnyNewEvent }> = [
    {
      name: "agent_message_chunk",
      event: (turnId) => ({
        kind: "agent_message_chunk",
        provider: "claude-code",
        turnId,
        payload: { messageId: "m_stream", content: { type: "text", text: "chunk" } },
      }),
    },
    {
      name: "agent_thought_chunk",
      event: (turnId) => ({
        kind: "agent_thought_chunk",
        provider: "claude-code",
        turnId,
        payload: { messageId: "m_thought", content: { type: "text", text: "pondering" } },
      }),
    },
    {
      name: "tool_call_update",
      event: (turnId) => ({
        kind: "tool_call_update",
        provider: "claude-code",
        turnId,
        payload: { toolCallId: "tc_1", title: "Read file", kind: "read", status: "in_progress" },
      }),
    },
  ];

  for (const c of cases) {
    test(`${c.name}: exactly one notification per event`, async () => {
      const adapter = new StreamingAdapter();
      let notifications = 0;
      const runtime = new BatonSessionRuntime({
        session,
        mentionBudgetChars: 4096,
        createAdapter: () => adapter,
        // 镜像 BatonChatProtocol 的接线：事件流订阅（subscribeSession）与 runtime 的
        // onStateChange 汇入同一个 changed()——每次调用重建一次完整 view。因此
        // 两条通道的计数之和 == 一个事件引发的 view 重建次数。
        onStateChange: () => {
          notifications += 1;
        },
      });
      const unsubscribe = session.subscribe(() => {
        notifications += 1;
      });

      const outcome = runtime.submit("claude", [{ type: "text", text: "go" }]);
      await adapter.admission;

      // 每发一个事件，通知恰好 +1（append 是同步广播，计数无需等待）
      notifications = 0;
      adapter.emit(c.event(adapter.turnId!));
      expect(notifications).toBe(1);
      adapter.emit(c.event(adapter.turnId!));
      expect(notifications).toBe(2);

      // 收口 turn，别让 pending 的 submit promise 泄漏到测试外
      adapter.emit({
        kind: "state_update",
        provider: "claude-code",
        turnId: adapter.turnId!,
        payload: { state: "idle", stopReason: "end_turn" },
      });
      await outcome;
      unsubscribe();
    });
  }
});
