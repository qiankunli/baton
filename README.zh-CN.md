# baton

[English](README.md) | [简体中文](README.zh-CN.md)

> 像传递接力棒一样，在 coding agents 之间传递上下文。

baton 是一个 terminal-native 的统一 coding agent 会话。你可以用 `/provider` 在不同 coding agent 间切换，而 BatonSession 始终是同一段持久对话；关闭 baton 后重新打开，也可以换一个 provider 自然续聊。Claude Code 和 Codex 是首批内置 provider，不是封闭支持列表。

各家的原生会话只是恢复加速；即使原生会话无法恢复，BatonSession 历史仍然存在。

## 理念

多 agent 协作最常见的形态，是人变成 agent 之间的传话筒：把一个 agent 的产出复制给另一个、反复解释背景、手写文档接力。baton 想把上下文变成**用户拥有的资产**，而不是锁在某个工具里的副产品。

当前已落地的两个基本点：

- **上下文打通**：BatonSession 是用户拥有的持久统一历史，跨 provider 存续。换 agent 不需要搬运上下文；各家原生会话只承担恢复加速，不是历史存续的前提。
- **原生体验**：尽量保留单独使用各 agent 时的输入、补全、流式输出、工具调用与审批体验，baton 只增加少量自己的命令（如 `/provider`）。

在此之上有三个演进方向（**均尚未实现**）：

- **多 provider 协作**：从同一会话内接力，走向把同一任务并行分派给多个 provider，结果汇回同一份统一历史。近路径是草稿会话——任务进行中有新想法时，拉一个草稿会话（可换 provider）并行探索，主线不被打断。
- **上下文收录**：主线不是全量流水账，而是用户认可的正典历史。草稿会话出了成果后，由用户决定将结论合入主线还是丢弃；丢弃不等于删除，草稿仍持久、可再引用。
- **事件驱动的长期 loop**：监听代码提交、PR 合并等外部事件，重新唤醒对应会话继续后续工作，让 agent 不止活在交互式终端里。

## 功能

- 在同一个终端界面中使用 Claude Code 和 Codex
- 使用 `/provider` 切换 Claude Code / Codex，使用 `/model` 配置当前 provider
- 使用 `/sessions` 打开历史 BatonSession，或用 `/new` 新建干净会话
- 使用 `baton -c` 继续当前项目最近会话，或用 `baton -s <id>` 打开指定会话
- 使用 `@<session-id>` 引用历史会话，并自动注入紧凑摘要
- 统一记录消息、思考、工具调用、文件改动、计划和 token usage
- 将事件追加写入本地 `session.jsonl`，支持状态重建和后续引用
- 复用本机 Claude Code / Codex 登录态，不托管凭证
- 提供 headless REPL，方便调试 agent 接入链路

## 安装与配置

环境要求：[Bun](https://bun.sh/)，以及已安装并登录至少一个受支持的 agent（[Codex CLI](https://github.com/openai/codex) / [Claude Code](https://docs.anthropic.com/en/docs/claude-code/overview)）。

```bash
git clone https://github.com/qiankunli/baton.git
cd baton
bun install
bun link   # 之后全局可用 `baton`；也可不 link，用 `bun run tui` 在仓库内运行
```

首次运行会生成 `~/.baton/config.yaml`：

```yaml
defaultAgent: codex
codexCommand:
  - codex
  - app-server
mentionBudgetChars: 4096
showThoughts: true
```

如果 Claude Code 使用自定义可执行文件，可以在配置中设置 `claudeExecutable`，或通过环境变量临时覆盖（`BATON_CLAUDE_BIN=/path/to/claude baton`）。配置优先级为：环境变量 > `config.yaml` > 默认值。

## 使用

启动 TUI 后直接输入内容即可发送。

```text
/provider            打开 provider 选择器
/provider claude     切换到 Claude Code
/provider codex      切换到 Codex
/model               打开当前 provider 的模型选择器
/model <id>          设置后续 turn 使用的模型
/sessions            打开 BatonSession 选择器
/new                 在当前项目新建 BatonSession
@bs_...               引用另一个 baton 会话
Tab                   补全命令或引用
Esc                   中断当前 turn
/exit                 退出
```

常用 CLI 命令：

```bash
baton                              # 启动 TUI
baton --cwd /path/to/project       # 在指定项目目录启动
baton -c                           # 继续当前目录最近的 BatonSession
baton -s bs_01...                  # 打开指定 BatonSession
baton repl --agent codex           # 使用 Codex 的 headless REPL
baton repl --agent claude          # 使用 Claude 的 headless REPL
baton sessions                     # 查看可引用的历史会话
baton help                         # 查看完整帮助
```

在输入中引用 `baton sessions` 列出的 ID：

```text
@bs_01... 根据前面 Claude 的分析实现这个功能
```

baton 会读取被引用会话的紧凑摘要，并将其作为上下文交给当前 provider。

## 数据存储

baton 的数据默认保存在 `~/.baton/`：

```text
~/.baton/
├── config.yaml
└── sessions/<session-id>/
    ├── meta.json
    └── session.jsonl
```

`session.jsonl` 是用于渲染、恢复、provider 接力和跨会话引用的持久逻辑历史。各 agent 的原生会话仍由 Claude Code / Codex 管理；baton 只保存其 ID 用于加速 resume，不会修改原生 session 文件。

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
