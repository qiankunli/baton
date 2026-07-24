# Baton：可扩展的 Loop Engineering 控制面

> 状态：讨论草案。本文描述 Baton 的长期演进方向，不改变当前 v1“统一会话与跨
> Harness 上下文接力”的实施范围。本文统一使用 `Harness` 表示 Codex、Claude Code 等
> 智能执行环境。支撑这些能力的 v2 内核目标见 [Baton v2](./baton-v2.md)；当前已经用
> 用户驱动的 Harness submit 落下首个 Intent / Attempt / Receipt 可靠投递切片。

## 1. 要解决的问题

devloop 当前管理以 PR/MR 为粒度的开发小闭环：

```text
开发 → lint/test → commit/push → PR/MR
```

它还可以参与更大的需求闭环：

```text
需求 → 开发 → 部署 → review/eval → 修复 → 验收
```

但需求闭环只是众多 loop 中的一种。用户也可能组装发布闭环、事故处置闭环、代码迁移闭环，
甚至完全不接需求系统。因此 Baton 不应把 Requirement、Work、PR/MR 或 Deployment 固化为
核心对象；这些对象及其领域语义应由扩展提供。

真正通用的问题是：

1. 如何把多个智能执行环境和外部能力接成一条可恢复的 loop；
2. 如何让用户输入、外部事件和时间共同驱动下一步；
3. 如何把跨步骤状态持续展示给人，并按需交给 agent；
4. 如何让副作用、智能委托、审批和失败恢复走同一条可追踪路径。

因此 Baton 的目标定位是：

> **Baton 是可扩展的 Loop Engineering 控制面：编排 Harness 与 Plugin，维护事件、状态、
> 上下文和调度，使用户能够组合并运行不同领域的工作闭环。**

## 2. 总体边界

```text
                             ┌───────────────────────────┐
用户 ── Slash Command ──────▶│                           │
用户 ── Composer Intent ────▶│                           │
时间 ── Schedule ───────────▶│           Baton           │
                             │                           │
                             │ Event Ledger / Router     │
                             │ Plugin Host / Action Gate │
                             │ Scheduler / Hook Runtime  │
                             │ Board / Context Composer  │
                             │ BatonSession / Policy     │
                             └─────────┬─────────┬───────┘
                                       │         │
                Harness Work（预留）  │         │ Plugin 能力
                                       ▼         ▼
                             ┌─────────────┐  ┌──────────────┐
                             │  Harnesses  │  │   Plugins    │
                             │ Codex       │  │ reqloop      │ bundled
                             │ Claude Code │  │ other loops  │
                             │ + devloop   │  │ / utilities  │
                             └──────┬──────┘  └──────┬───────┘
                                    │ events         │ events/results
                                    └───────▶ Baton ◀┘
```

### Baton

Baton 拥有控制面，而不拥有各领域：

- 接收、持久化、去重并路由事件；
- 装载 Plugin，注册命令、能力、Hook 和 Schedule；
- 将用户或 Plugin 提出的工作委托给合适的 Harness；
- 对外部 Action 和敏感 Effect 统一做策略与审批，并为未来 Harness Work 预留同一路径；
- 维护可持久化的 Board 状态以及面向人的 Board 视图；
- 根据目标 Harness、session 和 turn 组装 ContextBundle；
- 保存意图、决策、执行与回执，使 loop 可追踪、可恢复。

Baton core 只依赖稳定的控制面信封和能力协议，不理解“需求是否完成”“部署是否健康”
或“review 是否通过”等领域判断。

### Harness

Harness 是 Codex、Claude Code 等智能执行环境的统一称呼，负责：

- agent session 的 open、submit、cancel、resume；
- message、tool、approval、usage 等原生执行事件的归一；
- 按能力接收 Baton 组装的 context；
- 执行需要代码理解、推理和工具调用的智能工作。

Harness 是专门的执行协议，不是任意 Plugin 都要实现的共同接口。一个 Plugin 包可以交付
Harness 实现，但运行时仍按 Harness 契约注册和管理。

### Plugin

Plugin 是 Baton 唯一的通用扩展、安装和运行单元。一个 Plugin 可以封装完整 loop，也可以提供
能独立使用的领域能力或用户本地自动化；划分依据是能力是否能独立演进和复用，而不是它连接了
几个外部系统。

本文未加限定的 `Plugin` 均指 **Baton Plugin**。Codex、Claude Code 等 Harness 也有自己的
Plugin 机制，两者处于不同扩展层：

- **Harness Plugin**：运行在单个 Harness 内，约束或扩展当前 agent loop；
- **Baton Plugin**：运行在 Harness 之上的控制面，观察和推进跨 session、跨系统的 loop。

