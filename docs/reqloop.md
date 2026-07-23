# reqloop：Requirement Loop Plugin 设计

> 状态：讨论草案。reqloop 是 Baton 随产品交付的首个官方场景 Plugin，用一条开箱可理解的
> Requirement Loop 展示 Baton 能做什么。本文只描述 reqloop 的领域与内部边界；Baton 的通用
> Plugin、Event、Hook、Schedule、Board 和 Context 能力见
> [Loop Engineering 控制面](./loop-engineering.md)。

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
- reqloop 的私有状态和 credential 进入自己的 PluginInstance data/config；
- Baton 不导入 reqloop 类型，不根据 Requirement 状态写分支。

## 2. 核心概念

### ReqLoopRun

`ReqLoopRun` 是 reqloop 的聚合根，表示“一项 Requirement 正在经历的一次闭环”。它关联：

- RequirementRef：需求平台中的稳定身份；
- Deliveries：repo、branch、PR/MR、artifact 等开发交付物引用；
- Deployments：面向某个环境的部署尝试与结果；
- Verdicts：review、e2e、eval、perf 等判定及证据；
- Pending Decisions：需要用户确认或 Harness 判断的事项；
- Completion Policy：本次闭环的完成条件。

Requirement 是业务锚点，ReqLoopRun 是执行实例。二者分开，才能表达同一需求的重开、重试或
多环境验收，而不把外部需求系统状态直接当作内部状态机。

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
│ ReqLoopRun / Policy / Reducer / Commands              │
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
├── resources        requirement list/get、run status
├── event source     外部平台变化归一后的领域事件
├── subscriber       Harness、Plugin 和 Schedule 事件
├── actions          deploy、review、close requirement
├── operations       start development、deploy、review、repair、close
├── schedules        polling、deadline、定期验收
├── hooks            context、dispatch、action、completion gate
├── board             Requirement、进展、证据、关系和待处理事项
├── context           可选：单次 Harness turn 的筛选或补充
└── harness work?    预留：plan、diagnose、repair、summarize
```

reqloop 发出的外部领域事件以 reqloop PluginInstance 为 origin，同时保留实际平台和资源
provenance。Action 也始终先进入 Baton：

```text
reqloop policy
  → ActionIntent(target=reqloop instance, action=deployment.start)
  → Baton Policy / Permission / Audit
  → reqloop action handler
  → DeploymentConnector
  → ActionReceipt + domain event
```

即使 Action 的请求者和执行者都是 reqloop，也不能在 subscriber 或 Hook 中直接调用
Connector 绕过 Baton；否则权限、幂等、审计和恢复会形成旁路。

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
                              reqloop ──部署/review/收尾──▶ Baton Actions
```

reqloop 只消费 Baton 归一后的 `harness.delivery.ready`、`harness.development.blocked` 等事件和
资源引用。这样 Requirement Loop 不依赖某个 Harness Plugin 的私有文件、hook payload 或安装
方式；未来其他 agent-loop 规范工具也可以产生同一 DevelopmentOutcome。

首期 reqloop 需要修改代码或诊断失败时，更新 Board、贡献 context 并提示用户在 composer 中
启动 Harness。reqloop 不直接调用 Codex/Claude Code，也不持有其原生 session。

HarnessWorkIntent 只作为未来扩展点。实现 reqloop 后，如果真实工作区证明部署、verdict 或
Schedule 到达时必须在无人输入的情况下恢复 Harness，才开发这项能力。届时仍由 Baton 应用
路由、权限、并发、成本和确认策略，并把执行结果重新送回 reqloop 订阅的事件流。

## 6. 用户主流程

1. 用户首次运行 Baton 时看到 Requirement Loop quickstart；配置 reqloop 的需求与部署平台。
2. 用户通过 `/requirement` 选择需求，或直接粘贴、输入一项需求；reqloop 创建或恢复
   ReqLoopRun，并把目标和验收条件作为状态事实呈现在 Board。
3. reqloop 提交“开始开发”的 PermissionRequest；默认 Manual 策略下，Baton 询问用户，UI 可以
   将它呈现为 Board 待处理项。
4. 用户同意后，Baton 从 Board、reqloop 和自身状态组装 context，交给目标 Harness。Harness
   内部的 devloop 约束 agent 完成开发小闭环；因为有显式用户决策，这仍是 user-driven turn，
   不依赖预留的 HarnessWorkIntent。
5. Harness 边界报告 `harness.delivery.ready` 后，reqloop 提出部署与 verdict 行动。Manual
   策略逐项询问；已配置 Always Accept 的操作自动进入 Baton Action 路径。
6. Connector 报告外部变化，reqloop 更新 ReqLoopRun、Board 状态和 Context contribution。
7. verdict 要求修改时，reqloop 提出修复行动并准备 context；用户同意后 Harness 进入下一轮。
8. Completion Policy 满足时，reqloop 提出关闭需求行动；获得授权后通过 RequirementConnector
   关闭需求。

Harness turn 停止、Board 更新、Context 可用都不自动代表下一步可以执行。reqloop 只根据持久化
领域事实提出 Intent，最终仍由 Baton 的 Policy、Approval 和调度路径决定是否执行。

## 7. Board、权限与渐进式自动化

对 reqloop 而言，Board 是与 Baton、其他 Plugin 和多个 Harness 共享的协作状态，而不只是一个
面向用户的进度面板：

> 类比刑侦团队的案件板：Requirement、MR、部署、review、阻塞和待核实问题像不同探员贴上去的
> 线索与进展。reqloop、Harness 和用户都能从同一块板上形成当前认知；devloop 等 Harness
> Plugin 产生的信息经 Harness adapter 进入这块板，但各领域事实仍由自己的 owner 负责。

