# 用户输入生命周期

本文是 `harness-interaction-design.md` 中**用户输入主题的专项设计与统一跟踪入口**，聚焦产品输入语义、Adapter 必须满足的行为契约、当前实现状态与待决场景。产品语义是 Adapter 协议契约的一部分：一条输入从 Composer 到 harness、再到完成或中断时应发生什么，决定 Adapter 需要暴露和保持哪些能力；`harness-interaction-design.md` 则继续承载输入、输出、用户确认等完整交互面的总体分层与结构契约。

## 1. 理念与概念

原始需求不是“把一段文本发出去”，而是保证用户意图在并发时序下仍然清晰：

1. 输入不能静默丢失，baton 必须如实区分它是进入当前 turn、排队等待，还是被撤回。
2. steer 与 follow-up 不是同一种投递。steer 在当前 turn 的安全边界生效；follow-up 在当前 turn 结束后开启新 turn。
3. interrupt 作用于当前 harness turn，但不能顺带抹掉用户明确希望继续执行的后续输入。
4. 是否可撤回应由输入生命周期决定，不能只凭 UI 看起来“harness 还没干活”猜测。

为讨论方便，本文使用以下产品状态；它们描述语义，不预先冻结代码 enum：

| 阶段 | owner | 是否进入正典历史 | 当前语义 |
|---|---|---|---|
| draft | chat-tui Composer | 否 | 用户仍可编辑 |
| queued follow-up | SessionController | 否 | 等待当前 driven turn 结束；可召回编辑 |
| admitted prompt | controller + Store | 是 | 已从队列取走并形成 driven turn；当前只能 interrupt，不能 recall |
| accepted steer | Adapter + Store | 是 | harness 已接受为当前 turn 的追加用户消息；由一等 InputRecord 承载、挂在当前 turn 上 |
| finalized | Store | 是 | turn 已以明确 stop reason 收口 |

一条用户输入是一个 **Input** 概念，**身份即它的 `messageId`（`m_`）**：durable 形态是事件流里的 `user_message` 事件，live 形态是 controller 的 `InputRecord`（与 `TurnRecord` 对称），两者同一个 id，不另造平行身份。`InputRecord` 带显式 `status` 走上表各阶段：submit → `queued`，出队 → `admitted`，steer 成功 → `accepted_steer`，召回 → `recalled`，turn 正常收口 → `finalized`，被 Esc 打断 → `interrupted`。`controller.inputs` 暴露在世 Input 的只读快照，让 recall / interrupt / steer 的迁移是对同一 Input 的状态查询，而非散落的时序特判。历史回溯（§2.4）读的是事件流里已 finalized 的同一批 Input。

概念叫 **Input** 而非 UserInput 是有意的：input 有**来源**维度（对称于 Turn 的 origin）。
当前只有 `user`（composer 键入）。未来事件驱动的工作不会作为可召回的 `monitor Input` 直接
塞进队列，而是先形成持久 `HarnessWorkIntent`；经过 Policy、路由和冲突处理并真正 admit 到
BatonSession 后，才物化为 Input/Turn。这样自动工作复用可靠调度路径，同时不污染用户输入的
recall 语义，见 `baton-v2.md` §2。

**三种用户信号：Input / Response / Control。** Input（内容，驱动 / 加入 turn）之外，用户还发两种信号，三者同为"用户→会话信号"但不同型（状态机与落点都不同），不并进一个扁平 Input（参考 codex `Op`：UserInput / ExecApproval / Interrupt 是同一枚举的兄弟；pi `RpcCommand`）：

- **Response**（内容，对某个 harness Request 的答复，`refersTo` 一个 request）：走 `respond()` **就地解阻**当前 turn 的 pending request，不进 queue（见 harness-interaction-design.md §3.5）。
- **Control**（无内容，对 turn **生命周期**的命令）：`controller.control(signal)`，当前唯一 kind 是 `interrupt`（Esc）；`pause` / `abort-bash` / `shutdown` 等作为新 kind 时按 kernel §5 演进（届时把 `Control` 从单例升为判别联合）。Control 必须 **out-of-band** 够到正在跑的 turn——不进 queue，否则会排在它要打断的那个 turn 后面而死锁。

