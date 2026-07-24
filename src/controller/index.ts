import {
  isContextSynchronizable,
  isContextCompactable,
  isSteerable,
  type HarnessAdapter,
  type ApprovalRoute,
  type EffortOption,
  type InteractionContext,
  type InteractionHandler,
  type ModelOption,
  type SteerReceipt,
} from "../adapters/types.ts";
import { buildTargetCatchUpContext } from "../context/mention.ts";
import type { DiagnosticSink } from "../diagnostics.ts";
import { diagnosticError } from "../diagnostics.ts";
import { newId } from "../event/ids.ts";
import {
  type AnyEventDraft,
  type AnyEventEnvelope,
  type AnyNewEvent,
  type EventEnvelope,
  type EventSource,
  type PromptBlock,
  type StopReason,
} from "../event/types.ts";
import { HarnessBinding } from "../harness/binding.ts";
import type { HarnessTarget } from "../harness/target.ts";
import type {
  InteractionDraft,
  InteractionResolution,
} from "../interaction/types.ts";
import type { SessionHandle } from "../store/store.ts";
import { DeliveryAttempts } from "./attempt.ts";
import {
  InputQueue,
  inputSnapshot,
  type InputRecord,
  type InputSnapshot,
  type QueuedTurnSnapshot,
  type SubmitOutcome,
} from "./input.ts";
import { InteractionWaiters } from "./interaction.ts";
import { TurnLedger, type TurnRecord } from "./turn.ts";

export type {
  InputSnapshot,
  InputStatus,
  QueuedTurnSnapshot,
  SubmitOutcome,
} from "./input.ts";

/**
 * Control：与 Input / Interaction resolution 并列的第三种用户信号
 * （见 user-input-lifecycle.md §1）。
 * 不携带内容、不到达 model——是对 turn **生命周期**的命令，必须 out-of-band 够到正在跑的
 * turn（不进 queue，否则会排在它要打断的 turn 后面而死锁）。当前唯一 kind 是 `interrupt`
 * （Esc）；pause / abort-bash / shutdown 等作为新 kind 加入时按 kernel §5 演进。
 */
export type Control = { kind: "interrupt" };

/**
 * steer 请求的调度结果（design §3.7：requested 与 effective 分开呈现）：
 * - `steer`：已注入当前 turn 的下一个安全边界，不产生新 turn；
 * - `follow_up`：不可 steer 或 harness 拒绝，已显式降级入队；outcome 与 submit
 *   的回执同语义（turn 完成/被撤回时 resolve），UI 不得把降级结果仍标成 steer。
 */
export type SteerOutcome =
  | { effective: "steer" }
  | { effective: "follow_up"; outcome: Promise<SubmitOutcome> };

/** Controller 注入给 Adapter 的宿主能力；Interaction 必须经可信边界打开。 */
export interface InteractionHandlers {
  interactionHandler: InteractionHandler;
  diagnostic: DiagnosticSink;
}

export interface ControllerOptions {
  session: SessionHandle;
  mentionBudgetChars: number;
  /** 新 session 未选过 model 时使用的 HarnessTarget 级持久偏好。 */
  modelPreferences?: Readonly<Record<string, string>>;
  /** 新 session 未选过 effort 时使用的 HarnessTarget 级持久偏好。 */
  effortPreferences?: Readonly<Record<string, string>>;
  /** 工厂按 target.harness 选择 Adapter，并可使用 target.id lowering 实例级配置。 */
  createAdapter(target: HarnessTarget, handlers: InteractionHandlers): HarnessAdapter;
  /** HarnessTarget identity 的唯一 owner；未知 id 必须返回 undefined，不能反推 Harness。 */
  resolveTarget(harnessTargetId: string): HarnessTarget | undefined;
  onChange?: () => void;
  /**
   * cancel 后等待 harness 确认终态的宽限期。到期仍无终态则合成 terminal error 并
   * 推进队列（design §4.1：除 cancel grace 与 transport close 外不设全局 watchdog，
   * 合法的长任务不应被误杀）。
   */
  cancelGraceMs?: number;
}

const DEFAULT_CANCEL_GRACE_MS = 10_000;

/** 打断标记文案：cancelled 终态时落一条 notice，TUI 时间线醒目提示（对齐 Codex 的体验） */
export const INTERRUPTED_NOTICE_TITLE = "Conversation interrupted — tell the agent what to do differently";

