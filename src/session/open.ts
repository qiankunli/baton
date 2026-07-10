import type { SessionHandle, SessionStore } from "../store/store.ts";

export interface OpenBatonSessionOptions {
  cwd: string;
  sessionId?: string;
  continueLast?: boolean;
  title?: string;
}

export interface OpenBatonSessionResult {
  session: SessionHandle;
  resumed: boolean;
}

/** BatonSession 的唯一打开策略，供 CLI 和后续 TUI 会话选择器共同复用。 */
export function openBatonSession(
  store: SessionStore,
  opts: OpenBatonSessionOptions,
): OpenBatonSessionResult {
  if (opts.sessionId && opts.continueLast) {
    throw new Error("--session and --continue cannot be used together");
  }

  if (opts.sessionId) {
    return { session: store.openSession(opts.sessionId), resumed: true };
  }

  if (opts.continueLast) {
    const latest = store.listSessions({ cwd: opts.cwd })[0];
    if (latest) {
      return { session: store.openSession(latest.batonSessionId), resumed: true };
    }
  }

  return {
    session: store.createSession({ cwd: opts.cwd, title: opts.title }),
    resumed: false,
  };
}
