# Baton：可扩展的 Loop Engineering 控制面

> 状态：讨论草案。本文描述 Baton 的长期演进方向，不改变当前 v1“统一会话与跨
> Harness 上下文接力”的实施范围。本文统一使用 `Harness` 表示 Codex、Claude Code 等
> 智能执行环境。支撑这些能力的 v2 内核目标见 [Baton v2](./baton-v2.md)；当前已经用
> 用户驱动的 Harness submit 落下首个 Intent / Attempt / Receipt 可靠投递切片，并用
> BatonSession `session_history` 落下首个 ContextSource / Snapshot / Receipt / Epoch 切片。
> Plugin 的 Package / Instance / Binding / Contribution 详细模型以
> [Baton Plugin 设计](./plugin.md)为准。

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

Loop 不以“先写完一份完整 Task Contract，再用 Cron 执行”为前提。完整描述业务判断、例外和
完成条件的成本可能接近直接写代码，而且探索中的思路本来就会持续变化。Baton 允许 Plugin 用
普通代码消费 Baton 事实、表达领域 Resource 和 reconcile，再把已经稳定、适合自动化的动作
逐步交给控制面：

```text
Loop ≈ resource(spec + status) + reconcile
                                  ▲
                 change / result / requeueAfter

Observe → Recommend → Manual approval → Scoped automation
```

`spec` 保存人认可的 Contract，`status` 保存 Reconciler 的当前观测；Resource、Harness 结果和
`requeueAfter` 只负责提示“应该重新检查”。首期 Reconciler 可更新自有 status，并返回一段由人
审核、编辑后交给 Harness 的文本，不要求业务一开始就被穷举成 DSL。详细契约见
[Baton Plugin 设计](./plugin.md)。

Plugin 不一定是 loop。一个“观察已完成 turn，分析问题更适合哪个 Harness，并给用户推荐输入”
的 Plugin，可以只消费 Baton 的只读 Builtin Resource 并产生 Proposal；只有需要保存 desired /
observed state、长期推进外部状态时，才需要自有 PluginResource。

## 2. 总体边界

```text
                             ┌───────────────────────────┐
用户 ── Slash Command ──────▶│                           │
用户 ── Composer Intent ────▶│                           │
时间 ── RequeueAfter ───────▶│           Baton           │
                             │                           │
                             │ Event Ledger / Router     │
                             │ Plugin Manager            │
                             │ Reconcile Queue / Timer   │
                             │ Board / Context Composer  │
                             │ BatonSession / Policy     │
                             └─────────┬─────────┬───────┘
                                       │         │
           未来受控 Harness 调用     │         │ Plugin 能力
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
- 从 Event Ledger 投影只读 Builtin Resource，供 Plugin 以 level-based 方式观察 Baton 行为；
- 装载 Plugin，注册 Command 与 Resource Contribution；
- 持久化 PluginResource、合并 reconcile key 并恢复 `nextReconcileAt`；
- 将用户确认的 `proposedInput` 作为普通 Input 委托给合适的 Harness；
- 从 Resource 与协作事实生成 Board 视图；
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

运行时可把 Plugin Manager / Controller 理解成 Baton 内部对象的消费者：Manager 把 Event
Ledger 投影成稳定、只读的 Builtin Resource，Controller 重新读取最新 snapshot 并产出
Plugin Output。当前 Output 是给用户的 Proposal；未来可以是受 Baton 管控的 Harness work
request，但不能是直接 Adapter 调用。

本文未加限定的 `Plugin` 均指 **Baton Plugin**。Codex、Claude Code 等 Harness 也有自己的
Plugin 机制，两者处于不同扩展层：

- **Harness Plugin**：运行在单个 Harness 内，约束或扩展当前 agent loop；
- **Baton Plugin**：运行在 Harness 之上的控制面，观察和推进跨 session、跨系统的 loop。

devloop 属于 Harness Plugin：它规范 agent 在代码仓内完成开发、lint/test、commit 和 PR/MR，
而不是由 Baton Plugin Manager 装载的控制面能力。

外部系统不再对应另一种顶层运行角色。Plugin 用内部 Connector 隔离 Meego、Teambition 和不同
部署平台，并由 Resource Reconciler 在已授权 `spec` 范围内调用；Connector 不进入 Baton
manifest、runtime 或公共 Plugin API。这样安装、配置和运行都围绕同一个 PluginInstance，不再
为外部系统恢复一套平级身份。

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
    └── PluginInstance
          └── PluginBinding
                └── PluginContribution[]
```