devloop 属于 Harness Plugin：它规范 agent 在代码仓内完成开发、lint/test、commit 和 PR/MR，
而不是由 Baton Plugin Host 装载的控制面能力。

外部系统不再对应另一种顶层运行角色，其接入能力直接拆成更小、更明确的 Plugin 能力：

- `Resource / Query`：读取外部资源与事实；
- `EventSource`：通过 webhook、轮询、文件监听或长连接报告变化；
- `Action`：在资源 owner 的权限与审计边界内修改外部系统。

这样安装、配置、运行与能力发现都围绕同一个扩展身份，不再产生两个通常一一对应的概念。
Plugin 内部仍可以按自己的领域需要抽象适配层。例如 reqloop 用内部 Connector 隔离 Meego、
Teambition 和不同部署平台；该概念不进入 Baton manifest、runtime 或公共 Plugin API。

Baton 发行包默认带上 reqloop，给用户一条开箱可理解的 Requirement Loop；reqloop 仍保持
可配置、可禁用、可独立升级的 Plugin 边界。Baton core 不依赖 reqloop 的 Requirement、
Deployment 等领域类型，未启用 reqloop 时仍是完整的 Loop Engineering runtime。

### chat-tui

chat-tui 只消费展示快照并产生 intent。它可以提供 Board、命令选择器和状态栏等通用交互，
但不理解 Requirement、devloop、Deployment 或 Review 的领域语义。

## 3. Plugin 模型

### Package 与 Instance

需要区分不可变交付物和带配置的运行实例：

```text
PluginPackage
├── pluginId / version / manifest
├── commands / resources / actions / hooks / schedules
├── requested operations
└── executable assets

PluginInstance
├── package reference
├── instanceId
├── config / credentials / permissions
└── private runtime state
```

同一个包可以有多个实例，例如 `deploy@dev`、`deploy@prod`、
`requirement@company-a`。Event、Action、Schedule 和 Board contribution 都引用
`pluginInstanceId`，避免把账号、环境和安装包身份混在一起。

Plugin manifest 还要声明它可能向用户申请哪些操作，例如“开始开发”“部署到 dev”“关闭需求”。
声明只是让能力和风险提前可见，不等于获得执行权限；未声明的操作不能在运行时临时扩大授权面。

### 可贡献的能力

```text
BatonPlugin
├── slashCommands        用户直接发起的交互入口
├── resources / queries  列表、详情和只读事实
├── eventSources         外部变化进入 Baton 的入口
├── eventSubscribers     订阅 Baton 中已持久化的事件
├── actions              改变外部资源的受控副作用
├── schedules            声明式时间触发
├── hooks                Baton 稳定生命周期上的扩展点
├── board                共享协作状态贡献
├── context              可选：交付时的筛选、补充或私有材料
├── harnessWork?         预留：请求 Baton 委托智能工作
└── harnesses?           可选交付新的 Harness 实现
```

这些能力均可选，不形成一个要求所有 Plugin 实现的大接口。Plugin 可以在一个内聚的 loop
内部组合多个外部系统；只有某项能力已经能被多个 loop 独立复用时，才值得拆成单独 Plugin。
跨 Plugin 编排统一回到 Baton，不直接互调。

### Baton Plugin 与 Harness Plugin

Codex 和 Claude Code 的 Plugin 主要扩展当前 Harness 内正在运行的 agent，例如提供 skill、
tool、hook 和 command。Baton Plugin 位于 Harness 之上的控制面，长期可以额外开放一项能力：
**根据用户输入、外部事件、Schedule 或领域状态，请求启动、恢复或继续 Harness 工作。**

```text
Codex / Claude Code Plugin
  → 扩展当前 agent 能做什么

Baton Plugin
  → 观察 loop
  → 未来产生 HarnessWorkIntent
  → Baton 选择/恢复 Harness，组装 context 并调度 turn
```

这项能力当前只保留设计位置，不进入首期 Plugin API。先实现 reqloop 的 command、event、
action、schedule、Board 和 Context 路径；只有真实工作区证明某些步骤必须在无人输入时主动
唤醒 Harness，才实现 `HarnessWorkIntent`。

届时 Baton 放开的仍是受控的 Harness 驱动能力，而不是 `HarnessAdapter`/Harness 的裸句柄：
Plugin 只能提交 `HarnessWorkIntent`，由 Baton 统一执行路由、权限、成本、并发、取消、审批、
上下文交付和结果持久化。

### Slash Command

Plugin 可以注册 `/requirement`、`/deploy` 等 slash command。命令 handler 返回结构化结果或
intent，而不是直接控制 TUI：

