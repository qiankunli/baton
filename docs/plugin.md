# Baton Plugin 设计

> 状态：分阶段实现。Instance 持久化、可信进程内 Package 激活、Binding 生命周期，
> Resource / Reconcile / Proposal / 动态唤醒，以及本地 / Git Marketplace 的发现和不可变
> Package 安装、`/plugins` 首期管理面已经落地；Command、Board、Instance 管理和权限审阅仍按
> 真实产品入口增量实现。
> Loop 控制面的整体位置见
> [Loop Engineering](./loop-engineering.md)，reqloop 的领域设计见
> [reqloop](./reqloop.md)，当前稳定内核见 [kernel](./kernel.md)。

## 1. 理念与概念

### 1.1 要解决的问题

Baton Plugin 要让一个领域扩展在不进入 Baton core 的前提下：

1. 定义自己的 Loop Resource，以 `spec` 表达期望、以 `status` 表达观测；
2. 根据 Resource 和外部系统的最新状态执行 reconcile；
3. 向 Board 投影状态，并给出一段可由人审核、编辑后交给 Harness 的文本；
4. 在已声明的权限内调用自己的 Connector，逐步收敛外部状态；
5. 在 Baton 重启后恢复配置、Resource 和下一次 reconcile。

Plugin 不是一组随意拼接的回调。它既是可交付的能力包，也是在一个 BatonSession 中可配置、
可持久恢复的领域参与者。Baton 负责控制面一致性，Plugin 负责自己的领域模型和外部系统适配。

本文不决定 Harness Plugin 如何报告 `DevelopmentOutcome`。无论未来使用 Harness 原生事件、
Hook bridge 还是受控命令，进入 Baton 后都必须先归一成带可信来源的 Event；Baton Plugin 只
依赖归一后的事实，不依赖其 transport。

### 1.2 三层边界

三类扩展位于不同层次：

- **Harness Plugin**：运行在 Codex、Claude Code 等 Harness 内，扩展或约束当前 agent loop；
- **Baton Plugin**：运行在 Harness 之上的控制面，观察和推进跨 session、跨系统的领域 loop；
- **Harness**：执行智能工作的专用协议，不是普通 Baton Plugin 的一种能力。

Baton core 不导入 Requirement、Deployment、Review 等 Plugin 领域类型。Plugin 也不能持有
Controller、HarnessAdapter、EventStore、BoardState 或 TUI 的裸句柄。跨 Plugin 协作统一经过
Baton 的 Resource、Event 和 Contribution 路径，不直接调用彼此的内部接口。

一个 Plugin 包未来可以附带 Harness 实现，但 Harness 仍按独立的 Harness 契约注册和运行，
不进入普通 `PluginContribution`。

### 1.3 运行模型

```text
PluginPackage
    └── PluginInstance
          └── PluginBinding
                └── PluginContribution[]
```

#### PluginPackage

`PluginPackage` 是不可变的交付物，包含：

- 稳定的 `pluginId`、版本和 manifest 版本；
- 展示信息、配置 schema 和 secret 声明；
- 可安装前审阅的 Contribution 与权限声明；
- 激活入口及其所需的只读资源。

Package 版本目录只读。同一版本一旦安装便不原地修改；升级产生新的 Package 版本，避免运行中
代码和已审阅权限发生静默漂移。

当前可信进程内实现把运行契约收窄为 `pluginId + version + activate(context)`。Package
manifest 先声明 `manifestVersion + pluginId + version + entry` 和可选展示信息；配置 schema、
Contribution 与权限声明等到对应的安装审阅和运行期校验入口出现时再扩展，不先造无人消费的
字段。

#### PluginInstance

`PluginInstance` 是某个 Package 在 BatonSession 中的一份配置身份，包含：

- 稳定的 `pluginInstanceId` 和 Package 引用；
- 所属 `batonSessionId`；
- 启用状态、配置、secret 绑定和权限策略；
- 独立的可写数据位置。

