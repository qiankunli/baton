# baton 设计（v1）

baton 是一个 terminal-native 的多 agent 共享工作台：在一个 TUI 里同时驱动 Claude Code 和 Codex（后续可扩展其它 code CLI），让它们共享上下文——你可以在给 Codex 的输入里 @ Claude 的某段会话或产物，无需手工复制粘贴或写 handoff markdown。

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
| **BatonSession** | baton 的一次工作会话，聚合对象：一次 BatonSession 里可先后或同时使用多个 agent |
| **ProviderSession** | 某个 agent（claude / codex）的一次原生会话。baton 记录 `providerSessionId` 与 resume cursor，**原生会话状态归各家产品所有**，baton 只引用不接管 |
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
| 5 | 会话数据存哪 | `~/.baton/sessions/<id>/session.jsonl`（delta + turn-summary）+ `meta.json`；jsonl 是投影，resume 依赖原生会话 | 已定 |
| 6 | 外部启动的会话怎么纳管 | 三层：wire（自启会话）→ 宿主 hook 推送（Claude 支持）→ 文件监听 + 水位增量读（兜底） | 已定 |
| 7 | @ 时注入什么 | MVP 急切注入紧凑摘要（来自 turn-summary）；二期 `mention://` 句柄 + baton CLI 惰性回查 | 已定 |
| 8 | 能否直接写对方原生 session 文件 | **否决**，只读不写（见 5.4） | 已定 |
| 9 | 审批怎么闭环 | 统一 ApprovalRequest 模型，映射 SDK `canUseTool` 和 app-server `requestApproval`，TUI 弹卡片回传 | 已定 |
| 10 | token 消耗怎么算 | turn-summary 携带 usage；取数逻辑借鉴 ai_code_report（Claude 按 `message.id+requestId` 去重、Codex 反读 rollout 尾部） | 已定 |
| 11 | TUI 用什么 | opentui（OpenCode 生产在用）；运行时随之选 Bun | 待验证 |
| 12 | 崩溃恢复 | 状态可从 session.jsonl reduce 重建；resume cursor 存 meta.json | 已定 |
| 13 | jsonl 无限增长 | 轮转策略（参考 ai_code_report：按天/大小上限）；turn-summary 行兼作快速索引 | 方向已定，参数待定 |
| 14 | codex app-server 协议漂移 | pin codex 版本区间 + 官方 schema 校验（参考 tutti `codexproto/`） | 已定 |

## 4. 架构总览

```
┌────────────────────────── baton (Bun 进程) ──────────────────────────┐
│  TUI (opentui)                                                       │
│   ├─ session rail │ transcript 视图 │ composer(@补全) │ 审批卡片      │
│  core                                                                │
│   ├─ SessionManager（BatonSession 生命周期、@ 解析、摘要生成）        │
│   ├─ EventBus（内部事件，ACP v2 词汇）                                │
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
  config.json
  sessions/<batonSessionId>/
    session.jsonl    # 事件流（唯一合并真相源·投影）
    meta.json        # 标题、cwd、参与 agent、providerSession 映射、resume cursor
  watermarks/<provider>/   # 外部会话增量读水位
  logs/
```

## 5. 关键设计

### 5.1 Agent 接入与 Adapter 接口

各家用其最强的原生协议接入，统一发生在 baton 的 Adapter 层——tutti 验证过的路线（它曾用 ACP bridge 接 Codex，后退役换 app-server）。接口用"小核心 + 可选能力"模式（参考 tutti `adapter.go`），避免大接口逼出空实现：

```ts
interface AgentAdapter {
  readonly provider: string; // "claude-code" | "codex" | ...
  start(opts: { cwd: string; env?: Record<string, string> }): Promise<ProviderSessionRef>;
  prompt(ref: ProviderSessionRef, blocks: ContentBlock[], sink: EventSink): Promise<void>;
  cancel(ref: ProviderSessionRef): Promise<void>;
  close(ref: ProviderSessionRef): Promise<void>;
}
// 可选能力（按需实现，core 用类型收窄探测）
interface Resumable { resume(ref: ProviderSessionRef): Promise<void> }
interface Approvable { submitApproval(ref: ProviderSessionRef, requestId: string, outcome: ApprovalOutcome): Promise<void> }
interface PermissionModeCapable { setPermissionMode(ref: ProviderSessionRef, mode: string): Promise<void> }
```

