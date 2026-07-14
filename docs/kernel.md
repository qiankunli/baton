# baton 内核（kernel）

> 本文定义 baton 的**稳定内核**：少数核心概念 + 少数不变量 + 一条流水线 + 一份扩展契约。判据只有一条——**新增一个 provider 默认只改 `adapters/` + `providers/registry` + `providers/ids`（+ 或许一个新 capability 接口），不触碰 session / store-reduce / projection / chat-tui**。改动若渗进内核，通常说明"有个概念还没一等化"（见 §6）。内核并非冻结：当一个特性被多个 provider 共同印证，它也会演进——但改内核比改 adapter 贵一个量级，门槛见 §5。
>
> 内核之外的设计（产品定位、存储路径、外部会话纳管、@ 引用、里程碑）见 `design.md`；输入 / 输出 / 审批三轴的展开见 `user-input-lifecycle.md`、`provider-output-lifecycle.md`、`approval-lifecycle.md`；Adapter 契约的完整条款见 `provider-interaction-design.md`。

## 1. 核心概念

内核由五个概念承重。每个概念绑定一条不能被 provider 差异侵蚀的不变量。

| 概念 | 语义 | 绑定的不变量 |
|---|---|---|
| **BatonSession** | 用户拥有的持久逻辑历史，跨 provider 的唯一时间线 | 身份锚点：历史跟随 session，项目归属跟随发起 cwd（跨项目 fork = 同一段逻辑历史落到另一 cwd + 全新 ProviderSession）|
| **Event（信封）** | 最小 append-only 记录：归一字段 `payload` + 原始 wire `raw` | 事件流是**感知的唯一真相源**；UI / 崩溃恢复 / resume 全是它的 reduce/投影，无旁路通道 |
| **Turn** | 一段有始有终的 provider 活动（带 stopReason）| "谁发起"是属性（driven / observed），不是存在条件；**每个被 admit 的 turn 恰好收口一次** |
| **Adapter + Capability** | provider 方言的**唯一**居所：小核心 `AgentAdapter` + 可选能力 descriptor | 差异表达为"能力有无"，type-guard 发现、契约测试钉住；**内核永不 `if provider===`** |
| **Projection** | 纯函数：event reduce → 视图快照 | 只产展示形状；chat-tui 消费形状不消费语义；未变返回同引用（快照一致）|

ProviderSession 不在此表——它是某 provider 的私有执行状态、内核的实现细节：baton 优先用 `providerSessionId` 加速恢复，但它缺失只降级、不能阻止 BatonSession 续聊。

**ID 规则**：全部带前缀 ULID（`bs_` / `ps_` / `t_` / `m_` / `tc_`），从第一天起稳定、可外部引用——这是 @、resume/fork、将来委派的共同前提。fork 复制的对象与源**共享对象 ID**（git-branch 语义），跨会话引用以 `bs_ + 对象 ID` 消歧（why 见 `resume-fork.md`）。

## 2. 三条不变量

内核的正确性压在这三条上；违反任意一条，加 provider 就会渗进核心。

1. **单通道真相**：一切经 `event → append → broadcast → reduce → projection`。live 与 resume 是同一条 reduce 路径。不允许第二条投影通道（per-turn 回调曾是第二通道，导致 observed turn 的回复"只持久化、不投影"，重开会话才可见）。自愈也走这条：合成的终态事件重新进 `onAdapterEvent`，不直接改 state。由 `tests/provider-initiated-turn.test.ts` 的参数化契约测试钉住。

2. **终态封闭 + 悲观兜底**：内部状态是**封闭词表**，adapter 在边界把 provider 的开放 / UNSTABLE 字符串归一进来；**未知一律保守**（未知终态 → `failed` 不是 `completed`；未知 verdict → 不 finalize）。"悲观、绝不失声"是感知面的承重原则。

3. **核心无 provider 分支**：provider 差异只以 capability 有无出现在内核视野里。渲染层与存储层不出现 provider 分支；provider 私有形态留在信封 `raw`。归一是"最大公约数 + raw 保真"：形状统一，粒度差异不掩盖。

## 3. 内核流程：一条双向流水线

内核只有一条流水线，双向流动。observed turn、stall 自愈、审批闭环都是它的特例，不是另起的机制。

