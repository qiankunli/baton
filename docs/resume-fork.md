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

session picker 的可读名称对齐 Codex resume 的思路：`meta.title` 只表示用户显式命名；未命名会话以第一条有意义的用户文本预览作为名称，最后才回退到 cwd。chat-tui 粘贴图片产生的前导本地路径按附件处理，不占用名称。preview 在首次提交时只写一次；旧会话只在发现阶段有界读取日志回填展示，不改写历史数据。旧版本自动生成的 `chat/codex/claude @ cwd` 标题视为兼容占位，不遮住更有辨识度的 preview。

## 关键设计

### 为什么 fork 是复制，而不是父指针引用

`session.jsonl` 承载 BatonSession 完整逻辑历史是既有核心不变量，reduce / summarize / catch-up 全都假设单文件。父指针会让"读历史"处处变成两跳，还引入"父被删/被改写"的悬挂问题。复制让 child 完全自包含。

### 为什么不做 ID remap

事件里的 `toolCallId`、部分 `messageId` 本就是 provider 原生 ID（Claude 的 `tool_use_id`、Codex 的 `item.id`），不是 baton 签发的全局 ID；remap 它们没有唯一性收益，反而破坏 payload 与 `raw` 的审计对照。复制前缀既然是同一段逻辑历史，保留原 ID 恰是正确的身份表达；将来跨会话引用 turn 时用 `bs_ + t_` 限定即可消歧。`seq` 同理原样保留——边界永远是前缀（全局串行队列保证），天然连续。

### 为什么 providerSessions 只保留 provider + model / effort

`providerSessionId` / `syncedSeq` / `resumeCursor` 描述的是源会话与其原生 ProviderSession 的绑定，child 若继承会 resume 源的原生会话，导致两个 BatonSession 写进同一份 provider 历史，fork 即失效。`model` / `effort` 是用户偏好，丢掉会让 child 静默回落 provider 默认值，故单独保留。

### 为什么 recovery 挂在打开入口，且以锁为前提

recovery 的核心价值不是修 UI 状态（TUI 的 busy 来自 runtime，不来自 reduce），而是：**catch-up 与 `@` 引用只读 `_baton_turn_summary`，没有 summary 的半截 turn 对后续 provider 同步是永久盲区**。归一化动作与 `runtime.finalizeTurn` 的收口顺序一致（终态 → notice → summary）。

前提是持锁："最后事件是 running"只有在没有活进程持有会话时才能断定为崩溃残留，否则合成终态会污染另一个进程正在执行的活会话。锁只服务这个判定，不承担并发追加的完整保护（headless REPL 目前不加锁，属已知豁免）。抢锁用 `O_EXCL` 原子创建（不做"先检查再写入"，那是 TOCTOU）；锁不做进程内引用计数——约定同一进程内一个 session 至多一个活 handle，进程内并发归上层（TUI 单前台会话；将来 workspace runtime 由 session slot 唯一性保证）。

recovery 同时覆盖 fork：源会话若正在运行（或曾崩溃），复制会带进半截 turn；child 首次打开时经同一条归一化路径补上终态与 summary，`forkSession()` 自身不必关心。

### fork 的上下文保真度 = turn-summary 保真度

child 的 provider 通过补课看到的是紧凑 turn 摘要（预算内优先保最近，默认 4KB 字符），不是全量事件回放。这与既有跨 provider 接力的保真度一致，不是 fork 引入的新损耗；但用户直觉可能预期"fork = 完整带走上下文"，故显式记录。完整历史仍在 child 的 `session.jsonl` 里，随时可被更高保真的注入策略消费。

### 跨 project fork：历史跟源走，project 跟发起位置走

session 按 cwd 归入 project 只是**存放与发现的组织方式**，不是历史的属性；而 fork 的本质是"把一段逻辑历史带到新的工作现场继续"。所以两者各自跟随自己的锚点：

核心场景是跨仓排查：开发 project-a 时，排查过程发现它实际调用的 project-b 存在 bug。用户进入 project-b（包括另一个 monorepo）执行 `baton fork <project-a-session>`，即可把已经形成的调用关系、现象和判断上下文带到 project-b 继续修复，不必重新向 agent 解释问题。这里 project 由 fork 命令的执行 cwd 定义；跨 project 不是额外模式，而是源 session 的 cwd 与发起 cwd 不同所自然产生的结果。

这也是 session 归 Baton 管理、而非委托给 provider 原生 session 的直接收益：部分 provider 不允许原生 fork 跨 project，Baton 则在自身层复制逻辑历史，再到目标 cwd 创建 fresh ProviderSession 并补齐上下文，因此不依赖 provider 的跨 project fork 能力，也不修改其原生 session 文件。BatonSession 是历史真相源，ProviderSession 只是特定工作现场下的执行载体与 resume 加速路径；否则 Baton 的能力会退化成各 provider 原生能力的交集。

- **历史跟源 session 走**：复制的前缀、谱系（`forkedFrom`）都来自源，与源在哪个 project 无关。
- **project 归属跟 fork 发起位置走**：`cd project-b && baton fork bs_from_project_a`，fork 落在 project-b（`--cwd` 可覆盖）；picker fork 用启动 baton 时的 cwd。底层 `forkSession` 未显式指定目标 cwd 时仍沿用源 cwd，保持已有调用兼容。

这天然覆盖同 project fork（发起位置 == 源 project 时退化为原行为），所以不需要 `--to` 之类的显式参数。`resume` 则相反：回到会话原本的 project——resume 是"继续那个现场"，fork 是"带走历史开新现场"。

实现上只需在 fork 时把 `meta.cwd` 与落盘目录（`projectDirName(cwd)`）一起换成目标 cwd：runtime 执行工具、footer 展示、`listSessions({cwd})` 发现全都以 `meta.cwd` 为真相源，自动跟随；child 本就不 resume 源的原生 ProviderSession（fresh native + 全量补课），换 cwd 不影响上下文重建。注意落盘目录与 `meta.cwd` 必须同源，否则按目录扫描的 `listSessions({cwd})` 会漏掉该会话。

跨 project fork 只迁移会话上下文，不复制代码或工作区状态；源 project 的文件路径出现在历史里时，child 的 provider 需自行判断在新 cwd 下是否仍有效。

### 面向 /side 的预留

- `forkSession(sourceSessionId, { throughSeq })`：运行中 fork 只需传入"当前 active turn 之前"的水位，无需新入口。
- 锁按 per-session 设计，一个进程可同时持有多把（多 session workspace runtime 的前提）。
- 未决前提（workspace runtime 的入口条件）：主线与草稿共享同一 cwd 的并行写隔离方案（worktree / 只读草稿 / 显式警告）。