一个 Package 可以有多个 Instance，例如同一 reqloop 分别连接不同组织或环境。
`pluginId` 回答“是什么扩展”，`pluginInstanceId` 回答“当前由哪份配置负责”。

Instance data 只保存 Connector cursor、缓存或确实私有的材料。可驱动 loop 的领域状态进入
Plugin Resource 的 `spec/status`；外部平台仍是其领域事实的来源。不能把一份不透明的
`private runtime state` 变成 Baton 无法恢复、无法审计的第二真相源。

#### PluginBinding

`PluginBinding` 是 PluginInstance 在当前 Baton 进程中的一次活动绑定。它拥有本次激活产生的
全部 handler、订阅和定时唤醒，并在 disable、reload 或进程退出时统一撤销。

Binding 是临时生命周期，不持久化业务事实。把运行期注册收口到 Binding，可以保证激活失败时
整体回滚，禁用或升级时不会留下旧版本回调。

当前 `PluginActivationContext` 只开放按当前 Instance 收口的 Resource 注册，以及非 Resource
资源的 `onClose` cleanup。激活完成后 Binding 被封口，不能异步偷注册新 handler；关闭时按注册
逆序撤销；Plugin 先登记底层 Connector cleanup、再登记依赖它的 handler，即可保证 handler
先停、Connector 后关。

#### PluginResource

Plugin 用类似 CRD 的方式声明领域 Resource schema；Baton 持久化通用信封，但不理解
`spec/status` 内部字段：

```text
PluginResource<TSpec, TStatus>
├── metadata      identity / owner / generation / resourceVersion
├── spec          用户认可的期望状态与 Loop Contract
└── status        Reconciler 观测到的当前状态、条件和结果引用
```

`spec` 与 `status` 的区分是 Loop 的声明性边界：

- `spec` 回答“希望这条 loop 最终怎样”，由用户直接编辑，或接受 Harness / Plugin 的建议后更新；
- `status` 回答“现在实际怎样”，由 Reconciler 根据 Baton、Harness 和外部系统事实更新；
- `metadata.generation` 随 `spec` 变化递增，`status.observedGeneration` 表示当前状态基于哪版
  Contract；
- `status` 原则上应能重新观测或重新计算，不能藏入唯一凭据或不可恢复的工作；
- Board 是 Resource 和其他协作事实的人类可读投影与操作面，不是 Resource 本身或另一份真相源。

用户、Harness 和外部系统都可以带来新事实，但不直接任意改写同一份对象：用户认可的决定进入
`spec`，Harness 与外部系统的产出作为带 provenance 的 observation 进入，Reconciler 统一收敛
`status`。未来一个 Loop 启动多个 Harness 时，各自产出仍汇入同一个 Resource / Board，不形成
多个并列状态机。

#### PluginContribution

Plugin 的扩展点收束为一个以 `kind` 区分的判别联合：

| kind | 作用 | 返回或产生 |
|---|---|---|
| `command` | 用户直接发起的入口 | 创建、选择或修改 Resource |
| `resource` | 声明和控制一种领域 Resource | schema、reconcile、Board projection、可选 Context projection |

Manifest 中保存可序列化的 `ContributionDeclaration`；Binding 以相同的 `kind + id` 注册运行期
handler。Baton 在激活时校验二者一致，既能让安装者提前看见能力和风险，又不把函数或进程细节
写进 manifest。

Reconciler、Board projection 和 Context projection 都属于某种 Resource，不作为平铺的
Contribution。首期也不提供 Monitor、Schedule、Action 或通用 Hook：领域收敛和定时重查分别
使用 `reconcile` 与 `requeueAfter`。只有 webhook、关闭 TUI 后的持续监听、无法表达成 desired
state 的独立命令，或真实同步拦截不能由当前契约表达时，才增加对应的窄接口。

### 1.4 Marketplace 与 `/plugins`