- **ClaudeAdapter**：SDK `query()` 流直接转内部事件；`canUseTool` 回调转 ApprovalRequest；SDK 返回的 `session_id` 存为 providerSessionId，resume 走 SDK resume 参数。流顺序、取消、resume cursor 的处理细节参考 tutti `claude-sdk-sidecar/src/main.ts`。
- **CodexAdapter**：`initialize` → `thread/start` → `turn/start`；`item/agentMessage/delta` 等通知转内部事件；`requestApproval` 转 ApprovalRequest；`turn/interrupt` 实现 cancel。方法集与审批状态机参考 tutti `codex_appserver_adapter.go`；用官方 schema 做强类型校验并 pin codex 版本区间。

### 5.2 内部事件模型：对齐 ACP v2 词汇表，wire 不用 ACP

内部事件 schema 直接采用 ACP v2 语义——`state_update`（running / idle / requires_action + stopReason）、按 `messageId` 的消息 upsert + chunk 追加、`tool_call_update` upsert（首次即创建）、`plan_update`。这套词汇本来就是为归一化此类流设计的；ACP v2 成熟后加一个通用 AcpAdapter 即近似 1:1 接入长尾 CLI。baton 扩展事件（如 turn-summary）用 `_baton_` 前缀，遵守 ACP 的扩展约定。

信封结构（session.jsonl 每行一条）：

```json
{"v":1,"ts":"...","batonSessionId":"bs_...","provider":"codex","providerSessionId":"...","turnId":"t_...","seq":42,"kind":"tool_call_update","payload":{...归一化...},"raw":{...原始wire消息...}}
```

`payload` 供渲染/检索/摘要；`raw` 保真（"看到所有细节"由它兜底）。`seq` 单调递增，reduce 时定序。

### 5.3 存储：session.jsonl 是投影，不是真相源

- **记 delta + turn 结束追加一条 `_baton_turn_summary`**：最终消息全文、stopReason、tool call 清单、token usage、产出文件列表。一举三得：人只 grep summary 行就能读懂 session；@ 引用的紧凑投影直接取自它（把 tutti `compact_output.go` 的压缩逻辑摊销到写入时）；崩溃恢复时作为 reduce 的 checkpoint。
- **resume 依赖各家原生会话**：baton 的 jsonl 只增投影；`providerSessionId` + resume cursor 存 `meta.json`，baton 重启后据此把会话接回。
- **TUI 状态 = reduce(session.jsonl)**：upsert 语义保证重放幂等。
- 轮转：按天或大小上限拆卷（参数进 config，默认值参考 ai_code_report 的 30 天 / 50MB）。

### 5.4 各家原生 session 文件只读不写

曾考虑"把 Claude 的输出直接写进 Codex 的原生 session jsonl，@ 时给个 session id 即可"，**否决**：

1. 写入耦合无文档、随版本漂移的私有格式——读坏是降级，写坏会损坏对方 resume；
2. 伪造 agent 没经历过的历史（对方的 assistant 角色），且部分状态可能在服务端（如 response id 链），本地伪造无对应物；
3. 与运行中的 agent 进程并发写同一文件会交错损坏；
4. 急切全量 fan-out 预先吃掉目标 agent 的上下文窗口。

跨 agent 上下文一律在 @ 发生时经**受支持的通道**（prompt / AGENTS.md 托管块 / CLI 回查）按需注入。

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

### 5.8 Token 统计与子 agent 归属