同一个包可以有多个实例，例如 `deploy@dev`、`deploy@prod`、
`requirement@company-a`。Resource、Event 和 Board projection 都引用 `pluginInstanceId`，
避免把账号、环境和安装包身份混在一起。

Package 是不可变交付物，Instance 是 BatonSession 中的配置身份，Binding 拥有当前进程中的
注册和关闭生命周期。Plugin manifest 声明 Contribution 与 Connector 权限；声明只是让能力
提前可见，不等于获得执行权限。完整模型以 [Baton Plugin 设计](./plugin.md) 为准。

### 可贡献的能力

```text
BatonPlugin
├── commands             创建、选择或修改 Resource
├── builtin watches      消费 Baton 的只读资源投影
└── plugin resources
    ├── spec / status schema
    ├── reconcile
    ├── Board projection
    └── Context projection?   可选
```

当前运行时已有 PluginResource register 与 Builtin Resource watch；Command 等真实产品入口
出现后再补 manifest declaration。Reconciler 是两种 Controller 共用的处理语义，不要求 Plugin
必须先创建可写 Resource。Monitor、EventSource、Schedule 和 Action 等到
`requeueAfter + desired state` 无法覆盖真实场景时再引入。Plugin 可以在一个内聚的 loop 内部
组合多个外部系统；跨 Plugin 编排统一回到 Baton，不直接互调。

### Baton Plugin 与 Harness Plugin

Codex 和 Claude Code 的 Plugin 主要扩展当前 Harness 内正在运行的 agent，例如提供 skill、
tool、hook 和 command。Baton Plugin 位于 Harness 之上的控制面，长期可以额外开放一项能力：
**根据 Resource 状态请求启动、恢复或继续一个或多个 Harness。**

```text
Codex / Claude Code Plugin
  → 扩展当前 agent 能做什么

Baton Plugin
  → 观察 loop
  → 首期返回 proposedInput 给人审核
  → 未来请求 Baton 主动调度 Harness
  → Baton 选择/恢复 Harness，组装 context 并调度 turn
```

这项能力当前只保留长期方向，不进入首期 Plugin API，也不提前命名独立的顶层 Intent。只有真实
工作区证明某些步骤必须在无人输入时主动唤醒 Harness，才扩展 Resource/Reconcile 契约。届时
Baton 放开的仍是受控调度能力，而不是 `HarnessAdapter`/Harness 的裸句柄；路由、权限、成本、
并发、取消、上下文交付和结果持久化继续由 Baton 负责。

### Slash Command

Plugin 可以注册 `/requirement` 等 slash command。命令 handler 操作 Resource，而不是直接
控制 TUI：

- 列表、表单和选择项由 Baton 渲染；
- 选中或输入需求后创建、恢复或修改 PluginResource；
- Board 和 Context 由对应 Resource Contribution 投影；
- 需要智能判断时由 Reconciler 返回 `proposedInput`，用户提交后进入普通 Input 路径。

这使“查看需求并放入 Board”成为 Plugin 能力，而不是 Requirement 进入 Baton core 的理由。

## 4. Event 与 Resource observation

### 统一事件信封

Harness、Plugin、Baton 和用户都可以产生事件。事件来源显式表达：

```ts
type EventScope =
  { type: "session"; batonSessionId: string };

type EventSource =
  | { type: "baton" }
  | { type: "harness"; harnessTargetId: string }
  | { type: "plugin"; pluginInstanceId: string }
  | { type: "user" };

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
`harnessTargetId`、`turnId` 等执行坐标。Event 只写入 BatonSession ledger。fork 复制同一段
逻辑历史时保留领域对象 id；Event envelope 因进入 child ledger 而重新签发 event id 并更换
session scope。

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
  → reduce / project / enqueue reconcile key
  → Plugin Reconciler / Policy
```

先持久化再分发。`emit` 成功只表示 Baton 已可靠接收事实；Reconciler 仍要重新读取 Resource 和
外部状态。高频 message/tool delta 可以进入 session ledger 和 projection，但默认不逐条触发
Plugin，避免回调风暴。