/**
 * 一个 BatonSession 的唯一 turn 编排入口：统一负责 harness 恢复、上下文追平与全局串行。
 * UI 只提交意图和消费事件（经 SessionHandle.subscribe 订阅事件流），不能分别维护
 * 各 harness 的并发状态。
 *
 * turn 分两类生命周期（docs/design.md §5.10）：
 * - driven turn：baton 发起（用户 submit），入队、全局串行、finalize 推进队列；
 * - observed turn：harness 自发（Harness 来源的 `state_update(running)` 开界），
 *   baton 不控制其开始，只划界、记账（turn summary + 同步水位），不进队列。
 *
 * 生命周期由 state event 驱动（design §4.1）：adapter.submit 只确认接收，turn 的
 * 完成以 `state_update(idle)` 为准，经 finalize 按 baton turn id 幂等收口——
 * 重复/迟到的物理终态（reconnect、transport race）不会二次终结，也不会关闭更新的 turn。
 *
 * TurnLedger：driven/observed 统一入 `turns` 台账，终态一律按 envelope.turnId 查表
 * 路由（不看 binding——按 binding 路由在同 harness driven+observed 并发时会吞掉 observed
 * 的终态）。driven ≤ 1 是**队列策略**（TurnLedger 当前指针 + drain 串行），不是
 * 台账模型假设；将来放开并行 driven 只改 drain 取件策略，台账与路由不动。
 */
export class Controller {
  private readonly bindings = new Map<string, HarnessBinding>();
  private readonly inputQueue = new InputQueue();
  private readonly turns = new TurnLedger<HarnessBinding>();
  private readonly deliveryAttempts: DeliveryAttempts<HarnessBinding>;
  private readonly interactions: InteractionWaiters<HarnessBinding>;
  private draining = false;
  /** driven 工作从 Harness setup 开始即对 UI 可见；Target 是实例坐标，Harness 仅是协议类型。 */
  private processing?: { target: HarnessTarget; startedAt: number };

  constructor(private readonly options: ControllerOptions) {
    this.deliveryAttempts = new DeliveryAttempts(
      (binding, event) =>
        this.appendEvent(binding, event, {
          type: "baton",
        }) as EventEnvelope<"_baton_delivery_attempt_update">,
      options.session.readEvents(),
    );
    this.interactions = new InteractionWaiters(
      (binding, event, source) => this.appendEvent(binding, event, source),
      () => this.changed(),
    );
  }

  /**
   * 用户解决一个未决 Interaction。先把用户事实持久化，再唤醒 Harness；没有活跃 continuation
   * 时返回 false，UI 据此提示 stale，而不是把响应写进一个无人消费的内存通道。
   */
  resolveInteraction(interactionId: string, resolution: InteractionResolution): boolean {
    return this.interactions.resolve(interactionId, resolution);
  }

  private openHarnessInteraction(
    harnessTargetId: string,
    draft: InteractionDraft,
    context?: InteractionContext,
  ): Promise<InteractionResolution> {
    const binding = this.bindings.get(harnessTargetId);
    if (!binding) return Promise.reject(new Error(`unknown harness target for interaction: ${harnessTargetId}`));
    const active = this.activeDriven();
    const turnId =
      context?.turnId ?? (active?.binding === binding ? active.turnId : binding.setupTurnId);
    return this.interactions.open(binding, draft, turnId, context);
  }

  /** 当前未终结的 driven turn 记录；无或已终结时 undefined */
  private activeDriven(): TurnRecord<HarnessBinding> | undefined {
    return this.turns.activeDriven();
  }

  /** 当前 driven turn 的具体配置目标；Harness 类型只用于选择 Adapter。 */
  get activeHarnessTargetId(): string | undefined {
    return this.processing?.target.id ?? this.activeDriven()?.harnessTargetId;
  }

  /** 当前 driven turn 的 baton turn id；TUI 据此做 per-turn 投影（运行阶段等） */
  get activeTurnId(): string | undefined {
    return this.activeDriven()?.turnId;
  }

  /** 当前 turn 的起跑时刻（epoch ms）；elapsed 跳秒由 TUI 组件自理，这里只给起点 */
  get activeStartedAt(): number | undefined {
    return this.processing?.startedAt ?? this.activeDriven()?.startedAt;
  }

  get queueLength(): number {
    return this.inputQueue.length;
  }

  get queuedTurns(): QueuedTurnSnapshot[] {
    return this.inputQueue.snapshots;
  }

