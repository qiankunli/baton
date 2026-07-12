# baton 设计（v1）

baton 是一个 terminal-native 的统一 coding agent 会话：用户始终在 BatonSession 中工作，可用 `/provider` 在不同 coding agent 间切换，而不需要随 provider 一起切换或搬运会话历史。Claude Code 和 Codex 是首批内置 provider，用于打样原生协议接入，不构成封闭支持列表。

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

| 概念 | 语义 |
|------|------|
| **BatonSession** | 用户拥有的持久逻辑会话，也是跨 provider 的统一历史；所有 turn 全局串行落入同一时间线 |
| **ProviderSession** | 某个 provider 的私有执行状态。baton 优先用 `providerSessionId` 恢复，但其缺失不能阻止 BatonSession 续聊 |
| **Provider** | 可扩展的 coding agent 接入；首批内置 Claude Code / Codex，新增实现通过 registry 与 AgentAdapter 注册 |
| **Turn** | 一次用户输入到 agent 停下（含 stopReason） |
| **Message / ToolCall / Plan** | turn 内的产出，按 ID upsert（对齐 ACP v2 语义） |
| **Event** | 最小记录单元，信封结构（归一化字段 + `raw` 原始 wire 消息保真） |
| **@ 引用** | 用户 @ 的对象**永远是 baton 侧对象**（session / turn / 产物）；换算成什么形式喂给目标 agent 是 baton 内部实现 |
| **子 agent 归属** | Claude 的 Task 子会话、Codex 的子 agent 通过 `parentSessionId` / `agentId` 挂回父会话（借鉴 ai_code_report 模型） |

ID 规则：全部用带前缀的 ULID（`bs_` / `ps_` / `t_` / `m_` / `tc_`），从第一天起稳定、可外部引用——这是 @ 和将来委派的共同前提。

## 3. 问题域总览

| # | 问题 | 方案 | 状态 |
|---|------|------|------|
| 1 | 怎么驱动 Claude Code | Agent SDK（TS 宿主进程内直调，不需要 tutti 那样的 sidecar） | 已定 |
| 2 | 怎么驱动 Codex | 拉起 `codex app-server` 子进程，JSON-RPC over stdio（裸 `codex` 是交互式 TUI 不可用；简单场景可先用 `codex exec` 验证） | 已定 |
| 3 | 多家差异怎么统一 | Adapter 层：小核心 + 可选能力接口；内部事件模型对齐 ACP v2 词汇表 | 已定 |
| 4 | 登录凭证 | 零持有：子进程继承 HOME，复用本机 `~/.claude*`、`~/.codex/auth.json` | 已定 |
| 5 | 会话数据存哪 | `~/.baton/projects/<cwd 转义>/<id>/session.jsonl`（delta + turn-summary）+ `meta.json`，按项目分组（同 Claude Code）；它们承载 BatonSession 持久历史，原生会话只用于加速恢复 | 已定 |
| 6 | 外部启动的会话怎么纳管 | 三层：wire（自启会话）→ 宿主 hook 推送（Claude 支持）→ 文件监听 + 水位增量读（兜底） | 已定 |
| 7 | @ 时注入什么 | MVP 急切注入紧凑摘要（来自 turn-summary）；二期 `mention://` 句柄 + baton CLI 惰性回查 | 已定 |
| 8 | 能否直接写对方原生 session 文件 | **否决**，只读不写（见 5.4） | 已定 |
| 9 | 审批怎么闭环 | 统一 ApprovalRequest 模型，映射 SDK `canUseTool` 和 app-server `requestApproval`，TUI 弹卡片回传 | 已定 |
| 10 | token 消耗怎么算 | turn-summary 携带 usage；取数逻辑借鉴 ai_code_report（Claude 按 `message.id+requestId` 去重、Codex 反读 rollout 尾部） | 已定 |
| 11 | TUI 用什么 | UI 组件层用 chat-tui（自研开源，基于 opentui）；运行时随之选 Bun | 已定 |
| 12 | 崩溃恢复 | UI 从 session.jsonl reduce 重建；provider 原生恢复失败时，从 BatonSession 历史同步上下文 | 已定 |
| 13 | jsonl 无限增长 | 轮转策略（参考 ai_code_report：按天/大小上限）；turn-summary 行兼作快速索引 | 方向已定，参数待定 |
| 14 | codex app-server 协议漂移 | pin codex 版本区间 + 官方 schema 校验（参考 tutti `codexproto/`） | 已定 |

