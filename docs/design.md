# baton 设计（v1）

baton 是一个 terminal-native 的统一 coding agent 会话：用户始终在 BatonSession 中工作，可用 `/codex`、`/claude` 直接切换 coding agent，而不需要随 harness 一起切换或搬运会话历史。Claude Code 和 Codex 是首批内置 harness，用于打样原生协议接入，不构成封闭支持列表。

命名取"指挥棒 + 接力棒"双关：编排多个 agent，并把上下文递给下一棒（npm 裸名被死包占用，发布走 scope + bin 名 `baton`）。

## 1. 定位与边界

**解决的痛点**：多 agent 协作时，人变成了 agent 之间的传话筒——把 Claude 的产出复制给 Codex、反复解释上下文、手写 PLAN.md/RESULT.md 接力。

**差异化**：赛道拥挤在"并行会话管理器"（claude-squad / agent-deck / ccmanager / Crystal 等：N 个 agent 各自隔离在 worktree/tmux，互不知晓）；上下文 handoff 的现状是手写 markdown。**terminal-native 的上下文打通目前没人做**（tutti 做了但形态是 Electron GUI）。迭代时警惕滑回"又一个会话管理器"。

**非目标（v1 明确不做）**：

- agent 互相委派（机制 tutti 已验证，有统一存储 + 稳定 ID 后近乎免费，二期做）
- worktree / 并发写文件隔离（竞品的主战场；v1 只在多 agent 同 cwd 时提示冲突风险）
- 多人 / 多设备 / 云端协作（tutti·VM 的领域）
- 遥测上报、账号体系

## 2. 概念模型

核心概念（BatonSession / Event / Turn / Adapter+Capability / Projection）、ID 规则与其绑定的不变量已上升为**内核定义**，见 `docs/kernel.md` §1。本文其余章节只描述内核之外的设计。

补充语义（不属内核承重概念）：

- **@ 引用**：用户 @ 的对象**永远是 baton 侧对象**（session / turn / 产物）；换算成什么形式喂给目标 agent 是 baton 内部实现（见 5.6）。
- **子 agent 归属**：Claude 的 Task 子会话、Codex 的子 agent 通过 `parentSessionId` / `agentId` 挂回父会话（借鉴 ai_code_report 模型，见 5.8）。
- **Message / ToolCall / Plan**：turn 内的产出，按 ID upsert（对齐 ACP v2 语义）。

## 3. 问题域总览

| # | 问题 | 方案 | 状态 |
|---|------|------|------|
| 1 | 怎么驱动 Claude Code | Agent SDK（TS 宿主进程内直调，不需要 tutti 那样的 sidecar） | 已定 |
| 2 | 怎么驱动 Codex | 拉起 `codex app-server` 子进程，JSON-RPC over stdio（裸 `codex` 是交互式 TUI 不可用；简单场景可先用 `codex exec` 验证） | 已定 |
| 3 | 多家差异怎么统一 | Adapter 层：小核心 + 可选能力接口；内部事件模型对齐 ACP v2 词汇表 | 已定 |
| 4 | 登录凭证 | 零持有：子进程继承 HOME，复用本机 `~/.claude*`、`~/.codex/auth.json` | 已定 |
| 5 | 会话数据存哪 | `~/.baton/projects/<cwd 转义>/<id>/session.jsonl`（delta + turn-summary）+ `session.log`（旁路诊断）+ `meta.json`，按项目分组（同 Claude Code）；原生会话只用于加速恢复 | 已定 |
| 6 | 外部启动的会话怎么纳管 | 三层：wire（自启会话）→ 宿主 hook 推送（Claude 支持）→ 文件监听 + 水位增量读（兜底） | 已定 |
| 7 | @ 时注入什么 | MVP 急切注入紧凑摘要（来自 turn-summary）；二期 `mention://` 句柄 + baton CLI 惰性回查 | 已定 |
| 8 | 能否直接写对方原生 session 文件 | **否决**，只读不写（见 5.4） | 已定 |
| 9 | 审批怎么闭环 | 统一 ApprovalRequest 模型，映射 SDK `canUseTool` 和 app-server `requestApproval`，TUI 弹卡片回传 | 已定 |
| 10 | token 消耗怎么算 | turn-summary 携带 usage；取数逻辑借鉴 ai_code_report（Claude 按 `message.id+requestId` 去重、Codex 反读 rollout 尾部） | 已定 |
| 11 | TUI 用什么 | UI 组件层用 chat-tui（自研开源，基于 opentui）；运行时随之选 Bun | 已定 |
| 12 | 崩溃恢复 | UI 从 session.jsonl reduce 重建；harness 原生恢复失败时，从 BatonSession 历史同步上下文 | 已定 |
| 13 | jsonl 无限增长 | 轮转策略（参考 ai_code_report：按天/大小上限）；turn-summary 行兼作快速索引 | 方向已定，参数待定 |
| 14 | codex app-server 协议漂移 | pin codex 版本区间 + 官方 schema 校验（参考 tutti `codexproto/`） | 已定 |

