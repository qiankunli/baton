# Requirement-driven loop：baton、devloop 与外部系统的职责边界

> 状态：讨论草案。本文沉淀 baton 的长期演进方向，不改变当前 v1 “统一会话与跨 provider
> 上下文接力”的实施范围。具体模型、接口和里程碑后续继续收敛。

## 1. 原始问题

devloop 当前管理的是以 PR/MR 为粒度的开发小闭环：

```text
进入 repo → 开发 → lint/test → commit/push → PR/MR → 人工 merge
```

它希望逐步扩展到以 Requirement 为粒度的大闭环：

```text
Requirement → 开发 → 部署 → e2e/eval/perf 验收
                    ↑              ↓
                    └── 基于 verdict 纠偏
                          → 达标 → PR/MR → 人工 merge
```

大闭环不是替换小闭环。PR/MR 小闭环仍是 Requirement 大闭环内部的开发与交付子循环，
但顶层身份、状态聚合和流程推进从 PR/MR 上移到了 Requirement。一个 Requirement 还可能跨越
多个 repo、branch、PR/MR、部署环境和 agent session。

如果继续让 devloop plugin 承担全部职责，会遇到两个结构问题：

1. plugin 受 Claude Code、Codex 等宿主能力限制。HUD、外部事件唤醒、常驻任务等能力在各宿主
   上并不一致，Codex 当前尤其缺少可供 plugin 使用的原生 HUD 和完整唤醒机制。
2. Requirement、部署、验收等外部系统不属于 PR/MR 开发生命周期。把它们都接进 devloop 会让
   一个开发插件逐渐变成需求系统、部署平台、评测平台和 agent runtime 的混合体。

baton 已经拥有跨 provider 的持久 BatonSession、统一事件流、AgentAdapter 和 TUI，又是
Claude/Codex 的主动驱动方。因此更自然的方向是：**baton 承担大闭环控制面，devloop 退回为
开发子循环及其结构化状态来源。**

## 2. 选中的总体边界

```text
Requirement
    │
    ▼
baton：Requirement 级控制面
    ├── RequirementConnector：需求事实、事件与动作
    ├── Harness：Claude Code/Codex session 与智能执行
    ├── DevloopConnector：开发动作、guard 与开发状态
    ├── DeploymentConnector：部署动作、环境状态与部署事件
    ├── VerdictConnector：e2e/eval/perf 结果与验收事件
    └── Board：聚合事实、待办、健康状态和流程进度
```

### baton

baton 负责“把各能力串成一条可恢复的 Requirement loop”：

- 关联 Requirement、BatonSession、repo/PR、部署和 verdict；
- 接收并持久化外部事实与事件；
- 将相关上下文注入目标 session；
- 根据事件、Continuation 和权限策略决定展示、请求确认或调度 agent；
- 聚合并展示全局 Board；
- 保存委托、决策、执行和回执，使 loop 可追踪、可恢复。

baton 不应直接实现每个需求平台或部署平台的业务协议。它拥有编排协议与运行时，具体外部系统
仍通过 adapter/source 接入，避免 baton 演化成另一个 DevOps 巨石平台。

### devloop

devloop 保持 PR/MR 开发子循环的领域 owner：

- repo、branch、component、worktree 与 PR/MR 生命周期；
- lint/test、commit/push、code review 和开发期 guard；
- validation、review、friction、branch/PR 等结构化开发事实；
- `review_done`、`merge_blocked` 等开发领域事件的判定。

单独安装 devloop 时，它仍能完成 PR/MR 粒度的小闭环；运行在 baton 中时，它是 Requirement
大闭环里的开发能力。baton 不应长期解析 `.devloop/*.json` 的私有布局，devloop 最终需要稳定、
只读的 snapshot/event 出口。

### chat-tui

chat-tui 只消费展示快照并产生 intents。它可以提供 Board、状态栏等通用渲染能力，但不理解
Requirement、devloop、部署平台或 verdict 的领域语义；语义合成仍归 baton projection。