- 列表、表单和选择项由 Baton 渲染；
- 选中资源可以产生 BoardContribution；
- 需要外部副作用时产生 ActionIntent；
- 需要智能判断时先准备 ContextContribution 并引导用户启动 Harness；未来需要自动续跑时再产生
  HarnessWorkIntent。

这使“查看需求并放入 Board”成为 Plugin 能力，而不是 Requirement 进入 Baton core 的理由。

## 4. Event、Action 与智能委托

### 统一事件信封

Harness、Plugin、Baton、用户和 Schedule 都可以产生事件。事件来源显式表达：

```ts
type EventScope =
  | { type: "session"; batonSessionId: string }
  | { type: "workspace"; workspaceId: string };

type EventSource =
  | { type: "baton" }
  | { type: "harness"; harnessTargetId: string }
  | { type: "plugin"; pluginInstanceId: string }
  | { type: "user" }
  | { type: "schedule"; scheduleId: string };

type EventEnvelope = {
  v: 3;
  eventId: string;
  scope: EventScope;
  ts: string;
  seq: number;
  source: EventSource;
  parentEventId?: string;
  // harness / harnessTargetId / harnessSessionId / turnId 是可选执行坐标
  kind: string;
  payload: unknown;
  raw?: unknown;
};
```

`eventId` 是事实的稳定身份；`scope` 表示它归属哪个权威 ledger；`source` 表示谁对事实负责。
三者分别回答“哪条事实 / 属于哪里 / 谁报告”，都不等同于 payload 中的行为主体，也不替代
`harnessTargetId`、`turnId` 等执行坐标。当前 SessionHandle 写 session scope；workspace
ledger 落地后再启用 workspace scope。fork 复制同一段逻辑历史时保留领域对象 id；Event
envelope 因进入 child ledger 而重新签发 event id 并更换 session scope。

Event 本身就是持久、可重放的事实，不再为它另造平行名字。wake、文件通知和
projection invalidation 是可合并的 signal：它们只提示消费者读取权威状态，不通过
EventSink 冒充已经发生的事实，也不能直接驱动 reducer。

领域事件使用 namespace，例如：

```text
requirement.updated
harness.delivery.ready
deployment.completed
review.changes_requested
```

Baton core 只理解 event id、scope、source、subject/resource reference、时间、
`parentEventId`、payload schema 和 provenance 等稳定信封字段，不解释领域 payload。

各来源通过自己的宿主入口报告 Event 草稿，宿主在可信边界盖上不可伪造的 `source`：

```text
source emit draft
  → Baton stamp source + append + dedupe
  → ack source
  → reduce / project / dispatch
  → Plugin subscriber / Hook / Policy
```

先持久化再分发。`emit` 成功只表示 Baton 已可靠接收事实，不表示下游 Action 或 Harness Work
已经成功。高频 message/tool delta 可以进入 session ledger 和 projection，但默认不逐条触发
Plugin，避免回调风暴。

### Action

Action 表示由资源 owner 执行的外部副作用。Baton 将请求直接路由到 PluginInstance：

```ts
type ActionIntent = {
  target: {
    pluginInstanceId: string;
    action: string;
  };
  subjectRef?: ResourceRef;
  input: unknown;
  idempotencyKey: string;
  approvalPolicy?: ApprovalPolicy;
};
```

Plugin 返回可持久化的 `ActionReceipt`。Action 必须经过权限、审批、幂等和审计路径；
Harness 可以提出“重新部署”或“关闭需求”，但不直接持有外部系统凭据，也不绕过资源 owner。

### Harness Work（预留）

Plugin 不需要自己内置 LLM。首期由用户在 composer 中启动 Harness，Plugin 只贡献目标、证据和
建议动作。未来若 reqloop 的真实工作区出现必须自动续跑的步骤，再由 Plugin 返回
`HarnessWorkIntent`，并由 Baton 负责：

- 选择或请求用户选择 Harness/session；
- 组装 Board、Plugin 和 Baton 自身贡献的 context；
- 应用成本、权限、并发、取消和超时策略；
- 持久化执行结果，并把结果以事件或 contribution 送回 loop。

例如需求澄清、部署失败诊断、review 修复和多系统状态总结都可以委托给 Harness。

## 5. Hook 与 Schedule

### Baton 可以提供的 Hook

Hook 面向 Baton 自己的稳定生命周期，不照搬 `PreToolUse`、`SessionStart` 等 Harness 私有
事件名。候选 Hook 点包括：

