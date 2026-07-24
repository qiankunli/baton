# Baton v2：面向 Loop 的内核模型

> 状态：目标设计。本文从绿地视角描述 Baton 为承接长期 Loop Engineering 所需的内核形状。
> Event v3、Interaction、HarnessTarget / HarnessLaunchSnapshot，以及用户驱动 Harness submit
> 的首个可靠投递切片已经落地；Context 已落下以 BatonSession `session_history` 为首个
> ContextSource 的 Snapshot / DeliveryReceipt / Epoch 切片。通用 ActionIntent、
> HarnessWorkIntent、更多 ContextSource 和主动 reconcile 仍是目标设计，不改变当前 v1
> 以统一会话和跨 Harness 上下文接力为主的产品范围。
> 当前稳定内核见 [kernel](./kernel.md)，Loop 控制面与分阶段演进见
> [loop-engineering](./loop-engineering.md)。

## 1. 理念与概念

### 1.1 v2 解决什么

v1 已经建立 BatonSession、Turn、Event、Adapter 和 Projection，使用户可以在一条正典历史中
切换 Harness。Loop 带来的新要求不是“再加一种自动 prompt”，而是：

1. 外部事实、时间和用户意图都能可靠地产生工作；
2. 进程崩溃、请求超时或 Harness 回执丢失后，系统仍知道工作是否可能已经被接收；
3. 同一个逻辑会话可以更换 Harness 和执行位置，而不混淆历史、配置与原生 session；
4. Board、Plugin 与外部资源形成的上下文可以增量交付，并能判断目标 Harness 实际看到了什么；
5. 领域 loop 保持由 Plugin 拥有，Baton core 只提供跨领域重复出现的运行原语。

因此 v2 是一次内核概念收敛，不是一组新的产品功能。它首先定义身份、事实、调度和恢复边界，
再由 reqloop 等 Plugin 在其上组合具体工作闭环。

### 1.2 三个正交作用域

v2 必须把控制范围、逻辑历史和执行位置分开：

| 概念 | 回答的问题 | 不负责 |
|---|---|---|
| **Workspace** | 哪些配置、PluginInstance、Permission 和 Schedule 在一起生效？ | 不等同于 cwd，也不保存对话历史 |
| **BatonSession** | 用户正在延续哪一条正典逻辑历史？ | 不代表某个 Harness 的原生 session |
| **HarnessTarget** | 这次工作要由哪个已配置的 Harness、以什么执行位置和能力运行？ | 不承载可变的会话历史 |

在此基础上还有两个执行侧对象：

- **HarnessSession**：某个 Harness 的原生执行状态，可以恢复或重建；
- **HarnessLaunchSnapshot**：创建或恢复 HarnessSession 时实际使用的 HarnessTarget、cwd、
  model、能力和相关配置的不可变快照。

```text
Workspace
├── PluginInstance / Permission / Schedule
├── HarnessTarget
└── BatonSession
      ├── Turn
      ├── HarnessLaunchSnapshot ──▶ HarnessTarget
      └── HarnessSession
```

v1 可以把当前项目隐式映射成一个 Workspace，不要求先提供多 workspace 产品能力。关键是不要
继续让 cwd、Harness 名称或“当前 session”同时承担以上三种身份。恢复历史时使用当时的
HarnessLaunchSnapshot 解释执行事实；再次执行时仍要检查当前权限和可用性，旧快照不是永久授权。

### 1.3 Event 与 Signal

Loop 中必须区分两类输入：

- **Event**：已经发生、会改变 reducer 或领域判断的事实。它先持久化，再分发，可按序列和
  cursor 重放；`eventId`、`scope`、`source` 必填，且归属、来源与 Harness/Turn 等执行坐标正交；
- **Signal**：提示“可能有新状态”的唤醒或失效信号。它可以合并、重复或丢失，
  消费方收到后读取权威快照，再把观察到的新事实写成 Event。

二者可以共享 provenance 等来源信息，但不能共享可靠性承诺；落盘 Event 只用
`parentEventId` 指向直接上游 Event。
`wake(sessionId)`、文件变更通知和投影刷新属于 Signal；用户输入已 admit、外部资源状态改变、
Harness 接受工作和 Action 完成属于 Event。

```text
Signal ──▶ read canonical state ──▶ append Event ──▶ reduce / project
                         ▲
Event source ────────────┘
```

Signal 不是第二份真相源，也不能直接修改 Board、session projection 或领域状态。它只负责让
持有稳定 ID 的消费者尽快回来读取事实；即使 signal 丢失，重启后的 cursor、待处理工作扫描或
定期 reconcile 仍能恢复进度。

