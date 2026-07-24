import { describe, expect, test } from "bun:test";

import { closedTerminal } from "../src/harness/normalize.ts";

const TABLE = { completed: "completed", failed: "failed", declined: "declined" } as const;

describe("closedTerminal", () => {
  test("maps known values to the internal vocabulary", () => {
    expect(closedTerminal("completed", TABLE, "failed")).toBe("completed");
    expect(closedTerminal("declined", TABLE, "failed")).toBe("declined");
  });

  test("unknown values fail closed to the conservative fallback (never optimistic)", () => {
    expect(closedTerminal("weird_new_status", TABLE, "failed")).toBe("failed");
    expect(closedTerminal(42, TABLE, "failed")).toBe("failed");
  });

  test("empty / missing falls to the fallback unless emptyAs is given", () => {
    expect(closedTerminal(undefined, TABLE, "failed")).toBe("failed");
    expect(closedTerminal(null, TABLE, "failed")).toBe("failed");
    expect(closedTerminal("", TABLE, "failed")).toBe("failed");
    // emptyAs: 缺失即完成的特判（codex item/completed 缺 status）
    expect(closedTerminal("", TABLE, "failed", "completed")).toBe("completed");
    expect(closedTerminal(undefined, TABLE, "failed", "completed")).toBe("completed");
    // emptyAs 只作用于空/缺失，不改变未知值的保守回落
    expect(closedTerminal("weird", TABLE, "failed", "completed")).toBe("failed");
  });
});