| Hook 点 | 用途 |
|---------|------|
| `event.persisted` | 观察领域事实、派生 contribution 或 intent |
| `schedule.triggered` | 根据时间生成下一步 |
| `context.before_deliver` | 补充或裁剪待交付 context |
| `harness_work.before_dispatch` | 应用路由、策略与确认 |
| `harness_turn.completed` | 汇总结果、登记后续等待 |
| `action.before_execute` | 风险控制与人工确认 |
| `action.completed` | 处理回执、更新状态 |
| `board.changed` | 响应持久状态变化，而非 UI repaint |

Hook 行为分四类：

1. **Observer**：异步观察，返回新 Event、Contribution 或 Intent；
2. **Transformer**：同步且限时，只返回 Hook 点允许的结构化 patch；
3. **Gate**：同步且限时，返回 allow、deny 或 require-confirmation；
4. **Effect**：在 manifest 声明且用户授权的 filesystem、network 和 secret 边界内执行副作用。

从用户视角，Hook 既可以写本地文件、调用 API、发送通知，也可以返回结构化结果改变
Board 或下一次 Harness context。Hook 不直接拿到可变的 Board、session 或 store：

```text
Hook trigger
├── Effect → file / command / HTTP → EffectReceipt
└── HookResult
    ├── Event
    ├── BoardContribution
    ├── ContextContribution
    ├── ActionIntent
    ├── HarnessWorkIntent（预留）
    └── GateDecision
```

Baton 校验 HookResult 并先落盘，再由 reducer、projection 和调度链路生效。派生事件携带
`parentEventId` 和 depth，默认不重新触发同一 binding，避免自激循环。

Harness 原生 Hook 仍由对应 Harness adapter 对接。只有原生支持事前拦截的 Harness，才能向
Baton 声明 tool-before 等 capability；事后事件不能伪装成可阻断的 Gate。

### Schedule

Plugin 可以注册声明式 Schedule，由 Baton 统一持久化、触发和恢复。注册方只描述“何时触发
什么事件或 intent”，不自行持有常驻线程，也不在 timer callback 中绕过 Baton 修改外部系统。

```text
Schedule due
  → schedule.triggered 持久化
  → Plugin subscriber / Hook
  → ActionIntent 或 HarnessWorkIntent（预留）
  → Policy / Approval / Dispatch
```

一次性 deadline、固定间隔和 cron 共享同一模型；Baton 需要定义 misfire、并发、重试和幂等
语义。运行可靠性可以增量演进：

1. Baton 运行时按时触发；
2. Baton 重启后补消费或明确跳过错过的触发；
3. Baton 未打开时仍实时触发，此时再引入常驻 daemon。

Plugin 的 polling 也可以由 Schedule 驱动，但 cursor 和领域事件归一仍属于 PluginInstance，
不能让 timer callback 形成第二条事件旁路。

## 6. Board、Context 与 BatonSession

### Board 是共享协作面

Baton 拥有持久化、可查询的 `BoardState`，并从中生成面向人的 `BoardView`。Board 不只是 UI，
也不是某个 Plugin 的私有状态；它是 Baton、Plugin 与多个 Harness 交换协作信息的公共平面：

> 可以把 Board 理解成办案团队的“案件板”：不同参与者把线索、进展、结论、待核实项和关系放到
> 同一个可见空间，其他参与者据此整理认知并决定下一步。它是一种信息交互、整理和展示方式，
> 但不是系统唯一的通信或存储方式。

1. 向用户展示目标、进度、结果、blocker 和待处理事项；
2. 作为 ContextComposer 为目标 Harness 选择和编译 context 的主要来源；
3. 允许 Plugin 贡献结构化信息，并读取指定 scope 的 `BoardSnapshot` 决定下一步提出什么 Intent；
4. Baton 同时驱动多个 Harness 时，承载各 Harness 可共享的目标、进度、交付物和交接状态。

Baton core 不拥有 Requirement、Deployment 等领域对象。Plugin 和 Baton 以带来源的结构化
contribution 更新 Board；Harness 的进度和结果则由 adapter 先归一成事件，再投影进 Board：

```text
BoardItem
├── stable key / owner
├── scope
├── resourceRef?
├── structured payload / schemaRef?
├── title / status / detail
├── facets / presentation hints?
├── provenance
└── freshness / ttl?
```

Board 不是所有参与者共同修改的一份全局 JSON。每个 contributor 只能 upsert 或撤销自己
namespace 下的 key；跨 Plugin、跨 Harness 的关联通过 resourceRef、领域 ID 和派生项表达。
BoardState 维护 revision，读方用 `BoardSnapshot` 获得一致视图，避免并行 Harness 用
last-write-wins 相互覆盖。Plugin 禁用后可以撤销自己的临时 contribution，同时保留已经进入
事件历史的事实。Baton 也可以根据正典事件产生有 provenance 的派生项，例如未决审批、等待原因、
调度失败、context 水位和跨 Harness catch-up。