**cancel-cascade（Control:interrupt 与 pending Response 对账）：** 打断一个 turn 时，该 turn 上仍挂起的 Response（pending request）随收口一并了结——controller 在 `finalize` 里用 `{kind:"cancelled"}` 级联解开每个 resolver，adapter 发 `*_resolved(cancelled)` 留痕、并回 harness abort/deny。这样中断不留悬挂 waiter、不残留 `requires_action`（否则浮层会挂到会话重开）；**live cancel 与 crash-recovery 从此走同一套 "dangling → cancelled" 语义**。参考 codex `clear_pending_waiters` → `unwrap_or(Abort)`（且 abort-task-first）、opencode interrupt 的 `ensuring(pending.delete)`。

Turn 是一段有始有终的 harness 活动，不等于“一条用户消息”：一个 driven turn 包含初始 prompt，也可能包含零到多条 same-turn steer。

## 2. 当前主流程

### 2.1 普通提交

普通输入先交给 SessionController。controller 以 driven turn 全局串行：输入留在队列时可召回；一旦出队，controller 立即把原始用户消息和 running 状态写入事件流，再准备或调用 harness。这样 harness 冷启动不会让输入在界面上消失，崩溃恢复也始终有一条完整历史。

### 2.2 harness 忙时的第二条输入

当前默认策略是：没有更早的 follow-up 排队、输入目标就是活跃 harness，且 Adapter 声明 steer 能力时，优先尝试 same-turn steer。harness 接受后，输入以 `delivery: steer` 绑定当前 turn；拒绝、竞态或传输失败则如实降级为 queued follow-up。

若不满足 steer 条件，输入直接成为 queued follow-up。已有 follow-up 时不允许后来输入通过 steer 插队，以保留用户已经建立的顺序。

### 2.3 interrupt

Esc 在无局部浮层占用时被翻译成 `cancel` intent。controller 只中断当前 driven turn：

- harness 尚在 preparing、尚未提交 prompt 时，controller 立即合成 cancelled 终态；
- harness 已接收 turn 时，Adapter 映射到原生 interrupt，并以 harness 的 cancelled 终态或 cancel 宽限路径收口；
- turn finalize 后，controller 自动推进仍在队列中的 follow-up。

当前 interrupt 不会把 active prompt 放回 Composer，也不会为已经成功 steer 的输入重新创建 follow-up。

### 2.4 ↑/↓ 输入召回与历史回溯

Composer 的 ↑/↓ 是“取回既有输入”的统一入口。在无补全浮层、光标位于输入边界时，按三级优先级分派：

1. **队列召回**：输入框为空且队列非空时，↑ 把最近排队的 follow-up（LIFO）弹回 Composer 编辑并从队列移除（`recallQueued`）。“输入为空”前提是为了不覆盖用户正在敲的内容。
2. **历史回溯**：队列已空（或输入非空但仍等于上次召回条目）时，↑ 逐条回溯本会话的历史用户输入（新→旧，一次一条，到最旧停住），↓ 逐条前进；↓ 越过最新条目时恢复进入浏览前暂存的草稿（`historyPrev` / `historyNext`）。
3. **普通光标移动**：光标不在边界、或用户已改动召回内容时，↑/↓ 交回 textarea 作多行光标移动。

关键约束（why）：

- **门槛是“光标在边界（行首或行尾）”而非严格行首**：召回后光标落在末尾，用边界门槛才能让 ↑/↓ 对称地连续翻；严格行首会导致召回一条后就翻不动。
- **`lastHistoryText` 判改动**：连续回溯要求当前文本仍等于上次召回条目，用户一旦改动就中断回溯、退回光标移动，避免多行编辑被劫持（对齐 shell/codex 行为）。
- **历史范围 = 当前 BatonSession，源自事件流**：由 `user_message` 事件种入，不另存磁盘文件——事件流是统一历史真相源，resume 后 `loadState` 自动重建。跨会话全局历史不在当前能力范围内。
- **召回 / 回溯都不写事件流**：它们只是把既有内容取回 draft，不产生新的正典历史，直到用户重新提交。

## 3. 当前能力