### 3.1 Provider 能力支持矩阵

本节记录 **baton 当前实现**，不是 provider 的完整能力列表。`原生可用` 表示上游协议已有入口但 baton 尚未接入；chat-tui 的 UI 表达能力另见其 README，不能反推 provider adapter 已闭环。

#### 用户输入与控制

| 能力 | baton 统一语义 / 入口 | Claude Code | Codex | 当前状态 |
|---|---|---|---|---|
| 普通文本 | `ContentBlock[]` → `prompt()` | SDK `query()` | `turn/start` | 已支持；当前 adapter 最终只发送 text |
| 图片等富输入 | `ContentBlock` 可表示 image | 原生协议可表达 | `UserInput` 可表达 | 未接入；TUI composer 与 adapter 均按纯文本处理 |
| 模型切换 | `/model` → `ModelConfigurable` | SDK model discovery + 下一次 `query()` 配置 | `model/list` + 下一次 `turn/start` override | 两者已支持；只影响后续 turn，不改变正在运行的 turn |
| baton 自有 slash command | command registry → baton core | 不下发 provider | 不下发 provider | 已支持 `/provider`、`/model`、`/sessions`、`/status`、`/new`、`/exit`；其中 `/model` 是 baton 统一的 provider 控制面 |
| provider-compatible slash command | 待定义 command discovery + adapter execute capability | SDK 可发现 `supportedCommands()` | 需按 app-server 能力显式映射 | 未支持；未知命令当前报错，不作为普通文本透传 |
| 中断当前 turn | `AgentAdapter.cancel()` | `Query.interrupt()` | `turn/interrupt` | 已支持 |
| 排队 follow-up | `BatonSessionRuntime` 全局 FIFO | provider 无感知 | provider 无感知 | 已支持；当前 turn 结束后才开始下一 turn |
| same-turn steer | 尚无 adapter capability | SDK 有 streaming input/control channel | `turn/steer` | 未支持；不能把排队 follow-up 标成 steer |

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
| Provider 原始输出保真 | 已映射事件的 envelope `raw` | 已支持 | 已支持 | 已映射事件保留原消息；完全未识别的通知当前会忽略 |

#### Provider 请求用户响应

| 交互 | 应有的统一语义 | Claude Code | Codex | 当前状态 |
|---|---|---|---|---|
| 工具 / 文件 / 命令授权 | `permission_request` → option → `permission_resolved` | SDK `canUseTool` | `*/requestApproval` | 两者已闭环；Claude 当前仅 allow once / deny，Codex 保留四种决策 |
| Agent 结构化提问 | `question_request` → answers → `question_resolved`（不是 permission） | `AskUserQuestion` | `item/tool/requestUserInput` | 两者已闭环；支持多问题、多选、Other / 自由文本，secret 暂不遮罩 |
| Provider 自有阻塞 dialog | 开放 kind + typed payload/result | SDK `onUserDialog` | 按具体 server request 扩展 | 未支持 |
| MCP elicitation / form | 独立 elicitation request/response | SDK `onElicitation` | `mcpServer/elicitation/request` | 未支持 |

这里必须保留四条边界：

1. **permission、user input、elicitation 是三类不同契约**。permission 决定是否允许某个动作；user input 是 agent 为继续推理索取答案；elicitation 是工具 / MCP server 索取结构化数据。不能都塞进 `ApprovalRequest`。
2. **chat-tui picker 不等于 agent question**。picker 只适合单题单选的产品命令；provider question 通过独立 QuestionCard 处理多题、多选、自由文本和 preview，secret 遮罩与超时仍待补齐。
3. **baton command 不等于 provider command**。`/provider`、`/sessions` 等由 baton core 消费；`/model` 是 baton 统一后再调用 adapter capability；Claude/Codex 私有 slash command 必须经能力发现和显式 adapter 映射，不能把未知 `/xxx` 当文本盲透传。
4. structured question 已在 baton 事件层建立独立 request/response 模型，并由 chat-tui 的对应展示形状消费；provider 原始 payload 继续放在 `raw` 中保真。

