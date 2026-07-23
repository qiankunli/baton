/**
 * Baton 配置与调度侧的 Harness 目标。`harness` 选择执行协议，`id` 标识一份具体配置；
 * 同一种 Harness 可以有多个 target，但它们不能共享 controller slot 或原生 session。
 */
export interface HarnessTarget {
  readonly id: string;
  readonly harness: string;
}

/**
 * 一次 Harness open 实际采用的不可变配置。它属于 Baton 控制面，不穿透 Adapter 边界；
 * controller 仍把其中需要的 cwd / model / effort 映射成 Adapter 的 OpenOptions 与能力调用。
 */
export interface HarnessLaunchSnapshot {
  readonly harnessTargetId: string;
  /** 选择 Adapter 的 Harness id，例如 `claude`。 */
  readonly harness: string;
  /** Adapter 事件与原生 session 使用的稳定 key，例如 `claude-code`。 */
  readonly harnessSessionKey: string;
  readonly cwd: string;
  readonly model?: string;
  readonly effort?: string;
}

export function createHarnessLaunchSnapshot(opts: {
  target: HarnessTarget;
  harnessSessionKey: string;
  cwd: string;
  model?: string;
  effort?: string;
}): HarnessLaunchSnapshot {
  return Object.freeze({
    harnessTargetId: opts.target.id,
    harness: opts.target.harness,
    harnessSessionKey: opts.harnessSessionKey,
    cwd: opts.cwd,
    ...(opts.model ? { model: opts.model } : {}),
    ...(opts.effort ? { effort: opts.effort } : {}),
  });
}
