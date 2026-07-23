import type { StopReason } from "../event/types.ts";
import type { InputRecord, InputStatus } from "./input.ts";

type TurnRole = "driven" | "observed";

interface TurnBinding {
  adapter: { harness: string };
  target: { id: string };
}

/**
 * 一个 turn 从进入执行到逻辑终结的一等状态。所有终态按 turnId 查表路由，
 * status 保证重复、迟到或未知终态不会二次终结。
 */
export interface TurnRecord<TBinding extends TurnBinding> {
  turnId: string;
  role: TurnRole;
  binding: TBinding;
  harness: string;
  harnessTargetId: string;
  status: "active" | "finalized";
  startedAt: number;
  stopReason?: StopReason;
  /** driven 专属：admitted 输入；finalize 后释放。 */
  turn?: InputRecord;
  /** driven 专属：本 turn 已接受的 steer；finalize 后释放。 */
  steers?: InputRecord[];
  /** driven 专属：finalize 时释放 drain 循环。 */
  release?: () => void;
  cancelGraceTimer?: ReturnType<typeof setTimeout>;
}

/**
 * Turn 的内存 owner。它只维护台账、当前 driven 指针和幂等状态；Event 顺序、
 * Session 持久化与 Harness 调用仍由 Controller 负责。
 */
export class TurnLedger<TBinding extends TurnBinding> {
  private readonly records = new Map<string, TurnRecord<TBinding>>();
  private activeDrivenTurnId?: string;

  values(): IterableIterator<TurnRecord<TBinding>> {
    return this.records.values();
  }

  get(turnId: string): TurnRecord<TBinding> | undefined {
    return this.records.get(turnId);
  }

  activeDriven(): TurnRecord<TBinding> | undefined {
    if (!this.activeDrivenTurnId) return undefined;
    const record = this.records.get(this.activeDrivenTurnId);
    return record?.status === "active" ? record : undefined;
  }

  admitDriven(
    binding: TBinding,
    turnId: string,
    input?: InputRecord,
  ): { record: TurnRecord<TBinding>; released: Promise<void> } {
    let release!: () => void;
    const released = new Promise<void>((resolve) => {
      release = resolve;
    });
    const record: TurnRecord<TBinding> = {
      turnId,
      role: "driven",
      binding,
      harness: binding.adapter.harness,
      harnessTargetId: binding.target.id,
      status: "active",
      startedAt: Date.now(),
      turn: input,
      steers: [],
      release,
    };
    this.records.set(turnId, record);
    this.activeDrivenTurnId = turnId;
    return { record, released };
  }

  observe(binding: TBinding, turnId: string): void {
    if (this.records.has(turnId)) return;
    this.records.set(turnId, {
      turnId,
      role: "observed",
      binding,
      harness: binding.adapter.harness,
      harnessTargetId: binding.target.id,
      status: "active",
      startedAt: Date.now(),
    });
  }

  beginFinalization(
    turnId: string,
    stopReason: StopReason | undefined,
  ): TurnRecord<TBinding> | undefined {
    const record = this.records.get(turnId);
    if (!record || record.status === "finalized") return undefined;
    record.status = "finalized";
    record.stopReason = stopReason;
    return record;
  }

  finish(record: TurnRecord<TBinding>, stopReason: StopReason | undefined): void {
    const inputTerminal: InputStatus =
      record.role === "driven" && stopReason === "cancelled" ? "interrupted" : "finalized";
    if (record.turn) record.turn.status = inputTerminal;
    for (const steer of record.steers ?? []) steer.status = inputTerminal;

    if (record.role === "driven") {
      if (this.activeDrivenTurnId === record.turnId) this.activeDrivenTurnId = undefined;
      record.release?.();
    }
    this.retire(record);
  }

  /**
   * finalized 记录只保留 turnId + status 等幂等判定所需字段；PromptBlock[] 与闭包
   * 必须释放，避免长期会话的内存随 turn 数线性增长。
   */
  private retire(record: TurnRecord<TBinding>): void {
    if (record.cancelGraceTimer) clearTimeout(record.cancelGraceTimer);
    record.cancelGraceTimer = undefined;
    record.turn = undefined;
    record.steers = undefined;
    record.release = undefined;
  }
}
