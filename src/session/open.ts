import {
  DeliveryAttempts,
  type HarnessDeliveryAttemptState,
} from "../controller/attempt.ts";
import type { AnyEventEnvelope, EventEnvelope } from "../event/types.ts";
import { reduceEvents } from "../store/reduce.ts";
import type { SessionHandle, SessionStore } from "../store/store.ts";

export interface OpenBatonSessionOptions {
  cwd: string;
  sessionId?: string;
  continueLast?: boolean;
  title?: string;
}

export interface OpenBatonSessionResult {
  session: SessionHandle;
  resumed: boolean;
  /** true 表示本次打开修复了上个进程留下的中断残留（半截 turn / 悬挂审批）。 */
  recovered: boolean;
}

export const CRASH_RECOVERY_NOTICE_TITLE =
  "Previous baton process exited before this turn completed";

/**
 * BatonSession 的唯一打开策略，供 CLI 与 TUI 会话切换共同复用。
 * 打开即独占（会话锁）+ 归一化（crash recovery）：任何入口拿到的会话保证终态干净、
 * 每个 turn 都有 summary。recovery 的核心价值不在 UI 状态（busy 来自 controller），
 * 而在 catch-up 与 @ 引用只读 turn-summary——没有 summary 的半截 turn
 * 对后续 harness 同步是永久盲区。
 */
export function openBatonSession(
  store: SessionStore,
  opts: OpenBatonSessionOptions,
): OpenBatonSessionResult {
  if (opts.sessionId && opts.continueLast) {
    throw new Error("--session and --continue cannot be used together");
  }
  const resolved = resolveSession(store, opts);
  // 锁必须先于 recovery：见 recoverInterruptedState 的前提说明
  resolved.session.acquireLock();
  try {
    return { ...resolved, recovered: recoverInterruptedState(resolved.session) };
  } catch (err) {
    // recovery 失败不能把锁留在一个仍存活的进程名下（pid 探活会一直判"在用"），
    // 释放后原样上抛，让调用方看到真实错误
    resolved.session.releaseLock();
    throw err;
  }
}

function resolveSession(
  store: SessionStore,
  opts: OpenBatonSessionOptions,
): { session: SessionHandle; resumed: boolean } {
  if (opts.sessionId) {
    return { session: store.openSession(opts.sessionId), resumed: true };
  }
  if (opts.continueLast) {
    const latest = store.listSessions({ cwd: opts.cwd })[0];
    if (latest) {
      return { session: store.openSession(latest.batonSessionId), resumed: true };
    }
  }
  return {
    session: store.createSession({ cwd: opts.cwd, title: opts.title }),
    resumed: false,
  };
}

/**
 * 崩溃残留归一化。前提：调用方已持有会话锁——否则"最后事件是 running"可能是
 * 另一个活进程正在执行，合成终态会污染活会话。
 * 收口顺序与 controller.finalize 一致（终态 → notice → summary），三类残留：
 * 悬挂审批 → resolved(cancelled)；每个未收口的 turn（driven/observed 并发崩溃时
 * 可能不止一个）→ 各补 idle(cancelled) + 中断 notice；缺 summary 的 turn
 * （含 fork 从运行中源会话复制来的半截 turn）→ 补 summary。
 */