  /**
   * 所有**在世** Input 的只读快照：排队中的 follow-up + 当前 turn 的 admitted 输入 +
   * 已接受的 steer。终态输入（finalized/recalled/interrupted）不驻内存——其历史在事件流里
   * （`user_message`），与 turn 台账瘦身同一取舍。投影 / 诊断据此看到每条输入的 messageId 与消费状态。
   */
  get inputs(): InputSnapshot[] {
    const out: InputSnapshot[] = [];
    for (const input of this.inputQueue.queued) out.push(inputSnapshot(input));
    for (const record of this.turns.values()) {
      if (record.status !== "active") continue;
      if (record.turn) out.push(inputSnapshot(record.turn));
      for (const steer of record.steers ?? []) out.push(inputSnapshot(steer));
    }
    return out;
  }

  get isBusy(): boolean {
    return this.draining;
  }

  submit(harnessTargetId: string, blocks: PromptBlock[]): Promise<SubmitOutcome> {
    const target = this.targetFor(harnessTargetId);
    const outcome = this.inputQueue.enqueue(target, blocks);
    this.changed();
    void this.drain();
    return outcome;
  }

  /**
   * 当前输入能否 steer 到活跃 turn：有未终结的 driven turn、harness 匹配、
   * adapter 声明并实现了 steer。UI 据此决定 busy 时的默认 delivery 与选项展示。
   * observed turn（harness 自发）不接受 steer——baton 不拥有其生命周期。
   */
  canSteer(harnessTargetId: string): boolean {
    const active = this.activeDriven();
    if (!active?.turn) return false;
    if (active.turn.target.id !== harnessTargetId) return false;
    if (!active.binding.ref) return false;
    return (
      Boolean(active.binding.adapter.capabilities.steer) &&
      isSteerable(active.binding.adapter)
    );
  }

  /**
   * 把输入注入当前 turn 的下一个安全边界（design §4.3）。不可 steer、harness 拒绝
   * （expectedTurnId 过期 / review turn）或 wire 故障时，一律显式降级为 follow-up
   * 入队——永不静默丢失输入，也不把降级结果伪装成 steer（effective 如实上报）。
   */
  async steer(harnessTargetId: string, blocks: PromptBlock[]): Promise<SteerOutcome> {
    const active = this.activeDriven();
    if (!active || !this.canSteer(harnessTargetId) || !active.binding.ref) {
      return { effective: "follow_up", outcome: this.submit(harnessTargetId, blocks) };
    }
    const activeInput = active.turn;
    if (!activeInput) {
      return { effective: "follow_up", outcome: this.submit(harnessTargetId, blocks) };
    }
    const adapter = active.binding.adapter;
    if (!isSteerable(adapter)) {
      return { effective: "follow_up", outcome: this.submit(harnessTargetId, blocks) };
    }
    const target = activeInput.target;
    const messageId = newId("m");
    let receipt: SteerReceipt;
    try {
      receipt = await adapter.steer(
        active.binding.ref,
        // steer 消息归属被注入的 turn；messageId 照常由 controller 分配（design §4.10.1）
        { turnId: active.turnId, messageId, blocks },
        active.turnId,
      );
    } catch {
      // wire 故障视同拒绝：降级路径会经 submit 的正常错误通道暴露 transport 问题，
      // 这里不吞掉输入本身
      receipt = { effective: "rejected" };
    }
    if (receipt.effective !== "steer") {
      return { effective: "follow_up", outcome: this.submit(harnessTargetId, blocks) };
    }
    // 已接受的 steer 是一等 Input（不再"无独立队列实体"）：挂到当前 turn，供 cancel 时
    // 统一迁移 interrupted（S3：不静默丢、不自动重发）。fire-and-forget，无独立回执。
    // 身份即 steer user_message 的 messageId（adapter 成功路径已用它落 delivery:"steer" 消息）。
    (active.steers ??= []).push(
      this.inputQueue.acceptSteer(target, active.turnId, messageId, blocks),
    );
    this.changed();
    return { effective: "steer" };
  }

  /** 只允许撤回尚未开始执行的最新 turn；已被 drain 取走的 active turn 不在此列。 */
  recallLatestQueued(): QueuedTurnSnapshot | undefined {
    const turn = this.inputQueue.recallLatest();
    if (!turn) return undefined;
    this.changed();
    return turn;
  }

  async listModels(harnessTargetId: string): Promise<ModelOption[]> {
    return (await this.ensureHarness(harnessTargetId)).listModels();
  }

  async setModel(harnessTargetId: string, modelId: string | null): Promise<void> {
    await (await this.ensureHarness(harnessTargetId)).setModel(modelId);
    this.changed();
  }

