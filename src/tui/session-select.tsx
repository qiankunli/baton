// baton resume / fork 无 id 时的前置会话选择屏（对齐 codex CLI 的 resume/fork picker）：
// 不预先打开任何会话，选中才 resume / fork——锁与 crash recovery 只发生在被选中的目标上。
// 这是 baton 侧组件（它理解 SessionMeta）；渲染复用 opentui 的 <select>（自带 ↑↓/Enter）。
// 键位对齐 codex：Enter 选中、Esc 新开会话（StartFresh）、Ctrl+C 退出。

import { useKeyboard } from "@opentui/react";
import type { ReactNode } from "react";

import type { Theme } from "chat-tui";

import type { SessionMeta } from "../store/store.ts";

export interface SessionSelectProps {
  title: string;
  /** Enter 动作展示名（footer 提示）：resume / fork */
  actionLabel: string;
  sessions: SessionMeta[];
  theme: Theme;
  /** 打开失败（如目标会话被其它 baton 进程锁定）时回显，停留在列表让用户改选 */
  error?: string;
  onPick: (batonSessionId: string) => void;
  onStartFresh: () => void;
  onExit: () => void;
}

export function sessionSelectOptions(
  sessions: SessionMeta[],
): Array<{ name: string; description: string; value: string }> {
  return sessions.map((meta) => ({
    name: meta.title ?? meta.batonSessionId,
    description: `${meta.batonSessionId} · ${meta.cwd} · ${meta.updatedAt ?? meta.createdAt} · [${
      Object.keys(meta.providerSessions).join(",") || "-"
    }]`,
    value: meta.batonSessionId,
  }));
}

export function SessionSelectScreen(props: SessionSelectProps): ReactNode {
  const theme = props.theme;
  useKeyboard((key) => {
    if (key.ctrl && key.name === "c") props.onExit();
    else if (key.name === "escape") props.onStartFresh();
  });
  return (
    <box style={{ flexDirection: "column", flexGrow: 1, padding: 1 }}>
      <text fg={theme.accent}>{props.title}</text>
      <box
        border
        borderColor={theme.border}
        style={{ flexGrow: 1, marginTop: 1, flexDirection: "column" }}
      >
        <select
          focused
          style={{ flexGrow: 1 }}
          options={sessionSelectOptions(props.sessions)}
          onSelect={(_index: number, option: { value?: unknown } | null) => {
            if (option) props.onPick(String(option.value));
          }}
        />
      </box>
      {props.error ? <text fg={theme.error}>{props.error}</text> : null}
      <text fg={theme.dim}>{`↑↓ select · enter ${props.actionLabel} · esc start new session · ctrl+c quit`}</text>
    </box>
  );
}