function recoverInterruptedState(session: SessionHandle): boolean {
  const events = session.readEvents();
  if (events.length === 0) return false;
  const state = reduceEvents(events);
  const recoveredAttempt = recoverDeliveryAttempts(session, events);

  const summarized = new Set<string>();
  for (const ev of events) {
    if (ev.kind === "_baton_turn_summary") summarized.add(ev.payload.turnId);
  }
  const unsummarized: string[] = [];
  for (const ev of events) {
    if (ev.kind === "_baton_turn_summary" || !ev.turnId) continue;
    if (!summarized.has(ev.turnId) && !unsummarized.includes(ev.turnId)) unsummarized.push(ev.turnId);
  }

  const interruptedTurns = [...state.activeTurns.keys()];
  if (
    interruptedTurns.length === 0 &&
    unsummarized.length === 0 &&
    ![...state.interactions.values()].some((interaction) => !interaction.resolution)
  ) {
    return recoveredAttempt;
  }

  for (const [interactionId, interaction] of state.interactions) {
    if (interaction.resolution) continue;
    const opened = events.findLast(
      (event) =>
        event.kind === "interaction.opened" &&
        event.payload.interactionId === interactionId,
    );
    session.append({
      kind: "interaction.resolved",
      source: { type: "baton" },
      harness: opened?.harness ?? "baton",
      ...(opened?.harnessTargetId ? { harnessTargetId: opened.harnessTargetId } : {}),
      ...(interaction.turnId ? { turnId: interaction.turnId } : {}),
      payload: {
        interactionId,
        resolution: { kind: "cancelled", reason: "recovery" },
      },
    });
  }
  // 每个未收口的 turn 各补一份终态 + 中断标记（并发崩溃不止一个；恒带 turnId，
  // 让 per-turn reducer 精确收口，不误清并发 turn）
  for (const turnId of interruptedTurns) {
    const latest = events.findLast((ev) => ev.turnId === turnId);
    const harness = latest?.harness || "baton";
    const harnessTargetId = latest?.harnessTargetId;
    session.append({
      kind: "state_update",
      source: { type: "baton" },
      harness,
      ...(harnessTargetId ? { harnessTargetId } : {}),
      turnId,
      payload: { state: "idle", stopReason: "cancelled" },
    });
    session.append({
      kind: "_baton_notice",
      source: { type: "baton" },
      harness,
      ...(harnessTargetId ? { harnessTargetId } : {}),
      turnId,
      payload: { level: "warning", title: CRASH_RECOVERY_NOTICE_TITLE },
    });
  }
  for (const turnId of unsummarized) session.summarizeTurnEvent(turnId);
  return true;
}

/**
 * 打开期只做能从已有事实证明的收敛：
 * - prepared 从未进入 dispatching，可确认 not_accepted；
 * - Harness idle 是权威终态 Receipt，可 final；
 * - dispatching/accepted 但无 Harness 终态时只能标 uncertain，不能猜失败后重投。
 */
function recoverDeliveryAttempts(
  session: SessionHandle,
  events: AnyEventEnvelope[],
): boolean {
  const attempts = new DeliveryAttempts<SessionHandle>(
    (handle, event) =>
      handle.append({
        ...event,
        source: { type: "baton" },
      }) as EventEnvelope<"_baton_delivery_attempt_update">,
    events,
  );
  let changed = false;
  for (const attempt of attempts.values()) {
    if (attempt.phase === "finalized") continue;
    const terminal = findLaterHarnessTerminal(events, attempt);
    if (terminal) {
      attempts.observeTerminal(session, terminal);
      changed = true;
      continue;
    }
    if (attempt.phase === "prepared") {
      attempts.finalize(session, attempt, "not_accepted", {
        detail: "Baton exited before dispatch began",
      });
      changed = true;
      continue;
    }
    if (attempt.phase !== "uncertain") {
      attempts.markUncertain(
        session,
        attempt,
        "Baton exited before Harness delivery could be reconciled",
      );
      changed = true;
    }
  }
  return changed;
}

function findLaterHarnessTerminal(
  events: AnyEventEnvelope[],
  attempt: HarnessDeliveryAttemptState,
): EventEnvelope<"state_update"> | undefined {
  for (let index = events.length - 1; index >= 0; index--) {
    const event = events[index] as AnyEventEnvelope;
    if (event.seq <= attempt.preparedSeq) break;
    if (
      event.kind === "state_update" &&
      event.turnId === attempt.turnId &&
      event.source.type === "harness" &&
      event.payload.state === "idle"
    ) {
      return event;
    }
  }
  return undefined;
}