## 3. Harness、Connector 与 Baton

三类概念的边界是：

- **Harness**：Codex、Claude Code 等智能执行环境，负责运行和维护 agent session；
- **Connector**：Requirement、devloop、Deployment、Verdict 等外部系统接入，提供事实、事件和
  受控动作；
- **Baton**：面向 Work/Requirement 的智能工作控制面，编排 Harness 与 Connector，持久化上下文
  并推动工作闭环。

`Harness` 与 `Connector` 在 baton 编排层平级参与同一 Work loop，但不实现一个大而全的共同
接口。Harness 有 `open/submit/cancel/resume` 等 session 生命周期；Connector 按需组合
Facts/Snapshot、Events、Actions 等能力。共同扩展面先收敛事件信封、持久化与分发语义。

Harness 与 devloop 也不需要是两个独立安装或运行实例。当前更接近：

```text
CodexHarness / ClaudeCodeHarness
└── session 能力：open / submit / cancel / resume / events

DevloopConnector
├── 开发动作：lint/test/commit/PR
└── 开发状态：repo/branch/validation/review/friction
```

二者可以由同一个 plugin 交付，但概念职责仍需分开：Harness 管 agent session，
DevloopConnector 管开发领域。这样同一份开发状态可以交给不同 Harness 接续处理。

## 4. Connector 向 Harness 委托智能工作

Connector 不必自己内置 LLM。它们可以把需要智能判断的工作交给 baton，再由 baton 选择
Harness：

```text
RequirementConnector ─┐
DeploymentConnector ──┼─→ Baton control plane ─→ Harness
VerdictConnector ──────┘
```

典型任务包括：

- 将含糊需求整理成澄清问题、开发计划和验收建议；
- 根据部署日志诊断失败原因，判断修代码、重试还是请求人工介入；
- 结合 verdict、artifact 与代码 diff 提议下一轮纠偏；
- 汇总多个 Connector 的状态，生成 Requirement 当前进展与风险。

Connector 不应直接调用 Harness 或彼此调用。统一经 baton 委托，baton 才能
集中负责 session 选择、上下文组装、成本、取消、超时、审批和结果持久化。

可以先按四个能力面理解，而不是急于收敛成一个接口：

1. **Facts/Snapshot**：提供当前事实，供 Board 和 session context 使用；
2. **Events**：报告外部变化，驱动 loop；
3. **Actions/Tools**：执行需求更新、部署、验收等外部动作；
4. **Reason/Work**：Harness 消费事实，完成需要智能判断的任务。

副作用仍由资源 owner 执行。Agent 可以提出“重新部署”或“补充验收条件”的 action intent，
但最终应分别由 DeploymentConnector、RequirementConnector 在权限与审计边界内执行；agent 不直接
持有外部系统凭据或绕过 provider 修改资源。

## 5. Event 与 Baton Hook

Harness 与 Connector 都可能产生事件，Baton 自身也会产生生命周期与 Schedule 事件。为了避免
一个词同时表示事实和回调，本文先区分：

- **HarnessEvent**：agent session 中发生的执行事实；
- **ConnectorEvent**：外部领域系统报告的事实；
- **BatonEvent**：Baton 生命周期、调度与 Schedule 等内部事实；
- **HookBinding**：扩展订阅某类事件或生命周期节点，并作出反应；
- **Action**：Baton 调用 Connector 改变外部资源，是受权限约束的副作用。

```text
HarnessEvent ────┐
ConnectorEvent ──┼─→ persist/ack → Hook dispatcher
BatonEvent ──────┘                       │
                            Board / Continuation / Gate
                                        │
                              Harness ◀─┴─▶ Connector Action
```

### EventSink，而不是易失 callback

Baton 传给 Harness/Connector 的接口应叫 `EventSink` 或 `emit`，而不是注册一个只在进程内有效的
callback。两者负责报告事实，Baton 负责先持久化、去重和关联，再广播给 projection、
Continuation 与 Plugin Hook：

