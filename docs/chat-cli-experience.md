# Chat CLI 体验清单

长期目标是让 baton 在 terminal 里达到甚至超过单独使用 Claude Code / Codex 的原生体验。本文是一份**持续积累的体验维度清单**——不是路线图，而是“一个好的 terminal chat 体验要考虑哪些细节”的备忘：每条记录归属层、现状与要点，成熟落地后细节下沉到对应 `docs/<feature>.md` 或代码注释，本文只留“有这件事、为什么重要”。

## 理念

- **体验的默认锚点是原生 CLI**：用户单独用某个 agent 时习惯的输入、补全、流式、审批、快捷键，切到 baton 不应退化。差异化在“上下文打通”，但不能以牺牲交互手感换取。
- **归属分层**：通用 UI 手感归 chat-tui（provider 无关）；provider / 上下文 / 会话语义归 baton。清单每条标注 `[tui]` / `[baton]` / `[both]`，避免把 provider 语义漏进 chat-tui，或把 UI 细节沉进 runtime。
- **现状标记**：✅ 已具备 · 🚧 部分 · ⬜ 未做。落地条目从“未做/部分”推进后就地更新。

## 输入与编辑

- ✅ `[tui]` 多行编辑、Enter 发送 / Shift+Enter·Ctrl+J 换行（Shift+Enter 依赖 kitty keyboard 协议）。
- ✅ `[both]` ↑/↓ 队列召回 + 会话级历史回溯（光标边界门槛、`lastHistoryText` 判改动、stash 草稿）——见 `user-input-lifecycle.md` §2.4。
- ⬜ `[both]` **跨会话全局历史 + 持久化**（`~/.baton/history.jsonl`，参考 codex `~/.codex/history.jsonl`）：当前历史仅当前 BatonSession。
- ⬜ `[tui]` **历史增量搜索**（Ctrl+R fuzzy）：历史变长后逐条翻不够用。
- ⬜ `[both]` **草稿保活**：崩溃/退出前未发送的 draft 恢复（codex/opencode 都做，≥N 字符才存）。
- 🚧 `[tui]` **粘贴处理**：需要 bracketed paste；超大粘贴折叠成占位符而非灌满输入框；图片粘贴（富输入尚未接入，见 `user-input-lifecycle.md` §3）。
- ⬜ `[tui]` **Vim 编辑模式**（codex 有 normal/insert）：面向重度用户，非必需。
- ⬜ `[tui]` 词/行级动作与 kill/yank、undo/redo 手感对齐 readline。

## 补全与发现

- ✅ `[both]` slash 命令补全（命令表由 baton 注入）、`@` 引用补全（BatonSession 候选）。
- ⬜ `[tui]` **文件路径 / fuzzy 补全**、ghost text 预测。
- 🚧 `[tui]` 键位帮助浮层（`?`）、首次运行引导、placeholder 里的快捷键提示（现有 placeholder 已提示部分）。

## 输出与渲染

- ✅ `[tui]` 流式 Markdown、Tree-sitter 代码高亮、按文件操作语义渲染 diff（宽屏 side-by-side）、长内容裁剪 + Ctrl+O 展开、thought 折叠。
- ⬜ `[tui]` **transcript 内搜索 / 跳转**、OSC 8 超链接、内联图片（kitty/iTerm）。
- 🚧 `[tui]` resize 重排（换行随宽度）；窄终端 / SSH / tmux 下的降级表现需系统性验证。

## 交互与控制

- ✅ `[tui]` 分层 Ctrl+C（跑时打断 / 有输入清空 / 空闲二次确认退出）、Esc 语义、审批与结构化提问浮层（permission 不可 dismiss）。
- ✅ `[both]` Agent Status 行（provider · model · 运行相位 / idle 显式）、队列可见、steer vs follow-up 如实标注。
- ✅ `[tui]` 鼠标选区 → 剪贴板（OSC52）、footer token 双击复制。
- ⬜ `[both]` **完成通知**：长任务结束时终端 bell / 系统通知 / 窗口标题提示（后台等待时尤其有用）。

## 会话与上下文

- ✅ `[baton]` resume / fork（含跨 project fork）、session picker、`@bs_xxx` 跨会话引用与预算截断、会话内 provider 切换。
- 🚧 `[baton]` 上下文接力的**可感知度**：切 provider / 恢复会话时，让用户确信“上下文已带过去”而非猜测（当前靠 status 文案，未来可有更明确的 receipt）。

## 延迟与健壮

- ✅ `[baton]` 输入即时回显（原始输入出队即落正典历史，provider 冷启动不阻塞 Transcript）、不静默丢事件（事件流单通道投影）、crash recovery。
- ⬜ `[both]` **超大流式的背压 / 截流**：provider 疯狂输出时保持 UI 响应。
- 🚧 `[both]` 停滞观测 + 对账（`provider-output-lifecycle.md` §5）：卡住时如实提示而非假装在跑。

## 终端集成与无障碍

- 🚧 `[tui]` 主题（明/暗）、truecolor→256 回退、`NO_COLOR`。
- ⬜ `[tui]` 鼠标支持开关、窗口标题设置、高对比 / 屏幕阅读器友好度。

## References

- `user-input-lifecycle.md` — 输入语义、召回与历史回溯的生命周期与契约。
- `provider-output-lifecycle.md` — 输出归一、终态收口、停滞观测与对账。
- `provider-interaction-design.md` — 输入/输出/确认的完整交互面分层。
- chat-tui `README.md` 的 Capability matrix — UI 层当前支持的采集/渲染形状（provider 无关）。