Event v3 信封先钉住以下稳定字段：

```ts
type EventEnvelope = {
  v: 3;
  eventId: string;
  scope:
    | { type: "session"; batonSessionId: string }
    | { type: "workspace"; workspaceId: string };
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

当前 `SessionHandle` 只写 session scope；workspace ledger 落地后才启用 workspace scope。
fork 复制的是同一段逻辑历史，因此保留 turn / interaction / message 等领域对象 ID；Event
envelope 因进入 child session ledger 而重新签发 `eventId` 并改 scope，保证一个 event id
只有一个权威归属。`scope` 不是 permission 的资源范围，也不能从 `source` 或 cwd 反推。

### 1.4 Interaction

所有“某个参与者必须给出结果，等待方才能继续”的阻塞协作统一为 Interaction：

```text
InteractionDraft
  → Controller 签发 interactionId + requester
  → interaction.opened
  → user / policy resolution
  → interaction.resolved
  → 唤醒 requester
```

permission、question、hook trust 只是 `kind`；未来 Plugin 申请授权或 elicitation 继续增加
kind，不再各造 Request、Fact 和 pending Map。`requester` 当前可为 HarnessTarget、
PluginInstance 或 Baton。`Event.source` 表示谁报告 opened/resolved 事实，不能替代 requester。

Interaction 与 Intent/Attempt 不同：Interaction 等待一个外部决定；Intent/Attempt 记录 Baton
已经决定执行的可靠工作。一个 permission Interaction resolved 后可以产生 ActionIntent，
创建 ActionIntent 的 Event 以 `interaction.resolved` Event 作为 `parentEventId`，但不能用
“用户已同意”冒充“动作已执行”。

Controller 是 Interaction 的 lifecycle owner，Adapter/Plugin 只提交 typed draft 并等待
resolution。turn cancel、timeout 和 crash recovery 都以 cancelled resolution 收口；自动
reviewer 根本没有向 Baton 打开 Interaction 时，只记录独立 ApprovalReview 审计 Event，不伪造
一段不存在的 pending 生命周期。

### 1.5 Intent、Attempt 与 Receipt

所有可能跨进程、调用外部系统或唤醒 Harness 的工作，都采用同一个三段模型：

```text
Event / user decision
          │
          ▼
Intent ──▶ Attempt ──▶ Receipt
           │
           └── prepared → dispatching ─┬→ accepted → finalized
                                      ├→ uncertain → accepted / finalized
                                      └→ finalized
                                             └── outcome: completed / not_accepted / failed / cancelled
```

- **Intent**：Baton 已经决定“要做什么”，例如 `ActionIntent` 或未来的
  `HarnessWorkIntent`；它是持久事实，不是一次易失函数调用；
- **Attempt**：一次具体投递，记录目标、不可变执行快照、幂等身份和状态；
- **Receipt**：资源 owner 或 Harness 对执行结果的持久回执。

`accepted` 只表示目标已经承认接收，不表示工作完成。请求超时但无法证明目标未接收时进入
`uncertain`，由 reconcile 查明，不得把它猜成失败后直接重复投递。只有确认未接收或使用相同
幂等身份安全重试时，才能重新 dispatch。

Attempt 的生命周期字段叫 `phase`；`finalized` 只表达状态机已经收口，最终结果由仅在该
phase 出现的 `outcome` 表达。二者分开后，“已经结束”和“以何种结果结束”不会挤进一个枚举，
字段名也无需再加 `final` 前缀重复编码终态语义。

Attempt ledger 的 owner 是 Baton，实际执行的 owner 是目标 PluginInstance 或 Harness；事件由谁
观察、谁订阅，并不改变这两个所有权。这样 EventSubscriber、Hook 和 Schedule 都只负责提出
工作，不会各自长出一套执行状态机。

Intent 的身份和内容也必须分开：

- 相同 `idempotencyKey`、相同 payload digest：返回原 Intent/Attempt；
- 相同 `idempotencyKey`、不同 payload digest：冲突，拒绝静默复用；
- 不同 `idempotencyKey`、相同内容：是两个独立意图。

跨 Adapter 的关键身份不能藏在日志或 `raw` 中。至少要能贯穿
`intentId → attemptId → batonSessionId → turnId → harnessTargetId →
harnessSessionId?`，对应 Event 用 `parentEventId` 记录直接上游。Baton 先持久化 Attempt，再发起外部投递；
目标接受后，先把 provenance 落盘，才允许后续状态机继续推进。

### 1.6 Context 是可对账的交付

Board 只是共享协作读模型，不等于 Harness 已获得上下文。v2 将 Context 拆成：

- **ContextSource**：按稳定 key 和 owner 管理的来源，如 BatonSession 摘要、BoardSnapshot、
  Plugin contribution 或 ResourceRef；
- **ContextSnapshot**：某次组装看到的各 source revision/watermark 及内容摘要；
- **ContextEpoch**：目标 HarnessSession 当前已知上下文基线的版本；
- **ContextDeliveryReceipt**：实际向哪个 HarnessSession、通过何种 transport 交付了哪个
  snapshot，以及目标是否确认接受。

```text
ContextSource ──▶ ContextSnapshot ──▶ ContextBundle
                                           │
                                           ▼
                                  HarnessSession
                                           │
                                  DeliveryReceipt
                                           │
                                  ContextEpoch 前进
