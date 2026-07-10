# AGENTS.md

## 项目定位与边界

baton 是一个 terminal-native 的多 agent 共享工作台：在一个 TUI 里同时驱动 Claude Code 和 Codex，让它们共享上下文（@ 引用彼此的会话与产物），解决多 agent 协作时手工搬运上下文的痛点。差异化在"上下文打通"，不是"又一个并行会话管理器"。

## 代码地图与核心模块

整体设计（对象语义、数据流、关键决策及其 why）见 `docs/design.md`，动手前先读。

```
baton/
├── docs/
│   └── design.md            # 完整设计：问题域总表、架构、关键决策 why、里程碑
├── src/
│   ├── events/              # 内部事件模型（词汇对齐 ACP v2）
│   │   ├── ids.ts           # 带前缀 ULID（bs_/ps_/t_/m_/tc_...），稳定可外部引用
│   │   └── types.ts         # 信封结构 + payload 类型 + 三态 patch 语义
│   ├── config/
│   │   └── settings.ts      # ~/.baton/settings.json 加载与默认值（env > 文件 > 默认）
│   ├── adapters/
│   │   ├── types.ts         # AgentAdapter 小核心接口 + 审批回调契约
│   │   ├── claude/
│   │   │   └── adapter.ts   # Agent SDK 进程内接入：流式/审批/resume，可执行文件可换（BATON_CLAUDE_BIN）
│   │   └── codex/
│   │       ├── jsonrpc.ts   # 行分隔 JSON-RPC peer（请求/通知/服务端请求三路分发）
│   │       └── adapter.ts   # codex app-server 接入：事件翻译、审批、usage 差分（fast-submit 语义）
│   ├── context/
│   │   └── mention.ts       # @ 引用急切解析：turn-summary → 紧凑摘要 → 注入 prompt（预算截断）
│   ├── commands/
│   │   └── registry.ts      # baton slash command 真相源：/provider、/model、/exit
│   ├── store/               # 会话存储
│   │   ├── reduce.ts        # 事件流 reduce 成会话状态（TUI 渲染与崩溃恢复的来源）
│   │   └── store.ts         # session.jsonl 追加/读取 + meta.json + turn-summary 生成
│   ├── cli/
│   │   ├── bin.ts           # 统一命令入口（package.json bin）：baton / baton repl / baton sessions
│   │   └── main.ts          # headless REPL：bun run repl -- [--agent codex|claude] [--cwd <dir>]
│   └── tui/
│       └── main.tsx         # chat-first TUI：/provider 切目标，/model 选模型，@ 引用上下文，Esc 中断
└── tests/                   # bun test 单测
```

运行时 Bun，单包结构（不预造 package 边界）。验证命令：`bun run check`（typecheck + test）。

本地试用：仓库内 `bun install && bun link` 后全局可用 `baton`（Bun 直接跑 TS 源码，无构建步骤；不用 `bun build --compile`，opentui 原生库与 Claude SDK 的动态加载在单文件二进制下有坑）。

## 关键约定

- 各家 agent 的原生 session 文件（`~/.claude/projects/**`、`~/.codex/sessions/**`）**只读不写**，原因见 `docs/design.md`。
- 内部事件模型对齐 ACP v2 词汇表；wire 协议用各家原生协议，不强求 ACP。
- baton 自己的 session.jsonl 是投影，resume 依赖各家原生会话。
- session / turn / message 的 ID 必须稳定可外部引用。
- `/` 只控制 baton/provider，`@` 只引用 baton 对象；不透传各家 TUI 的私有 slash command。

## References

- `docs/design.md` — 完整设计与竞品定位
- 参考实现与协议规范的外部链接见 `docs/design.md` 末尾"参考"一节
