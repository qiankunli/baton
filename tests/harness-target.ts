import type { HarnessTarget } from "../src/harness/target.ts";

const TEST_TARGETS: readonly HarnessTarget[] = [
  { id: "codex", harness: "codex" },
  { id: "claude", harness: "claude" },
  { id: "example", harness: "example" },
  { id: "scripted", harness: "scripted" },
];

/** Tests use an explicit target catalog so production's no-inference invariant stays exercised. */
export function resolveTestTarget(harnessTargetId: string): HarnessTarget | undefined {
  return TEST_TARGETS.find((target) => target.id === harnessTargetId);
}