```text
Harness.open(..., harnessEventSink)
Connector.start(connectorEventSink)

source emit → Baton append/ack → reduce/route → HookBinding
```

`emit` 成功只表示 Baton 已可靠接收该事实，不表示后续 agent 工作或 Connector Action 已成功。
耗时处理不能阻塞 source ack；后续每一步通过 correlation/causation id 关联原始事件。

### Baton 从 Harness 接收的事件

HarnessEvent 描述 agent session 中实际发生的事。不同 Harness 的原生协议先由 adapter 归一，
Baton 不把 Claude/Codex 私有事件名暴露为稳定 Plugin API：

| 类别 | 归一事件 | 用途 |
|------|----------|------|
| Session | `harness.session.opened/resumed/closed` | session 绑定和恢复 |
| Turn | `harness.turn.started/completed/failed/cancelled` | 执行边界与 Continuation |
| Output | `harness.message.updated`、`harness.thought.updated` | 时间线和 context |
| Tool | `harness.tool.started/updated/completed` | 活动、审计和结果摘要 |
| Interaction | `harness.approval.requested/resolved`、`harness.question.requested/resolved` | 人机闭环 |
| Runtime | `harness.usage.updated`、`harness.config.updated`、`harness.notice` | 成本、能力和健康状态 |

当前 BatonSession 的 `state_update`、message/chunk、`tool_call_update`、request/resolved、
usage/config/notice 等事件已经覆盖了大部分事实形状。流式 delta 仍进入 session ledger 和
projection，但首批不逐条触发 Plugin Hook，避免高频回调造成阻塞、重复副作用和上下文放大。

`harness.tool.before` 不是通用 HarnessEvent：它要求 Harness 支持事前拦截，属于 capability-gated
的原生 Hook 点。只支持事后 tool event 的 Harness 不能伪装成可阻断。

### Baton 从 Connector 接收的事件

ConnectorEvent 分为少量通用生命周期和开放的领域事件：

| 类别 | 事件 | 用途 |
|------|------|------|
| Lifecycle | `connector.started/stopped/health_changed` | Connector 运行状态 |
| Sync | `connector.sync.completed/failed` | snapshot/cursor 同步结果 |
| Resource | `<domain>.<resource>.<event>` | 领域事实，如 `deployment.run.completed` |
| Action | `connector.action.progress/completed/failed` | Baton 请求的外部动作回执 |

领域 `kind` 必须带 Connector namespace，payload 由对应 Connector schema 定义；Baton core 只依赖
`subject/resourceRef`、scope、时间、cursor 和 provenance 等稳定信封字段。Connector 只报告自己
拥有的事实，不在事件里指定要唤醒哪个 session，也不直接调用 Harness。

### ConnectorEvent：Connector 的共同接入面

Connector 可以通过 webhook、轮询、文件监听或长连接感知变化；transport 属于各自 adapter，
Baton 只接收归一后的信封。信封至少需要表达：

```text
ConnectorEvent { eventId, connectorId, kind, subject/resourceRef, scope?,
                 occurredAt, observedAt, payload, raw?, cursor? }
```

Baton 应在 ack 前先持久化，再做 Hook 分发和 session 路由。Connector 不负责选择要唤醒哪个
BatonSession；它只报告自己的领域事实，Continuation/Binding 由 baton 解析相关性。

现有 AgentAdapter 的 `open(opts, sink)` 已经证明了“adapter 经 EventSink 向 baton 报告事件”的
方向，但不能直接拿完整 AgentAdapter 接口要求 Connector 实现。Connector 可以形成组合式贡献面：

- `events.start(emit) / close()`：可选事件源；
- `snapshot()`：可选当前事实；
- `execute(action)`：可选外部动作；
- Harness 另有 `open/submit/cancel/resume` 等 session 能力。

### Baton 自己产生的事件

BatonEvent 描述控制面做出的关联、调度和决策，是大闭环可恢复与可审计的事实：

