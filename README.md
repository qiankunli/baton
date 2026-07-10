# baton

> Pass context between coding agents like a baton.

baton 是一个 terminal-native 的多 agent 共享工作台。它在同一个 TUI 中驱动 Claude Code 和 Codex，并允许一个 agent 通过 `@` 引用另一个 agent 的会话上下文，省去手工复制对话、整理 handoff 文档和重复解释背景。

baton 的重点不是同时打开更多 agent，而是让它们真正共享上下文。

## 功能

- 在同一个终端界面中使用 Claude Code 和 Codex
- 使用 `/claude`、`/codex` 快速切换 agent
- 使用 `@<session-id>` 引用历史会话，并自动注入紧凑摘要
- 统一记录消息、思考、工具调用、文件改动、计划和 token usage
- 将事件追加写入本地 `session.jsonl`，支持状态重建和后续引用
- 复用本机 Claude Code / Codex 登录态，不托管凭证
- 提供 headless REPL，方便调试 agent 接入链路

## 环境要求

- [Bun](https://bun.sh/)
- 已安装并登录至少一个受支持的 agent：
  - [Codex CLI](https://github.com/openai/codex)
  - [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview)

## 本地安装

```bash
git clone https://github.com/qiankunli/baton.git
cd baton
bun install
bun link
```

完成后可直接启动：

```bash
baton
```

也可以不 link，在仓库内运行：

```bash
bun run tui
```

## 使用

启动 TUI 后直接输入内容即可发送。

```text
/claude             切换到 Claude Code
/codex              切换到 Codex
@bs_...             引用另一个 baton 会话
Tab                 补全命令或引用
Esc                 中断当前 turn
/exit               退出
```

常用 CLI 命令：

```bash
baton                              # 启动 TUI
baton --cwd /path/to/project       # 在指定项目目录启动
baton repl --agent codex           # 使用 Codex 的 headless REPL
baton repl --agent claude          # 使用 Claude 的 headless REPL
baton sessions                     # 查看可引用的历史会话
baton help                         # 查看完整帮助
```

在输入中引用 `baton sessions` 列出的 ID：

```text
@bs_01... 根据前面 Claude 的分析实现这个功能
```

baton 会读取被引用会话的紧凑摘要，并将其作为上下文交给当前 agent。

## 配置

首次运行会生成 `~/.baton/settings.json`：

```json
{
  "defaultAgent": "codex",
  "codexCommand": ["codex", "app-server"],
  "mentionBudgetChars": 4096,
  "showThoughts": true
}
```

如果 Claude Code 使用自定义可执行文件，可以在配置中设置 `claudeExecutable`，或通过环境变量临时覆盖：

```bash
BATON_CLAUDE_BIN=/path/to/claude baton
```

配置优先级为：环境变量 > `settings.json` > 默认值。

## 数据存储

baton 的数据默认保存在 `~/.baton/`：

```text
~/.baton/
├── settings.json
└── sessions/<session-id>/
    ├── meta.json
    └── session.jsonl
```

`session.jsonl` 是用于渲染、恢复和跨 agent 引用的事件投影。各 agent 的原生会话仍由 Claude Code / Codex 管理，baton 不会修改它们的原生 session 文件。

## 开发

```bash
bun install
bun run check        # TypeScript 类型检查 + 单元测试
bun run repl -- --agent codex
bun run tui
```

项目架构、事件模型、Adapter 设计和后续里程碑见 [docs/design.md](docs/design.md)。

## License

Apache-2.0