`/plugins` 是 Baton 自有、不可被 Plugin 覆盖的统一管理入口。它同时承载 Package 获取和
Instance 管理，但在信息结构上保持两者分层：

```text
/plugins
├── Discover       Marketplace 中可获得的 PluginPackage
├── Installed      bundled / 已安装的 PluginPackage
├── Marketplaces   已注册的 Marketplace 与来源
└── Errors         Marketplace / Package 加载错误
```

首期管理面保留上方当前 BatonSession 历史，在底部打开可搜索的管理面板；Package 与
Marketplace 详情在面板内逐层展开，不把 Plugin 管理伪装成新的 Session。当前已打通：

- 注册本地目录或 Git 仓库形式的 Marketplace；
- 从 Marketplace 仓内相对路径发现 PluginPackage；
- 校验 Marketplace 索引与 Package manifest 的 `pluginId` 一致；
- 按 `pluginId + version` 安装不可变快照并记录来源；
- 从 `/plugins` 浏览、搜索、查看详情并安装 Package；
- 从安装缓存加载可信的进程内 PluginPackage，交给现有 Manager 激活。

`baton plugins marketplace add|list`、`baton plugins available`、`baton plugins install` 和
`baton plugins list` 继续作为添加来源与开发验证入口；普通浏览和安装走 `/plugins`。Plugin
自己的 `/requirement` 等 command 用来使用领域能力，`/plugins` 只负责能力的获取、配置和
生命周期。这些管理操作由 Baton core 执行，不注册成普通 PluginContribution，也不能被 Plugin
自己拦截或替换。

Instance 的启停、配置与 Package 更新 / 卸载尚未进入首期面板：Package 安装不等于创建或启用
Instance，更新也不能静默改写现有 Instance 引用。等这些运行期动作具备完整校验和回执后，再在
Installed 详情下展开 Instance 层，不先提供看似可点、实际语义不完整的动作。

Marketplace 是长期的 Package 发现与分发层，负责搜索、版本、来源、信任信息、安装、升级和
卸载。它交付不可变的 PluginPackage 后便退出运行链路，不拥有 PluginInstance、Binding、
权限策略、PluginResource 或 reconcile due time。安装 Package 也不等于启用 Instance，更不
等于批准其 Connector 权限。

`pluginId` 是跨 Marketplace 稳定的包身份，应使用 owner namespace 避免冲突；Marketplace
来源作为安装 provenance 单独记录，不拼进 PluginInstance 身份。这样更换分发源不会让既有
Instance、Resource 和权限记录变成另一套对象。

Marketplace 和 Package 各自使用一份小 manifest。Marketplace 索引只保存 Package 身份和仓内
相对路径，Package manifest 才是版本、入口和展示信息的权威来源：

```json
{
  "name": "reqloop",
  "plugins": [
    {
      "pluginId": "qiankun/requirement-loop",
      "source": "./requirement-loop"
    }
  ]
}
```

以上文件位于 `<marketplace>/.baton-plugin/marketplace.json`。对应 Package 的
`<package>/.baton-plugin/plugin.json`：

```json
{
  "manifestVersion": 1,
  "pluginId": "qiankun/requirement-loop",
  "version": "0.1.0",
  "entry": "./src/index.ts",
  "displayName": "Requirement Loop"
}
```

`source` 和 `entry` 都不能逃逸各自根目录。`entry` 模块 default export `PluginPackage`，其运行期
`pluginId + version` 必须再次与 manifest 一致。Git Marketplace 在注册时解析并记录 commit，
安装时复制 Package 自包含内容但排除 `.git` 与 `node_modules`；当前不执行依赖安装，因此
Package 入口必须能从安装快照直接加载。

## 2. 流程

### 2.1 安装与激活

```text
discover / install PluginPackage
  → inspect manifest and requested permissions
  → create or update PluginInstance
  → validate config and secret bindings
  → activate PluginBinding
  → register declared PluginContribution
  → restore PluginResource / resume due reconcile
```