| 类别 | 代表事件 |
|------|----------|
| Work | `work.created/bound/state_changed/completed` |
| Schedule | `schedule.registered/triggered/misfired/cancelled` |
| Continuation | `continuation.armed/matched/consumed/expired` |
| Dispatch | `turn.queued/dispatched/finalized` |
| Context | `context.assembled` |
| Action | `action.requested/authorized/completed/failed` |
| Approval | `approval.requested/resolved` |
| Plugin | `plugin.enabled/disabled/upgraded/failed` |

BatonEvent 使用过去式，表示已经落盘的事实。`context.before_submit`、`turn.before_dispatch`、
`action.before_execute` 这类事前扩展点不是事实事件，而是 Baton 在执行状态转换前主动调用的
Hook 点；Hook 的输入、决策及最终结果仍需落成 BatonEvent。

### HookBinding：消费事件或扩展 Baton 生命周期

Hook 点必须基于 baton 的稳定概念，而不是透传 Claude/Codex 的宿主 hook 名称。首批候选包括
`session.opened/closed`、`turn.before_submit/completed`、`connector_event.persisted`、
`continuation.matched`、`action.before_execute/completed`。

按行为区分四类 Hook：

1. **Transformer**：同步、限时，返回结构化 patch，例如补充有来源和预算的 context；
2. **Gate**：同步、限时，返回 allow / deny / require-confirmation；
3. **Effect**：在授权的文件、网络和 secret 边界内执行命令或 HTTP 请求，返回 effect receipt；
4. **Observer/Signal**：不持有 veto，异步执行，结果以新事件或 contribution 回流。

Hook 不直接修改 Board、projection、store 或 Harness 原生 session。Effect Hook 可以作为用户
自动化逃生口写本地文件或调用外部 API，但需要显式 capability、信任和审计；稳定、可复用且拥有
领域资源的副作用仍应提升为 Connector Action。Claude/Codex 原生 hooks 仍由
AgentAdapter/devloop 处理；Baton Hook 位于更高的 BatonSession、Turn、ConnectorEvent、
Continuation 和 Action 层，两者通过 adapter 对接。

## 6. Timer / Schedule：时间也是一等驱动源

除了用户输入和 ConnectorEvent，时间也可以驱动 Requirement loop。Connector 以及面向用户的
plugin 可以向 baton 注册声明式 Schedule，由 baton 统一持久化、触发和恢复：

```text
User Intent ───────┐
ConnectorEvent ────┼─→ Baton event pipeline → Hook / Continuation / Policy
ScheduleTriggered ─┘                              │
                                          Harness work / Connector action
```

注册方只描述“何时触发什么 intent/event”，不自行持有常驻线程，也不在 timer callback 中直接调用
Harness 或修改外部系统。触发必须先形成可追踪的 `ScheduleTriggered` 事件，再经过既有的 Hook、
Continuation、mode gate 和 Action 路径；时间到达不等于自动获得副作用权限。

首批 Schedule 至少需要表达稳定身份、owner、作用域、触发规则、时区和错过触发后的处理策略。
一次性 deadline、固定间隔和 cron 可以共享注册与持久化机制，但 runtime 内部的短时 timeout
仍是实现细节，不提升为用户可见 Schedule。

Timer 的可靠性分为三个等级：

1. baton 正在运行时按时触发；
2. baton 重启后根据持久化状态补消费或明确跳过错过的触发；
3. baton 未打开时也要求实时触发——这需要常驻 daemon。

因此 Schedule 的持久模型应在 daemon 之前建立，daemon 只是更换执行宿主，不改变注册、事件和
回放语义。Connector 的 polling 也可以由 Schedule 驱动，但读取 cursor、归一 ConnectorEvent
仍属于 Connector，不能把 polling callback 变成第二条事件旁路。

## 7. Baton Plugin API

Plugin 是可安装、可版本化、可启停的**能力包**，不是与 Harness、Connector 并列的新运行时角色。
一个 plugin 可以贡献 Connector、Hook、Schedule、Workflow 等组件；Baton 负责装载、授权、隔离和
生命周期。这样“devloop plugin”可以同时交付 DevloopConnector、开发 workflow 和相关 Hook，
但这些组件仍按各自稳定接口参与控制面。