“可行动事项”和“状态事实”可以作为默认 facet，帮助 UI 区分“系统建议下一步做什么”和
“已经发生或正在发生什么”，但它们不是 Board 的封闭类型，也不规定固定布局。TUI 可以使用
分区、卡片分组、筛选视图、统一时间线或其他形式。

Plugin 读取的是带 revision 的结构化 `BoardSnapshot`，不能解析 `BoardView` 的展示文本。
Board 变化可以产生 `board.changed` 事件供 Plugin 重新评估，但 Plugin 的决定仍要表达为
Event/Intent 并经过 Baton 路由；不能从 Board observer 直接执行外部副作用。Board 是共享协作
状态，不取代 Event Ledger、Plugin 领域状态或外部系统作为各自事实的真相源。

Event routing、Plugin 私有状态、Harness 原生 session 和 Resource lookup 仍各自存在。Board
适合放可共享、可归属、可整理的信息或受控引用；secret、大体积原始材料和只对单次 turn 有效的
内容不必进入 Board，可以在 ContextComposer 交付时通过受控的 ContextContribution 补充。

### 操作授权与渐进式信任

申请用户同意不是 Board 的独立职责。Baton 应提供统一的 Permission Gate，让 Harness
的 tool 请求、Plugin 的 Action、以及未来的 Harness Work 使用同一套用户授权语义。Board 只是
`Interaction{kind:permission}` 的一种展示和追踪入口；真正的决策、策略与回执属于
Policy/Permission。

Baton 按 `requester + operation + permissionScope` 保存授权策略，其中 requester 可以是
HarnessTarget、PluginInstance 或 Baton。首期至少提供：

- **Manual**：每次执行前请求用户同意，UI 可以把它投影成 Board 待处理项；
- **Always Accept**：同一作用域内自动同意该操作，仍保留 ActionReceipt 和审计历史。

默认使用 Manual。授权粒度必须是 Plugin 声明的具体操作，而不是“一次信任整个 Plugin”。
生产环境部署和关闭需求可以保持 Manual，同时让低风险的查询、dev 部署或 review 自动执行。
Plugin 版本新增操作、扩大作用域或提高风险时必须重新询问，不能继承旧授权静默扩权。

理想状态是用户不必参与每一步，但不能把全自动作为初始默认。随着用户对 Baton 和某个 Plugin
的结果建立信任，可以逐项从 Manual 调整为 Always Accept。这与 Harness 对 tool 调用的权限
请示是同一个模型：不同 requester 提出受控操作，用户决定哪些操作以后可以自动通过。

```text
Interaction { kind: permission }
├── interactionId
├── requester: HarnessTarget / PluginInstance / Baton
└── permission payload: operation / permissionScope / risk / subject references / options

PermissionPolicy
└── manual / always-accept

interaction.resolved
└── allow / deny + decidedBy + policyRef
```

Controller 持有 Interaction identity 和 opened/resolved 生命周期；Harness Adapter 或 Plugin
只提交 typed draft 并等待 resolution。Harness 的 tool approval 已归一到该模型，Plugin Action
不另造一套“Board 审批”。Permission 状态可以投影进 Board，方便用户统一查看，但 BoardItem
本身不是授权凭证。permission resolution 只证明决策已作出，不证明随后 Action 已执行；执行结果
仍由 ActionReceipt 表达。

### 同一 Board，不同消费视图

```text
Baton / Plugin / Harness Events
                 │
           BoardState
      ┌──────────┼───────────┐
      ▼          ▼           ▼
  BoardView  BoardSnapshot  ContextComposer
   面向用户     面向 Plugin      面向 Harness
                              │
                         ContextBundle
                              │
                       BatonSession 记录
```

BoardView、BoardSnapshot 和 ContextBundle 是同一协作状态针对不同消费者的投影。ContextBundle
针对某个 Harness、session 和 turn 按 scope、受众、freshness 和预算编译；不能把整个 Board
文本无差别塞进 prompt。大体积证据优先在 Board 保存 resource reference，由 Harness 按需读取。

必须区分三个动作：

> **Board 更新 ≠ Context 已交付 ≠ Harness 被唤醒。**

Board 变化先更新持久状态；ContextComposer 只在用户准备发起 Harness Work，或未来调度准备
续跑时编译所需增量；是否创建 turn 仍由用户 intent、Plugin intent 和 Policy 决定。

### Context 交付

BatonSession 记录 context 的 assemble 和 delivery receipt，包括 contribution、来源水位、
摘要、目标 Harness 与实际 transport。Harness adapter 按 capability 选择：

1. 独立 context sync；
2. turn 级 side channel；
3. 受预算约束地 prepend 到下一次 prompt；
4. 大体积内容通过 resource、MCP 或 CLI lookup 按需读取。