```

某个 source 暂时不可用时，应标记 unavailable 并保留上次可靠快照，不应把“读取失败”解释成
“来源已删除”。compaction 产生新的基线快照，而不是悄悄丢掉此前已经交付的约束。大体积材料仍
通过 Resource/MCP/CLI 按需读取，不复制进 Board 或 prompt。

当前首个落地切片刻意保持小：`ContextSource` 判别联合只有 `session_history`，其
`owner + key` 稳定指向一条 BatonSession 正典历史；每次 catch-up 先持久化包含
`(afterSeq, throughSeq]` 和实际文本的 Snapshot，再经三种既有 transport 之一交付。只有
`syncContext` resolve 或携带上下文的 submit admission 通过后才落 DeliveryReceipt；
ContextEpoch 从 Receipt 重放，`meta.syncedSeq` 仅保留为旧会话迁移和读取加速的缓存。
Snapshot 存在但 Receipt 缺失表示未证明送达，下次仍可重新组装。当前上下文只随用户 Turn
投递、没有独立自动重试，因此不提前增加 ContextDeliveryAttempt；当 Context 能脱离 Turn
独立调度时再补 Attempt / 幂等键。

### 1.7 Lineage 与领域所有权

重试、fork、delegate 和 handoff 必须使用显式 lineage，不能根据时间戳、当前活跃会话或
“最近一条消息”推断：

- Turn retry 记录 parent turn 和 relation；
- BatonSession fork 记录 source session 与共享历史边界；
- 只有跨 BatonSession 的 fork/delegate/handoff 才需要 `SessionLink` 或未来的
  `CollaborationAttempt`；
- 同一 BatonSession 内 `/codex`、`/claude` 切换只是 Harness 接力，不是一次协作 run。

Baton core 不引入通用 `LoopRun`。Requirement、Deployment、Verdict 和 `ReqLoopRun` 由
reqloop 拥有，其他 Plugin 也拥有自己的聚合根、checkpoint 和完成条件。除非多个独立领域证明
存在完全相同的生命周期，core 只提供 ResourceRef、Event、Intent/Attempt/Receipt、
`parentEventId` 关系和 projection 原语。

## 2. 流程

### 2.1 用户驱动的 Turn

v2 保留 v1 的输入语义：draft 和 queued follow-up 可召回，Input 一旦 admit 就进入
BatonSession 正典历史。随后：

1. controller 预分配稳定 Input/Turn identity，并持久化 admit 事实；
2. 解析目标 HarnessTarget，生成本次 HarnessLaunchSnapshot；
3. 组装 ContextSnapshot/Bundle，持久化 ContextDeliveryAttempt；
4. 为 Harness submit 创建 Attempt 后再投递；
5. Harness 接受后记录原生 session/turn provenance；执行事件继续进入 BatonSession ledger；
6. Turn 终态、ContextDeliveryReceipt 和 Harness work receipt 分别收口，不能相互代替。

同一 BatonSession 的 driven Turn admission 继续由 Controller 串行化；不同 BatonSession
可以在权限和容量策略允许时并发。Harness 自发的 observed Turn 仍与 driven queue 正交。

当前落地切片复用已持久化 Input 的 message identity 作为上游 Intent identity，不提前引入
`HarnessWorkIntent`：Controller 在 submit 前先持久化引用 Input identity、包含
HarnessLaunchSnapshot 的 Attempt；Adapter 接受投递责任后记为 `accepted`，Harness 来源的
idle 作为权威终态 Receipt 收口。若只有 Baton 合成的终态，或重启时无法证明 Harness 是否
接收或结束，则保留为 `uncertain`，不自动重投。当前尚无自动重试，因此不提前把
`idempotencyKey` 或 payload digest 塞进 Adapter 契约；需要安全重试时再按 §1.5 引入。

queued follow-up 仍不是持久工作队列。来自 Schedule、Plugin 或外部事件的自动工作先表达为
`HarnessWorkIntent`；经过 Policy、路由和冲突处理并真正 admit 到 BatonSession 后，才产生
对应 Input/Turn。这样用户召回语义不会被后台任务复用。

### 2.2 事件驱动的 Loop

```text
外部变化 / Schedule
  → append Event
  → Plugin reducer / policy
  → append ActionIntent 或 HarnessWorkIntent
  → Permission / routing
  → append Attempt(prepared)
  → dispatch / wake by stable id
  → accepted | uncertain
  → Receipt / result Event
  → Board projection + Plugin 下一次决策