激活采用 all-or-nothing：任一必要 Contribution 注册失败，当前 Binding 整体关闭，不留下部分
可用状态。首期不做运行中无感热升级；更新 Package 后在显式 reload 或下一次启动时重新绑定，
优先保证单机多进程场景下的身份和恢复语义清晰。

`MarketplaceRegistry.load()` 从安装目录加载并复核 Package 身份；`Manager` 从本 BatonSession
的 `instance.json` 读取启用 Instance，以精确
`pluginId + packageVersion` 找到 Package，再创建 Binding。Package 不接收 Store、Controller
或可伪造的 owner；`registerResource` 由 Binding 自动补齐 BatonSession 和 PluginInstance
scope。单个 Instance 激活失败只关闭并报告该 Binding，不阻断其他 Plugin 的恢复；Manager
退出或 Instance 解绑时，Binding 统一撤销注册和动态唤醒。

### 2.2 PluginResource 与 Reconciler

Resource 创建、`spec` 更新、Harness 产出、启动恢复或计时到期都只表示“某个领域对象可能需要
重新检查”。Baton 将同一对象的重复触发合并成 reconcile key：

```text
batonSessionId + pluginInstanceId + resourceKind + resourceId
```

Reconciler 不把触发原因当成一条必须执行一次的命令。它根据 key 重新读取 Resource 和必要的
外部状态，比较 `spec` 与 `status`，执行当前仍需要的收敛动作：

```text
resource change / Harness outcome / startup / timer due
                         │
                         ▼
enqueue(pluginInstanceId, resourceKind, resourceId)
                         │ same key coalesces
                         ▼
reconcile(spec, status, latest external state)
                         │
                         ├── patch status / project Board
                         ├── call owned Connector when authorized
                         └── return { proposedInput?, requeueAfter? }
```

`Manager` 按 `batonSessionId + pluginInstanceId + resourceKind` 注册和路由 `Controller`。参考
controller-runtime 的分工，每个 Controller 拥有独立 workqueue，隔离重复 key、dirty
follow-up 和局部并发；Manager 统一持有一个动态唤醒队列、错误退避和 Baton 级总容量，避免
Plugin 数量增长时 timer 与执行并发随 Resource 数量线性放大。注册关闭后，该 Scope 的 pending
任务和动态唤醒一并撤销，不会误投到其他 Plugin。

Controller 另外持有同 Resource 的跨进程 reconcile 锁，保证本机多个 Baton 进程不会同时执行
它。该锁不阻塞用户更新 `spec`：Controller 在写回 status 和 due time 时检查
`resourceVersion`，基于旧 Contract 的结果会冲突失败，再由最新 Resource 触发下一轮
reconcile。

首期接口保持窄小：

```ts
interface ReconcileContext<TSpec, TStatus> {
  resource: Readonly<PluginResource<TSpec, TStatus>>;
  patchStatus(patch: Partial<TStatus>): Promise<void>;
}

type ReconcileResult = {
  proposedInput?: {
    text: string;
  };
  requeueAfterMs?: number;
};
```

`proposedInput` 只是准备交给 Harness 的文本草稿，不创建 Interaction 或一套审批状态机。Baton
把它放入 composer；用户可以编辑后提交，也可以丢弃。只有提交后，它才成为普通 Input，继续走
现有 Input → Attempt → Harness 路径。Baton 从本次 ReconcileContext 自动取得 resource
identity 和 generation，再结合文本摘要给 Proposal 生成稳定内部身份；这些 Manager 管理的信息
不由 Plugin 回填。

Manager 在通知 UI 前先持久化 Proposal，接收方按 `proposalId` 幂等投影。`resolution` 缺省即
待处理，首次 `submitted | dismissed` 终结后不再改变；因此同一状态下被丢弃或提交的建议不会
反复出现。进程重启时，Manager 重新投影尚无 resolution 的 Proposal。首期 Reconciler 不主动
启动、恢复或选择 Harness。