仍然坚持只通过 Harness 支持的通道注入，不写 Codex、Claude Code 等原生 session 文件。

## 7. Requirement Loop：reqloop Plugin 示例

Requirement Loop 用来验证 Baton 的通用抽象，但不是 Baton 内建流程。默认只需新增一个
`reqloop` Plugin，由它拥有这条 loop 的领域模型、推进策略和完成条件；不必预先把 Requirement、
Deploy、Review、Repair 和 Completion 拆成五个 Plugin。

reqloop 将 Requirement、Deployment、Verdict 等抽象为自己的领域概念，并用内部 Connector
适配具体平台。Baton 只看到 reqloop 注册的 command、event、action、hook、schedule、Board 和
Context contribution。详细设计见 [reqloop](./reqloop.md)。

1. 用户启用并配置随 Baton 交付的 reqloop。它注册 `/requirement`，并声明“开始开发”“部署”
   “发起 review”“关闭需求”等可能申请的操作。
2. 用户选择、粘贴或输入一项需求；reqloop 在 Board 呈现目标与验收条件，并提出
   “是否开始开发？”这一可行动事项。
3. 默认 Manual 策略下，用户同意后 Baton 才组装 context 并启动所选 Harness。该启动源于显式
   用户决策，仍属于 user-driven turn，不要求提前实现 HarnessWorkIntent。
4. 目标 Harness 内安装的 devloop 规范 agent 完成开发、lint/test、commit 和 PR/MR；它使用
   Codex/Claude Code 自己的 skill、hook、command 和权限机制，不注册为 Baton Plugin。
5. MR 可交付时，devloop 产生结构化 DevelopmentOutcome，经 Harness adapter 或窄化的 Baton
   event bridge 归一为 `harness.delivery.ready` 并送入 Baton event ledger。reqloop 据此提出
   部署和独立 review 动作；Manual 策略询问用户，Always Accept 则自动进入 Baton Action
   路径。这里不能只把“Harness 停止”当成部署条件，因为停止不代表交付物已就绪。
6. reqloop 收到 `review.changes_requested` 后更新状态并提出修复行动，由用户确认后启动
   Harness。未来真实工作区需要无人值守续跑时，再返回 HarnessWorkIntent。
7. 部署、review 和修复状态均满足 reqloop 的收尾策略后，reqloop 请求 Baton 弹框确认。用户
   同意后，reqloop 执行 close action 修改需求系统。

reqloop 可以在自己的 package 内实现 Meego/Teambition、部署平台和 review 平台 Connector，
因为这些适配共同服务于同一条 loop。devloop 仍有独立产品和 standalone 价值，但它安装在
Harness 内，不占用 Baton Plugin 身份。如果未来部署或 review 能力被 release loop、事故处置
loop 等多个场景复用，再将对应能力提取为独立 Baton Plugin；reqloop 仍通过 Baton 的 Event
和 Action 路径使用它，不直接调用其内部接口。

这条链路展示了 Plugin 的本质：它可以交付一条完整 loop，同时提供资源和动作、监听事件、注册
定时器、更新 Board、贡献 context 或委托 Harness。Baton 只提供这些能力的共同运行时。

## 8. devloop 下沉为 Harness Plugin

devloop 负责规范 Harness 内部的 agent 开发循环：

- repo、branch、component、worktree 与 PR/MR 生命周期；
- 约束 agent 执行 lint/test、commit/push、code review 和开发期 guard；
- 通过 Harness 原生的 skill、hook、command 和 permission 影响 agent 行为；
- 在交付条件满足时产生结构化 DevelopmentOutcome。

它不是 Baton Plugin，不向 Baton 注册 slash command、Action、Schedule、Board contribution
或 ContextContribution。单独使用 Codex/Claude Code 时，devloop 仍能完成 PR/MR 小闭环；
运行在 Baton 驱动的 Harness 内时，Baton 只观察由 Harness 边界归一后的开发事件。

这要求在 Harness 边界定义稳定的 DevelopmentOutcome，而不是让 Baton 解析
`.devloop/*.json`、Harness transcript 文案或某个宿主的私有 hook payload：

```text
devloop（Harness Plugin）
  → Harness-native signal / narrow event bridge
  → Harness adapter / Baton ingress
  → harness.delivery.ready / harness.development.blocked
  → Baton event ledger / Board / reqloop
```

具体 transport 取决于 Harness 能力：可以是原生 custom event、hook 回调或受控的 `baton emit`
入口。无论哪种方式，都只是结构化事件出口，不使 devloop 获得 Baton PluginInstance 身份。

