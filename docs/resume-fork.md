# BatonSession 的 resume 与 fork

## 理念 / 概念

resume 和 fork 都是 **BatonSession 自己的语义**，不依赖任何 provider 的原生 resume/fork 能力：

- **resume**：沿用原 `bs_` ID 重新打开会话，恢复统一逻辑历史；provider 原生会话只是恢复加速，缺失时从 BatonSession 历史重建上下文（既有约定，见 `design.md`）。
- **fork**：从一个 BatonSession 复制事件历史，得到一个独立的新会话。复制的前缀与源是**同一段逻辑历史**（git-branch 语义），谱系由 `meta.forkedFrom = { batonSessionId, throughSeq }` 表达。fork 是后续"草稿会话"（任务进行中拉草稿并行探索、成果由用户决定收录）的数据层基础，当前先以 CLI 子命令形态提供（`baton fork`），会话内运行中 fork（类 Codex `/side`）留待 workspace runtime。

配套引入两个打开期机制：

- **会话锁**：session 目录下的 pid 文件，标记"哪个活进程正持有该会话"。
- **crash recovery**：打开会话时归一化上个进程留下的中断残留。

## 流程

1. `baton resume [bs_xxx]` / `baton fork [bs_xxx]` 由 `cli/bin.ts` 转译成 TUI 入口已支持的 flags。不带 id 时默认进 **session picker**（`tui/session-picker.tsx` 前置会话选择屏，词汇与形态对齐 codex CLI 的 resume_picker）：不预先打开任何会话，Enter 选中才 resume / 落盘 fork（锁与 crash recovery 只发生在被选中的目标上，选错 / Esc 不产生 fork 副本），Esc 新开会话，Ctrl+C 退出；显式 id / `--last` / 非 TTY 直通。session picker 是 chat 之外的启动画面，不经过 BatonChatProtocol——协议保持"恒绑一个已打开会话"的不变量；会话内切换仍走 `/sessions`（行投影 `sessionPickerOptions` 两处共用）。
2. 一切打开路径（CLI 启动、TUI `/sessions` 切换、`/new`）收敛到 `session/open.ts` 的 `openBatonSession()`：解析目标 → `acquireLock()` → `recoverInterruptedState()`。
3. fork 的 child 首次发消息时，`BatonSessionRuntime.ensureProvider()` 发现无 `providerSessionId` → 开 fresh 原生会话 → `syncedSeq=0` 触发全量补课（`buildProviderCatchUpContext`），上下文自然重建——完全复用既有能力，fork 没有为 runtime 增加任何分支。

## 关键设计

### 为什么 fork 是复制，而不是父指针引用

`session.jsonl` 承载 BatonSession 完整逻辑历史是既有核心不变量，reduce / summarize / catch-up 全都假设单文件。父指针会让"读历史"处处变成两跳，还引入"父被删/被改写"的悬挂问题。复制让 child 完全自包含。

### 为什么不做 ID remap

事件里的 `toolCallId`、部分 `messageId` 本就是 provider 原生 ID（Claude 的 `tool_use_id`、Codex 的 `item.id`），不是 baton 签发的全局 ID；remap 它们没有唯一性收益，反而破坏 payload 与 `raw` 的审计对照。复制前缀既然是同一段逻辑历史，保留原 ID 恰是正确的身份表达；将来跨会话引用 turn 时用 `bs_ + t_` 限定即可消歧。`seq` 同理原样保留——边界永远是前缀（全局串行队列保证），天然连续。

### 为什么 providerSessions 只保留 provider + model

`providerSessionId` / `syncedSeq` / `resumeCursor` 描述的是源会话与其原生 ProviderSession 的绑定，child 若继承会 resume 源的原生会话，导致两个 BatonSession 写进同一份 provider 历史，fork 即失效。`model` 是用户偏好，丢掉会让 child 静默回落默认模型，故单独保留。

### 为什么 recovery 挂在打开入口，且以锁为前提

recovery 的核心价值不是修 UI 状态（TUI 的 busy 来自 runtime，不来自 reduce），而是：**catch-up 与 `@` 引用只读 `_baton_turn_summary`，没有 summary 的半截 turn 对后续 provider 同步是永久盲区**。归一化动作与 `runtime.finalizeTurn` 的收口顺序一致（终态 → notice → summary）。

前提是持锁："最后事件是 running"只有在没有活进程持有会话时才能断定为崩溃残留，否则合成终态会污染另一个进程正在执行的活会话。锁只服务这个判定，不承担并发追加的完整保护（headless REPL 目前不加锁，属已知豁免）。抢锁用 `O_EXCL` 原子创建（不做"先检查再写入"，那是 TOCTOU）；锁不做进程内引用计数——约定同一进程内一个 session 至多一个活 handle，进程内并发归上层（TUI 单前台会话；将来 workspace runtime 由 session slot 唯一性保证）。

recovery 同时覆盖 fork：源会话若正在运行（或曾崩溃），复制会带进半截 turn；child 首次打开时经同一条归一化路径补上终态与 summary，`forkSession()` 自身不必关心。

### fork 的上下文保真度 = turn-summary 保真度

child 的 provider 通过补课看到的是紧凑 turn 摘要（预算内优先保最近，默认 4KB 字符），不是全量事件回放。这与既有跨 provider 接力的保真度一致，不是 fork 引入的新损耗；但用户直觉可能预期"fork = 完整带走上下文"，故显式记录。完整历史仍在 child 的 `session.jsonl` 里，随时可被更高保真的注入策略消费。

### 面向 /side 的预留

- `forkSession(sourceSessionId, { throughSeq })`：运行中 fork 只需传入"当前 active turn 之前"的水位，无需新入口。
- 锁按 per-session 设计，一个进程可同时持有多把（多 session workspace runtime 的前提）。
- 未决前提（workspace runtime 的入口条件）：主线与草稿共享同一 cwd 的并行写隔离方案（worktree / 只读草稿 / 显式警告）。
