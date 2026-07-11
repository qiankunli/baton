import { describe, expect, test } from "bun:test";

import { thoughtDisplayBlocks, toolTranscriptItem } from "../src/tui/protocol.ts";

describe("thoughtDisplayBlocks", () => {
  test("turns Codex title-only summaries into separate blocks", () => {
    expect(thoughtDisplayBlocks("**Inspecting files**\n\n<!-- -->\n**Planning changes**\n\n<!-- -->")).toEqual([
      { title: "Inspecting files" },
      { title: "Planning changes" },
    ]);
  });

  test("hides an incomplete streaming placeholder", () => {
    expect(thoughtDisplayBlocks("**Inspecting files**\n\n<!--")).toEqual([{ title: "Inspecting files" }]);
  });

  test("keeps an ordinary thought body", () => {
    expect(thoughtDisplayBlocks("**Comparing options**\n\nThe second approach is smaller.")).toEqual([
      { title: "Comparing options", content: "The second approach is smaller." },
    ]);
  });
});

describe("toolTranscriptItem", () => {
  test("keeps command source separate from its output", () => {
    expect(
      toolTranscriptItem({
        toolCallId: "tc_cmd",
        title: "Bash: git status --short",
        kind: "execute",
        status: "completed",
        content: [{ type: "text", text: " M src/index.ts\n" }],
        locations: [],
        rawInput: { command: "git status --short" },
      }),
    ).toEqual({
      type: "block",
      id: "tc_cmd",
      kind: "tool",
      title: "Ran",
      status: "completed",
      content: [
        { type: "command", command: "git status --short" },
        { type: "output", lines: [" M src/index.ts"] },
      ],
    });
  });

  test("preserves patch and path for native diff rendering", () => {
    const patch = "@@ -1 +1 @@\n-old\n+new";
    expect(
      toolTranscriptItem({
        toolCallId: "tc_edit",
        title: "edit src/index.ts",
        kind: "edit",
        status: "completed",
        content: [{ type: "diff", changes: [{ operation: "modify", path: "src/index.ts" }], patch }],
        locations: [],
      }),
    ).toEqual({
      type: "block",
      id: "tc_edit",
      kind: "tool",
      title: "edit src/index.ts",
      status: "completed",
      content: [{ type: "diff", patch, path: "src/index.ts" }],
    });
  });
});