### 3.1 Harness 能力支持矩阵

本节记录 **baton 当前实现**，不是 harness 的完整能力列表。`原生可用` 表示上游协议已有入口但 baton 尚未接入；chat-tui 的 UI 表达能力另见其 README，不能反推 harness adapter 已闭环。

#### 用户输入与控制

用户输入不是“一次 submit”这么简单：普通 prompt、queued follow-up、same-turn steer、recall 与 interrupt 共同组成一条生命周期。当前 harness 能力、三类关键时序场景与待决边界统一见 `docs/user-input-lifecycle.md`；本节不再复制易随实现变化的状态矩阵。

#### Agent 输出

| 能力 | baton 统一事件 / 内容块 | Claude Code | Codex | 当前状态 |
|---|---|---|---|---|
| 最终回答与流式文本 | `agent_message(_chunk)` | text delta + assistant message | `item/agentMessage/delta` | 两者已支持 |
| 思考过程 | `agent_thought(_chunk)` | `thinking_delta` | `item/reasoning/*` | 两者已支持；原生粒度不同 |
| 工具生命周期 | `tool_call_update` | `tool_use` / `tool_result` | `item/started` / `item/completed` | 两者已支持 |
| 文件改动 | tool content 的 `diff` block | Edit/Write 入参合成 | fileChange `changes[].diff` | 两者已支持；Claude 为合成结果 |
| 命令实时输出 | `tool_call_content_chunk` | 无对应实时流 | command output delta | Codex 已支持；Claude 结束后一次性返回 |
| 计划 | `plan_update` | `TodoWrite` 归一 | `turn/plan/updated` | 两者已支持 |
| token usage | `usage_update` | SDK result usage | token usage 通知差分 | 两者已支持 |
| Harness 原始输出保真 | 已映射事件的 envelope `raw` | 已支持 | 已支持 | 已映射事件保留原消息；完全未识别的通知当前会忽略 |

#### Harness 请求用户响应

| 交互 | 应有的统一语义 | Claude Code | Codex | 当前状态 |
|---|---|---|---|---|
| 工具 / 文件 / 命令授权 | `Interaction{kind:permission}` opened → option → resolved | SDK `canUseTool` | `*/requestApproval` | 两者已闭环；Claude 当前仅 allow once / deny，Codex 保留四种决策 |
| Agent 结构化提问 | `Interaction{kind:question}` opened → answers → resolved（不是 permission） | `AskUserQuestion` | `item/tool/requestUserInput` | 两者已闭环；支持多问题、多选、Other / 自由文本，secret 暂不遮罩 |
| Harness 自有阻塞 dialog | 开放 kind + typed payload/result | SDK `onUserDialog` | 按具体 server request 扩展 | 未支持 |
| MCP elicitation / form | 独立 elicitation request/response | SDK `onElicitation` | `mcpServer/elicitation/request` | 未支持 |

这里必须保留四条边界：

