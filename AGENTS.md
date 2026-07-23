# AGENTS.md

## 项目定位与边界

baton 是一个 terminal-native 的统一 coding agent 会话：用户始终在自己拥有的 BatonSession 中工作，在一个 TUI 里切换不同 coding agent，而不需要随 harness 一起切换或搬运会话历史。它要消除“人充当 agent 之间传话筒”的工作——反复复制产出、解释上下文、手写交接文档。Claude Code 和 Codex 是首批内置 harness，不是封闭支持列表；差异化在“上下文打通”，不是“又一个并行会话管理器”，开发时要警惕滑回后者。

第一阶段只聚焦两件事：

1. **交互体验**：尽量保留单独使用 coding agent 时的输入、补全、命令、流式输出、工具调用和审批体验，baton 用 `/codex`、`/claude` 一步切换 agent。
2. **数据打通**：BatonSession 是用户拥有的持久会话，也是跨 harness 的统一逻辑历史；只要 BatonSession 仍在，任一 harness 都应能恢复所需上下文。同一次会话内切换 harness，以及关闭后重新打开同一 BatonSession 再切换 harness，都应自然续聊，无需用户手工复制上下文或显式 `@` 当前会话。

v1 明确不做 agent 互相委派、worktree / 并发写文件隔离、多人多设备云端协作、遥测上报与账号体系。它们并非永远不做，而是不应挤占第一阶段“单一逻辑会话中的原生交互与上下文接力”；多 agent 同 cwd 时只提示文件冲突风险。

后续演进有三个方向：

1. **多 harness 协作**：当前先支持同一 BatonSession 内由不同 harness 接力；未来可把同一任务并行分派给多个 harness，再由 baton 汇总各自结果，形成统一产出。近路径是用户驱动的草稿会话：任务进行中有新想法时，拉一个草稿会话（可换 harness）并行探索，主线不被打断。
2. **上下文收录**：主线不是全量流水账，而是用户认可的正典历史。草稿会话看到成果后，由用户决定将结论合入主线还是丢弃；丢弃不等于删除，草稿仍持久、可再引用。收录只发生在合入边界，不回溯修改已收录历史。
3. **事件驱动的长期 loop**：Claude Code / Codex 目前缺少可供外部系统统一依赖的完整唤醒机制。baton 作为 agent 驱动方，可监听代码提交、PR 合并等外部事件，重新唤醒对应会话继续后续工作；这是 loop engineering 的长期方向之一。首个官方 Baton Plugin `reqloop` 随产品交付但不进入 core，用 Requirement Loop 提供开箱可理解的默认故事；devloop 则下沉为 Harness Plugin，约束 Harness 内部的开发小闭环。

## 代码地图与核心模块

**稳定内核**（核心概念 / 不变量 / 流程 / 扩展契约）见 `docs/kernel.md`，动手前先读——加 harness 只碰 adapter/registry/ids 的判据在此。内核之外的完整设计见 `docs/design.md`。