`requeueAfter` 是这个 Resource 的一次性动态定时唤醒。Baton 将它换算成持久化的
`nextReconcileAt`；Manager 只保留一个进程内 timer，总是唤醒当前最早到期的一批 key。进程
重启后，已到期的 Resource 立即入队，未到期的恢复到动态唤醒队列。空返回会清除旧的 due time，
表示等待 Resource、Input 或 Harness 事实发生变化，不需要独立 Monitor。错误通过抛出表达，
Manager 使用按 key 的指数退避并把下一次 retry 同样写入 `nextReconcileAt`，因此 retry 不因进程
退出而丢失；一次成功 reconcile 会重置该 key 的失败计数。不引入语义模糊的
`requeue: boolean`。

Reconciler 可以调用 Plugin 自己的 Connector 修改外部系统，因为副作用本来就是“使实际状态
靠近 spec”的一部分，而不是返回值的一部分。前提是当前 `spec` 或已记录的用户决定已经授权该
变化，且 manifest 声明了对应权限。可能已生效却拿不到回执的操作必须使用稳定 operation key，
重试前重新观察外部状态，不能因一次超时盲目重复执行。

### 2.3 后续触发条件

- webhook、长连接、文件监听或无 Resource 的持续观察出现后，再增加只负责 enqueue 的
  EventSource，不恢复一套 Monitor 状态机；
- calendar cron、时区和 misfire 语义出现后，再增加 Schedule；普通轮询继续使用
  `requeueAfter`；
- 无法自然表达成 desired state、又需要被独立调用的命令出现后，再增加 Action，并复用
  Intent / Attempt / Receipt；
- 需要关闭 TUI 后继续实时推进时，再引入 daemon，复用同一 Resource store 和 reconcile queue。

### 2.4 Command 与多实例

Command 的产品身份属于 Package，以 `pluginId + commandId` 唯一，不因配置多个 Instance 就
在命令列表中生成多份 `/requirement`。

- 没有可用 Instance：进入配置或启用引导；
- 只有一个 Instance：直接路由；
- 有多个 Instance：使用当前 BatonSession 的默认值，没有默认值时让用户选择。

命令一旦开始执行，后续 Resource、Event 和 Board projection 都携带明确的
`pluginInstanceId`，不能依赖“当前 Plugin”之类的隐式全局状态。

### 2.5 Disable、崩溃与升级

禁用 Instance 时，Baton 关闭其 Binding，撤销运行期注册和 due timer，并停止推进 reconcile
queue；已经持久化的 Resource、Receipt 和审计历史继续保留。

进程重启后，Baton 从启用的 PluginInstance 重建 Binding，先恢复待处理 Proposal，再扫描
Resource 和 `nextReconcileAt`，将未完成对象重新 enqueue。Package 升级不会静默覆盖 Instance data；
确需 Resource schema migration 时由新版本显式声明并产生可审计结果。

## 3. 关键设计

### 3.1 Contract 由领域代码和 Reconcile 表达

“Loop 是一个 Task Contract 加 Cron”适合描述边界稳定、步骤已经充分理解的自动化，但不能作为
Baton 的前置条件。把业务细节完整写成 Contract 的成本可能接近直接写代码，而且探索中的目标、
判断和例外本来就会持续变化。Baton 不要求先发明完整 Loop DSL，而允许 Plugin 用普通代码表达
领域模型与 reconcile：

```text
Loop ≈ resource(spec + status) + reconcile
                                  ▲
                 change / result / requeueAfter
```

“Contract + Cron”的声明性方向是对的，但可以进一步落成 Resource：Contract 进入 `spec`，
执行事实进入 `status`，Reconciler 用代码表达不适合经济地写成 DSL 的判断，`requeueAfter`
表达下一次动态检查。Operator 模型可以帮助区分这些职责，但 Board 不直接等于 CRD：