| 能力 | baton 统一语义 / 入口 | Claude Code | Codex | 当前状态 |
|---|---|---|---|---|
| 普通文本 | `PromptBlock[]` → `submit()` | SDK `query()` | `turn/start` | 已支持；当前 Adapter 最终发送 text |
| 图片等富输入 | `PromptBlock` 可表达 image/resource | 原生协议可表达 | `UserInput` 可表达 | 未接入；TUI Composer 与 Adapter 仍按纯文本处理 |
| 模型切换 | `/model` → `ModelConfigurable` | 下一次 `query()` 配置 | 下一次 `turn/start` override | 已支持；不改变正在运行的 turn |
| 推理强度 | `/effort` → `EffortConfigurable` | 下一次 `query()` 的 `effort` | 当前 model 的候选 → 下一次 `turn/start.effort` | 已支持；与 model 分开选择，不改变正在运行的 turn |
| baton slash command | command registry → baton core | 不下发 harness | 不下发 harness | 已支持已注册命令；未知命令不做文本透传 |
| harness command | command discovery + Adapter capability | 原生可发现 | 需显式映射 | 未支持 |
| interrupt | `HarnessAdapter.cancel()` | `Query.interrupt()` | `turn/interrupt` | 已支持当前 driven turn |
| queued follow-up | controller 全局 FIFO | harness 无感知 | harness 无感知 | 已支持；当前 turn 结束后开启下一 turn |
| same-turn steer | `Steerable` capability；拒绝时降级 follow-up | 未声明 | `turn/steer(expectedTurnId)` | Codex 条件支持；Claude 自动走 follow-up |
| ↑/↓ 召回与历史回溯 | chat-tui 按键 → `recallQueued` / `historyPrev` / `historyNext`（光标边界门槛） | harness 无感知 | harness 无感知 | 已支持；会话级历史源自事件流，跨会话全局待做 |

## 4. 三个重点场景

### S1：query1 发出后立即 Esc，未真正执行时回到输入框

**目标**：若 harness 尚未真正开始处理 query1，Esc 撤回 query1 并恢复到 Composer；一旦已经开始处理，Esc 才是 interrupt。

**当前结论：未支持，暂缓；但可做的切片只有一个。** query1 一出队就成为 admitted prompt。即使仍在 harness 冷启动阶段，Esc 也会留下 cancelled turn，而不会恢复 draft。只有仍在 controller 队列中的输入可用召回操作回到 Composer。

需要先纠正一个常见误解：“真正开始处理”按**首个输出 / 首个工具调用 / 首个副作用**去判定，是一条跨 harness 不可靠的脏边界——没有输出不代表模型没处理，出现输出也可能早于副作用。这类边界不应作为撤回依据。

真正可靠、且 harness 无关的边界只有一个：**preparing 窗口**（`cancelActive()` 中 `!slot.ref`，即 harness 冷启动尚未 admit）。这段时间 baton 一个字节都没发给 harness，边界完全由 baton 自己拥有。因此若将来重启 S1，应当**只做这一刀**：preparing 窗口内的 Esc 把 query1 还原为 draft，冷启动完成后即视为已 admit、不再可撤回；不要去碰“首个输出”那类边界。

即便只做这一刀，仍要先决定：

1. 已落盘的 user_message / running 用何种 append-only 事件标记为 recalled（历史不可删除）；
2. 恢复 Composer 与后台冷启动完成之间发生竞态时，以哪一侧为准。

### S2：query1 回答中提交 query2，优先原生 steer

**目标**：query2 在 harness 支持时进入 query1 的当前原生 turn，而不是永远由 baton 排队到 query1 完成。

**当前结论：Codex 条件满足时已支持；不是跨 harness 保证。**

Codex 成功路径会调用原生 `turn/steer`，并把 query2 作为当前 turn 的 steer 用户消息落盘。以下情况会改为 queued follow-up：

- 当前输入目标不是正在运行的 harness；
- 已有更早的 follow-up 排队；
- harness 尚未建立可定向的 active turn；
- Adapter 未声明 steer（当前 Claude 即如此）；
- harness 拒绝、turn 已过期或 wire 调用失败。

baton 保证 effective delivery 如实：只有 harness 确认接受才记录 steer，否则明确提示已降级 follow-up。

### S3：query2 已提交后 Esc，打断 query1 并继续 query2

**目标**：Esc 停止 query1 的回答，但保留用户的新意图 query2，并让 harness 随后继续处理 query2。

**当前结论：产品语义待定，不作为独立 P1 缺口；当前默认可接受。**

分两条路径看当前行为：

- Claude 或 Codex steer 降级路径：query2 仍在 controller 队列。Esc 终结 query1 后，finalize 会自然推进 query2。
- Codex steer 成功路径：query2 已成为 query1 同一原生 turn 的一部分，controller 队列为空。Esc 的 `turn/interrupt` 会终结整个 turn，baton 没有独立 query2 实体可以继续提交。

关键判断：**Esc 在“已存在第二条意图”时的语义本身是未定义的，这不是 steer 引入的独有缺陷。** 用户按 Esc 可能想“全停”，也可能想“停 query1、继续 query2”——两种意图都合理：