```
baton/
├── docs/
│   ├── kernel.md            # 稳定内核：6 概念 + 3 不变量 + 双向流水线 + harness 扩展契约（权威入口）
│   ├── design.md            # 内核之外的完整设计：问题域总表、架构、关键决策 why、里程碑
│   ├── user-input-lifecycle.md # 用户输入：queue/steer/recall/interrupt 生命周期与待决场景
│   ├── harness-output-lifecycle.md # harness 输出/感知：归一、终态收口、丢事件自愈与对账
│   ├── approval-lifecycle.md # 审批/用户确认：审批诚实、审批人跟随 harness、人工审批与回执
│   ├── harness-interaction-design.md # 输入/输出、用户交互与 Adapter 协议演进方案
│   └── resume-fork.md       # resume/fork 语义、会话锁与 crash recovery 的 why
├── src/
│   ├── events/              # 内部事件模型（词汇对齐 ACP v2）
│   │   ├── ids.ts           # 带前缀 ULID（bs_/hs_/t_/m_/tc_...），稳定可外部引用
│   │   └── types.ts         # 信封结构 + payload 类型 + 三态 patch 语义
│   ├── config/
│   │   └── config.ts        # ~/.baton/config.yaml 加载与默认值（env > 文件 > 默认）
│   ├── adapters/
│   │   ├── types.ts         # HarnessAdapter 小核心接口 + 审批回调契约
│   │   ├── claude/
│   │   │   └── adapter.ts   # Agent SDK 进程内接入：流式/审批/resume，可执行文件可换（BATON_CLAUDE_BIN）
│   │   └── codex/
│   │       ├── jsonrpc.ts   # 行分隔 JSON-RPC peer（请求/通知/服务端请求三路分发）
│   │       └── adapter.ts   # codex app-server 接入：事件翻译、审批、usage 差分（fast-submit 语义）
│   ├── harness/
│   │   ├── registry.ts      # 内置 harness 注册入口；新增 harness 不进入 session core
│   │   └── target.ts        # HarnessTarget 与不可变 HarnessLaunchSnapshot；执行位置不与协议类型混用
│   ├── context/
│   │   └── mention.ts       # @ 引用急切解析：turn-summary → 紧凑摘要 → 注入 prompt（预算截断）
│   ├── session/
│   │   ├── open.ts          # BatonSession 打开的唯一入口：新建/继续/指定 + 会话锁 + crash recovery
│   │   └── controller.ts    # 全局 turn 队列、harness 恢复与同会话上下文同步
│   ├── commands/
│   │   └── registry.ts      # baton slash command 真相源：harness/model/session 生命周期
│   ├── store/               # 会话存储
│   │   ├── reduce.ts        # 事件流 reduce 成会话状态（TUI 渲染与崩溃恢复的来源）
│   │   └── store.ts         # session.jsonl 追加/读取 + meta.json + turn-summary 生成
│   ├── cli/
│   │   ├── launcher.cjs     # npm bin 薄启动器：调用包内 runtime，不要求用户预装 Bun
│   │   ├── bin.ts           # 统一命令入口：baton / repl / resume / fork / sessions
│   │   └── main.ts          # headless REPL：bun run repl -- [--agent codex|claude] [--cwd <dir>]
│   └── tui/                 # UI 组件层来自 chat-tui（github.com/qiankunli/chat-tui，git 依赖）
│       ├── main.tsx         # 入口：参数解析 + ChatShell 装配
│       ├── session-picker.tsx # session picker：resume/fork 无 id 的前置会话选择屏（不经过 protocol）
│       ├── protocol.ts      # ChatProtocol 实现：controller/store → 视图投影，intents → controller 操作
│       ├── theme.ts         # baton 配色：按 author 区分 agent 颜色（harness 语义不进 chat-tui）
│       └── mentions.ts      # @ 候选源（BatonSession 匹配）
└── tests/                   # bun test 单测
```

运行时 Bun，单包结构（不预造 package 边界）。验证命令：`bun run check`（typecheck + test）。

本地试用：仓库内 `bun install && bun link` 后全局可用 `baton`（Bun 直接跑 TS 源码，无构建步骤；不用 `bun build --compile`，opentui 原生库与 Claude SDK 的动态加载在单文件二进制下有坑）。

根目录 `VERSION` 记录项目内部版本；每次逻辑改动至少递增 patch version，同一轮改动只递增
一次。npm 包版本独立管理，不随 `VERSION` 自动更新。

## 关键约定

