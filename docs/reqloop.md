# reqloop：Requirement Loop Plugin 设计

> 状态：讨论草案。reqloop 是 Baton 随产品交付的首个官方场景 Plugin，用一条开箱可理解的
> Requirement Loop 展示 Baton 能做什么。本文只描述 reqloop 的领域与内部边界；Baton 的通用
> Plugin、Resource 和 Reconcile 契约见 [Baton Plugin 设计](./plugin.md)，整体控制面
> 见 [Loop Engineering](./loop-engineering.md)。

## 1. 定位与边界

reqloop 把一项需求从选择、开发、部署、review、修复推进到验收和关闭：

```text
Requirement
    → Development
    → Deployment
    → Verdict
    → Repair ─┐
         ▲    │
         └────┘
    → Confirm
    → Close
```

它解决两个问题：

1. Baton 是通用 runtime，单独交付时用户不容易立即理解可以组装什么；
2. Requirement Loop 需要稳定领域模型，但不能绑定 Meego、Teambition、某个部署平台或某种
   review 系统。

因此采用两层边界：

- **Baton**：只提供 Plugin runtime、Harness、事件、调度、权限、Board 和 Context；
- **reqloop**：拥有 Requirement Loop 的领域模型、推进策略、完成条件与平台适配。

reqloop 作为 bundled Plugin 随 Baton 发布，但不是 Baton core：

- 可以禁用、替换和独立升级；
- 未配置时 `/requirement` 提供引导，不要求 Baton core 理解需求字段；
- reqloop 的 Connector cursor、缓存和 credential 进入自己的 PluginInstance data/config；
- Baton 不导入 reqloop 类型，不根据 Requirement 状态写分支。

## 2. 核心概念

### ReqLoopRun

`ReqLoopRun` 是 reqloop 声明的一种 PluginResource，表示“一项 Requirement 正在经历的一次
闭环”。它用 `spec/status` 分开期望和观测：

```text
ReqLoopRun
├── spec
│   ├── requirement       用户选择或输入的需求
│   ├── acceptance        验收目标
│   ├── repositories      目标仓库
│   ├── environments      目标环境
│   └── completionPolicy  完成条件
└── status
    ├── deliveries        branch / commit / PR/MR / artifact
    ├── deployments
    ├── verdicts          review / e2e / eval / perf
    ├── harnessResults
    ├── conditions
    └── observedGeneration
```

Requirement 是业务锚点，ReqLoopRun 是执行实例。二者分开，才能表达同一需求的重开、重试或
多环境验收，而不把外部需求系统状态直接当作内部状态机。

Requirement、验收目标和完成策略属于用户认可的 Contract；PR、部署、review 和 Harness 结果
是实际产出。Harness 可以建议修改 Requirement，但只有用户认可后才更新 `spec`。

### ReqLoopReconciler

`ReqLoopReconciler` 是 ReqLoopRun Resource Contribution 的一部分。Resource 变化、Harness
结果、启动恢复和 `requeueAfter` 到期都只负责让某个 ReqLoopRun 重新进入 reconcile；
Reconciler 读取最新 `spec/status` 和必要的外部状态，再决定当前是否需要：

- 更新 `status` 与 Board projection；
- 调用 reqloop 自己的 Connector，使外部状态靠近 `spec`；
- 返回一段 `proposedInput`，建议用户审核后交给 Harness；
- 没有下一步时等待新事实，或用 `requeueAfter` 安排下一次检查。

Reconciler 不把触发原因当成必须执行一次的命令。重复触发、队列合并或进程重启都可以让同一
key 再次 reconcile；只要 `spec` 和外部状态没有变化，它就不应产生新的非幂等动作。Board 是
ReqLoopRun 面向人和其他参与者的共享投影与操作面，而不是另一份领域事实源。

### Requirement

Requirement 是对不同需求平台的最小共同语义。reqloop 关心目标、描述、验收条件、当前状态和
外部引用，不把 Meego 或 Teambition 的原始 DTO 作为领域对象。

平台特有字段保留为带 provenance 的 extension 或 raw reference；只有真实 loop 逻辑需要的
共同语义才进入 Requirement 模型。

### Deployment

Deployment 表示“将某个 Delivery 投放到目标环境的一次尝试”。它独立于具体 pipeline，至少
需要区分目标环境、输入交付物、运行状态、结果和外部引用。

部署成功只是事实，不自动意味着 Requirement 完成；是否继续 review、修复或收尾由
Completion Policy 决定。

### Verdict

Verdict 表示对某个 Delivery 或 Deployment 的结构化判断，例如 passed、changes requested、
blocked 或 inconclusive，并携带证据引用。review、e2e、eval 和 perf 可以有不同 payload，
但都能驱动“继续、修复、确认或终止”的决策。