之前 notify 没有稳定跑起来，主要不是领域事件判断错误，而是宿主侧缺少持久历史、常驻调度和
可靠唤醒。迁移方向是：

- **留在 devloop**：agent loop 约束，以及交付、阻塞等开发结果的判定；
- **交给 Harness 边界**：通过 adapter 或窄化 event bridge，把宿主内信号归一成 HarnessEvent；
- **移交 Baton**：事件持久化、cursor、回放、Schedule、session 路由、Board、Policy 与
  Harness 调度；
- **逐步退休**：依赖单一宿主的易失 notifier、waiter re-arm 和 agent 手工建立唤醒的步骤。

Baton TUI 运行时可以直接监听；关闭 TUI 后仍要求实时推进时，再把相同 Schedule/Event runtime
放进 daemon，而不是另造一套 notify 协议。

## 9. 安装、权限与运行约束

- manifest 声明稳定 plugin id、版本、components、配置 schema 和所需权限；
- PluginPackage 版本目录只读，可写状态进入独立的 PluginInstance data 目录；
- secret 由 Baton 管理并按 capability 注入，不进入事件 payload、日志或 HookResult；
- project Plugin 仅在 workspace trusted 后装载；
- 可执行 Hook 按内容与来源建立信任，安装 Plugin 不等于自动授权全部 Effect；
- Hook 和 Action 都有 timeout、输出预算、失败策略和 provenance；未来 Harness Work 沿用同一
  约束；
- Plugin 禁用时停止其 EventSource、撤销 Schedule 和 Hook binding，并保留可审计历史；
- Baton 负责控制面一致性，Plugin 失败不能破坏 event ledger 或其他 Plugin 的状态。

Plugin API 可以参考 Codex 和 Claude Code 的打包、权限和 Hook 经验，但不复制任一宿主的私有
事件协议：

