export type PluginOutput = {
  /** Baton-owned closed vocabulary; each kind has its own validation and lifecycle. */
  readonly kind: "proposed-input";
  readonly text: string;
};

export function validatePluginOutput(value: unknown): asserts value is PluginOutput {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("reconcile output must be a PluginOutput object");
  }
  const output = value as { kind?: unknown; text?: unknown };
  if (output.kind !== "proposed-input") {
    throw new Error(`unsupported PluginOutput kind: ${String(output.kind)}`);
  }
  if (typeof output.text !== "string" || !output.text.trim()) {
    throw new Error("reconcile proposed-input text must not be empty");
  }
}