```

Schedule 和 Hook 只产生事实、contribution 或 Intent，不拥有自己的执行状态机。进程恢复时，
Baton 扫描未 finalized 的 Attempt 和各 subscriber cursor；它不依赖某个 timer callback、
内存队列或 wake 信号仍然存在。

### 2.3 恢复与对账

恢复过程按事实而不是按 UI 状态进行：

1. 从 BatonSession ledger 恢复正典历史和未终结 Turn；
2. 从 Plugin/Event ledger 恢复 cursor、领域事实和 Intent；
3. 扫描未 finalized Attempt：`prepared` 可继续投递，`accepted` 查询进度，
   `uncertain` 必须 reconcile；
4. 使用 HarnessLaunchSnapshot 解释既有执行，再按当前 HarnessTarget 与 Permission 判断能否
   继续；
5. 从 ContextDeliveryReceipt 重建每个 HarnessSession 的 ContextEpoch；
6. 最后发出必要的 signal，让 controller 拉取并推进仍有工作的稳定 ID。

这使“Baton 是否打开”“某次 wake 是否送达”和“UI 是否正在显示”都不再决定 loop 的正确性。
daemon 只提高关闭 TUI 时的实时性，不改变事实、调度和恢复协议。

## 3. 关键设计

### 3.1 Workspace 不是另一种会话

Workspace 是配置、信任和运行策略的作用域；BatonSession 是用户历史；HarnessTarget 是执行
放置。三者分离后，同一 workspace 可以有多条历史，同一历史可以切换多个 target，target
配置变更也不会重写既有执行事实。

### 3.2 可靠唤醒来自持久工作，不来自更强的 signal

没有必要要求所有 Harness 都提供“绝不丢失的 wake”。Baton 先持久化 Intent/Attempt，再用
Signal 提醒 Controller 按 ID 取任务；Signal 合并或丢失时，恢复扫描仍能找到工作。可靠性由
ledger 和幂等投递提供。

### 3.3 `uncertain` 是必要状态

跨进程调用存在“目标已接收，但响应在返回途中丢失”的窗口。把它直接记成 failed 会导致重复
副作用，把它直接记成 accepted 又会掩盖未知。`uncertain` 明确要求后续 reconcile，是 Action
和 Harness Work 能共享的最小正确模型。

### 3.4 Board、领域状态和执行状态分层

三层分别回答不同问题：

```text
Plugin-owned Run       业务现在应该走到哪一步
Intent / Attempt       这一步是否已经被可靠地投递和执行
BoardState             人和多个 Harness 现在需要看到什么
```

Board 可以由前两层投影，也可贡献下一步决策所需信息，但不能替代领域聚合或执行 ledger。

### 3.5 先收敛内核，再开放自动 Harness Work

v2 的落地顺序应是：

1. 在现有 Harness registry 外增加 HarnessTarget 与 HarnessLaunchSnapshot；
2. 明确 Event 与 Signal 的不同承诺；
3. 先让现有用户驱动的 Harness submit 落入 Attempt ledger，验证
   Intent/Attempt/Receipt 和 `uncertain` 恢复，再让 ActionIntent 与未来的
   HarnessWorkIntent 复用，并在真实重试需求出现时补齐幂等身份；
4. 以 `session_history` 落下 ContextSource/Snapshot/Epoch/DeliveryReceipt 首个切片，再按
   Board / Plugin / Resource 的真实接入需求扩展 source kind；
5. 用 reqloop 跑通用户确认驱动的 loop；
6. 真实场景证明需要无人输入主动续跑时，才开放 HarnessWorkIntent；
7. 只有关闭 TUI 仍要求实时推进时，才引入 daemon。

这条顺序不要求一次重写 v1 存储或协议。每一步都应保持旧 BatonSession 可重放，并通过新增
对象与投影逐步迁移；具体产品阶段见 `loop-engineering.md` §10。