1. **permission、question、elicitation 是不同 kind contract**。permission 决定是否允许某个动作；question 是 agent 为继续推理索取答案；elicitation 是工具 / MCP server 索取结构化数据。它们共享 Interaction identity 与 opened/resolved 生命周期，不共享万能 payload。
2. **chat-tui picker 不等于 agent question**。picker 只适合单题单选的产品命令；harness question 通过独立 QuestionCard 处理多题、多选、自由文本和 preview，secret 遮罩与超时仍待补齐。
3. **baton command 不等于 harness command**。`/codex`、`/claude`、`/sessions` 等由 baton core 消费；`/model`、`/effort`、`/compact` 是 baton 统一后再调用 adapter capability；Claude/Codex 私有 slash command 必须经能力发现和显式 adapter 映射，不能把未知 `/xxx` 当文本盲透传。
4. structured question 已成为 `Interaction{kind:question}`，由 chat-tui 的对应展示形状消费；harness 原始 payload 继续放在 `raw` 中保真。

## 4. 架构总览

```
┌────────────────────────── baton (Bun 进程) ──────────────────────────┐
│  TUI (chat-tui · opentui)                                            │
│   ├─ session picker │ transcript │ composer │ 审批卡片               │
│  core                                                                │
│   ├─ Controller（全局 turn 队列、harness 恢复与上下文同步） │
│   ├─ Session open / @ 解析 / turn-summary                            │
│   └─ Store（session.jsonl 追加写 + reduce 重建 + meta.json）          │
│  adapters                                                            │
│   ├─ ClaudeAdapter ──── @anthropic-ai/claude-agent-sdk（进程内）      │
│   ├─ CodexAdapter ───── codex app-server 子进程（JSON-RPC/stdio）     │
│   └─ (二期) AcpAdapter ─ ACP v2 通用适配，吃长尾 CLI                  │
│  observers（外部会话纳管，只读）                                       │
│   ├─ HookReceiver（宿主 hook 推送信号）                               │
│   └─ FileWatcher（原生 session 文件 + 水位增量读）                    │
└──────────────────────────────────────────────────────────────────────┘
```

数据目录：

```
~/.baton/
  config.yaml      # 用户配置（首次运行自动生成）；优先级 env > config.yaml > 默认值
  projects/<cwd 转义>/<batonSessionId>/   # 与 Claude Code 同规则按项目分组；转义不可逆，cwd 真相源在 meta.json
    session.jsonl    # 事件流（唯一合并真相源·投影）
    session.log      # harness/transport 内部诊断，不参与重放与投影
    meta.json        # 标题、cwd、参与 agent、harnessSession 映射、resume cursor
  watermarks/<harness>/   # 外部会话增量读水位
  logs/
```

## 5. 关键设计

### 5.1 Agent 接入与 Adapter 接口

Adapter 抽象（"小核心 + 可选能力"、`HarnessAdapter` 接口、能力 descriptor 与扩展契约）是**内核定义**，见 `docs/kernel.md` §4；完整契约条款见 `docs/harness-interaction-design.md`。本节只记两家首批 harness 的原生接入细节。

各家用其最强的原生协议接入，统一发生在 baton 的 Adapter 层——tutti 验证过的路线（它曾用 ACP bridge 接 Codex，后退役换 app-server）。Harness 列表是运行时 registry，不是 core 的封闭枚举。

- **ClaudeAdapter**：SDK `query()` 流直接转内部事件；`canUseTool` 回调转 ApprovalRequest；SDK 返回的 `session_id` 存为 harnessSessionId，resume 走 SDK resume 参数。流顺序、取消、resume cursor 的处理细节参考 tutti `claude-sdk-sidecar/src/main.ts`。
- **CodexAdapter**：`initialize` → `thread/start` → `turn/start`；`item/agentMessage/delta` 等通知转内部事件；`requestApproval` 转 ApprovalRequest；`turn/interrupt` 实现 cancel。方法集与审批状态机参考 tutti `codex_appserver_adapter.go`；用官方 schema 做强类型校验并 pin codex 版本区间。跨 harness catch-up 走 `turn/start.additionalContext` side-channel 随本 turn 送达（不用 `thread/inject_items` 注独立 user message——会在原生 rollout 留下无对应回合的悬空消息）。

