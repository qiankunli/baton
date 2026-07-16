import { describe, expect, test } from "bun:test";

import { sanitizeTerminalTitle, setTerminalTabTitle } from "../src/tui/terminal-title.ts";

describe("terminal tab title", () => {
  test("sanitizes control characters from user-controlled titles", () => {
    expect(sanitizeTerminalTitle(" fix\nlogin\x1b]2;owned\x07 ")).toBe("fix login ]2;owned");
  });

  test("writes an OSC 1 sequence to a TTY", () => {
    const chunks: string[] = [];
    setTerminalTabTitle("first question", {
      isTTY: true,
      write(chunk) {
        chunks.push(chunk);
      },
    });

    expect(chunks).toEqual(["\x1b]1;first question\x1b\\"]);
  });

  test("does not write outside a TTY", () => {
    const chunks: string[] = [];
    setTerminalTabTitle("first question", {
      isTTY: false,
      write(chunk) {
        chunks.push(chunk);
      },
    });

    expect(chunks).toEqual([]);
  });
});