对 Plugin 而言，Event 不是必须逐条处理的 callback 参数。Plugin Manager 先把选定的内部事实
投影成有稳定 kind、identity 和 revision 的只读 Builtin Resource，再把 key 放入 workqueue；
Reconciler 执行时读取最新 snapshot。首个 `baton.turn` 来自
`_baton_turn_summary`，启动 replay 与 live append 使用同一投影和队列。用户和 Plugin 都不能
修改 Builtin Resource；需要 desired state 时使用 PluginResource。

## 5. Builtin / Plugin Resource、Reconcile 与 RequeueAfter

Resource 有两个 owner：

- `baton`：从 Event Ledger 产生的只读 Builtin Resource，例如 `baton.turn`；
- `plugin`：Plugin 自有、可持久化 `spec/status` 的 PluginResource。

PluginResource 用 `spec` 保存人认可的 Contract，用 `status` 保存 Reconciler 的观测。Builtin
投影、PluginResource 创建或 spec 更新、启动恢复和计时到期都映射为
`pluginInstanceId + resourceOwner + resourceKind + resourceId`，Baton 合并同一 key 的重复唤醒：

```text
Builtin projection / PluginResource change / startup / timer due
                         │
                         ▼
keyed reconcile queue
                         │ same key coalesces
                         ▼
reconcile(latest resource snapshot, latest external state)
                         │
                         ├── patch owned status / project Board
                         ├── call owned Connector when authorized
                         └── Plugin Output? / requeueAfter?
```

触发原因只是 wake hint，不是必须逐条执行的业务命令。同一 Resource 不并发 reconcile；
`metadata.generation` 随 spec 变化，`status.observedGeneration` 表示 status 基于哪版 Contract。
Reconciler 可以调用自己 Plugin 的 Connector，使实际状态靠近已授权 spec；不确定外部写入使用
稳定 operation key，并在重试前重新观察。

首期 `ReconcileResult` 只有 `proposedInput?` 和 `requeueAfter?`。前者是给人审核、编辑或丢弃的
文本，提交后才成为普通 Input；PluginResource 的后者换算成持久化 `nextReconcileAt`，进程
重启后恢复。Builtin Resource 的 due time 只存在于进程队列，重启时由 ledger replay 再次
enqueue。错误都由 Baton 退避重试，空结果等待新事实。

Monitor、EventSource、Schedule 和 Action 都不进入首期。webhook、长连接或无 Resource 的观察
出现后再增加只负责 enqueue 的 EventSource；calendar cron、时区和 misfire 出现后再增加
Schedule；无法表达成 desired state 的独立命令出现后再增加 Action。关闭 TUI 后仍要求实时推进
时，再让 daemon 复用同一 Resource store 和 reconcile queue。

## 6. Board、Context 与 BatonSession

### Board 是共享协作面

一期 `BoardView` 直接从 PluginResource 和带 provenance 的协作事实投影，不先建设一份可独立
演化的 Board 数据库。长期出现跨 Resource、跨 owner 的独立整理需求后，再引入持久化、可查询的
`BoardState`。Board 不只是 UI，也不是某个 Plugin 的私有状态；它是 Baton、Plugin 与多个
Harness 交换协作信息的公共平面：

> 可以把 Board 理解成办案团队的“案件板”：不同参与者把线索、进展、结论、待核实项和关系放到
> 同一个可见空间，其他参与者据此整理认知并决定下一步。它是一种信息交互、整理和展示方式，
> 但不是系统唯一的通信或存储方式。

1. 向用户展示目标、进度、结果、blocker 和待处理事项；
2. 作为 ContextComposer 为目标 Harness 选择和编译 context 的主要来源；
3. 允许 Plugin 投影结构化信息，并读取指定 scope 的 snapshot 参与 Reconcile；
4. Baton 同时驱动多个 Harness 时，承载各 Harness 可共享的目标、进度、交付物和交接状态。

Baton core 不拥有 Requirement、Deployment 等领域对象。Plugin 从 Resource 投影领域条目；
Harness 的进度和结果则由 adapter 先归一成事件，再关联 Resource 并投影进 Board：

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
Board 变化可以 enqueue 相关 Resource 供 Plugin 重新评估，但 Reconciler 仍要重新读取 Resource
和外部状态，不能把 Board repaint 当成业务命令。Board 是共享协作状态，不取代 Event Ledger、
PluginResource 或外部系统作为各自事实的真相源。