## 3. Connector：reqloop 的内部适配层

Connector 是 reqloop 内部的领域 port，用于隔离外部平台差异。它不是 Baton 概念，也不注册为
Baton runtime 中的独立组件。

```text
                        reqloop
┌───────────────────────────────────────────────────────┐
│ ReqLoopRun / Reducer / Reconciler / Policy / Commands │
│                    │                                  │
│          internal Connector ports                     │
│       ┌────────────┼─────────────┐                    │
│       ▼            ▼             ▼                    │
│ Requirement    Deployment      Verdict                │
│ Connector      Connector       Connector               │
└───────┬────────────┬─────────────┬─────────────────────┘
        ▼            ▼             ▼
   Meego/TB      BITS/K8s/...   Review/Eval/...
```

首批内部 port 可以按领域拆分：

- **RequirementConnector**：查询、读取、更新和关闭 Requirement，观察需求变化；
- **DeploymentConnector**：创建部署、读取状态、取消或重试，观察部署结果；
- **VerdictConnector**：发起或读取 review/eval，观察 verdict 变化。

Connector 只做三件事：

1. 调用外部平台协议；
2. 将外部 DTO 映射为 reqloop 领域对象；
3. 将平台变化归一成 reqloop 领域事实。

Connector 不负责 Baton session 路由、Board 渲染、Harness 选择、完成条件或跨领域编排。
这些职责分别属于 Baton 和 reqloop domain。

实现可以叫 `MeegoRequirementConnector`、`TeambitionRequirementConnector`、
`BitsDeploymentConnector`。它们由 reqloop 内部 registry 根据 PluginInstance 配置选择；
Baton 只看到 reqloop PluginInstance，不看到 Connector identity。

### 配置与多实例

一个 reqloop PluginInstance 可以配置多个具名 Connector，例如一个需求源、dev/test/prod
部署目标和多个 verdict source。Credential 仍由 Baton 按 reqloop 声明的 capability 注入，
但配置 schema 和使用方式由 reqloop 定义。

首版 Connector 随 reqloop package 交付，不急于开放第三方 Connector SDK。等出现独立发布、
版本兼容和多团队贡献的真实需求后，再设计 reqloop 自己的扩展机制，避免提前在 Baton 中恢复
第二套 Plugin 系统。

## 4. reqloop 对 Baton 的贡献

从 Baton 视角，reqloop 只是一个能力较完整的 Plugin：

```text
reqloop
├── slash command    /requirement
└── resource         ReqLoopRun
    ├── spec/status schema
    ├── reconciler   按 ReqLoopRun key 收敛状态
    ├── board        Requirement、进展、证据和待处理事项
    └── context?     单次 Harness turn 的筛选或补充
```

reqloop 的 Connector 是 Resource controller 的内部依赖，不提升为 Baton Contribution。
Reconciler 可以在 manifest 已声明、当前 `spec` 已授权的范围内直接调用 Connector：

```text
ReqLoopRun.spec 要求 review
  → ReqLoopReconciler
  → VerdictConnector.start(stable operation key)
  → patch status.review = running
  → requeueAfter
  → VerdictConnector.get
  → patch status.review = completed
```

外部操作如果超时，Reconciler 先按稳定 operation key 重新观察，不能盲目重复创建。只有将来
出现无法自然表达成 `spec`、又需要被独立调用的一次性命令时，才为 Baton 增加 Action。

## 5. 与 devloop 和 Harness 的关系

devloop 下沉为 Harness 内部 Plugin，用 Codex/Claude Code 自己的 skill、hook、command 和
permission 机制规范 agent 的 PR/MR 开发小闭环。它不是 Baton Plugin，reqloop 不直接发现、
配置或调用 devloop。

```text
Baton ──context / user turn──▶ Harness
                                │
                           devloop 约束
                    开发 → lint/test → PR/MR
                                │ DevelopmentOutcome
                                ▼
                     Harness adapter / bridge
                                │ harness.delivery.ready
                                ▼
                              Baton
                                │ persisted event
                                ▼
                         ReqLoopReconciler
                           ├── patch status
                           └── Connector: 部署/review/收尾
```

reqloop 只消费 Baton 归一后的 `harness.delivery.ready`、`harness.development.blocked` 等事件和
资源引用。这样 Requirement Loop 不依赖某个 Harness Plugin 的私有文件、hook payload 或安装
方式；未来其他 agent-loop 规范工具也可以产生同一 DevelopmentOutcome。

首期 reqloop 需要修改代码或诊断失败时，返回 `proposedInput.text`。Baton 将文本放入
composer，用户可以原样提交、编辑后提交或丢弃；只有提交后才成为普通 Input，继续走现有
Input → Attempt → Harness 路径。reqloop 不直接调用 Codex/Claude Code，也不持有其原生
session。

