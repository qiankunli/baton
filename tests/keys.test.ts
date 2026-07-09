import { describe, expect, test } from "bun:test";

import { CTRL_C_CONFIRM_WINDOW_MS, ctrlCAction } from "../src/tui/keys.ts";

describe("ctrlCAction 分层语义", () => {
  test("busy 优先：中断 turn，而非退出", () => {
    expect(ctrlCAction({ busy: true, hasDraft: true, armedAt: 0, now: 1000 })).toBe("cancel-turn");
  });

  test("有输入：清空草稿", () => {
    expect(ctrlCAction({ busy: false, hasDraft: true, armedAt: 0, now: 1000 })).toBe("clear-draft");
  });

  test("空闲首次：进入待确认", () => {
    expect(ctrlCAction({ busy: false, hasDraft: false, armedAt: 0, now: 999999 })).toBe("arm-exit");
  });

  test("确认窗口内二次按下：退出；窗口过期：重新待确认", () => {
    const armedAt = 10_000;
    expect(
      ctrlCAction({ busy: false, hasDraft: false, armedAt, now: armedAt + CTRL_C_CONFIRM_WINDOW_MS - 1 }),
    ).toBe("exit");
    expect(
      ctrlCAction({ busy: false, hasDraft: false, armedAt, now: armedAt + CTRL_C_CONFIRM_WINDOW_MS + 1 }),
    ).toBe("arm-exit");
  });
});