- steer 成功路径按“全停”解，query2 随 turn 一并中断；
- queued 路径按“继续 query2”解，query1 停、query2 照跑。

即两条路径各自坐实了二义中的一端，且都无法在不问用户的前提下判定哪端“正确”。因此**不应**为此写时序特判去“interrupt 后重发最新 steer”：harness 可能已消费 steer 并产生部分副作用，重发会重复执行；接受回执只证明进入当前 turn，不证明模型已处理到它——重发是在拿重复副作用赌一个拿不到的信号。

正确且唯一的解法是 §5 的统一 pending-input 生命周期：把每条输入（含 steer）保留为有稳定 ID、可查询消费状态的实体，再由它统一决定 Esc 的迁移。在那之前，当前“整 turn 打断 + interrupted notice + 不静默丢 / 不静默重”是可接受的默认。

## 5. 收敛方向与验收

统一的 input 生命周期已在 **controller 侧落地**（一等 `InputRecord`，身份即 messageId，见上文 §1 与 `src/session/controller.ts`），取代了在 submit、steer、Esc handler 中散落的时序特判。该模型显式表达：

- requested delivery 与 effective delivery（`delivery` 字段 + `SteerOutcome` effective）；
- 输入属于 queued follow-up、admitted prompt、当前 turn 的 accepted_steer，还是已 finalized；
- recall（→recalled）、interrupt（→interrupted）、harness reject（降级 follow_up）各自的状态迁移；
- steer 被接受后作为一等 Input 挂在 turn 上，cancel 时迁移 interrupted——**不静默丢、不自动重发**（S3）。

仍待补齐的切片（需 chat-tui 联动，不在 controller 侧）：

- **S1 draft-restore**：preparing 窗口内 Esc 把 admitted 输入还原回 Composer（当前只迁移状态，未回填 draft）；需要 composer 回填 + append-only recalled 标记 + 冷启动竞态归属（§4 S1 的两个待决）。

验收矩阵：

| 场景 | 预期 |
|---|---|
| preparing 窗口内 Esc | query1 回到 Composer，harness 不执行；历史有明确 recalled 语义（S1 唯一可做切片） |
| preparing 窗口后（已 admit）Esc | query1 以 cancelled 收口，不伪装成 recall |
| Codex active + 无既有队列 + query2 | 原生 steer；同一 turn；effective delivery 可见 |
| steer rejected / stale / wire failure | query2 只入队一次，当前 turn 结束后执行 |
| query2 queued 后 Esc | query1 cancelled，随后 query2 开新 turn |
| query2 steer 成功后 Esc | 整 turn 打断，query2 随之中断；不静默重发。最终语义待统一 pending-input 生命周期定 |
| Claude 未声明 steer | query2 保持 follow-up，不伪装成 steer |

## 6. 代码与测试锚点

- `src/tui/protocol.ts`：busy submit 的 steer / follow-up 选择，Esc intent 到 controller 的映射；`recallQueued` / `historyPrev` / `historyNext` 与历史游标 / stash / 事件流种入。
- chat-tui `components/chat-shell.tsx`（↑/↓ 三级分派）、`components/composer.tsx`（`cursorAtBoundary` 边界门槛）、`protocol/index.ts`（`historyPrev` / `historyNext` 契约）。
- `src/session/controller.ts`：一等 `InputRecord`（身份即 messageId + status）、`inputs` 快照、队列、active driven turn、steer 降级、cancel 与 finalize 的状态迁移；`Control` 类型 + `control(signal)`（interrupt 为首个 kind）；finalize 里 pending request 的 cancel-cascade。
- `tests/input-lifecycle.test.ts`：Input id / status 迁移契约（queued/admitted/accepted_steer/recalled/interrupted）。
- `tests/cancel-cascade.test.ts`：Control:interrupt 打断时 pending Response 级联 cancelled、不留悬挂 requires_action。
- `src/adapters/codex/adapter.ts`：`turn/steer` / `turn/interrupt` 原生映射。
- `src/adapters/claude/adapter.ts`：当前只声明普通 prompt，cancel 映射 SDK interrupt。
- `tests/steer.test.ts`、`tests/codex-steer.test.ts`：same-turn steer 与降级契约。
- `tests/lifecycle.test.ts`、`tests/turn-intake.test.ts`：interrupt 后队列推进与 preparing cancel。
- `tests/tui-protocol.test.ts`：busy 输入默认 delivery 的 UI 编排；input history 回溯 / 编辑中断 / stash 恢复 / 去重 / resume 种入。
