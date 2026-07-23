import { newId } from "../event/ids.ts";
import type { PromptBlock } from "../event/types.ts";
import type { HarnessTarget } from "../harness/target.ts";

/**
 * 一条用户输入的生命周期状态（kernel.md §6 · user-input-lifecycle.md §1）。让 recall /
 * interrupt / steer / race 的迁移成为对同一 Input 的状态查询，而不是散落在 submit /
 * steer / Esc 里的时序特判。
 */
export type InputStatus =
  | "queued"
  | "admitted"
  | "accepted_steer"
  | "finalized"
  | "recalled"
  | "interrupted";

/**
 * 一条输入的 controller 生命周期记录。身份即 `messageId`：durable 形态是事件流里的
 * `user_message`，live 形态就是这条记录，不另造平行身份。
 */
export interface InputRecord {
  messageId: string;
  /** 队列内展示排序用的自增号；与身份无关。 */
  id: number;
  /** baton turn id：入队时即分配，steer 的 expectedTurnId 引用它。 */
  turnId: string;
  target: HarnessTarget;
  blocks: PromptBlock[];
  status: InputStatus;
  delivery: "prompt" | "steer";
  /** queued/admitted 专属：submit 的回执通道；accepted_steer 无。 */
  resolve?: (outcome: SubmitOutcome) => void;
  reject?: (error: unknown) => void;
}

export interface QueuedTurnSnapshot {
  id: number;
  turnId: string;
  harnessTargetId: string;
  harness: string;
  blocks: PromptBlock[];
}

/** Input 只读快照：投影 / 诊断消费 status，不触碰内部 resolve/reject。 */
export interface InputSnapshot {
  messageId: string;
  turnId: string;
  harnessTargetId: string;
  harness: string;
  status: InputStatus;
  delivery: "prompt" | "steer";
}

export type SubmitOutcome = "completed" | "recalled";

/**
 * Input 的内存 owner：只管理待 admission 的队列、输入身份与队列状态迁移。
 * 是否开始 drain、如何执行 turn 仍由 Controller 编排。
 */
export class InputQueue {
  private readonly queue: InputRecord[] = [];
  private nextId = 1;

  get length(): number {
    return this.queue.length;
  }

  get queued(): readonly InputRecord[] {
    return this.queue;
  }

  get snapshots(): QueuedTurnSnapshot[] {
    return this.queue.map(queuedTurnSnapshot);
  }

  enqueue(target: HarnessTarget, blocks: PromptBlock[]): Promise<SubmitOutcome> {
    return new Promise((resolve, reject) => {
      this.queue.push({
        id: this.nextId++,
        turnId: newId("t"),
        messageId: newId("m"),
        target,
        blocks,
        status: "queued",
        delivery: "prompt",
        resolve,
        reject,
      });
    });
  }

  dequeue(): InputRecord | undefined {
    const input = this.queue.shift();
    if (input) input.status = "admitted";
    return input;
  }

  acceptSteer(
    target: HarnessTarget,
    turnId: string,
    messageId: string,
    blocks: PromptBlock[],
  ): InputRecord {
    return {
      id: this.nextId++,
      turnId,
      messageId,
      target,
      blocks,
      status: "accepted_steer",
      delivery: "steer",
    };
  }

  recallLatest(): QueuedTurnSnapshot | undefined {
    const input = this.queue.pop();
    if (!input) return undefined;
    input.status = "recalled";
    input.resolve?.("recalled");
    return queuedTurnSnapshot(input);
  }
}

export function inputSnapshot(input: InputRecord): InputSnapshot {
  return {
    messageId: input.messageId,
    turnId: input.turnId,
    harnessTargetId: input.target.id,
    harness: input.target.harness,
    status: input.status,
    delivery: input.delivery,
  };
}

function queuedTurnSnapshot(input: InputRecord): QueuedTurnSnapshot {
  return {
    id: input.id,
    turnId: input.turnId,
    harnessTargetId: input.target.id,
    harness: input.target.harness,
    blocks: [...input.blocks],
  };
}