### 5.2 内部事件模型：对齐 ACP v2 词汇表，wire 不用 ACP

Event 信封（`payload` 归一 + `raw` 保真）、"事件流是唯一真相源"、"最大公约数 + raw 保真"归一原则均为**内核定义**，见 `docs/kernel.md` §1–§2。本节只记内核之外的 schema 决策。

内部事件 schema 直接采用 ACP v2 语义——`state_update`（running / idle / requires_action + stopReason）、按 `messageId` 的消息 upsert + chunk 追加、`tool_call_update` upsert（首次即创建）、`plan_update`。这套词汇本来就是为归一化此类流设计的；ACP v2 成熟后加一个通用 AcpAdapter 即近似 1:1 接入长尾 CLI。baton 扩展事件（如 turn-summary、run status）用 `_baton_` 前缀，遵守 ACP 的扩展约定。

各家原生形态到统一事件的逐项映射（含运行阶段等短寿命状态）、终态收口与丢事件自愈见 `docs/harness-output-lifecycle.md` §2–§3；本节不复制易随 harness schema 变化的映射表。

### 5.3 存储：BatonSession 是持久逻辑历史

- **记 delta + turn 结束追加一条 `_baton_turn_summary`**：最终消息全文、stopReason、tool call 清单、token usage、产出文件列表。一举三得：人只 grep summary 行就能读懂 session；@ 引用的紧凑投影直接取自它（把 tutti `compact_output.go` 的压缩逻辑摊销到写入时）；崩溃恢复时作为 reduce 的 checkpoint。
- **原生 resume 是优化而非前提**：`harnessSessionId` 与同步水位存 `meta.json`；能恢复时增量补其它 harness 的 turn，不能恢复时新建 HarnessSession 并从 BatonSession 摘要重建上下文。
- **TUI 状态 = reduce(session.jsonl)**：upsert 语义保证重放幂等。
- 轮转：按天或大小上限拆卷（参数进 config，默认值参考 ai_code_report 的 30 天 / 50MB）。

### 5.4 各家原生 session 文件只读不写

曾考虑"把 Claude 的输出直接写进 Codex 的原生 session jsonl，@ 时给个 session id 即可"，**否决**：

1. 写入耦合无文档、随版本漂移的私有格式——读坏是降级，写坏会损坏对方 resume；
2. 伪造 agent 没经历过的历史（对方的 assistant 角色），且部分状态可能在服务端（如 response id 链），本地伪造无对应物；
3. 与运行中的 agent 进程并发写同一文件会交错损坏；
4. 急切全量 fan-out 预先吃掉目标 agent 的上下文窗口。

同一 BatonSession 内的 harness 接力由 Controller 自动经受支持的通道同步；`@` 只用于引用其它 BatonSession / turn / 产物。两者都不写 harness 私有文件。

### 5.5 外部会话纳管：hook 推送优先，文件监听兜底

baton 自己启动的会话走 wire 事件（细节最全、实时最好）。用户在别的终端裸跑的 claude / codex 会话，分两层纳管（**均只读**）：

- **宿主 hook 推送**（借鉴 ai_code_report）：`baton install claude-code` 一键往 `~/.claude/settings.json` 写 `Stop` / `PostToolUse` / `SubagentStop` hook（`async: true` + timeout，不阻塞宿主）。hook 只做轻量信号——把 session id + transcript 路径戳给 baton 常驻进程，重活（解析）留在常驻进程。注意：开源 Codex 无 hook 机制，此通道仅 Claude 可用。
- **文件监听 + 水位增量读**（兜底，Codex 外部会话唯一通道）：watch `~/.claude/projects/**`、`~/.codex/sessions/**`；每个来源一个水位文件，按 `observe → report → commit` 推进 offset，只解析追加的完整行，处理文件被替换的场景；Codex rollout 只做有界反向读尾部。整套机制照搬 ai_code_report（`src/*/tokenWatermark.ts`、`parseClaude.ts`、`parseCodex.ts`）。