## 4. 架构总览

```
┌────────────────────────── baton (Bun 进程) ──────────────────────────┐
│  TUI (chat-tui · opentui)                                            │
│   ├─ session/provider picker │ transcript │ composer │ 审批卡片      │
│  core                                                                │
│   ├─ BatonSessionRuntime（全局 turn 队列、provider 恢复与上下文同步） │
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
    meta.json        # 标题、cwd、参与 agent、providerSession 映射、resume cursor
  watermarks/<provider>/   # 外部会话增量读水位
  logs/
```

## 5. 关键设计

### 5.1 Agent 接入与 Adapter 接口

各家用其最强的原生协议接入，统一发生在 baton 的 Adapter 层——tutti 验证过的路线（它曾用 ACP bridge 接 Codex，后退役换 app-server）。接口用"小核心 + 可选能力"模式（参考 tutti `adapter.go`），避免大接口逼出空实现：

Provider 列表是运行时 registry，不是 core 的封闭枚举。BatonSessionRuntime 只面向 `AgentAdapter` 与可选能力；增加 provider 不改变 session、turn、同步水位和事件存储语义。

```ts
interface AgentAdapter {
  readonly provider: string; // "claude-code" | "codex" | ...
  start(opts: { cwd: string; env?: Record<string, string>; resumeSessionId?: string }): Promise<ProviderSessionRef>;
  prompt(ref: ProviderSessionRef, blocks: ContentBlock[], sink: EventSink, opts: PromptOptions): Promise<void>;
  cancel(ref: ProviderSessionRef): Promise<void>;
  close(ref: ProviderSessionRef): Promise<void>;
}
// 可选能力（按需实现，core 用类型收窄探测）
interface ModelConfigurable {
  listModels(ref: ProviderSessionRef): Promise<ModelOption[]>;
  setModel(ref: ProviderSessionRef, modelId: string | null): Promise<void>;
}
interface ContextSynchronizable { syncContext(ref: ProviderSessionRef, blocks: ContentBlock[]): Promise<void> }
interface NativeSessionIdentifiable { nativeSessionId(ref: ProviderSessionRef): string | undefined }
```

- **ClaudeAdapter**：SDK `query()` 流直接转内部事件；`canUseTool` 回调转 ApprovalRequest；SDK 返回的 `session_id` 存为 providerSessionId，resume 走 SDK resume 参数。流顺序、取消、resume cursor 的处理细节参考 tutti `claude-sdk-sidecar/src/main.ts`。
- **CodexAdapter**：`initialize` → `thread/start` → `turn/start`；`item/agentMessage/delta` 等通知转内部事件；`requestApproval` 转 ApprovalRequest；`turn/interrupt` 实现 cancel。方法集与审批状态机参考 tutti `codex_appserver_adapter.go`；用官方 schema 做强类型校验并 pin codex 版本区间。

### 5.2 内部事件模型：对齐 ACP v2 词汇表，wire 不用 ACP

内部事件 schema 直接采用 ACP v2 语义——`state_update`（running / idle / requires_action + stopReason）、按 `messageId` 的消息 upsert + chunk 追加、`tool_call_update` upsert（首次即创建）、`plan_update`。这套词汇本来就是为归一化此类流设计的；ACP v2 成熟后加一个通用 AcpAdapter 即近似 1:1 接入长尾 CLI。baton 扩展事件（如 turn-summary）用 `_baton_` 前缀，遵守 ACP 的扩展约定。

**中间过程的最大公约数规范**：agent 的中间过程（思考、工具调用、文件改动、命令输出、计划）由 baton 统一定义，各 provider adapter 负责把原生形态归一进来——渲染层与存储层不允许出现 provider 分支：

