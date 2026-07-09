// Ctrl+C 的分层语义（纯逻辑，可单测）。TUI 惯例：Ctrl+C 表达"打断"而非"退出"——
// 跑着 → 中断 turn；有输入 → 清空；空闲 → 二次确认（窗口内再按才退出）。

export const CTRL_C_CONFIRM_WINDOW_MS = 1500;

export type CtrlCAction = "cancel-turn" | "clear-draft" | "arm-exit" | "exit";

export function ctrlCAction(state: {
  busy: boolean;
  hasDraft: boolean;
  /** 上一次空闲态按下 Ctrl+C 的时间戳；从未按过传 0 */
  armedAt: number;
  now: number;
}): CtrlCAction {
  if (state.busy) return "cancel-turn";
  if (state.hasDraft) return "clear-draft";
  if (state.now - state.armedAt < CTRL_C_CONFIRM_WINDOW_MS) return "exit";
  return "arm-exit";
}