```text
控制（出站）  chat-tui intent
             → Runtime（拥有 PendingInput，调度 driven turn）
             → Adapter（按 capability 映射 submit / steer / cancel / approve）
             → provider wire
感知（入站）  provider wire
             → Adapter 归一（→ 封闭词表，未知 fail-closed，保留 raw）
             → Event append → broadcast
             → reduce → Projection 快照
             → chat-tui 渲染
```

**Turn 生命周期**（内核心跳）：

- `admit`（runtime，driven turn）：出队即由 runtime 落 `user_message` + `state_update(running)`——用户输入是 BatonSession 的事实，不等 provider 冷启动；driven turn 全局串行、finalize 推进队列。
- `observe`（adapter，observed turn）：provider 自发。adapter 在终态后的同一消息流上检测到新活动，铸新 turnId、以 `state_update(running, origin:"provider")` 开界、idle 收界；runtime 只划界记账、投影，**不进队列**（它已在跑，调度它无意义、阻塞用户输入更是倒置）。全局串行约定据此收窄为：**driven turn 全局串行，observed turn 与其正交**。
- `terminal`（恰好一次）：adapter 在任何退出路径（正常 / wire error / 子进程退出 / transport close）都必须报告或合成一次 `state_update(idle)`；错误路径先发 `_baton_error_update`。重复 / 迟到的物理终态允许存在，runtime 按 baton turn id 幂等 finalize。
- `finalize`：落 turn-summary、推进队列（仅 driven）。

**自愈旁支**（provider 静默悬挂时）：stall 在事件流上被观测（L1，`_baton_stall_notice`）→ 若 adapter 声明 `Reconcilable` 则探权威快照（L2）→ 用修复事件结算被丢的 item 级终态 → 合成终态重新进同一条流水线。silence 是观察不是判决，权威探测应能 clear / refine 而非直接判死。

**审批闭环**（同一条流水线的专门子流程）：`permission_request` 事件 → PendingApproval（state → requires_action）→ 由**授权方**决策（用户在 TUI，或显式委托的 reviewer）→ **ApprovalReview 回执**（带自己的 id）append → projection 挂到目标 tool 卡。declined 是一等终态；委托状态对当前活跃 provider 可见。

## 4. 扩展契约：加一个 provider

`AgentAdapter` 是内核唯一面向 provider 的接口（完整条款见 `provider-interaction-design.md`）：

```ts
interface AgentAdapter {
  readonly provider: string;
  readonly capabilities: AdapterCapabilities;              // 可展示的能力 descriptor
  open(opts, sink: EventSink): Promise<ProviderSessionRef>;
  submit(ref, input: PromptInput): Promise<PromptReceipt>; // resolve 仅代表 admission 通过，不代表 turn 完成
  cancel(ref): Promise<void>;
  close(ref): Promise<void>;
}
```

**MUST**：

- 实现小核心 `AgentAdapter`；把 wire 方言归一进 Event 信封并保 `raw`；未知终态按不变量 #2 保守收口。
- 可选能力（`Steerable` / `Reconcilable` / `ModelConfigurable` / …）**声明即必须实现**，由契约测试保证；不声明 = 优雅降级，绝不是核心分支。
- 经 `providers/registry`（运行时定义 + adapter 工厂）+ `providers/ids`（无 SDK 身份目录：id + aliases）注册。

**MUST NOT**（默认边界；确需突破时走 §5 的演进门槛，不在此私自扩核心）：

- 为**单个** provider 的方言给 BatonSession / Turn / Event 核心加字段或分支；
- 开第二条投影通道；
- 让 provider 字符串越过 adapter 边界（封闭词表在此收口）；
- 静默持有审批授权（必须产生可见、带 id 的回执）。

**自检**：新增 provider 的 diff 只落在 `adapters/<provider>/` + `registry` + `ids`（+ 或许一个新 capability 接口）。一旦落进 `session/`、`store/reduce`、projection 语义或 chat-tui，先自问："这是这一家的方言，还是 ≥2 家的共性？"——前者归 adapter/`raw`，后者才按 §5 慎重提升内核。

## 5. 内核的演进规则

内核不是冻结的。BatonSession / Turn / Event 也会演进——但内核是所有 provider 与全部投影 / 存储的共同约束，改它比改一个 adapter 贵一个量级，因此要很慎重，有明确的门槛与方向。