Event routing、Plugin 私有状态、Harness 原生 session 和 Resource lookup 仍各自存在。Board
适合放可共享、可归属、可整理的信息或受控引用；secret、大体积原始材料和只对单次 turn 有效的
内容不必进入 Board，可以在 ContextComposer 交付时通过对应 Resource 的 Context projection
按需补充。

### 操作授权与渐进式信任

申请用户同意不是 Board 的独立职责。Baton 应提供统一的 Permission Gate：Harness tool 继续
按执行请求授权；Plugin 的敏感外部变化则在相应 desired state 写入 `spec` 前完成授权。Board
只是决策的展示和追踪入口，真正的策略与回执属于 Policy/Permission。

Baton 按 `requester + operation + permissionScope` 保存授权策略，其中 requester 可以是
HarnessTarget、PluginInstance 或 Baton。首期至少提供：

- **Manual**：敏感 spec 变化或 Harness tool 执行前请求用户同意；
- **Always Accept**：同一作用域内自动同意，仍保留 spec revision、Interaction 或 Harness
  receipt 等对应审计历史。

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

Controller 持有 Interaction identity 和 opened/resolved 生命周期。Harness 的 tool approval
已归一到该模型，Plugin 不另造一套“Board 审批”。Permission 状态可以投影进 Board，方便用户
统一查看，但 BoardItem 本身不是授权凭证；对 Plugin 而言，授权后的 spec revision 才是
Reconciler 可以收敛的 desired state，实际结果进入 status。

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

Board 变化先更新投影；ContextComposer 只在用户提交 `proposedInput`，或未来调度准备续跑时
编译所需增量；是否创建 turn 首期只由用户 Input 决定。

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
适配具体平台。Baton 只看到 reqloop 注册的 command 和 ReqLoopRun Resource Contribution；
schema、reconcile、Board projection 与可选 Context projection 都收在该 Resource 下。详细设计
见 [reqloop](./reqloop.md)。

1. 用户启用并配置随 Baton 交付的 reqloop，通过 `/requirement` 创建或恢复 ReqLoopRun；
   Requirement、验收条件和完成策略进入 `spec`。
2. ReqLoopReconciler 返回“根据需求完成开发并提交 PR”的 `proposedInput`；用户原样提交、编辑后
   提交或丢弃。提交后才成为普通 Input，因此仍是 user-driven turn。
3. 目标 Harness 内安装的 devloop 规范 agent 完成开发、lint/test、commit 和 PR/MR；它使用
   Codex/Claude Code 自己的 skill、hook、command 和权限机制，不注册为 Baton Plugin。
4. MR 可交付时，devloop 产生结构化 DevelopmentOutcome，经 Harness adapter 或窄化的 Baton
   event bridge 归一为带 ReqLoopRun reference 的 `harness.delivery.ready`；Reconciler 将 PR
   等实际交付物写入 `status`。
5. `spec` 要求 review 时，Reconciler 调用 VerdictConnector，并通过 `requeueAfter` 轮询长耗时
   结果；收到 changes requested 后返回包含 review 意见的修复 `proposedInput`。
6. 部署、review 和修复满足 completion policy 后，Reconciler 更新 conditions，并在已授权
   `spec` 范围内调用 Connector 完成收尾。

reqloop 可以在自己的 package 内实现 Meego/Teambition、部署平台和 review 平台 Connector，
因为这些适配共同服务于同一条 loop。devloop 仍有独立产品和 standalone 价值，但它安装在
Harness 内，不占用 Baton Plugin 身份。如果未来部署或 review 能力被 release loop、事故处置
loop 等多个场景复用，再将对应能力提取为独立 Baton Plugin；跨 Plugin 协作仍通过 Baton 的
Resource 与 Event 边界，不直接调用内部接口。

这条链路展示了 Plugin 的本质：它通过 Resource `spec/status` 和 Reconcile 交付一条完整 loop；
Baton 提供持久化、定时唤醒、Board/Context 投影和 Harness Input 运行时。

## 8. devloop 下沉为 Harness Plugin

devloop 负责规范 Harness 内部的 agent 开发循环：

- repo、branch、component、worktree 与 PR/MR 生命周期；
- 约束 agent 执行 lint/test、commit/push、code review 和开发期 guard；
- 通过 Harness 原生的 skill、hook、command 和 permission 影响 agent 行为；
- 在交付条件满足时产生结构化 DevelopmentOutcome。