长期如果真实工作区证明必须在无人输入时恢复 Harness，再让 Reconciler 通过 Baton 的受控能力
请求一个或多个 Harness。该能力嵌套在 Resource/Reconcile 契约下，不提前增加一个顶层
Harness Work 类型；Harness 的路由、成本、并发、取消和可靠投递仍归 Baton。

## 6. 用户主流程

1. 用户首次运行 Baton 时看到 Requirement Loop quickstart；配置 reqloop 的需求与部署平台。
2. 用户通过 `/requirement` 选择需求，或直接粘贴、输入一项需求；reqloop 创建或恢复
   ReqLoopRun，将目标和验收条件写入 `spec`，并投影到 Board。
3. ReqLoopReconciler 返回“根据需求完成开发并提交 PR”的 `proposedInput`，Board 展示这段
   文本。用户原样提交或编辑后提交，Baton 组装 context 并交给目标 Harness；这仍是
   user-driven turn。
4. Harness 内部的 devloop 约束 agent 完成开发小闭环；Harness 边界报告带 ReqLoopRun reference
   的 `harness.delivery.ready`，Reconciler 将 PR 等实际交付物写入 `status`。
5. `spec` 要求 review 且尚未启动时，Reconciler 调用 VerdictConnector，并用
   `requeueAfter` 定时读取长耗时 review 的结果。
6. review 要求修改时，Reconciler 返回包含 review 意见的修复 `proposedInput`；用户审核后再次
   驱动 Harness。
7. Deployment、Verdict 和 Completion Policy 满足时，Reconciler 更新 conditions，并在已由
   `spec` 授权的范围内推进部署或关闭需求。

Harness turn 停止、Board 更新或 Context 可用都不自动代表下一步已完成。reqloop 总是重新读取
最新 Resource 和外部状态，再决定更新 status、调用 Connector、建议 Harness 输入或等待。

## 7. Board、权限与渐进式自动化

对 reqloop 而言，Board 是与 Baton、其他 Plugin 和多个 Harness 共享的协作状态，而不只是一个
面向用户的进度面板：

> 类比刑侦团队的案件板：Requirement、MR、部署、review、阻塞和待核实问题像不同探员贴上去的
> 线索与进展。reqloop、Harness 和用户都能从同一块板上形成当前认知；devloop 等 Harness
> Plugin 产生的信息经 Harness adapter 进入这块板，但各领域事实仍由自己的 owner 负责。

- 用户通过 BoardView 观察 Requirement Loop 的目标、进度、结果、blocker 和待处理请求；
- ContextComposer 从 ReqLoopRun 与 Board snapshot 选择和当前 Harness、session、turn 有关的信息；
- reqloop 从 ReqLoopRun 投影 Requirement、Deployment、Verdict 等结构化摘要，也可以读取同
  scope 的 Baton 和 Harness observation，决定下一步如何收敛；
- Baton 并行驱动多个 Harness 时，各 Harness 的进度、交付物和交接状态经 Baton 投影到 Board，
  再按目标 Harness 编译成 context，实现受控的状态共享。

“可行动事项”和“状态事实”只是 UI 可使用的默认 facet，不是封闭数据类型或固定页面布局。
reqloop 读取带 revision 的结构化 BoardSnapshot，不解析面向人的渲染文本。

reqloop 只能更新自己的 ReqLoopRun status 与 Board projection，不能覆盖 Baton 或 Harness 的
事实；它通过 resourceRef、领域 ID 和 provenance 关联不同 owner 的信息。并行 observation 由
Reconciler 汇入新的 Resource revision，各 Plugin 和 ContextComposer 总是基于明确版本读取。

Board 也不是 reqloop 唯一的信息通道。领域事件仍走 Baton Event Ledger，Connector 原始状态
仍保留在外部系统或 reqloop 私有投影，大体积证据通过 Resource reference 按需读取；只对一次
Harness turn 有效或不适合共享的信息可以在 context 交付时单独补充。

reqloop manifest 声明 Connector 可能访问和修改的外部资源范围，使用户在启用 Plugin 时预先
知道它可能做什么。`spec` 表达已经认可的 desired state；部署生产或关闭需求等敏感变化应在
对应 spec 更新落盘前经过 Baton Permission Gate。Reconciler 只能收敛已授权的 spec，不能在
运行时自行扩大 operation 或 scope。Plugin 升级新增权限或扩大 scope 时必须重新授权。

自动化按信任渐进：