**判据：默认下沉，共性才上浮。**

- **默认：单个 provider 的特性留在 adapter + `raw`**，或表达为一个 optional capability。一家有、别家没有的东西不进内核——否则内核长出只服务一家的字段，就退化成"provider 分支的联合体"，§2 不变量 #3 名存实亡。
- **提升触发：同一特性在 ≥2 个 provider 上独立出现**，说明它是这个问题域的普遍形状、而非某家方言——此时才把它归一进内核。cross-provider 证据是门槛，单家便利不是。
- **加法优先、语义封闭**：优先新增事件类型 / Turn 属性 / capability，尽量不改既有 `payload` 的既定含义——旧 `session.jsonl` 必须仍能 replay 出相同累计结果（§2 不变量 #1）。能用 optional capability 表达的，就不进核心必选。

**两个演进方向：**

1. **capability 毕业**：一个可选能力（如 `Steerable`）若被所有活跃 provider 支持、且成为交互刚需，可从"可选"升为"核心约定"。代价是新 provider 从此必须实现它、接入门槛随之抬高——所以非刚需不升。
2. **概念提升**：一个反复在投影 / 存储层打补丁的隐式概念，被确认为跨 provider 的普遍需求后，提升为一等内核概念。§6 列的四个就是当前候选——它们正是"多次局部修复"累积出的共性信号。

**每次内核改动回答三问**：① 这是 ≥2 家的共性，还是一家的方言？② 能否用 optional capability 而非核心字段表达？③ 改完，旧事件流还能 replay 出相同结果吗？三问不全过，就先留在 adapter 层。

## 6. 待提升为一等的概念（内核演进目标）

以下概念当前是隐式 / 泄漏的；它们正是"实际体验后反复打局部补丁"的根因，也是 §5 判据下已攒够 cross-provider 证据、够格提升的候选。提为一等，内核才真正稳、扩展才真正只碰 adapter。此处遵循 baton "文档先于代码" 惯例，标注现状与目标——未落地前不代表已支持。

- **PendingInput（输入轴的缺失内核）**——带稳定 id、可查消费状态的输入实体，统一 draft / queued / admitted / steer / recall / interrupt。
  - 现状：runtime 分散持有 pending input，无一等实体，故 "Esc + 第二条待决意图" 本质不可判定（见 `user-input-lifecycle.md` S3）。
  - 目标：一等 PendingInput，让 recall / steer / interrupt 的时序判定从特例收敛为对同一实体的状态查询。

- **ApprovalReview by `reviewId`（审批轴的缺失内核）**——回执按自己的 id 归档，带显式 reviewer / authority；tool-card 只是其一种投影。
  - 现状：回执按 `toolCallId` 归档 → 无 target 的 review 被静默丢弃、同 item 多次决策被覆盖。
  - 目标：`ApprovalReview(reviewId, targetItemId?, reviewer, decision)` 一等审计对象，保证"每个决策都有权威、可见、不被覆盖的回执"。

- **封闭终态词表 + 共享保守归一器**——把不变量 #2 从"每种事件各自发明白名单"变成一处结构保证（未知终态 → 保守态的单一 helper）。
  - 现状：tool 终态已保守（fail-closed），但审批 review decision 的 `else → in_progress`、`StopReason` 的开放 string union 仍在破它。

- **展示态双轴（chat-tui 侧，纯展示取舍）**——lifecycle/outcome（completed / failed / declined）与 tone/severity（warning…）正交。
  - 现状：`TranscriptBlockStatus` 单一 union 同时承担进度与"跑了但需留痕"，两个语义共用一个颜色 token。
  - 目标：拆成 outcome 轴 + 独立 tone 轴，止住 status 枚举膨胀。

## 7. References

- `design.md` — 内核之外的完整设计（定位、问题域、架构、存储、纳管、@、里程碑）
- `provider-interaction-design.md` — Adapter 契约完整条款（生命周期 / 能力 descriptor / admission）
- `user-input-lifecycle.md` / `provider-output-lifecycle.md` / `approval-lifecycle.md` — 输入 / 输出 / 审批三轴展开
- `resume-fork.md` — resume/fork 语义（fork = 同一段逻辑历史的复制）、会话锁与 crash recovery