它不是 Baton Plugin，不向 Baton 注册 Command 或 Resource Contribution。单独使用
Codex/Claude Code 时，devloop 仍能完成 PR/MR 小闭环；
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
- **移交 Baton**：事件持久化、Resource、reconcile queue、`requeueAfter`、session 路由、Board 与
  Harness 调度；
- **逐步退休**：依赖单一宿主的易失 notifier、waiter re-arm 和 agent 手工建立唤醒的步骤。

Baton TUI 运行时可以直接 reconcile；关闭 TUI 后仍要求实时推进时，再把相同 Resource/Event
runtime 放进 daemon，而不是另造一套 notify 协议。

## 9. 安装、权限与运行约束

- manifest 声明稳定 plugin id、版本、components、配置 schema 和所需权限；
- PluginPackage 版本目录只读，可写状态进入独立的 PluginInstance data 目录；
- secret 由 Baton 管理并按 capability 注入，不进入事件 payload、日志或 ReconcileResult；
- Plugin 仅在当前 BatonSession 对应的 Project 已被用户信任后装载；
- 安装 Plugin 不等于自动授权其 Connector 权限或敏感 spec 变化；
- Reconciler 有 timeout、取消、失败策略和 provenance；未来主动 Harness 调用沿用现有可靠
  Input 投递约束；
- Plugin 禁用时撤销 Binding 和 due timer，并保留 Resource 与可审计历史；
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
  → Builtin Resource projection / PluginResource(spec / status)
  → Reconcile + proposedInput + RequeueAfter
  → 未来受控 Harness 调用
  → daemon