  currentModel(harnessTargetId: string): string | null {
    const binding = this.bindings.get(harnessTargetId);
    if (binding) return binding.currentModel();
    this.targetFor(harnessTargetId);
    return (
      this.options.session.meta.harnessSessions[harnessTargetId]?.model ??
      this.options.modelPreferences?.[harnessTargetId] ??
      null
    );
  }

  async listEfforts(harnessTargetId: string): Promise<EffortOption[]> {
    return (await this.ensureHarness(harnessTargetId)).listEfforts();
  }

  async setEffort(harnessTargetId: string, effortId: string | null): Promise<void> {
    await (await this.ensureHarness(harnessTargetId)).setEffort(effortId);
    this.changed();
  }

  currentEffort(harnessTargetId: string): string | null {
    const binding = this.bindings.get(harnessTargetId);
    if (binding) return binding.currentEffort();
    this.targetFor(harnessTargetId);
    return (
      this.options.session.meta.harnessSessions[harnessTargetId]?.effort ??
      this.options.effortPreferences?.[harnessTargetId] ??
      null
    );
  }

  /**
   * 用 harness 原生机制压缩当前上下文。它是一个没有 user_message 的 driven control turn：
   * 仍走统一 running → harness events → idle 流水线，因此 TUI、持久化与崩溃恢复不会旁路。
   */
  async compactContext(harnessTargetId: string): Promise<void> {
    if (this.draining || this.inputQueue.length > 0) {
      throw new Error("/compact requires an idle session");
    }
    this.draining = true;
    try {
      await this.runContextCompaction(harnessTargetId);
    } finally {
      this.draining = false;
      this.changed();
      if (this.inputQueue.length > 0) void this.drain();
    }
  }

  private async runContextCompaction(harnessTargetId: string): Promise<void> {
    const target = this.targetFor(harnessTargetId);
    this.processing = { target, startedAt: Date.now() };
    let record: TurnRecord<HarnessBinding> | undefined;
    try {
      const binding = await this.ensureHarness(harnessTargetId);
      if (
        !binding.ref ||
        !binding.adapter.capabilities.compact?.supported ||
        !isContextCompactable(binding.adapter)
      ) {
        throw new Error(`${harnessTargetId} does not support /compact`);
      }

      const turnId = newId("t");
      const admitted = this.admitDrivenTurn(binding, {
        turnId,
        harnessSessionId: binding.nativeSessionId(),
      });
      record = admitted.record;
      await binding.adapter.compactContext(binding.ref, turnId);
      await admitted.released;
    } catch (error) {
      this.options.session.diagnostic({
        level: "error",
        component: "controller.compact",
        harness: target.harness,
        harnessTargetId,
        turnId: record?.turnId,
        message: "harness context compaction failed",
        error: diagnosticError(error),
      });
      if (record && record.status !== "finalized") {
        this.synthesizeTerminal(record, {
          message: error instanceof Error ? error.message : String(error),
          stopReason: "error",
        });
      }
      throw error;
    } finally {
      this.processing = undefined;
    }
  }

  /**
   * 该 harness 当前生效的审批路由；不支持该能力、或 harness 没报出来 → null，
   * 投影据此静默。不读 config：config 是意图，只有 harness 自己报的才是事实。
   */
  approvalRoute(harnessTargetId: string): ApprovalRoute | null {
    return this.bindings.get(harnessTargetId)?.approvalRoute() ?? null;
  }

  /**
   * 施加一个 Control 信号（Input / Interaction resolution 之外的第三种用户信号，见
   * `Control`）。当前唯一
   * kind 是 `interrupt`（Esc）——打断当前 driven turn。新增 kind 时在此按 kind 分派。
   */
  async control(signal: Control): Promise<void> {
    switch (signal.kind) {
      case "interrupt":
        return this.interrupt();
    }
  }