```text
Observe    Reconciler 只更新 Board，由人判断和执行
Recommend  Reconciler 给出 proposedInput
Approve    人审核、编辑后提交为普通 Input
Automate   已授权 spec 下的 Connector 操作自动收敛
Autonomous 真实工作区证明需要无人续跑后，再开放受控 Harness 调用
```

理想状态可以是用户什么都不做，但它是长期信任积累的结果，不是首次启用 reqloop 的默认模式。

## 8. 状态与恢复

ReqLoopRun 是 reqloop 持久化的 PluginResource，不以 Board 文本作为真相源。`spec` 保存用户
认可的 Contract，`status` 保存 Reconciler 对 Baton、Harness 和外部系统事实的当前观测；私有
Connector cursor 和缓存只用于加速读取，不成为第二真相源。

```text
Input / Harness Event / external observation / timer due
                         │
                         ▼
                    ReqLoopRun
                         │
                         ▼
                ReqLoopReconciler
                  ├── patch status
                  ├── Board / Context projection
                  ├── proposedInput
                  └── requeueAfter
```

BoardView 和 ContextBundle 按不同预算与受众从 ReqLoopRun 和相关事实中派生。Resource 创建、
spec 更新、Harness 结果和 `requeueAfter` 到期都会 enqueue 同一 key；Baton 合并重复触发，并
保证同一个 ReqLoopRun 不并发 reconcile。

ReqLoopReconciler 可以调用自己拥有的 Connector，但外部写入使用稳定 operation key；调用超时
或进程崩溃后先查询实际状态，再决定是否继续。`nextReconcileAt` 随 Resource 持久化，Baton
重启后恢复到期检查。Board 仍是跨参与者共享的协调读模型，不取代 ReqLoopRun 或外部系统的事实
来源。

## 9. Bundled Plugin 的产品形态

Baton 作为通用产品需要一个清晰的默认故事。reqloop 随 Baton 发行并出现在 onboarding、
`/help` 和 Plugin 列表中：

- 未配置：展示可接入的平台和最小配置路径；
- 已配置：`/requirement` 直接进入需求选择；
- 不需要：用户可以禁用 reqloop，只使用 Baton 的 Harness 接力或安装其他 loop Plugin。

“随 Baton 交付”不等于“写进 Baton core”。Baton 的默认 UX 可以优先展示 reqloop，但 UI 仍
通过 slash command、Board contribution 和 Plugin metadata 渲染，不读取 reqloop 私有状态。

## 10. 关键不变量

1. Requirement、Deployment、Verdict 和 ReqLoopRun 只属于 reqloop，不进入 Baton core。
2. Connector 只属于 reqloop 内部，不成为 Baton Plugin API 或 runtime identity。
3. Reconciler 可以调用 reqloop Connector，但只能收敛已授权 spec，并对不确定外部写入先观察
   后重试。
4. reqloop 只通过 Baton 的 Input、Event 和 Resource reference 与 Harness 协作，不发现或依赖
   devloop 等
   Harness Plugin 的内部实现。
5. 首期 Reconciler 只返回 `proposedInput`，用户提交后才形成普通 Input。
6. 未来即使开放主动 Harness 调用，reqloop 也不直接持有 Harness runtime 或原生 session。
7. ReqLoopRun 是持久 Resource；Board、Connector cursor 和私有 snapshot 都不是独立真相源。
8. reqloop bundled 但可禁用、可升级；Baton core 在没有 reqloop 时仍完整工作。
9. Plugin 声明能力不等于获得权限；敏感 desired state 在写入 spec 前完成授权。
10. reqloop 只能修改自己的 Resource status 与 Board projection；其他 owner 的产出只能作为
    observation 读取。
11. `requeueAfter` 是首期唯一时间触发；Baton 将其持久化为 `nextReconcileAt`。
12. Resource、Input、Harness 结果和 timer 只触发重新检查；Reconciler 不把触发当成必须逐条
    执行的命令。

## 11. 待继续讨论

1. Requirement 与 ReqLoopRun 是默认一对一，还是允许同一 Requirement 存在多个并行 run？
2. Completion Policy 的默认条件和用户覆盖边界是什么？
3. Connector 配置如何表达多个部署环境、租户和 credential binding？
4. 哪些真实场景不能由 `requeueAfter` 覆盖，足以引入 EventSource 或 Schedule？
5. ReqLoopRun 的 spec/status schema 如何版本化和迁移？
6. DevelopmentOutcome 应包含哪些最小字段，才能让不同 Harness Plugin 统一产生
   `harness.delivery.ready` 和阻塞事件？
7. 哪些 Connector 应随首版 reqloop 交付，第三方 Connector SDK 的触发条件是什么？
8. Connector permission scope 如何表达 project、BatonSession、环境和资源范围，Plugin 升级时哪些变化
   必须重新授权？