| Kubernetes Operator | Baton |
|---|---|
| CRD | Plugin 声明的 Resource kind 与 `spec/status` schema |
| CR | 一个具体的 PluginResource，例如某次 ReqLoopRun |
| spec / status | 人认可的 Loop Contract / Reconciler 观测状态 |
| Controller / Reconciler | Resource Contribution 中的 `reconcile()` |
| watch / work queue | Resource、Input、Harness 变化与 reconcile queue |
| periodic resync | `RequeueAfter` → 持久化 `nextReconcileAt` |
| API mutation | Reconciler 更新 status、调用 Plugin Connector |
| kubectl / status view | Board projection |

Board 可以展示和编辑 desired state、observed state、condition、证据与待决事项；用户认可的
编辑更新 `spec`，Harness 和外部系统产出作为 observation 进入，再由 Reconciler 更新 `status`。
一期 Board 可以直接从 Resource 投影，不先建设一份可独立演化的 Board 数据库。

一期只打通最小的人驱动闭环：

```text
Reconcile
  → 更新 status / Board
  → proposedInput(text)
  → 用户审核、编辑或丢弃
  → 普通 Input
  → Harness
  → Harness 产出回到 Resource / Board
```

长期可以让 Reconciler 通过 Baton 的受控能力主动启动一个或多个 Harness，例如先把用户需求
文字整理成结构化 Requirement，再让不同 agent 分别开发、review 或验证；各 Harness 的产出都
回写为 observation，由 Reconciler 更新同一个 Resource / Board。这个能力不进入首期，也暂不
为它提前命名独立的顶层 Intent 类型。

### 3.2 从现有 Plugin 体系吸收什么

| 体系 | 吸收 | 不照搬 |
|---|---|---|
| OpenCode | 按领域注册、作用域拥有注册项、关闭作用域时自动撤销 | 向 Plugin 暴露 client、shell 和可变宿主对象；一张不断增长的 Hooks 表 |
| Codex | 不可变能力包、manifest、资源路径约束、Package Root 与可写 Data 分离、宿主控制信任与权限 | 只把 Plugin 当静态能力集合，缺少 Baton 所需的多实例和长期 reconcile 身份 |
| Claude Code | 自包含包、组件命名空间、安装 scope、版本隔离和持久化 Plugin Data | 用易失 monitor stdout 承担可靠领域事件，或让 Hook 形成第二条执行状态机 |

Baton 因此采用“Codex / Claude 的 Package 边界 + OpenCode v2 的 scoped Binding +
Baton 自己的 Instance、Event 和 Attempt 语义”，而不是复制其中任意一套完整 API。

调研参考：