### 5.6 @ 引用：解析发生在 baton 层，先急切后惰性

composer 里 `@` 触发补全，可引用对象：BatonSession / 单个 turn / turn 的产出文件。

- **MVP（急切）**：发送时读目标的 turn-summary 生成紧凑摘要，以"用户提供的材料"身份拼进目标 agent 的 prompt（归属清晰："以下是 Claude 会话摘要"）。摘要有 token 预算上限（进 config）。零额外机制；代价是快照语义 + prompt 变大，量级可控（tutti 踩的"prompt 爆炸"坑主要在文件夹递归展开，不在会话摘要）。
- **二期（惰性）**：@ 只注入 `mention://` URI；`baton install` 时往 agent 的 AGENTS.md 托管块注入用法说明，agent 看到 URI 自己调 `baton context get <uri> --json` 回查（CLI 与常驻进程走本地 IPC 或直接读 jsonl）。换来执行时最新上下文 + 按需拉取深度。tutti 的路由表（`tutti-runtime.md`）是现成模板。

### 5.7 审批闭环

统一模型：adapter 把 SDK `canUseTool` 回调 / app-server `requestApproval` 请求翻译成 `ApprovalRequest` 事件（挂起对应 turn，state → requires_action）→ TUI 弹审批卡片 → 用户选择经 `Approvable.submitApproval` 回传 → turn 恢复 running。要处理"审批被带外解决"（超时 / agent 侧取消）避免悬挂卡片，参考 tutti `acp_pending.go` 的 pending 状态机。

本节只描述 **permission approval**。agent 主动提问、harness dialog、MCP elicitation 不复用 `ApprovalRequest`；它们的当前覆盖与目标边界见 3.1。

### 5.8 Token 统计与子 agent 归属

- turn-summary 携带 usage（input / output / cache_read / cache_write / reasoning / is_estimated），TUI 状态栏按 agent 汇总展示。
- wire 通道直接取协议 usage 字段；外部纳管通道按 ai_code_report 的取数逻辑：Claude 流式重复记录按 `message.id + requestId` 去重取最大值，Codex 反读 rollout 的 `token_count` 序列并以 `total_token_usage` 校验。
- 子 agent（Claude Task 子会话 / Codex 子 agent）事件带 `parentSessionId` / `agentId` / `agentType`，挂回父会话；@ 引用摘要默认只含父会话主线，子 agent 内容按需展开。

### 5.9 TUI