  /**
   * Control:interrupt 的实现——中断当前 driven turn。确认以 harness 的 idle/cancelled 终态
   * 为准；宽限期内没等到则合成 terminal error，保证队列永远能推进（不能因 harness 失联而死锁）。
   * preparing（harness 冷启动中）无需确认：尚未向 harness 提交任何内容，立即合成取消。
   */
  private async interrupt(): Promise<void> {
    const active = this.activeDriven();
    if (!active) return;
    if (!active.binding.ref) {
      // preparing：Esc 立即生效，不被冷启动绑住。启动流程继续在后台完成——成功则 binding
      // 保留给后续 turn 复用；卡死由 adapter 的启动期超时兜底，不会永久占住队列。
      this.synthesizeTerminal(active, { stopReason: "cancelled" });
      return;
    }
    active.cancelGraceTimer ??= setTimeout(() => {
      this.synthesizeTerminal(active, {
        message: "cancel grace period expired without harness confirmation",
        stopReason: "cancelled",
      });
    }, this.options.cancelGraceMs ?? DEFAULT_CANCEL_GRACE_MS);
    try {
      await active.binding.adapter.cancel(active.binding.ref);
    } catch (error) {
      this.options.session.diagnostic({
        level: "error",
        component: "controller.cancel",
        harness: active.harness,
        harnessTargetId: active.harnessTargetId,
        turnId: active.turnId,
        message: "harness cancel request failed",
        error: diagnosticError(error),
      });
      // cancel 请求本身失败（transport 已断等）：不再等 harness，直接合成终态
      this.synthesizeTerminal(active, {
        message: `cancel request failed: ${error instanceof Error ? error.message : String(error)}`,
        stopReason: "cancelled",
      });
    }
  }

  async close(): Promise<void> {
    const closing: Promise<void>[] = [];
    for (const binding of this.bindings.values()) {
      if (binding.ref) {
        closing.push(
          binding.close().catch((error) => {
            this.options.session.diagnostic({
              level: "warn",
              component: "controller.close",
              harness: binding.adapter.harness,
              harnessTargetId: binding.target.id,
              message: "harness close failed",
              error: diagnosticError(error),
            });
          }),
        );
      }
    }
    await Promise.all(closing);
  }

  private async drain(): Promise<void> {
    if (this.draining) return;
    this.draining = true;
    try {
      while (this.inputQueue.length > 0) {
        const turn = this.inputQueue.dequeue() as InputRecord;
        this.changed();
        try {
          await this.runTurn(turn);
          turn.resolve?.("completed");
        } catch (error) {
          turn.reject?.(error);
        }
      }
    } finally {
      this.draining = false;
      this.changed();
    }
  }

  /**
   * driven turn 开界的唯一入口（kernel §3 admit）：入台账、置为当前 driven turn、
   * 落 user_message + state_update(running)。**control turn**（/compact 这类无用户
   * 输入、占用 turn 形状的控制操作）不传 input，跳过 user_message——两类 driven turn
   * 的开界序列只活在这里，不允许旁路再手搭一份。
   */
  private admitDrivenTurn(
    binding: HarnessBinding,
    opts: { turnId: string; input?: InputRecord; harnessSessionId?: string },
  ): { record: TurnRecord<HarnessBinding>; released: Promise<void> } {
    const admitted = this.turns.admitDriven(binding, opts.turnId, opts.input);
    if (opts.input) {
      const inputEvent = this.appendEvent(
        binding,
        {
          kind: "user_message",
          harnessSessionId: opts.harnessSessionId,
          turnId: opts.turnId,
          payload: { messageId: opts.input.messageId, content: opts.input.blocks },
        },
        { type: "user" },
      );
      admitted.record.inputEventId = inputEvent.eventId;
    }
    this.appendEvent(
      binding,
      {
        kind: "state_update",
        harnessSessionId: opts.harnessSessionId,
        turnId: opts.turnId,
        payload: { state: "running" },
      },
      { type: "baton" },
    );
    return admitted;
  }