- turn-summary 携带 usage（input / output / cache_read / cache_write / reasoning / is_estimated），TUI 状态栏按 agent 汇总展示。
- wire 通道直接取协议 usage 字段；外部纳管通道按 ai_code_report 的取数逻辑：Claude 流式重复记录按 `message.id + requestId` 去重取最大值，Codex 反读 rollout 的 `token_count` 序列并以 `total_token_usage` 校验。
- 子 agent（Claude Task 子会话 / Codex 子 agent）事件带 `parentSessionId` / `agentId` / `agentType`，挂回父会话；@ 引用摘要默认只含父会话主线，子 agent 内容按需展开。

### 5.9 TUI

opentui（OpenCode 生产在用，组件化 + flex 布局，含 React/Solid reconciler）。布局：左侧 session rail（多会话状态一览）、中间 transcript（reduce 后的 upsert 状态渲染，流式追加）、底部 composer（@ 补全）、审批以模态卡片插入。运行时随 opentui 选 Bun。

## 6. 里程碑

| 阶段 | 内容 | 验收 |
|------|------|------|
| M0 | 仓库骨架 + 内部事件 schema + Store（jsonl 追加/reduce/turn-summary）单测 | schema 与存储可独立测试 |
| M1 | CodexAdapter（app-server）+ 无 TUI 的 headless REPL | 终端里与 codex 对话，session.jsonl 完整落盘 |
| M2 | ClaudeAdapter（SDK）+ 审批闭环 | 双 agent 均可对话，审批卡片可用（先用简单 readline UI） |
| M3 | opentui TUI + @ 急切注入 | 在 Codex 输入里 @ Claude 的会话，摘要注入生效 |
| M4 | 外部会话纳管（hook install + 文件监听 + 水位） | 别的终端跑的 claude 会话出现在 rail 里且可被 @ |
| M5（二期） | `mention://` 句柄 + baton CLI 回查；互相委派 | — |

## 7. 开放问题

1. ~~Bun 下 Claude Agent SDK 兼容性~~：已验证可行（Bun 1.3 + SDK 0.3.x + 自定义 `pathToClaudeCodeExecutable`，流式/审批/resume 全通）。
2. **opentui 对 Bun 的强绑定程度**：确认其 FFI 依赖是否允许 Node 运行。
3. **Claude SDK 侧 transcript 路径**：SDK 给 session_id，原生 transcript 路径需从 `~/.claude/projects/<cwd-hash>/` 推导，规则需验证稳定性。
4. **@ 摘要的 token 预算**：默认上限拍多少（初值 4KB？），超限时截断策略（保 turn-summary 的最近 N 条？）。
5. **一个 BatonSession 是否绑定单一 cwd**：MVP 绑定单 cwd（跨项目开多个 BatonSession）；多 cwd 聚合的诉求二期再评估。
6. **多 agent 同 cwd 并发写文件**：v1 只提示冲突风险；是否引入可选 worktree 隔离待用户反馈。
7. **codex app-server 的版本 pin 策略**：跟随 codex 发版节奏的 schema 更新流程。

## 8. 参考

- [tutti](https://github.com/tutti-os/tutti)：打通机制参考实现。重点：`docs/architecture/agent-reference-mention-resolution.md`（@ 解析）、`docs/architecture/tutti-agent-integration-plan.md`（事件流全景）、`packages/agent/daemon/runtime/adapter.go`（Adapter 模式）、`codex_appserver_adapter.go`（Codex 接入）、`claude-sdk-sidecar/`（Claude SDK 用法）、`acp_pending.go`（审批状态机）、`services/tuttid/service/cli/providers/agentcontext/compact_output.go`（紧凑投影）
- [agent-client-protocol](https://github.com/agentclientprotocol/agent-client-protocol)：ACP 规范。重点：`docs/protocol/v2/migration.mdx`（内部事件模型的对齐目标）
- ai_code_report（字节内部）：原生会话解析参考。重点：水位增量读（`src/*/tokenWatermark.ts`）、原生格式解析（`parseClaude.ts` / `parseCodex.ts`）、hook 安装（`ai-report-hook-install`）、子 agent 归属（`parent_session_id`）
- [opentui](https://github.com/anomalyco/opentui)：TUI 框架（OpenCode 生产在用，TS/Bun 生态）