- [Codex plugins](https://developers.openai.com/codex/plugins/build#plugin-structure)
- [Codex hooks](https://developers.openai.com/codex/config-advanced#hooks)
- [Claude Code plugins](https://code.claude.com/docs/en/plugins-reference)
- [Claude Code hooks](https://code.claude.com/docs/en/hooks)

## 10. 增量演进

代码、持久格式和 Plugin 模型统一使用 `Harness` 边界，不再引入额外的外部系统运行角色。

演进分成两条相互依赖、但不能混成一张 feature list 的路径：

```text
v2 内核可靠性
scope / placement
  → fact / signal
  → intent / attempt / receipt
  → context snapshot / delivery
                              │
                              ▼
Loop 产品能力
DevelopmentOutcome
  → Plugin / Event / Board
  → Action + Manual loop
  → HarnessWorkIntent
  → daemon
```

### v2 内核路径

1. **作用域与执行位置分离**：引入 Workspace、HarnessTarget 和不可变的
   HarnessLaunchSnapshot；BatonSession 继续只承担正典逻辑历史。初期可以把当前项目隐式映射
   成一个 Workspace，不要求先做多 workspace UI。
2. **Event、Interaction 与 Signal 收敛**：Event v3 使用稳定 `eventId + scope + source`；
   permission/question/hook trust 共用 `Interaction opened/resolved` 生命周期；wake、文件通知和
   projection invalidation 只作为可合并的 signal。signal 触发权威读取，不能直接改变状态。
3. **可靠工作投递**：先让现有用户驱动的 Harness submit 进入 Attempt ledger，以已持久化
   Input 作为上游，验证先记账再投递、`uncertain` 和恢复语义；再抽成 ActionIntent 与未来
   HarnessWorkIntent 共用的 Intent/Attempt/Receipt 路径，并在需要自动重试时补齐幂等身份。
4. **上下文可对账**：建立有 owner/key 的 ContextSource、ContextSnapshot、ContextEpoch 和
   ContextDeliveryReceipt；明确 Board 更新、context 交付和 Harness 唤醒是三个独立转换。

这四步的目标模型和恢复流程见 [Baton v2](./baton-v2.md)。它们可以逐项叠加在 v1 之上，不要求
一次替换 BatonSession ledger 或 Adapter 协议。

### Loop 产品路径

1. devloop 在 Harness 内提供稳定 DevelopmentOutcome；Harness 边界归一成 Baton Event；
2. 建立 PluginPackage/PluginInstance、EventSink、统一事实信封和 subscriber cursor；
3. 支持 slash command、resource/query、BoardContribution 与 ContextContribution；
4. 建立 Hook、Schedule，先只观察、更新 projection 或走 Manual 策略；它们只产生 Event、
   Contribution 或 Intent，不拥有另一套执行状态机；
5. 接入 ActionIntent，统一走 Policy、Permission、Attempt 和 Receipt；
6. 用 reqloop + 安装了 devloop 的 Harness 跑通用户确认驱动的 Requirement Loop；
7. 真实工作区证明必须由 Plugin 主动续跑 Harness 时，再实现 HarnessWorkIntent。它先形成持久
   Intent/Attempt，经过路由和冲突处理后才 admit 成 BatonSession Input/Turn，不能伪装成
   queued follow-up 或易失的 `monitor Input`；
8. 只有关闭 TUI 后仍要求实时推进时，才引入 daemon；daemon 复用同一 ledger、cursor 和
   Attempt 恢复流程，不另造 notify 协议。

reqloop 的 `ReqLoopRun`、checkpoint 与完成条件始终归 reqloop。Baton core 在这一阶段只提供
`parentEventId`、ResourceRef、Event、Interaction、Intent/Attempt/Receipt 和 projection 原语，不提前抽象
一个所有领域都必须采用的通用 `LoopRun`。

每一步都应保持 BatonSession 的 session 事件流是 Harness 会话历史真相源，并明确它与全局
Plugin/Event ledger 的关联，避免形成两份可独立修改的历史。

## 11. 关键不变量

1. Baton core 不内建 Requirement、Work、Deployment、Review 等领域对象和状态机。
2. Plugin 是唯一通用扩展单元；Harness 是专门的智能执行协议。
3. Connector 等领域适配抽象只能是 Plugin 内部概念，不进入 Baton 公共协议。
4. Baton Plugin 与 Harness Plugin 是两层扩展机制；devloop 属于后者，不注册进 Baton Plugin
   runtime。
5. Plugin 只拥有自己的领域事实和动作，跨 Plugin 编排统一经过 Baton。
6. HarnessWorkIntent 只保留扩展位置；实现前必须由 reqloop 的真实工作区需求验证。
7. 若实现 HarnessWorkIntent，Plugin 也不能直接持有或调用 Harness runtime。
8. Event 先持久化再分发；Action、Effect 以及未来的 Harness Work 都产生可追踪回执。
9. Board 是带 owner、scope、revision 和 provenance 的共享协作读模型，不是领域真相源或全局
   可变字典。
10. Plugin 只能修改自己的 Board contribution；读取 Board 后只能提出 Event/Intent，不能直接
   产生副作用。
11. Board 更新、Context 交付和 Harness 唤醒是三个独立状态转换。
12. Harness 与 Plugin 共用 `Interaction{kind:permission}` 语义；Board 只投影 opened/resolved
    结果，不持有授权。
13. 时间触发不自动获得副作用权限，仍需经过同一 Policy 与 Action 路径。
14. Context 只通过 Harness 支持的通道交付，不修改其原生 session 文件。
15. Event 是可重放事实；wake 与 invalidation signal 只提示读取权威状态，不能直接驱动
    reducer 或形成第二份真相源。
16. Action 与未来 Harness Work 都先持久化 Intent/Attempt 再 dispatch；无法确认目标是否接收
    时进入 `uncertain` 并对账，不盲目重试。
17. Workspace、BatonSession 与 HarnessTarget 分别承担控制作用域、逻辑历史和执行位置，不能
    继续由 cwd、Harness 名称或“当前 session”隐式混用。
18. Baton core 不内建通用 LoopRun；具体 run、checkpoint 和完成条件由领域 Plugin 拥有。

## 12. 待继续讨论

1. Plugin/Event 全局 ledger 与 BatonSession `session.jsonl` 如何关联而不形成双真相？
2. Workspace 与项目/cwd 的初始映射、Plugin Package/Instance 和用户配置的继承关系是什么？
3. Event 的 ack、cursor、回放、乱序和 schema version，以及 signal 的合并/补扫策略如何
   定义？
4. PermissionPolicy 的 scope 继承与覆盖规则如何跨 requester、operation、workspace、环境和
   session 表达？
5. 哪些真实场景足以触发 HarnessWorkIntent 的实现？实现后如何以稳定 Intent/Attempt 身份与
   用户 turn 协调 admit、排队、steer 或取消？
6. Board scope 与 resource reference 如何设计，才能支持多 repo 和多个并行 loop？
7. 首批稳定 Hook 点、失败策略和版本兼容范围是什么？
8. Schedule 的 misfire、并发、重试、幂等和卸载清理如何定义？
9. 什么可靠性或实时性指标足以触发 Baton daemon？
10. 不同 Harness 分别用 custom event、hook 还是 `baton emit` 传递 DevelopmentOutcome，才能
    兼顾原生能力、可靠性和最小耦合？
11. Harness 对“已接收工作”的权威边界分别是什么，哪些 Harness 能原生查询并收敛
    `uncertain` Attempt？