| 中间过程 | 统一事件 | codex 原生形态 | claude 原生形态 |
|---|---|---|---|
| 思考 | `agent_thought(_chunk)` | `item/reasoning/*`（需 `summary:"auto"` 显式开启，completed 带全文兜底） | `thinking_delta` 流 |
| 工具调用生命周期 | `tool_call_update`（kind/status/title upsert） | `item/started` / `item/completed` | `tool_use` / `tool_result` |
| 文件改动 | tool_call content 里的 **diff 内容块**（`changes[]` + 可选 `patch`，形状对齐 ACP v2） | fileChange item 的 `changes[].diff` | Edit/Write/MultiEdit 入参合成 |
| 命令实时输出 | `tool_call_content_chunk` | `item/commandExecution/outputDelta` | 无此能力（输出随 tool_result 一次性到达） |
| 计划 | `plan_update` | `turn/plan/updated` | `TodoWrite` 工具调用归一（并抑制其工具卡） |
| 运行阶段（compacting…） | `_baton_run_status`（phase 开放字符串，null 清除） | `contextCompaction` item started/completed（并抑制其工具卡） | `system/status` 消息（SDKStatus 原生就是 phase-or-null 形状） |

归一是"最大公约数 + raw 保真"：形状统一，粒度差异（如 claude 是原始思考流、codex 是 reasoning 摘要）不掩盖，细节永远在信封 `raw` 里。

信封结构（session.jsonl 每行一条）：

```json
{"v":1,"ts":"...","batonSessionId":"bs_...","provider":"codex","providerSessionId":"...","turnId":"t_...","seq":42,"kind":"tool_call_update","payload":{...归一化...},"raw":{...原始wire消息...}}
```

`payload` 供渲染/检索/摘要；`raw` 保真（"看到所有细节"由它兜底）。`seq` 单调递增，reduce 时定序。

### 5.3 存储：BatonSession 是持久逻辑历史

- **记 delta + turn 结束追加一条 `_baton_turn_summary`**：最终消息全文、stopReason、tool call 清单、token usage、产出文件列表。一举三得：人只 grep summary 行就能读懂 session；@ 引用的紧凑投影直接取自它（把 tutti `compact_output.go` 的压缩逻辑摊销到写入时）；崩溃恢复时作为 reduce 的 checkpoint。
- **原生 resume 是优化而非前提**：`providerSessionId` 与同步水位存 `meta.json`；能恢复时增量补其它 provider 的 turn，不能恢复时新建 ProviderSession 并从 BatonSession 摘要重建上下文。
- **TUI 状态 = reduce(session.jsonl)**：upsert 语义保证重放幂等。
- 轮转：按天或大小上限拆卷（参数进 config，默认值参考 ai_code_report 的 30 天 / 50MB）。

### 5.4 各家原生 session 文件只读不写

曾考虑"把 Claude 的输出直接写进 Codex 的原生 session jsonl，@ 时给个 session id 即可"，**否决**：

1. 写入耦合无文档、随版本漂移的私有格式——读坏是降级，写坏会损坏对方 resume；
2. 伪造 agent 没经历过的历史（对方的 assistant 角色），且部分状态可能在服务端（如 response id 链），本地伪造无对应物；
3. 与运行中的 agent 进程并发写同一文件会交错损坏；
4. 急切全量 fan-out 预先吃掉目标 agent 的上下文窗口。

同一 BatonSession 内的 provider 接力由 runtime 自动经受支持的通道同步；`@` 只用于引用其它 BatonSession / turn / 产物。两者都不写 provider 私有文件。

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

本节只描述 **permission approval**。agent 主动提问、provider dialog、MCP elicitation 不复用 `ApprovalRequest`；它们的当前覆盖与目标边界见 3.1。

### 5.8 Token 统计与子 agent 归属

- turn-summary 携带 usage（input / output / cache_read / cache_write / reasoning / is_estimated），TUI 状态栏按 agent 汇总展示。
- wire 通道直接取协议 usage 字段；外部纳管通道按 ai_code_report 的取数逻辑：Claude 流式重复记录按 `message.id + requestId` 去重取最大值，Codex 反读 rollout 的 `token_count` 序列并以 `total_token_usage` 校验。
- 子 agent（Claude Task 子会话 / Codex 子 agent）事件带 `parentSessionId` / `agentId` / `agentType`，挂回父会话；@ 引用摘要默认只含父会话主线，子 agent 内容按需展开。

### 5.9 TUI