这一定位借鉴两类现有设计：

- Codex plugin 可以打包 skills、connectors/MCP、apps 与 lifecycle hooks；非托管 hook 按定义
  hash 单独审查和信任，plugin 安装或启用不等于自动信任其 hook；
- Claude Code plugin 可以打包 skills、agents、hooks、MCP/LSP、background monitors、channels
  与 userConfig，并区分只读版本目录和跨版本持久数据目录。

Baton 不直接复制任何一家的宿主协议：Claude Code monitor 的 stdout、channel 的消息注入在
Baton 中应先归一为 ConnectorEvent；Codex/Claude 的 prompt/agent hook 在 Baton 中应返回
`WorkIntent`，再由控制面选择 Harness、组装上下文和执行权限判断。

### Plugin 可贡献的能力

```text
BatonPlugin
├── connectors     外部事实、事件与受控动作
├── hooks          Baton 稳定生命周期上的反应
├── schedules      声明式时间触发
├── workflows      用户或事件可触发的可复用工作流
├── context        有来源、预算和作用域的上下文贡献
├── projections    Board card / status 等结构化投影
├── tools          供 Harness 使用的工具或 MCP server（能力协商）
└── config         用户配置、secret 声明和 plugin 私有持久数据
```

这些都是可选 contribution，不形成一个要求所有 plugin 实现的大接口。首批只需要稳定
`connectors/hooks/schedules/config`；workflow、projection 与跨 Harness tool 注入在真实需求验证
后再开放。

### 用户视角：做事情与贡献信息

一个 Hook 可以同时拥有两条输出通道：

1. **Effect**：执行命令、写入授权范围内的本地文件、调用 HTTP API 或发送通知；
2. **Contribution**：返回结构化结果，影响 Baton 的 Board、Context、Continuation 或后续工作。

```text
Hook trigger
├── effect：file / command / HTTP
│      └── EffectReceipt → BatonEvent
└── result：structured HookResult
       ├── BoardContribution → persist → BoardProjection
       ├── ContextContribution → ContextComposer → BatonSession → Harness
       ├── Continuation / WorkIntent
       └── GateDecision
```

两者可以独立使用。例如一个 Hook 可以在 `turn.completed` 后把摘要写到本地文件；也可以不做任何
外部副作用，只返回一张 “deployment blocked” Board card 和一段下一轮要注入的 context。

Hook 不能直接拿到可变的 Board 或 Session 对象。command handler 通过 stdin 接收带 provenance
的 JSON，stdout 返回 `HookResult`，stderr 作为日志；HTTP handler 使用同一输入输出 schema。
Baton 校验结果后先落盘，再由 reducer/projection/context pipeline 生效。一个概念形状是：

```text
HookResult
├── decision?：allow / deny / require-confirmation
├── board[]：key、scope、title、status、detail、ttl
├── context[]：id、scope、content/ref、priority、freshness、sensitivity
├── events[]：带 plugin namespace 的派生事实
├── continuations[] / workIntents[]
└── effectReceipts[]：目标、结果、幂等键和错误
```

BoardContribution 必须有稳定 key、owner 和 scope，重复执行采用 upsert，plugin 禁用时可撤销；
ContextContribution 必须有预算、来源和新鲜度，只在需要时经 ContextComposer 交付，不因产生
contribution 就自动唤醒 Harness。Hook 派生事件携带 `causedByHook` 和 depth，默认不重新触发同一
binding，避免自激循环。

Effect Hook 是面向用户的低门槛扩展能力，不取代 Connector：一次性的通知、写报告、调用内部
webhook 适合 Hook；需要 cursor、重试、资源身份、Action 权限和稳定 schema 的集成应实现
Connector。

### 首批稳定 Hook 点

Hook 名称基于 Baton 自己的稳定概念，不透传 `PreToolUse`、`SessionStart` 等 Harness 私有事件：

