# AGENTS.md

## 项目定位与边界

baton 是一个 terminal-native 的统一 coding agent 会话：在一个 TUI 里切换不同 coding agent，让它们共享上下文，解决更换 agent 时手工搬运历史的痛点。Claude Code 和 Codex 是首批内置 provider，不是封闭支持列表；差异化在"上下文打通"，不是"又一个并行会话管理器"。

第一阶段只聚焦两件事：

1. **交互体验**：尽量保留单独使用 coding agent 时的输入、补全、命令、流式输出、工具调用和审批体验，baton 主要增加 `/provider` 用于切换 agent。
2. **数据打通**：BatonSession 是用户拥有的持久会话，也是跨 provider 的统一逻辑历史；只要 BatonSession 仍在，任一 provider 都应能恢复所需上下文。同一次会话内切换 provider，以及关闭后重新打开同一 BatonSession 再切换 provider，都应自然续聊，无需用户手工复制上下文或显式 `@` 当前会话。

后续演进有三个方向：

1. **多 provider 协作**：当前先支持同一 BatonSession 内由不同 provider 接力；未来可把同一任务并行分派给多个 provider，再由 baton 汇总各自结果，形成统一产出。近路径是用户驱动的草稿会话：任务进行中有新想法时，拉一个草稿会话（可换 provider）并行探索，主线不被打断。
2. **上下文收录**：主线不是全量流水账，而是用户认可的正典历史。草稿会话看到成果后，由用户决定将结论合入主线还是丢弃；丢弃不等于删除，草稿仍持久、可再引用。收录只发生在合入边界，不回溯修改已收录历史。
3. **事件驱动的长期 loop**：Claude Code / Codex 目前缺少可供外部系统统一依赖的完整唤醒机制。baton 作为 agent 驱动方，可监听代码提交、PR 合并等外部事件，重新唤醒对应会话继续后续工作；这是 loop engineering 的长期方向之一。

## 代码地图与核心模块

整体设计（对象语义、数据流、关键决策及其 why）见 `docs/design.md`，动手前先读。

```
baton/
├── docs/
│   ├── design.md            # 完整设计：问题域总表、架构、关键决策 why、里程碑
│   ├── provider-interaction-design.md # 输入/输出、用户交互与 Adapter 协议演进方案
│   └── resume-fork.md       # resume/fork 语义、会话锁与 crash recovery 的 why
├── src/
│   ├── events/              # 内部事件模型（词汇对齐 ACP v2）
│   │   ├── ids.ts           # 带前缀 ULID（bs_/ps_/t_/m_/tc_...），稳定可外部引用
│   │   └── types.ts         # 信封结构 + payload 类型 + 三态 patch 语义
│   ├── config/
│   │   └── config.ts        # ~/.baton/config.yaml 加载与默认值（env > 文件 > 默认）
│   ├── adapters/
│   │   ├── types.ts         # AgentAdapter 小核心接口 + 审批回调契约
│   │   ├── claude/
│   │   │   └── adapter.ts   # Agent SDK 进程内接入：流式/审批/resume，可执行文件可换（BATON_CLAUDE_BIN）
│   │   └── codex/
│   │       ├── jsonrpc.ts   # 行分隔 JSON-RPC peer（请求/通知/服务端请求三路分发）
│   │       └── adapter.ts   # codex app-server 接入：事件翻译、审批、usage 差分（fast-submit 语义）
│   ├── providers/
│   │   └── registry.ts      # 内置 provider 注册入口；新增 provider 不进入 session core
│   ├── context/
│   │   └── mention.ts       # @ 引用急切解析：turn-summary → 紧凑摘要 → 注入 prompt（预算截断）
│   ├── session/
│   │   ├── open.ts          # BatonSession 打开的唯一入口：新建/继续/指定 + 会话锁 + crash recovery
│   │   └── runtime.ts       # 全局 turn 队列、provider 恢复与同会话上下文同步
│   ├── commands/
│   │   └── registry.ts      # baton slash command 真相源：provider/model/session 生命周期
│   ├── store/               # 会话存储
│   │   ├── reduce.ts        # 事件流 reduce 成会话状态（TUI 渲染与崩溃恢复的来源）
│   │   └── store.ts         # session.jsonl 追加/读取 + meta.json + turn-summary 生成
│   ├── cli/
│   │   ├── bin.ts           # 统一命令入口（package.json bin）：baton / repl / resume / fork / sessions
│   │   └── main.ts          # headless REPL：bun run repl -- [--agent codex|claude] [--cwd <dir>]
│   └── tui/                 # UI 组件层来自 chat-tui（github.com/qiankunli/chat-tui，git 依赖）
│       ├── main.tsx         # 入口：参数解析 + ChatShell 装配
│       ├── protocol.ts      # ChatProtocol 实现：runtime/store → 视图投影，intents → runtime 操作
│       ├── theme.ts         # baton 配色：按 author 区分 agent 颜色（provider 语义不进 chat-tui）
│       └── mentions.ts      # @ 候选源（BatonSession 匹配）
└── tests/                   # bun test 单测
```

运行时 Bun，单包结构（不预造 package 边界）。验证命令：`bun run check`（typecheck + test）。

本地试用：仓库内 `bun install && bun link` 后全局可用 `baton`（Bun 直接跑 TS 源码，无构建步骤；不用 `bun build --compile`，opentui 原生库与 Claude SDK 的动态加载在单文件二进制下有坑）。

## 关键约定

- 各家 agent 的原生 session 文件（`~/.claude/projects/**`、`~/.codex/sessions/**`）**只读不写**，原因见 `docs/design.md`。
- 内部事件模型对齐 ACP v2 词汇表；wire 协议用各家原生协议，不强求 ACP。
- provider 是开放扩展点：当前先以 Claude Code / Codex 打样；新增 provider 应通过 registry + AgentAdapter 能力接入，不把 provider 分支下沉到 BatonSession core。
- baton 自己的 session.jsonl 承载 BatonSession 的统一逻辑历史；各家原生 ProviderSession 只是 provider 私有执行状态与恢复加速，不是 BatonSession 存续或跨 provider 恢复的前提。
- 同一 BatonSession 内的 provider 接力由 baton 自动完成；`@` 只承担跨 BatonSession / turn / 产物的显式引用。
- session / turn / message 的 ID 必须稳定可外部引用；fork 复制的前缀与源**共享对象 ID**（同一段逻辑历史，git-branch 语义），跨会话引用 turn/message 时以 `bs_ + 对象 ID` 限定消歧，why 见 `docs/resume-fork.md`。
- `/provider` 是 baton 额外提供的 agent 切换入口；其余命令与引用在能力允许时保持 provider 原生语义，由 baton/Adapter 显式映射，不做不可控的文本透传。

## References

- `docs/design.md` — 完整设计与竞品定位
- `docs/provider-interaction-design.md` — chat-tui 与 Adapter 的交互抽象方案
- `docs/resume-fork.md` — resume/fork 语义（fork=同一段逻辑历史的复制，不做 ID remap）、会话锁与 crash recovery
- 参考实现与协议规范的外部链接见 `docs/design.md` 末尾"参考"一节