UI 组件层来自 [chat-tui](https://github.com/qiankunli/chat-tui)（从 baton 抽出的开源库，基于 opentui React reconciler）：baton 侧实现 ChatProtocol——`tui/protocol.ts` 把 runtime/store 状态投影成视图快照、把 intents 翻译成 runtime 操作；补全、分层 Ctrl+C、浮层等交互语义都在 chat-tui。当前布局为 transcript、可增长 composer、状态栏与贴近 composer 的命令 / 引用 / 审批浮层；`/sessions` 提供持久会话切换，`/new` 新建会话。

#### 界面分层：时态与寿命

界面自上而下按信息的**时态与寿命**分层——越"现在时"的信息越往下、越固定（不随历史滚动）。带 `[]` 的层是条件渲染：无内容时整层消失、不占高度。

```text
Transcript        可滚动历史（过去时；plan 块留在此层、状态原地更新；子 agent 输出折叠进工具卡）
[Plan]            全量 plan pin（有未完成项才渲染，全部完成即消失；超长时窗口对准第一个未完成项）
[Queued]          排队快照（将来时；空则不渲染；空 composer 时 ↑ 按 LIFO 撤回编辑）
Composer          输入框（现在时）
  ├ Agent Status  主行：当前输入目标（provider · model）+ 运行相位（thinking · 计时 · Esc hint）；idle 退化为目标标识
  │               附加行：其他活跃 agent / 子 agent 各一行（best-effort，结束即消失）
  ├ placeholder   空输入提示（/ commands、@ mentions；有可召回队列时提示 ↑ recall）
  └ 浮层           命令 / 引用 / 审批，锚定输入框
Footer            常驻状态栏（usage、队列计数、plan 进度摘要、cwd）
```

- **Agent Status 是输入框的地址标签，不是独立层**：`claude · default · thinking` 回答的是"下一条输入发给谁、它现在在干嘛"——运行状态是输入目标的属性，随 Composer 固定在底部，翻历史时天然可见。主行常驻（idle 只剩目标标识），运行相位是秒级现在时、只有当下有意义，只出现在这里、不落 transcript。plan 寿命不同（turn 级、值得回看），全量始终留在 transcript。
- **pin 的判断尺：只有"未完成"才 pin，且 pin 带消失规则**：`[Plan]` 层仅在有未完成项时渲染（对齐 opencode sidebar / pi-mono widget 的业界惯例），全部完成即消失；超长 plan 窗口对准第一个未完成项，保证"现在进行到哪一步"始终可见。plan 信息**不进 Agent Status 行**——相位行要求稳定短小、每秒重绘，塞可变长步骤文本会抖动（codex / opencode / pi-mono 三家也均未这么做）；进度摘要（`plan:2/4`）归 Footer。
- **语义合成在 baton projection，chat-tui 只收展示结构**：projection 的合成规则是——active provider 默认 thinking；`_baton_run_status` 的 phase 覆盖之（如 compacting，来源见 5.2 归一表）；`willRetry` 错误合成 retrying；idle 回落为目标标识主行。chat-tui 侧的 `runStatus` 只有 author / label / startedAt / hint（model 由 projection 拼进 label，chat-tui 不理解 model 概念），elapsed 跳秒由 TUI 自理，baton 只在状态变化时发快照（避免为跳秒每秒重建整个 view）。着色也走展示结构：不在协议里传颜色，author 沿用 transcript 的 `agentColorFor` 约定，同一 provider 在历史与状态行天然同色，颜色决策始终归 Theme。同理，`[Plan]` 的显隐规则（有未完成项才下发）在 projection，chat-tui 只按"非空即渲染"处理。
- **子 agent 状态是现在时的复数形式**：provider 可上报时（对齐 5.8 的 `parentSessionId` / `agentId` / `agentType` 事件），每个活跃子 agent 在 Agent Status 主行下附加一行、结束即消失；provider 不上报则只显示主行——best-effort，不做正确性承诺。`runStatus` 本就是数组，行形状已就绪。
- **run status 不塞 `state_update`、不建模成 tool_call**：前者驱动 runtime 的 busy/idle finalize（adapter 终态硬约定），是生命周期语义，混入阶段信息会污染 finalize；后者没有输入输出契约，也不值得在 transcript 占工具卡。
- **交互提示挂在交互发生地**：↑ 召回队列的提示在 composer placeholder（按键发生在 composer，且 placeholder 天然只在空输入时可见，与召回的生效条件一致），不在队列块上占一行。

输入语义刻意分开：`/provider` 选择当前输入目标，`/model` 配置该 ProviderSession 后续 turn 使用的模型，`@` 只引用 baton session / turn / 产物。所有普通输入先进入 BatonSessionRuntime 的全局串行队列，因此切换 provider 不会分裂出两条并发逻辑历史。

排队中的 turn 由 BatonSessionRuntime 单点持有，TUI 只在 composer 上方读取快照展示，避免界面状态与真实执行队列分叉。尚未开始的消息立即可见，并可在空 composer 时用 ↑ 按 LIFO 撤回编辑；正常执行仍按 FIFO，turn 被 runtime 取走开始执行后才进入持久事件流，不再允许撤回。

## 6. 里程碑

| 阶段 | 内容 | 验收 |
|------|------|------|
| M0 | 仓库骨架 + 内部事件 schema + Store（jsonl 追加/reduce/turn-summary）单测 | schema 与存储可独立测试 |
| M1 | CodexAdapter（app-server）+ 无 TUI 的 headless REPL | 终端里与 codex 对话，session.jsonl 完整落盘 |
| M2 | ClaudeAdapter（SDK）+ 审批闭环 | 双 agent 均可对话，审批卡片可用（先用简单 readline UI） |
| M3 | opentui TUI + BatonSession runtime + @ 急切注入 | 切换 / 重开 provider 可自然续聊，历史会话可打开和引用 |
| M4 | 外部会话纳管（hook install + 文件监听 + 水位） | 别的终端跑的 claude 会话出现在 rail 里且可被 @ |
| M5（二期） | `mention://` 句柄 + baton CLI 回查；互相委派 | — |

## 7. 开放问题

1. ~~Bun 下 Claude Agent SDK 兼容性~~：已验证可行（Bun 1.3 + SDK 0.3.x + 自定义 `pathToClaudeCodeExecutable`，流式/审批/resume 全通）。
2. **Claude SDK 侧 transcript 路径**：SDK 给 session_id，原生 transcript 路径需从 `~/.claude/projects/<cwd-hash>/` 推导，规则需验证稳定性。
3. **@ 摘要的 token 预算**：默认上限拍多少（初值 4KB？），超限时截断策略（保 turn-summary 的最近 N 条？）。
4. **一个 BatonSession 是否绑定单一 cwd**：MVP 绑定单 cwd（跨项目开多个 BatonSession）；多 cwd 聚合的诉求二期再评估。
5. **codex app-server 的版本 pin 策略**：跟随 codex 发版节奏的 schema 更新流程。

## 8. 参考

- `docs/provider-interaction-design.md`：基于 pi-tui/pi-agent、OpenCode、Codex 与 ACP v2 的输入、输出、用户交互和 Adapter 抽象方案

- [tutti](https://github.com/tutti-os/tutti)：打通机制参考实现。重点：`docs/architecture/agent-reference-mention-resolution.md`（@ 解析）、`docs/architecture/tutti-agent-integration-plan.md`（事件流全景）、`packages/agent/daemon/runtime/adapter.go`（Adapter 模式）、`codex_appserver_adapter.go`（Codex 接入）、`claude-sdk-sidecar/`（Claude SDK 用法）、`acp_pending.go`（审批状态机）、`services/tuttid/service/cli/providers/agentcontext/compact_output.go`（紧凑投影）
- [agent-client-protocol](https://github.com/agentclientprotocol/agent-client-protocol)：ACP 规范。重点：`docs/protocol/v2/migration.mdx`（内部事件模型的对齐目标）
- ai_code_report（字节内部）：原生会话解析参考。重点：水位增量读（`src/*/tokenWatermark.ts`）、原生格式解析（`parseClaude.ts` / `parseCodex.ts`）、hook 安装（`ai-report-hook-install`）、子 agent 归属（`parent_session_id`）
- [opentui](https://github.com/anomalyco/opentui)：TUI 框架（TS/Bun 生态）