| Hook 点 | 典型用途 | 允许的行为 |
|---------|----------|------------|
| `connector_event.persisted` | 更新关联、派生信号、通知 | Observer / Effect |
| `schedule.triggered` | 根据时间生成下一步 intent | Observer / Effect |
| `context.before_submit` | 注入 Requirement、开发或部署上下文 | Transformer |
| `continuation.matched` | 选择通知、确认或候选工作 | Transformer / Gate |
| `turn.completed` | 汇总结果、登记后续等待 | Observer / Effect |
| `action.before_execute` | 风险策略与人工确认 | Gate |
| `action.completed` | 记录回执、推进状态 | Observer / Effect |

Hook 行为分为四类：

1. **Observer**：异步观察，不能 veto；输出新 event、Continuation 或 intent；
2. **Transformer**：同步且限时，只返回该 Hook 点声明允许的结构化 patch；
3. **Gate**：同步且限时，只返回 allow / deny / require-confirmation。
4. **Effect**：在 manifest 声明且用户授权的 filesystem/network/secret 能力内执行副作用。

Plugin 不能把普通 Observer 声明成 Gate，也不能从 Hook 直接修改 store、Board 或 Harness
session。Hook 需要智能判断时返回 `WorkIntent`；需要稳定领域副作用时返回 `ActionIntent`；
低门槛用户自动化可以由 Effect Hook 直接执行，并把结果 receipt 回流 Baton。

### Harness 原生 Hook 的边界

Codex 与 Claude Code 都提供 tool/session 级原生 hooks，但事件覆盖、阻断语义和 handler 类型并不
完全一致。Baton Plugin 的可移植 API 不承诺 `tool.before/after` 一定可拦截；需要这类能力的
plugin 必须声明目标 Harness 和 capability，由对应 Harness adapter 安装原生 hook。未声明拦截
能力时，Baton 只能观察归一后的 HarnessEvent，不能把事后观察伪装成事前 Gate。

### 安装、信任与运行边界

- manifest 声明稳定 `pluginId`、版本、组件路径、所需权限、配置 schema 和依赖；
- plugin 版本目录只读，更新产生新版本目录；可写状态只进入独立的 plugin data 目录；
- secret 由 Baton 安全存储并按 capability 注入，不写入 manifest、event payload 或 hook 输出；
- project plugin 仅在 workspace trusted 后装载；command/HTTP 等可执行 Hook 按内容 hash 单独信任；
- Hook 有明确 timeout、输出大小、失败策略和 provenance；Gate 默认失败策略由 Hook 点决定，
  plugin 不能自行把安全 Gate 改成 fail-open；
- plugin 卸载或禁用时停止其 Connector、撤销 Schedule/HookBinding，并明确选择删除或保留私有数据。

官方参考：