- **BatonSession 与 HarnessSession 不是同一层对象**：前者是用户拥有、跨 harness、可持久恢复的逻辑会话；后者只是某个 harness 的私有执行状态。driven turn（用户 submit）在 BatonSession 内全局串行，切换 harness 不会分裂出多条并发逻辑历史；harness 自发的 observed turn（如后台任务唤醒）与队列正交，baton 只划界记账不调度，见 `docs/kernel.md` §3。
- **事件流是统一历史的合并真相源，UI 是投影**：`session.jsonl` 记录可重放事件，TUI 状态由 reduce 重建——live 投影经 `SessionHandle.subscribe` 订阅事件流，与 resume 同一条 reduce 路径，不允许旁路投影通道（曾因 per-turn 回调这条第二通道静默丢掉 observed turn 的回复）；`meta.json` 保存定位与恢复元数据，不替代事件历史。HarnessSession 原生 resume 是加速路径，不是正确性的前提。
- **用户输入的 owner 是 SessionController，harness 执行的 owner 是 Adapter**：driven turn 出队即由 controller 落 `user_message`/`running`（原始输入进正典历史，harness 冷启动不阻塞 Transcript，preparing 可取消）；Adapter 只报告执行过程与终态，steer 成功时补 `delivery:"steer"` 的用户消息。用户输入专项语义及其 Adapter 行为契约见 `docs/user-input-lifecycle.md`；完整交互面的总体结构见 `docs/harness-interaction-design.md`。
- 各家 agent 的原生 session 文件（`~/.claude/projects/**`、`~/.codex/sessions/**`）**只读不写**，原因见 `docs/design.md`。
- 内部事件模型对齐 ACP v2 词汇表；wire 协议用各家原生协议，不强求 ACP。
- harness 中间过程按“最大公约数 + raw 保真”归一：Adapter 统一思考、工具、文件改动、命令输出、计划等展示与存储形状，粒度差异留在事件信封 `raw` 中；渲染层与存储层不出现 harness 分支。
- harness 是开放扩展点：当前先以 Claude Code / Codex 打样；新增 harness 应通过 registry + HarnessAdapter 能力接入，不把 harness 分支下沉到 BatonSession core。
- **凭证零持有**：harness 进程继承用户环境与 HOME，复用各家 CLI 已有登录态；baton 不复制、托管或另建账号凭证体系。
- **审批诚实性是产品不变量**：baton 不替 harness 定审批人默认（缺省跟随 codex 自己的解析），用户可显式覆盖；生效值只认 harness 回吐，问不出来就不声称。无论授权方是谁，状态必须全局可见、逐条决策必须有权威回执。工具终态展示必须诚实（declined 是一等终态）；adapter 翻译终态只走白名单，未知值悲观处理，未知策略旁路审批时必须发对账 notice。
- **用户安装与开发运行时分离**：普通用户统一通过 npm 安装，包内 launcher 自带所需 runtime，不暴露 Bun 前置条件；仓库开发仍使用 Bun，避免为分发方式改写开发工具链。
- 同一 BatonSession 内的 harness 接力由 baton 自动完成；`@` 只承担跨 BatonSession / turn / 产物的显式引用。
- session / turn / message 的 ID 必须稳定可外部引用；fork 复制的前缀与源**共享对象 ID**（同一段逻辑历史，git-branch 语义），跨会话引用 turn/message 时以 `bs_ + 对象 ID` 限定消歧，why 见 `docs/resume-fork.md`。
- `/codex`、`/claude` 是 baton 自有的直接 agent 切换入口；其余命令与引用在能力允许时保持 harness 原生语义，由 baton/Adapter 显式映射，不做不可控的文本透传。

- 界面按信息的**时态与寿命**分层：越是“现在时”的信息越靠下、越固定，不随历史滚动；条件层（pinned plan、队列）无内容即整层消失。这是 baton projection 与页面装配的产品语义；chat-tui 只负责按展示结构渲染。分层图与合成规则见 `docs/design.md` 5.9。

## References

- `docs/kernel.md` — 稳定内核：核心概念 / 不变量 / 流程 / harness 扩展契约（权威入口）
- `docs/design.md` — 内核之外的完整设计与竞品定位
- `docs/user-input-lifecycle.md` — 用户输入生命周期、当前 harness 能力与三类 interrupt/steer 时序场景
- `docs/harness-output-lifecycle.md` — harness 输出/感知生命周期：事件归一、终态硬约定、丢事件/乱序自愈、静默悬挂对账（reconcile 能力，Codex `thread/read.status` / Claude `backgroundTasks`）
- `docs/backlog.md` — 暂缓能力与演进触发条件（何时该做、为什么现在不做）
- `docs/harness-interaction-design.md` — chat-tui 与 Adapter 的交互抽象方案
- `docs/resume-fork.md` — resume/fork 语义（fork=同一段逻辑历史的复制，不做 ID remap）、会话锁与 crash recovery
- `docs/session-paths.md` — 主线/草稿 path 设计稿：会话树（森林表示）、写令牌、context-import 收录原语与两步走实施
- `docs/baton-v2.md` — 面向 Loop 的 v2 内核目标：作用域、可靠工作投递、上下文交付与恢复
- `docs/loop-engineering.md` — 长期 Loop Engineering 控制面：Baton Plugin / Harness Plugin、Event、Hook、Schedule、Board 与 Context 边界
- `docs/reqloop.md` — bundled `reqloop` Plugin：Requirement Loop 领域模型、内部 Connector 与预留的 Harness 驱动能力
- 参考实现与协议规范的外部链接见 `docs/design.md` 末尾"参考"一节