- 用户通过 BoardView 观察 Requirement Loop 的目标、进度、结果、blocker 和待处理请求；
- ContextComposer 从 BoardState 选择与当前 Harness、session、turn 有关的信息；
- reqloop 向 Board 贡献 Requirement、Deployment、Verdict 等结构化摘要，也可以读取同 scope
  的 Baton 和 Harness 状态，决定下一步提出什么 Event/Intent；
- Baton 并行驱动多个 Harness 时，各 Harness 的进度、交付物和交接状态经 Baton 投影到 Board，
  再按目标 Harness 编译成 context，实现受控的状态共享。

“可行动事项”和“状态事实”只是 UI 可使用的默认 facet，不是封闭数据类型或固定页面布局。
reqloop 读取带 revision 的结构化 BoardSnapshot，不解析面向人的渲染文本。

reqloop 只能更新自己 namespace 下的 contribution，不能覆盖 Baton 或 Harness 的条目；它通过
resourceRef 和 correlation 关联不同 owner 的信息。并行更新由 Baton 生成新的 Board revision，
各 Plugin 和 ContextComposer 总是基于一个明确的 snapshot 读取。

Board 也不是 reqloop 唯一的信息通道。领域事件仍走 Baton Event Ledger，Connector 原始状态
仍保留在外部系统或 reqloop 私有投影，大体积证据通过 Resource reference 按需读取；只对一次
Harness turn 有效或不适合共享的信息可以在 context 交付时单独补充。

reqloop manifest 声明可能申请的操作列表，使用户在启用 Plugin 时预先知道它可能做什么。Baton
使用与 Harness/Provider 权限请求相同的 Permission Gate，为每个
`requester + operation + scope` 保存策略：

- **Manual**：每次请求用户同意，UI 可以在 Board 呈现待处理项；
- **Always Accept**：自动同意同一作用域内的该项操作，但仍生成行动、Action 和 Receipt 历史。

默认 Manual。Always Accept 不是 Plugin 级总开关，用户可以让 dev 部署自动通过，同时继续手动
批准生产部署和关闭需求。Plugin 升级后新增操作或扩大 scope 时必须重新授权。

自动化按信任渐进：

```text
Manual
  → 用户观察 reqloop 的建议和执行结果
  → 对低风险操作逐项 Always Accept
  → 更多 Action 自动推进
  → 真实工作区证明需要无人续跑
  → 再实现 HarnessWorkIntent，并复用同一授权模型
```

理想状态可以是用户什么都不做，但它是长期信任积累的结果，不是首次启用 reqloop 的默认模式。

## 8. 状态与恢复

ReqLoopRun 是 reqloop 领域投影，不以 Board 文本作为真相源。reqloop 的状态由 Baton 已持久化的
相关领域事件、ActionReceipt 和用户决策归约得到；私有 snapshot 只是加速恢复的缓存，并记录
消费水位。

```text
Baton event ledger
      │
      ▼
reqloop reducer ──▶ ReqLoopRun
      │                ├── BoardContribution
      │                ├── ContextContribution
      │                └── next Intent candidate
      ▼
cursor / snapshot cache
```

BoardContribution 进入共享 BoardState；BoardView、Plugin 可读的 BoardSnapshot 和
ContextBundle 再按不同预算与受众从中派生。Board 更新可以发出带 revision、changed keys、
origin 和 correlation 的 `board.changed` 事件，reqloop 据此重新读取 snapshot、评估并提出
新的 Intent。

Board observer 不能直接调用 Connector 或执行副作用；Intent 仍需经过 Baton 的
Policy/Permission/Action 路径，并使用 origin、correlation 和幂等键避免 contribution
反馈成自激 loop。ReqLoopRun 仍由领域事件、ActionReceipt 和用户决策归约；Board 是跨参与者
共享的协调读模型，不取代 reqloop 或外部系统的事实真相源。

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
3. 外部副作用必须经 Baton Action 路径，不能从 Hook/subscriber 直接调用 Connector。
4. reqloop 只通过 Baton 的 Event 和 Intent 与 Harness 协作，不发现或依赖 devloop 等
   Harness Plugin 的内部实现。
5. HarnessWorkIntent 只预留，必须由 reqloop 的真实工作区需求触发实现。
6. 即使未来实现，reqloop 也只提交 Intent，不直接持有 Harness runtime 或原生 session。
7. ReqLoopRun 从持久事件归约；Board 和私有 snapshot 都不是独立真相源。
8. reqloop bundled 但可禁用、可升级；Baton core 在没有 reqloop 时仍完整工作。
9. Plugin 声明操作不等于获得权限；默认 Manual，Always Accept 按 operation 和 scope 授予。
10. reqloop 只能修改自己的 Board contribution；可以读取其他 owner 的共享状态来提出 Intent，
    但不能由 Board observer 直接执行副作用。
11. reqloop Action 与 Harness/Provider tool approval 使用同一套 Baton Permission 语义。

## 11. 待继续讨论

1. Requirement 与 ReqLoopRun 是默认一对一，还是允许同一 Requirement 存在多个并行 run？
2. Completion Policy 的默认条件和用户覆盖边界是什么？
3. Connector 配置如何表达多个部署环境、租户和 credential binding？
4. webhook、polling cursor 与 Baton Schedule 如何共同保证不漏事件且不重复推进？
5. reqloop Action namespace 与领域事件 schema 如何版本化？
6. DevelopmentOutcome 应包含哪些最小字段，才能让不同 Harness Plugin 统一产生
   `harness.delivery.ready` 和阻塞事件？
7. 哪些 Connector 应随首版 reqloop 交付，第三方 Connector SDK 的触发条件是什么？
8. Operation scope 如何表达 workspace、环境和资源范围，Plugin 升级时哪些变化必须重新授权？
