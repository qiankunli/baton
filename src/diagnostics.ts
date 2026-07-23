export type DiagnosticLevel = "debug" | "info" | "warn" | "error";

export interface DiagnosticError {
  name?: string;
  message: string;
  stack?: string;
}

export interface DiagnosticEntry {
  level: DiagnosticLevel;
  component: string;
  message: string;
  harness?: string;
  harnessTargetId?: string;
  turnId?: string;
  error?: DiagnosticError;
  details?: Record<string, string | number | boolean | null>;
}

/** Harness/transport 诊断走旁路日志，不进入可重放的 session event 模型。 */
export type DiagnosticSink = (entry: DiagnosticEntry) => void;

export function diagnosticError(error: unknown): DiagnosticError {
  if (error instanceof Error) {
    return {
      name: error.name,
      message: error.message,
      ...(error.stack ? { stack: error.stack } : {}),
    };
  }
  return { message: String(error) };
}