  private async runTurn(turn: InputRecord): Promise<void> {
    this.processing = { target: turn.target, startedAt: Date.now() };

    // 出队即入账、即落盘：用户输入是 BatonSession 的事实，owner 是 controller——
    // 不等 harness 冷启动（codex 首启要 spawn → initialize → thread resume/start，
    // 可达数秒，期间 Transcript 必须已能看到这条输入）。落盘的是**原始输入** turn.blocks：
    // <baton-sync> 注入只进 harness transport（syncContext / prepend），不进正典历史。
    const binding = this.bindingFor(turn.target.id, turn.turnId);
    const harnessKey = binding.adapter.harness;
    const targetKey = binding.target.id;
    const { record, released } = this.admitDrivenTurn(binding, {
      turnId: turn.turnId,
      input: turn,
      harnessSessionId: this.options.session.meta.harnessSessions[targetKey]?.harnessSessionId,
    });
    const coldStart = !binding.ref;
    if (coldStart) {
      // 冷启动阶段对用户可见（否则 spinner 只能显示误导性的 thinking…）；
      // idle 终态会连带清掉 phase，失败/取消路径无需单独收尾
      this.appendEvent(
        binding,
        {
          kind: "_baton_run_status",
          turnId: turn.turnId,
          payload: { phase: "starting", title: `Starting ${turn.target.harness}…` },
        },
        { type: "baton" },
      );
    }

    try {
      await this.ensureHarness(targetKey);
      // preparing 期间被取消：终态已合成、summary 已落，不再向 harness 提交
      if (record.status === "finalized") return;
      if (!binding.ref) throw new Error(`${targetKey} failed to start`);
      if (coldStart) {
        this.appendEvent(
          binding,
          {
            kind: "_baton_run_status",
            turnId: turn.turnId,
            payload: { phase: null },
          },
          { type: "baton" },
        );
      }

      const session = this.options.session;
      const meta = session.meta.harnessSessions[targetKey];
      const catchUp = buildTargetCatchUpContext(session, {
        target: binding.target,
        sinceSeq: meta?.syncedSeq ?? 0,
        includeTargetTurns: binding.freshNative,
        budgetChars: this.options.mentionBudgetChars,
      });
      let blocks = turn.blocks;
      let syncBlocks: PromptBlock[] | undefined;
      // 水位（syncedSeq）只在注入时前进到本批 throughSeq（并发正确性的关键：
      // throughSeq 固定在注入时点，turn 运行期间其它 harness 落盘的事件 seq 必然
      // 大于它，下一次注入自然回补；finalize 推尾水位则会永久越过它们）。
      let submitCatchUp: typeof catchUp = null;
      if (catchUp) {
        const syncBlock: PromptBlock = {
          type: "text",
          text: `<baton-sync>\n${catchUp.text}\n</baton-sync>`,
        };
        if (isContextSynchronizable(binding.adapter)) {
          await binding.adapter.syncContext(binding.ref, [syncBlock]);
          session.setHarnessSession(targetKey, {
            ...meta,
            harnessTargetId: targetKey,
            harness: harnessKey,
            harnessSessionId: meta?.harnessSessionId ?? binding.nativeSessionId(),
            syncedSeq: catchUp.throughSeq,
          });
          binding.freshNative = false;
        } else {
          // 随本 turn 的 submit 送达（原生 side-channel 或 prepend）；两种形态共享
          // 同一水位语义：admission 通过后才推进，失败则下次重注入
          if (binding.adapter.capabilities.sync?.supported) {
            syncBlocks = [syncBlock];
          } else {
            blocks = [syncBlock, { type: "text", text: "\n\n" }, ...blocks];
          }
          submitCatchUp = catchUp;
        }
      }

      if (!meta?.launchSnapshot) {
        throw new Error(
          `cannot prepare harness delivery for turn ${record.turnId}: missing HarnessLaunchSnapshot`,
        );
      }
      const attempt = this.deliveryAttempts.prepare(binding, {
        turnId: record.turnId,
        inputEventId: record.inputEventId,
        inputId: turn.messageId,
        launchSnapshot: meta.launchSnapshot,
        harnessSessionId: meta.harnessSessionId ?? binding.nativeSessionId(),
      });
      this.deliveryAttempts.markDispatching(binding, attempt);

      // submit 回执只确认 Adapter 接受本次投递责任；Harness 终态仍由 idle Event 收口。
      // Adapter 契约规定：throw 只发生在接受责任之前；接受后即使原生 transport 失败，
      // 也必须经事件流报告终态，不能把不确定性藏进一个迟到 rejection。
      try {
        await binding.adapter.submit(binding.ref, {
          turnId: turn.turnId,
          messageId: turn.messageId,
          blocks,
          ...(syncBlocks ? { syncBlocks } : {}),
        });
      } catch (error) {
        this.deliveryAttempts.finalize(binding, attempt, "not_accepted", {
          detail: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
      this.deliveryAttempts.markAccepted(binding, attempt);
      if (submitCatchUp) {
        // admission 通过 ⇒ 随 submit 送达的 sync 块（syncBlocks 或 prepend）已进入 harness
        // 输入：视为同步到 throughSeq。
        // admission 失败走 catch 上抛，水位不动，下次重新注入。
        session.setHarnessSession(targetKey, {
          ...session.meta.harnessSessions[targetKey],
          harnessTargetId: targetKey,
          harness: harnessKey,
          harnessSessionId:
            session.meta.harnessSessions[targetKey]?.harnessSessionId ??
            binding.nativeSessionId(),
          syncedSeq: submitCatchUp.throughSeq,
        });
        binding.freshNative = false;
      }
      await released;
    } catch (error) {
      // preparing 期间被取消、随后启动又失败：用户已收到 cancelled 终态并继续别的事，
      // 迟到的启动错误不再作为本 turn 的失败上抛（事件历史已闭合）
      if (record.status === "finalized") return;
      const detail = error instanceof Error ? error.message : String(error);
      this.options.session.diagnostic({
        level: "error",
        component: "controller.turn",
        harness: turn.target.harness,
        harnessTargetId: targetKey,
        turnId: turn.turnId,
        message: "harness startup or prompt admission failed",
        error: diagnosticError(error),
      });
      // 启动/admission 失败：合成结构化终态（error + idle + summary）——user_message 已
      // 落盘，必须有结局，不允许"输入消失且无历史"的半状态；随后仍上抛给 submit 调用方。
      this.synthesizeTerminal(record, { message: detail, stopReason: "error" });
      throw new Error(`BatonSession ${this.options.session.id} · ${targetKey}: ${detail}`, {
        cause: error,
      });
    } finally {
      this.processing = undefined;
      this.changed();
    }
  }

  /**
   * 所有事件的唯一入口（adapter 上报 + controller 自有：出队 user_message/running、
   * 合成终态）：持久化（append 即广播给事件流订阅者，UI 投影由订阅侧完成，
   * 这里不做任何转发）→ 识别 turn 边界并记账。
   * 不变量：任何进入本方法的事件必然对订阅者可见——投影正确性由 append 广播
   * 单通道保证，不依赖"是否有活跃 turn"。
   */
  private appendEvent(
    binding: HarnessBinding,
    ev: AnyEventDraft,
    source: EventSource,
  ): AnyEventEnvelope {
    const envelope = this.options.session.append({
      ...ev,
      source,
      harness: binding.adapter.harness,
      harnessTargetId: binding.target.id,
    } as AnyNewEvent) as AnyEventEnvelope;
    if (envelope.kind === "state_update") {
      const p = envelope.payload;
      if (p.state === "running" && envelope.source.type === "harness" && envelope.turnId) {
        // observed turn 开界：登记入台账，不进队列（design §5.10）
        this.turns.observe(binding, envelope.turnId);
      } else if (p.state === "idle") {
        // 终态一律按 baton turn id 查表路由（不看 binding）。无 turnId 的终态：
        // 已持久化留痕，但无法归属任何 turn，不驱动生命周期（adapter 契约要求
        // 终态必带 turnId，由契约测试钉住）。
        if (envelope.turnId) {
          // Attempt 对账先于 Turn 幂等收口：cancel grace 后迟到的 Harness idle 虽然不能
          // 二次 finalize Turn，却仍是把 uncertain Attempt 收敛到终态的权威 Receipt。
          this.deliveryAttempts.observeTerminal(binding, envelope);
          this.finalize(envelope);
        }
      }
    }
    // append 已同步广播给投影；普通流式事件不能再走 controller 通知，否则每个 chunk
    // 都会重建两次完整 view。终态对 controller 私有台账的变更由 finalize 自己通知。
    return envelope;
  }

  /**
   * 所有 turn 的统一有序 finalize 路径（design §4.1）：终态已持久化 →
   * （driven 被打断时）interrupted notice → 一次 turn summary → 同步元数据 →
   * （driven）释放等待者推进队列。observed 只记账，不碰队列——summary 让 harness
   * 自发产出进入 @ 引用与跨 harness catch-up 的正典历史，否则后台唤醒的结论对
   * 下一棒 harness 是永久盲区。
   * 按 baton turn id 幂等：迟到/重复/未知终态一律 inert，不会关闭更新的 turn。
   */
  private finalize(terminal: EventEnvelope<"state_update">): void {
    const turnId = terminal.turnId;
    if (!turnId) return;
    const stopReason = terminal.payload.stopReason;
    const record = this.turns.beginFinalization(turnId, stopReason);
    if (!record) return;

    // cancel-cascade：本 turn 仍挂起的 Interaction 随收口一并了结，绝不留悬挂 continuation。
    // Controller 先持久化 cancelled resolution，再唤醒 Adapter；参考 codex
    // clear_pending_waiters→Abort、opencode interrupt 的 ensuring(pending.delete)。
    // 顺序天然对：finalize 发生在 adapter.cancel 之后（先中断 turn，再收 pending），不会让取消以
    // model 可见的 tool rejection 抢在 turn 中断之前冒出来。
    this.interactions.cancelForTurn(turnId);

    const session = this.options.session;

    // 用户打断的 turn 在时间线留下醒目标记；排队的后续输入会自然跟在标记后面
    if (record.role === "driven" && stopReason === "cancelled") {
      session.append({
        kind: "_baton_notice",
        source: { type: "baton" },
        harness: record.harness,
        harnessTargetId: record.harnessTargetId,
        turnId,
        payload: { level: "warning", title: INTERRUPTED_NOTICE_TITLE },
      });
    }

    session.summarizeTurnEvent(turnId);
    if (record.role === "driven") record.binding.freshNative = false;
    this.backfillHarnessSessionId(record.binding);

    this.turns.finish(record, stopReason);
    this.changed();
  }

  /**
   * turn 收界后的元数据回填：原生 session id 首轮结束才拿得到（claude）。
   * 刻意**不**推进 syncedSeq——水位只在注入时前进（见 runTurn）：finalize 推尾水位
   * 会越过并发期间其它 harness 落盘、尚未注入本 harness 的事件，形成永久同步洞。
   */
  private backfillHarnessSessionId(binding: HarnessBinding): void {
    const session = this.options.session;
    const key = binding.target.id;
    const existing = session.meta.harnessSessions[key];
    const nativeId = binding.nativeSessionId() ?? existing?.harnessSessionId;
    if (nativeId === existing?.harnessSessionId) return; // 无变化不写盘
    session.setHarnessSession(key, {
      ...existing,
      harnessTargetId: key,
      harness: binding.adapter.harness,
      harnessSessionId: nativeId,
    });
  }

  /**
   * controller 合成终态：可选的结构化 error 留痕 + idle，走统一事件管线（→ finalize）。
   * 使用方：cancel 宽限期到期 / cancel 请求失败 / preparing 取消（无 error，纯 cancelled）/
   * 启动与 admission 失败（stopReason:"error"）。
   */
  private synthesizeTerminal(
    record: TurnRecord<HarnessBinding>,
    opts: { message?: string; stopReason: StopReason },
  ): void {
    if (record.status === "finalized") return;
    if (opts.message !== undefined) {
      this.appendEvent(
        record.binding,
        {
          kind: "_baton_error_update",
          turnId: record.turnId,
          payload: { message: opts.message, retryable: false },
        },
        { type: "baton" },
      );
    }
    this.appendEvent(
      record.binding,
      {
        kind: "state_update",
        turnId: record.turnId,
        payload: { state: "idle", stopReason: opts.stopReason },
      },
      { type: "baton" },
    );
  }

  /**
   * 同步获取（创建即启动）HarnessBinding：Adapter 构造和可信 Event sink 在这里绑定，
   * runTurn 因此能在 open() 完成之前落 user_message。实际启动生命周期由 binding 拥有。
   */
  private bindingFor(harnessTargetId: string, setupTurnId?: string): HarnessBinding {
    let binding = this.bindings.get(harnessTargetId);
    if (!binding) {
      const target = this.targetFor(harnessTargetId);
      const adapter = this.options.createAdapter(target, {
        interactionHandler: (interaction, context) =>
          this.openHarnessInteraction(target.id, interaction, context),
        diagnostic: (entry) =>
          this.options.session.diagnostic({ ...entry, harnessTargetId: target.id }),
      });
      let created!: HarnessBinding;
      created = new HarnessBinding({
        target,
        adapter,
        session: this.options.session,
        setupTurnId,
        modelPreference: this.options.modelPreferences?.[target.id],
        effortPreference: this.options.effortPreferences?.[target.id],
        eventSink: (event) =>
          this.appendEvent(created, event, {
            type: "harness",
            harnessTargetId: created.target.id,
          }),
      });
      binding = created;
      this.bindings.set(target.id, created);
      created.start();
    }
    return binding;
  }

  private async ensureHarness(harnessTargetId: string): Promise<HarnessBinding> {
    const binding = this.bindingFor(harnessTargetId);
    if (binding.isStarting) {
      try {
        await binding.ensure();
      } catch (error) {
        this.bindings.delete(harnessTargetId);
        throw error;
      } finally {
        this.changed();
      }
    }
    return binding;
  }

  private targetFor(harnessTargetId: string): HarnessTarget {
    const resolved = this.options.resolveTarget(harnessTargetId);
    if (!resolved) {
      throw new Error(`HarnessTarget not registered: ${harnessTargetId}`);
    }
    if (!resolved.id || resolved.id !== harnessTargetId || !resolved.harness) {
      throw new Error(
        `invalid HarnessTarget for ${harnessTargetId}: id=${resolved.id}, harness=${resolved.harness}`,
      );
    }
    return Object.freeze({ id: resolved.id, harness: resolved.harness });
  }

  private changed(): void {
    this.options.onChange?.();
  }
}