UI 组件层来自 [chat-tui](https://github.com/qiankunli/chat-tui)（从 baton 抽出的开源库，基于 opentui React reconciler）：baton 侧实现 ChatProtocol——`tui/protocol.ts` 把 controller/store 状态投影成视图快照、把 intents 翻译成 controller 操作；补全、分层 Ctrl+C、浮层等交互语义都在 chat-tui。当前布局为 transcript、可增长 composer、状态栏与贴近 composer 的命令 / 引用 / 审批浮层；`/sessions` 提供持久会话切换，`/new` 新建会话。

#### 界面分层：时态与寿命

界面自上而下按信息的**时态与寿命**分层——越"现在时"的信息越往下、越固定（不随历史滚动）。带 `[]` 的层是条件渲染：无内容时整层消失、不占高度。

```text
Transcript        可滚动历史（过去时；plan 只在盖棺后落终态卡；子 agent 输出折叠进工具卡）
[Plan]            全量 plan pin（有未完成项才渲染，全部完成即消失；超长时窗口对准第一个未完成项）
[Queued]          待执行输入快照（将来时；空则不渲染）
Composer          输入框（现在时）
  ├ Target Status   单行：driven turn > background turn > 当前输入目标 idle
  ├ placeholder   空输入提示（/ commands、@ mentions）
  └ 浮层           命令 / 引用 / 审批，锚定输入框
[Feedback]        短寿命操作回执 / 错误提示（有内容才渲染；不替换 Footer）
Footer            常驻状态栏（usage、队列计数、plan 进度摘要、cwd）
```

- **Target Status 是输入框的单行状态，不是独立层**：优先显示当前 driven turn；没有 driven turn 时显示 Harness 自发的 background turn；完全空闲才回落到当前输入 Target。运行相位是秒级现在时、只有当下有意义，只出现在这里、不落 transcript。多运行者并发尚未进入当前产品范围，不提前用多行表达；plan 寿命不同（turn 级、值得回看），盖棺后落 transcript 终态卡。
- **Feedback 与 Footer 寿命不同，不互相替换**：Feedback 只承载当前操作的短寿命回执或错误（如 steer 降级、命令结果、过期请求），状态变化后即可消失；Footer 是用户随时可查的常驻会话状态，即使 Feedback 出现也必须保留。需要跨操作回看的 warning / error 不放 Feedback，应作为 notice 进入 Transcript。
- **pin 的判断尺：只有“当前 Target 的未完成 plan + 该 Target 有回合在运行”才 pin，且 pin 带消失规则**：`[Plan]` 层仅在当前输入 Target 的 plan 有未完成项、且同一 Target 处于运行态时渲染。切换 Target 后，上一 Target 的未完成 plan 卸下 pin 归 transcript；全部完成或 idle 后也同样卸下——pin 是“现在时”层，搁置即过去时，否则状态更新缺失或中途放弃时 pin 永驻，别的 Target 回合也会误将它重新激活。切回且该 Target 重新开跑时可重新上 pin。超长 plan 窗口对准第一个未完成项，保证“现在进行到哪一步”始终可见。plan 信息**不进 Target Status 行**——相位行要求稳定短小、每秒重绘，塞可变长步骤文本会抖动；进度摘要（`plan:2/4`）归 Footer。
- **plan 互补显示：同一时刻只出现在一个地方**。进行中归 pin（现在时），transcript 不渲染该 plan 卡——pin 已完整承担"进行到哪"，同屏两份是冗余，且"过去时区域里有块在实时改写"本身违背时态分层（pin 出现前它是不得已，之后失去存在理由）。全部完成 pin 停发，终态卡在 timeline 原位出现（过去时），回看长 turn 时它就是目录，@ 引用与 resume 也靠它。数据（plan_update 事件与 reduce 状态）始终全量保留，互补只是显隐规则，全部在 baton projection，chat-tui 无感知。
- **语义合成在 baton projection，chat-tui 只收展示结构**：projection 的合成规则是——active Target 默认 thinking；`_baton_run_status` 的 phase 覆盖之；`willRetry` 错误合成 retrying；idle 回落为 Target 标识主行。chat-tui 侧的 `runStatus` 只有 author / label / startedAt / hint（model 由 projection 拼进 label，chat-tui 不理解 model 概念），elapsed 跳秒由 TUI 自理，baton 只在状态变化时发快照。着色仍按 Harness 类型走展示结构：同一 Harness 的多个 Target 可同色，但状态与查询不能因此合并。同理，`[Plan]` 的显隐规则在 projection，chat-tui 只按“非空即渲染”处理。
- **子 agent 独立状态暂不投影**：harness 可上报的归属信息仍按 5.8 进入事件与历史；等多运行者并发进入产品范围后，再一起设计状态区的复数呈现。
- **run status 不塞 `state_update`、不建模成 tool_call**：前者驱动 controller 的 busy/idle finalize（adapter 终态硬约定），是生命周期语义，混入阶段信息会污染 finalize；后者没有输入输出契约，也不值得在 transcript 占工具卡。
- **输入处理只在此保留稳定边界**：chat-tui 采集 intent，Controller 拥有 pending input 与 driven turn 调度，Adapter 映射 harness 原生操作。delivery、recall、steer 与 interrupt 的当前细节和演进统一见 `docs/user-input-lifecycle.md`。

### 5.10 Harness 自发回合（observed turn）与投影单通道

turn role（driven / observed）、observed turn 的开界收界与"不进队列"、投影单通道不变量均为**内核定义**，见 `docs/kernel.md` §2 不变量 #1 与 §3 Turn 生命周期。

内核之外的 v1 产品取舍：当前 TUI 只显示一条状态，driven turn 优先于 observed turn；v1 不支持打断 observed turn（Esc 只作用于 driven turn），也不把它的唤醒来源建模成事件——留给"事件驱动 loop"方向一并设计。

## 6. 里程碑

| 阶段 | 内容 | 验收 |
|------|------|------|
| M0 | 仓库骨架 + 内部事件 schema + Store（jsonl 追加/reduce/turn-summary）单测 | schema 与存储可独立测试 |
| M1 | CodexAdapter（app-server）+ 无 TUI 的 headless REPL | 终端里与 codex 对话，session.jsonl 完整落盘 |
| M2 | ClaudeAdapter（SDK）+ 审批闭环 | 双 agent 均可对话，审批卡片可用（先用简单 readline UI） |
| M3 | opentui TUI + Controller + @ 急切注入 | 切换 / 重开 harness 可自然续聊，历史会话可打开和引用 |
| M4 | 外部会话纳管（hook install + 文件监听 + 水位） | 别的终端跑的 claude 会话出现在 rail 里且可被 @ |
| M5（二期） | `mention://` 句柄 + baton CLI 回查；互相委派 | — |

## 7. 开放问题

1. ~~Bun 下 Claude Agent SDK 兼容性~~：已验证可行（Bun 1.3 + SDK 0.3.x + 自定义 `pathToClaudeCodeExecutable`，流式/审批/resume 全通）。
2. **Claude SDK 侧 transcript 路径**：SDK 给 session_id，原生 transcript 路径需从 `~/.claude/projects/<cwd-hash>/` 推导，规则需验证稳定性。
3. **@ 摘要的 token 预算**：默认上限拍多少（初值 4KB？），超限时截断策略（保 turn-summary 的最近 N 条？）。
4. **一个 BatonSession 是否绑定单一 cwd**：单个 BatonSession 仍绑定单 cwd（`meta.cwd`）；但历史与项目归属已解耦——跨项目 fork 可把同一段逻辑历史落到另一 cwd（历史跟随 session、项目归属跟随发起 cwd，见 `docs/kernel.md` §1 与 `docs/resume-fork.md`）。单会话内多 cwd 聚合的诉求仍二期再评估。
5. **codex app-server 的版本 pin 策略**：跟随 codex 发版节奏的 schema 更新流程。

## 8. 参考

- `docs/user-input-lifecycle.md`：用户输入从 Composer 到 queue / steer / interrupt 的产品语义、当前状态与重点场景
- `docs/harness-output-lifecycle.md`：harness 输出/感知从 wire 归一到终态收口的语义、丢事件/乱序自愈、静默悬挂对账（reconcile 能力）与重点场景
- `docs/harness-interaction-design.md`：基于 pi-tui/pi-agent、OpenCode、Codex 与 ACP v2 的输入、输出、用户交互和 Adapter 抽象方案

- [tutti](https://github.com/tutti-os/tutti)：打通机制参考实现。重点：`docs/architecture/agent-reference-mention-resolution.md`（@ 解析）、`docs/architecture/tutti-agent-integration-plan.md`（事件流全景）、`packages/agent/daemon/runtime/adapter.go`（Adapter 模式）、`codex_appserver_adapter.go`（Codex 接入）、`claude-sdk-sidecar/`（Claude SDK 用法）、`acp_pending.go`（审批状态机）、`services/tuttid/service/cli/harnesses/agentcontext/compact_output.go`（紧凑投影）
- [agent-client-protocol](https://github.com/agentclientprotocol/agent-client-protocol)：ACP 规范。重点：`docs/protocol/v2/migration.mdx`（内部事件模型的对齐目标）
- ai_code_report（字节内部）：原生会话解析参考。重点：水位增量读（`src/*/tokenWatermark.ts`）、原生格式解析（`parseClaude.ts` / `parseCodex.ts`）、hook 安装（`ai-report-hook-install`）、子 agent 归属（`parent_session_id`）
- [opentui](https://github.com/anomalyco/opentui)：TUI 框架（TS/Bun 生态）