```

### v2 内核路径

1. **作用域与执行位置分离**：BatonSession 同时收口正典逻辑历史与 session-scoped Plugin
   runtime，HarnessTarget 和不可变 HarnessLaunchSnapshot 只表达执行位置与当时配置；Project
   只负责按 cwd 组织和发现 BatonSession。
2. **Event、Interaction 与 Signal 收敛**：Event v3 使用稳定 `eventId + scope + source`；
   permission/question/hook trust 共用 `Interaction opened/resolved` 生命周期；wake、文件通知和
   projection invalidation 只作为可合并的 signal。signal 触发权威读取，不能直接改变状态。
3. **可靠工作投递**：先让现有用户驱动的 Harness submit 进入 Attempt ledger，以已持久化
   Input 作为上游，验证先记账再投递、`uncertain` 和恢复语义；未来 Reconciler 主动调用
   Harness 时复用这条路径，不向 Plugin 暴露 Harness runtime。
4. **上下文可对账**：建立有 owner/key 的 ContextSource、ContextSnapshot、ContextEpoch 和
   ContextDeliveryReceipt；明确 Board 更新、context 交付和 Harness 唤醒是三个独立转换。
   当前已用 `session_history` 打通 Snapshot → 三种 transport → Receipt → Epoch；Board /
   Plugin / Resource source 和独立 Context Attempt 仍按真实调度需求增量加入。

这四步的目标模型和恢复流程见 [Baton v2](./baton-v2.md)。它们可以逐项叠加在 v1 之上，不要求
一次替换 BatonSession ledger 或 Adapter 协议。

### Loop 产品路径

1. devloop 在 Harness 内提供稳定 DevelopmentOutcome；Harness 边界归一成 Baton Event；
2. 建立 PluginPackage/PluginInstance/PluginBinding，以及 PluginResource 通用信封与存储；
3. 将 `_baton_turn_summary` 投影为只读 `baton.turn`，让 Plugin 从启动 replay 和 live
   append 感知 Baton 内部事实；
4. 建立同 key 不并发的 reconcile queue，并将 PluginResource 的 `requeueAfter` 持久化为
   `nextReconcileAt`；
5. 接通 Board/Context projection 和 `proposedInput`，用 reqloop + 安装了 devloop 的 Harness
   跑通用户审核文本后驱动的 Requirement Loop；
6. 真实场景无法由轮询、desired state 或当前进程覆盖时，再依次引入 EventSource、Schedule、
   Action 或 daemon；
7. 真实工作区证明必须由 Reconciler 主动续跑 Harness 时，再扩展受控调用；它复用既有
   Input/Attempt 投递与路由，不伪装成易失的 `monitor Input`。

reqloop 的 `ReqLoopRun` spec/status 与完成条件始终归 reqloop。Baton core 只提供通用
PluginResource 信封、ResourceRef、Event、Input/Attempt/Receipt 和 projection 原语，不提前
抽象一个所有领域都必须采用的通用 `LoopRun`。

每一步都应保持 BatonSession 的 session 事件流是 Harness 会话历史真相源，并明确它与全局
Plugin/Event ledger 的关联，避免形成两份可独立修改的历史。

## 11. 关键不变量

1. Baton core 不内建 Requirement、Work、Deployment、Review 等领域对象和状态机。
2. Plugin 是唯一通用扩展单元；Harness 是专门的智能执行协议。
3. Connector 等领域适配抽象只能是 Plugin 内部概念，不进入 Baton 公共协议。
4. Baton Plugin 与 Harness Plugin 是两层扩展机制；devloop 属于后者，不注册进 Baton Plugin
   runtime。
5. PluginResource 用 `spec` 表达用户认可的 Contract，用 `status` 表达 Reconciler 观测；
   generation / observedGeneration 显式表示收敛水位。
6. Builtin Resource 是 Event Ledger 的只读、可重放投影；用户和 Plugin 都不能修改，也不
   另建持久真相。
7. 首期 Reconciler 只返回 `proposedInput` 和 `requeueAfter`；提交文本的 owner 仍是用户。
8. 未来若实现主动 Harness 调用，Plugin 也不能直接持有 Harness runtime，必须复用 Baton
   Input/Attempt 投递路径。
9. Event 先持久化再投影 Builtin Resource 并触发 Reconcile，触发本身不是必须执行一次的命令。
10. Board 是带 owner、scope、revision 和 provenance 的共享协作读模型，不是领域真相源或全局
   可变字典。
11. Plugin 只能修改自己的 Resource status 与 Board projection；Reconciler 可以调用自己的
    Connector 收敛已授权 spec，但不能扩大权限或 scope。
12. Board 更新、Context 交付和 Harness 唤醒是三个独立状态转换。
13. Harness tool 与敏感 spec 更新共用 Baton Permission 语义；Board 只投影决策，不持有授权。
14. 时间触发不自动获得副作用权限；Reconciler 只能收敛已经授权的 spec。
15. Context 只通过 Harness 支持的通道交付，不修改其原生 session 文件。
16. Event 是可重放事实；wake 与 invalidation signal 只提示读取权威状态，不能直接驱动
    reducer 或形成第二份真相源。
17. 外部 Connector 写入使用稳定 operation key；无法确认是否生效时先观察后重试。Harness
    投递无法确认是否接收时进入 `uncertain` 并对账。
18. Project、BatonSession 与 HarnessTarget 分别承担会话组织、loop/历史归属和执行位置，不能
    继续由 cwd、Harness 名称或隐式“当前值”混用。
19. Baton core 不内建通用 LoopRun；具体 run、checkpoint 和完成条件由领域 Plugin 拥有。
20. `requeueAfter` 是首期唯一时间触发；PluginResource 将它持久化为 `nextReconcileAt`，
    Builtin Resource 由 ledger replay 恢复；Monitor 和 Schedule 等到真实语义超出该模型后再引入。

## 12. 待继续讨论

1. Plugin/Event 全局 ledger 与 BatonSession `session.jsonl` 如何关联而不形成双真相？
2. 用户级 PluginPackage、BatonSession 内 PluginInstance 与项目级默认配置应如何继承？
3. PluginResource schema version、reconcile key、队列合并和启动补扫策略如何定义？
4. PermissionPolicy 的 scope 继承与覆盖规则如何跨 requester、operation、project、环境和
   session 表达？
5. 哪些真实场景足以触发 Reconciler 主动调用 Harness？实现后如何与用户 turn 协调 admit、
   排队、steer 或取消？
6. Board scope 与 resource reference 如何设计，才能支持多 repo 和多个并行 loop？
7. PluginResource 的 identity、spec/status schema、status patch 冲突和 migration 如何定义？
8. 哪些场景不能由 `requeueAfter` 覆盖，足以引入 EventSource 或 Schedule？
9. 什么可靠性或实时性指标足以触发 Baton daemon？
10. 不同 Harness 分别用 custom event、hook 还是 `baton emit` 传递 DevelopmentOutcome，才能
    兼顾原生能力、可靠性和最小耦合？
11. Harness 对“已接收工作”的权威边界分别是什么，哪些 Harness 能原生查询并收敛
    `uncertain` Attempt？