- [Codex plugins](https://developers.openai.com/codex/plugins/build#plugin-structure)
- [Codex hooks](https://developers.openai.com/codex/config-advanced#hooks)
- [Claude Code plugins](https://code.claude.com/docs/en/plugins-reference)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)

## 8. Board 的 owner

长期形态下，Baton 是全局 Board owner。它聚合 Requirement、开发、部署、verdict、Harness
session 和自身编排状态，再通过 projection 输出给 TUI/HUD。Connector 只提供领域事实，不拼接
最终 Board 文本。

Board 与注入 Harness 的 context 必须同源但分开：

```text
ConnectorEvent / HarnessEvent / BatonEvent
                    │
              canonical state
               ┌────┴────┐
               ▼         ▼
        BoardProjection  ContextComposer
          面向用户          面向 agent
               │         │
             TUI     ContextBundle
                           │
                    BatonSession 记录
                           │
                   HarnessContextTransport
```

Board 是人类可扫读的全局投影；`ContextBundle` 是针对某个 Work、BatonSession、Harness 和 turn
按预算编译的 agent 投影。不能把 Board 文本整块塞进 prompt：用户需要的状态噪音、展示顺序和
Connector 健康信息不一定对 agent 有用，且会造成重复注入和上下文膨胀。

必须区分三个状态转换：**Board 更新不等于 context 已交付，context 可用也不等于唤醒
Harness**。事实变化先更新 projection；ContextComposer 只在 session/turn 需要时编译增量；
是否创建新 turn 仍由用户 intent 或 Continuation + mode gate 决定，避免状态刷新形成自激循环。

### Baton 自己也是 Context Contributor

Baton 不只是转发 Connector 信息。它可以根据正典事件与状态产生有 provenance 的派生信息：

- 当前 Work/Requirement 目标、阶段与完成条件；
- 已完成步骤、未决问题、blocker 和下一候选动作；
- 已 arm 的 Continuation、Schedule 与等待原因；
- 已批准/拒绝的决策及当前权限边界；
- Connector Action 回执、Harness turn 摘要和跨 Harness catch-up；
- context 水位、预算裁剪和省略说明。

派生信息必须标记 `source=baton`、`derivedFrom` 和生成时间；Baton 可以总结和判断，但不能把推断
伪装成 Connector 的外部事实。Connector、Plugin 和 Baton 内部 reducer 都可以实现
`ContextContributor`，最终由一个 `ContextComposer` 统一处理作用域、优先级、预算、新鲜度、
敏感性、去重与 provenance。

### 从 BatonSession 到 Harness

为目标 session 组装出的 context 不应冒充 `user_message`。BatonSession 至少记录
`context.assembled` 和 `context.delivered`（或等价 receipt），包含 contribution id、来源水位、
内容摘要/digest、目标 Harness 和实际 transport；敏感或大体积内容只记录受控引用，不复制进
普通事件 payload。

Harness adapter 根据 capability 选择交付方式：

1. Harness 支持独立 context sync 时调用 `syncContext`；
2. 支持随 turn 附带 context 时使用 `syncBlocks` 一类 side channel；
3. 两者都不支持时，受预算约束地 prepend 到下一次 prompt；
4. 大体积或按需信息优先提供 resource link / MCP / CLI lookup，由 Harness 在需要时读取。

当前 runtime 的跨 Harness catch-up 已经实现了前三种交付路径和 `syncedSeq` 水位语义，可以把
`buildProviderCatchUpContext()` 演进为通用 `ContextComposer`，并将现有 catch-up 作为第一个
内置 contributor。仍然坚持不写 Harness 原生 session 文件。

devloop 可以保留本地 Board/HUD 作为不经过 baton 使用时的 standalone fallback，但不应继续
发展出一套与 baton 平行的跨系统 Board。devloop 当前 `BoardRuntime.snapshot()` 一类结构化读取面
比 Claude status line 或 Codex tmux pane 更有长期价值：前者可以成为 baton 的输入，后两者只是
特定宿主的展示 transport。

## 9. 外部事件与 Continuation

外部事件到来后，仅知道“发生了什么”还不够；baton 还必须知道“哪个 Requirement/session
在等它，以及接下来准备做什么”。这里需要一个暂称 **Continuation** 的一等概念：

```text
Continuation
├── batonSessionId
├── requirementId（若已绑定）
├── source + filter
├── cursor
├── next intent
└── mode：notify-only / confirm / auto
```

目标流程：

```text
Connector 事实变化
  → 结构化 ConnectorEvent
  → baton 持久化、去重、分发 Hook 并更新 Board
  → 匹配 Continuation
  → mode / permission gate
  → 调度 Harness 或等待确认
  → 结果与外部动作回执继续进入同一事件流
```

ConnectorEvent 不一定在产生时就能关联 BatonSession，因此可能先进入 Requirement/control-plane
层的事件账本；一旦投递给某个 session，其 session-facing 表示必须进入既有
`event → append → broadcast → reduce → projection` 单通道，不能为 Board 或唤醒另建旁路。
全局事件账本与 BatonSession `session.jsonl` 的关系尚待专门设计。

### 与现有 turn origin 的关系

外部事件触发的 turn 不应冒充现有 `observed turn`。observed 表示 provider 已经自行开始活动，
baton 只是观察并划界；外部事件场景是 baton 收到事件后主动调度 provider，应进入 runtime 的
调度与权限路径。

具体可以新增 `event-triggered` origin，或把外部事件建模为一种 `Trigger Input`。名称和模型尚未
定稿，但必须保留这个语义差别：

- observed turn：已经在跑，不进 driven queue；
- event-triggered turn：由 baton 发起，需要排队、取消、mode gate 和明确终态。

## 10. devloop notify 的迁移判断

devloop 已验证 `Source`（何时产生事件）与 `Notifier`（如何投递）的有效拆分，但 transport
受宿主限制：Claude Channel 仍是手工启用的 preview 且关闭会话会丢事件；waiter 必须由 agent
显式 arm、单次触发并超时退出，且可能错过 arm 前已完成的事件。问题不在 Source 判定，而在
缺少拥有 session 生命周期和持久历史的常驻 runtime；baton 是更自然的 owner。

迁移方向不是把 `lib/notify` 原样复制到 baton：

- **留在 devloop**：PR/review/validation 等事实，以及 blocker 边沿检测、actionable review
  判定等开发领域语义；
- **移交 baton**：Source runner、持久 cursor、事件回放、session/Requirement 路由、Board、
  mode gate 和 Harness 调度；
- **逐步退休**：ChannelNotifier、StdoutNotifier、`should-arm`、waiter re-arm，以及 skill 中要求
  agent 手动建立唤醒的步骤。

baton TUI 运行时可直接监听并驱动 Harness；关闭 TUI 后仍需实时推进时才引入 daemon。
此前先持久化 source cursor，在下次启动时补消费，不把 daemon 作为第一步前置条件。

## 11. 可选方案与取舍

- **devloop 继续扩大**：能复用现有开发流，但会把宿主差异、外部协议和长驻运行塞进 plugin；不选。
- **baton 编排、devloop 提供开发能力**：复用 BatonSession、事件流、context 与 TUI；当前选择。
- **另建通用 daemon 平台**：会提前复制 baton 能力；等离线实时或多进程需求出现再考虑。

## 12. 增量演进顺序（草案）

1. devloop 提供稳定的结构化 snapshot；baton 只读接入并展示 Board，不自动续跑；
2. 定义 ConnectorEvent 信封、EventSink/ack 与少量稳定 HookBinding，不开放任意流程旁路；
3. 建立持久 cursor、声明式 Schedule、事件路由与 Continuation，先以
   `notify-only/confirm` 模式运行；
4. 将 Connector 与 Schedule 触发纳入 runtime 调度，形成可取消、可收口的 triggered turn；
5. 接入 Requirement、Deployment 与 Verdict Connector，开放受控 actions；
6. 真实需求证明必须离线实时触发时，再把事件与 Schedule runtime 下沉为 daemon。

每一步都应保持 devloop standalone 可用，并保持 BatonSession 事件流是唯一历史与投影真相源。

## 13. 待继续讨论

1. Requirement 是否成为一等对象？它与 BatonSession、Continuation 的所有权和基数是什么？
2. Connector 身份与 Facts/Events/Actions 能力如何注册，Harness registry 如何完成命名迁移？
3. devloop 稳定出口采用 CLI snapshot、事件日志、socket，还是本地 adapter？
4. ConnectorEvent 的 ack/cursor/回放如何定义，全局账本怎样关联 `session.jsonl` 而不形成双真相？
5. `notify-only/confirm/auto` 授权按 Requirement、Connector、Action 还是 session 配置？
6. event-triggered turn 与用户 driven turn 冲突时如何排队、steer 或取消？
7. 哪些事实进入 context、哪些只进 Board？devloop standalone HUD 保留到什么程度？
8. 何种实时性或可靠性指标足以触发 baton daemon？
9. 首批稳定 Hook 点及其安装、信任、超时、失败和版本兼容策略是什么？
10. Schedule 的作用域、misfire、并发、重试和幂等策略如何定义，plugin 卸载后由谁清理？