- [OpenCode Plugin 文档](https://opencode.ai/docs/plugins/)
- [OpenCode 当前 Plugin API](https://github.com/anomalyco/opencode/blob/92cede0541305a99579b0575b79297089d37e6da/packages/plugin/src/index.ts)
- [OpenCode v2 Effect 设计](https://github.com/anomalyco/opencode/blob/92cede0541305a99579b0575b79297089d37e6da/packages/plugin/src/v2/effect/README.md)
- [Codex Plugin 文档](https://learn.chatgpt.com/docs/build-plugins)
- [Codex Plugin manifest](https://github.com/openai/codex/blob/1f0566d3f59298d1bb88820a0d35294f1eeb07ea/codex-rs/plugin/src/manifest.rs)
- [Claude Code Plugin 文档](https://code.claude.com/docs/en/plugins-reference)
- [Claude Code Hook 文档](https://code.claude.com/docs/en/hooks)

### 3.3 Plugin 运行时是窄能力边界

Manager 只向 Plugin 暴露完成 Contribution 契约所需的窄入口：

- 当前 BatonSession、PluginInstance 和 Binding 的不可伪造身份；
- Contribution 注册和关闭生命周期；
- 当前 Resource 的只读 snapshot、受控 status patch 和可信 Board/Context projection 入口；
- 按 declaration 与权限注入的配置和 secret；
- 受 timeout、取消和输出预算约束的执行上下文。

Plugin 不获得通用 Store、Controller、Harness 或 shell。访问 Meego、GitHub、部署平台等外部
系统由 Plugin 内部 Connector 完成，并受 manifest 权限、Resource owner 和 Reconcile 生命周期
约束。Connector 是 Plugin 内部实现，不提升为 Baton 顶层概念。

### 3.4 当前只支持可信的进程内 Plugin

当前 Package 使用进程内 TypeScript 激活，属于 trusted code。安装前尚无权限审阅或签名校验，
Baton 不宣称提供安全隔离；窄 Plugin 契约的目的首先是稳定架构边界，而不是假装沙箱。

本地 / Git Marketplace 先解决真实 Plugin 的开发、发现和不可变交付。远程 JSON、npm、
自动更新、卸载、签名、依赖解析和独立进程协议留到实际分发与信任需求出现后再做；届时可以让
进程适配层实现同一 Binding / Contribution 契约，不需要推翻 Instance / Binding 模型。

### 3.5 目录兑现领域边界

Plugin core 不为每种 Contribution 建平级子目录；Marketplace 自身有独立的内部子域：

```text
src/plugin/                 # Baton Plugin 领域：Package / Instance / Binding / Contribution
└── marketplace/            # Marketplace manifest、注册、发现、安装与加载
reqloop repository          # 独立 Marketplace，只依赖 Baton 公开 Plugin 契约
```

`src/plugin/` 是 Baton core 的 Plugin Manager 边界；独立 reqloop 仓库拥有 Requirement Loop
的领域模型和 Connector。Baton core 除安装注册入口外，不依赖 reqloop 的领域类型。

PluginPackage 是用户级安装资产；Plugin 运行数据则跟随 BatonSession：

```text
~/.baton/
├── plugins/
│   ├── marketplaces.json
│   ├── marketplaces/<marketplaceName>/    # Git source 的本地 checkout
│   └── packages/<encodedPluginId>/<version>/
└── projects/<projectKey>/
    └── sessions/<batonSessionId>/
        └── plugins/<pluginInstanceId>/
            ├── instance.json
            ├── resources/<kind>/<resourceId>.json
            └── proposals/<proposalId>.json
```

Project 只负责组织和发现 BatonSession，不拥有 Plugin runtime。Manager、Controller、Binding
和队列是进程态；恢复时从当前 Session 的 PluginInstance、Resource 和 Proposal 重建。

### 3.6 增量落地

1. 已建立 Package、Instance、Binding 的可信进程内最小契约：启动恢复启用 Instance，激活失败
   整体回滚，解绑和退出统一关闭。
2. 已建立 PluginResource 通用信封与存储、同 key 不并发的 reconcile queue、持久 Proposal，
   以及 `requeueAfter` due time；运行数据全部归当前 BatonSession。
3. 已建立本地 / Git Marketplace 注册、仓内 Package 发现、版本化不可变安装和进程内加载；
   Marketplace provenance 与 Package identity 分离。
4. 以 reqloop 的 `/requirement` 验证 Command 的真实需要，再补
   `command | resource` 声明校验和多实例路由，不先为未接产品入口的 Command 造 handler。
5. 接通 Board projection、`proposedInput` 与可选 Context projection，跑通用户审核文本后驱动
   Harness 的 Requirement Loop。
6. reqloop 出现真实外部变化需求后再接 EventSource；无法表达成 desired state 的独立命令出现
   后再接 Action，不给 Plugin 预造 Monitor 或私有 timer。
7. 真实 loop 证明必须由 Reconciler 主动启动 Harness 后，再设计受控调用；首期只允许用户把
   `proposedInput` 提交成普通 Input。
8. `/plugins` 首期管理面已接入 Marketplace 浏览、Package 搜索 / 详情 / 安装和加载错误；
   Instance 管理具备完整运行期闭环后再接入。真实分发需求出现后再增加更新、卸载、内容信任和
   进程隔离，不改变既有 Instance / Binding 运行模型。
