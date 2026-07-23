# Harness 输出生命周期

本文是 `harness-interaction-design.md` 中**harness 输出/感知主题的专项设计与统一跟踪入口**，聚焦 baton 如何把各家原生 wire 消息归一成内部事件、如何保证一个 turn 一定收口、以及在上游丢事件/乱序/静默悬挂时如何自愈或如实降级。它是 `user-input-lifecycle.md` 的对偶：后者讲"一条输入进 harness 会发生什么"，本文讲"harness 的产出与终态被 baton 感知时应发生什么"。感知语义同样是 Adapter 协议契约的一部分——Adapter 必须暴露和保持哪些终态、自愈与保真行为，由它决定；`harness-interaction-design.md` 继续承载输入、输出、用户确认的完整交互面总体分层。

## 1. 理念与概念

原始需求不是"把 harness 的字节搬到屏幕上"，而是保证 baton 对 harness 活动的**感知在丢包、乱序、静默失败下仍然如实且可收口**：

1. 事件流是感知的唯一真相源，UI 是投影。Adapter 把原生协议归一到内部事件（`payload` 供渲染/检索/摘要，`raw` 兜底保真），reduce 是渲染与崩溃恢复的同一条路径，不允许旁路投影通道。
2. 每个被接受的 turn 一定收口。turn = 一段有始有终的 harness 活动，无论正常结束、报错、子进程退出还是传输断开，都必须恰好产生一次终态；controller 按 baton turn id 幂等 finalize。
3. 感知要能自愈。流式 chunk 可能乱序或丢失，因此 completed 必须携带全量内容作为自愈点，覆盖此前的增量累积。
4. 不确定时悲观，不静默。未知终态归 failed 而非乐观绿勾；未知通知进有界诊断日志而非 `default: break`；completed 但零产出的 turn 显式报空回合，不假装成功。
5. turn 的存在不以用户请求为前提。driven turn 由用户 submit 发起、进队列串行；observed turn 由 harness 自发（如后台任务唤醒），baton 只划界、记账、投影，不进队列。

为讨论方便，本文用以下感知阶段描述语义，不预先冻结代码 enum：

| 阶段 | 触发 | 是否终态 | 语义 |
|---|---|---|---|
| running | `state_update(running)`；`source:baton`=driven，`source:harness`=observed | 否 | turn 开界，busy 由它派生 |
| streaming | message/tool/plan 的 chunk 与 update | 否 | 增量产出，可乱序、可丢，completed 自愈 |
| settling | `tool_call_update(completed/failed/declined)`、item completed | 部分 | 单个产出收口，携全量内容纠偏 |
| finalized | `state_update(idle, stopReason)` | 是 | 整个 turn 收口，controller 幂等 finalize、推进队列 |
| stalled | 无（**待决**，见 §5） | 否 | 活着但长时间无任何事件——当前无此观测态，是感知盲区 |

## 2. 当前主流程

### 2.1 事件归一与保真

Adapter 消费原生 wire（Codex app-server 的 JSON-RPC 通知、Claude Agent SDK 的消息流），翻译成内部 Event 草稿交给 sink；宿主在可信入口盖上 `source:harness`，Store 再补齐版本、时间、序号和 BatonSession。归一原则是"最大公约数 + raw 保真"：思考、工具、文件改动、命令输出、计划等形状统一，粒度差异（Claude 原始思考流 vs Codex reasoning 摘要）不掩盖、全部留在 `raw`。渲染层与存储层不出现 harness 分支。

### 2.2 三态 patch 与自愈

消息与工具调用用 upsert：message 按 messageId、tool_call 按 toolCallId 键控，首个未见过的 id 即创建（无独立 create 事件，对齐 ACP v2）。字段省略=不变、null/[]=清除、具体值=替换；chunk 永远是追加。关键自愈点：completed item 携带全文，整体覆盖此前 chunk 累积——outputDelta 丢失或乱序时，completed 一到就把工具卡/消息纠正回完整结果。

### 2.3 终态收口：从可观测退出到感知盲区

终态硬契约本身——每个 turn 在任一退出路径恰好一次逻辑终态、物理终态可重复到达时 controller 按 baton turn id 幂等 finalize——定义在 `harness-interaction-design.md` §4.1 与 `adapters/types.ts`，本节不复述，只看它在感知侧落到哪些具体 harness 事件、以及它覆盖不到哪：

| 退出路径 | harness 事件 | 收口方 |
|---|---|---|
| 正常结束 | `turn/completed` / 消息流自然结束 → `idle` + stopReason | harness 报告 |
| 错误 | 先 `_baton_error_update` 再 `idle(failed)`；retrying error 不切 idle | Adapter |
| 子进程退出 / spawn error / transport close | Adapter 就地**合成**终态，否则 controller 永远等不到 idle | Adapter |
| cancel | harness 的 cancelled 终态；超 cancel 宽限期则 controller 合成 | Adapter / controller |

关键观察：这四条全部绑定在**可观测退出**上。还有一种失败落在所有触发器的缝里——上游进程活着、不报错、不退出、transport 不断，只是静默停止产出。终态契约覆盖不到它，这就是 §4 S1 的盲区、§5 reconcile 要补的地方。

### 2.4 空回合与未知项

completed 但整个 turn 零产出，说明 prompt 在进模型前被丢弃（hook 拦截、harness 静默空结束），显式合成空回合警示而非留白。未知终态状态悲观归 failed；完全未识别的通知不进主 timeline，进有界诊断日志并记 method/type 与计数，Adapter mapping contract test 钉住当前支持清单，harness schema 升级时显式暴露未映射项。这三条是 interaction-design §4.9（error / 未知事件 / raw 保真）契约在感知侧的落地，结构约束以那节为准。

## 3. 当前能力

归一是"最大公约数 + raw 保真"：统一事件那一列是跨 harness 稳定的词汇，Claude/Codex 两列是易随各家 schema 变化的原生映射锚点（细节永远兜在信封 `raw`，粒度差异不掩盖）。事件 schema 本身的设计取舍（如 `usage_update` delta 与 `context_usage_update` snapshot 为何并存）见 interaction-design §4.8，本表不复述。

| 输出/感知能力 | baton 统一事件 | Claude Code 原生 | Codex 原生 | 当前状态 |
|---|---|---|---|---|
| 文本消息 | `agent_message(_chunk)` | SDK 消息流 | `item` 消息 | 已支持 |
| 思考流 | `thought_message(_chunk)` | `thinking_delta` 流 | `item/reasoning/*`（需 `summary:"auto"` 开启，completed 带全文兜底） | 已支持；粒度差异留 raw |
| 工具调用生命周期 | `tool_call_update` / `_content_chunk`（三态 + completed 自愈） | `tool_use` / `tool_result` | `item/started`·`item/completed` | 已支持 |
| 命令实时输出 | `tool_call_content_chunk` | 无（输出随 `tool_result` 一次性到达） | `item/commandExecution/outputDelta` | 已支持 |
| 文件改动 | `DiffBlock`（changes + 标准 unified patch） | Edit/Write/MultiEdit 入参合成 | fileChange item 的 `changes[].diff` | 已支持；拼不出合法 patch 时只发 changes |
| 计划 | `plan_update`（整体替换 entries） | `TodoWrite` 归一并抑制其工具卡 | `turn/plan/updated` | 已支持 |
| 运行阶段（compacting…） | `_baton_run_status`（phase 开放字符串，null 清除） | `system/status`（SDKStatus 原生即 phase-or-null） | `contextCompaction` item 并抑制其工具卡 | 已支持 |
| token 用量 | `usage_update`（delta，baton 既有语义） | SDK usage | usage 差分 | 已支持 |
| context 用量 | `context_usage_update`（按 HarnessTarget 保存的 snapshot，映射 ACP v2 usage） | result `modelUsage` | `thread/tokenUsage/updated` 的 `last` + `modelContextWindow` | 已支持；`/status` 展示当前 Target/model 快照 |
| 终态 | `state_update(idle, stopReason)` | 消息流结束 / interrupt | `turn/completed` | 已支持；退出路径均合成 |
| 错误 | `_baton_error_update` + `idle(failed)` | SDK error | wire error / 响应终态 | 已支持 |
| 空回合 | `_baton_notice`（warning，不改生命周期） | 无此形态（SDK 进程内 hook 报错走 error 流） | completed 且零产出 + `hook/completed`（仅 userPromptSubmit/sessionStart 的 blocked/stopped 会让 codex 静默空结束） | Codex 已支持 |
| observed turn | Harness 来源的 `state_update(running)` 开界、idle 收界 | 后台任务唤醒 | — | 已支持；不进队列 |
| 未知通知 | 有界诊断日志 + 计数 | 进程内 hook 报错走 error 流 | 未识别通知 | 当前忽略，不进 timeline |
| **静默悬挂对账** | L1 stall 观测 + 可选 `reconcile` 能力（见 §5） | 未声明 reconcile，回落 L1（`backgroundTasks`/`getContextUsage` 为后续方向） | `thread/read.status` | L1 已支持；L2 Codex 已支持，Claude 回落 L1 |

## 4. 三个重点场景

### S1：上游丢终态事件，turn 永久 in_progress

**目标**：harness 侧其实已结束（或已彻底卡死），baton 不应无限显示转圈。

**当前结论：L1 观测 + L2 对账已覆盖（Codex）。** §2.3 表里的四条退出路径全部绑定**可观测退出**。但上游可能进程活着、不报错、不退出、transport 不断，只是静默停止产出（如某并行工具的完成回传在上游被丢）——它不触发任何一条，controller 永远等不到 idle，tool_call 与 turn 一起卡在 in_progress。

设计上要区分两件被混谈的事：**固定 wall-clock 超时**（interaction-design §4.1 已明确反对——合法长任务不该被误杀）与**无进展停滞**（stall）。合法长跑一定有心跳/子事件流，真悬挂是连心跳都没有。§5 的做法只针对 stall、不碰 §4.1 反对的固定超时：L1 把静默变可见，L2 用 harness 状态查询把"猜"升级成"问"。

### S2：chunk 乱序 / 丢失导致展示与真实产出不一致

**目标**：流式增量不可靠时，最终展示仍等于 harness 的完整产出。

**当前结论：已由自愈点覆盖。** completed item 携全量内容整体 upsert，覆盖 chunk 累积（§2.2）。因此 outputDelta 丢一段或乱序，只要 completed 到达即纠偏。前置约束：id owner 必须稳定——harness message/tool id 保留映射、不临时重造，否则 upsert 断裂、自愈失效（interaction-design §4.10）。这条是"改代码不能破坏"的不变量，不是可选优化。

### S3：harness 自发产出（observed turn）被静默丢失

**目标**：agent 无用户输入时自己开口（后台任务唤醒、未来的 cron/事件 loop），其回复必须出现在 UI，而不是重开会话才可见。

**当前结论：已支持，由投影单通道不变量保证。** observed turn 以 Harness 来源的 running 开界、idle 收界，Controller 只划界记账、不进队列。UI 状态 = `loadState()`（补历史）+ `subscribe`（跟增量），live 与 resume 同一条 reduce 路径；事件一经 append 即广播，投影正确性不依赖"是否有活跃 turn"。历史教训：per-turn 回调曾是第二条投影通道，导致 observed turn 事件"只持久化、不投影"，UI 静默丢后台唤醒的回复——因此**不允许旁路投影通道**，由 `tests/harness-initiated-turn.test.ts` 参数化契约钉住。v1 不支持打断 observed turn（Esc 只作用 driven turn）。

## 5. 收敛方向与验收

补齐 S1 的感知盲区，核心是把 stall 从"判据"降级成"触发器"：**超时只触发一次对账，判断交给 harness 的真相**，而不是超时即判死。分两层，且**对账是可选 Adapter 能力**——两家 harness 的对账基元异构，不能编成 controller 全局假设。

**L1 进展时钟（harness 无关，只观测不 finalize）**：controller 给每个 active turn 记 `lastActivityTs`，命中该 turn 的任何事件都刷新；低频 monitor 发现长时间无进展 → 发 `_baton_stall_notice`（warning，不改生命周期、不合成 idle）。它不违背 interaction-design §4.1"不设强制 finalize 的 watchdog"——只把静默变可见。

**L2 对账探针（harness 相关，声明 `reconcile` 能力才有）**：stall 触发时 controller 调 `Reconcilable.reconcile(ref, turnId)`，返回归一化裁决（`idle | active | waiting_* | unknown`），各 Adapter 用各自基元实现：

- **Codex = pull 状态**：`thread/read { includeTurns }` 读**权威运行态** `thread.status`（`Idle | Active{WaitingOnApproval|WaitingOnUserInput} | SystemError`）。注意只信 live 的 `status`，不信 `includeTurns` 返回的 item 列表——后者来自 rollout history，可能和已漏事件一样陈旧。`Idle` → 漏了终态，直接 finalize（无感自愈，最常见）；`Active{}` → 真悬挂，有把握地标 stalled 并给取消；`Active{WaitingOnApproval}` → 审批被丢/带外解决，重弹审批卡。
- **Claude = 无状态可 pull**：Agent SDK 无 `thread/read` 对等物，改用副作用式探测与启发式——卡点是某 toolUse 时 `backgroundTasks(toolUseId)`（返回 false ⇒ 该前台任务已不在 ⇒ 判 idle；返回 true ⇒ 转后台、turn 继续，直接解卡）；否则 `getContextUsage()` 两次采样比对（动=active、冻=可疑）；终态真相另有 Stop/SubagentStop hook 通道。

**默认不自动判死**：baton 不确定上游死没死时不自动合成 idle（对齐"悲观不静默"），默认把决策交回用户（stalled 卡片给 继续等/取消/重启），取消走既有 cancel 宽限 + 合成终态路径。可选 `autoCancelAfterStallMs`（默认关）给无人值守 loop。顺带收益：resume/fork 时对遗留 in_progress 做一次对账，覆盖"重开会话仍转圈"。

验收矩阵：

| 场景 | 预期 |
|---|---|
| turn 正常结束 | 恰好一次 `idle` + stopReason，finalize 幂等 |
| 子进程退出 / transport close | Adapter 合成终态，不永久 in_progress |
| completed 携全文，chunk 曾丢/乱序 | 最终展示 = 完整产出（自愈） |
| 未知终态状态 | 悲观归 failed，不渲染绿勾 |
| completed 且零产出 | 空回合 warning，不留白、不假装成功 |
| observed turn 产出 | live 与 resume 同投影，不静默丢 |
| 静默悬挂 + Codex 声明 reconcile | `thread/read.status`=Idle → 自愈 finalize；Active → stalled 可取消 |
| 静默悬挂 + Claude | `backgroundTasks`/`getContextUsage` 探测 → 解卡或交用户决策 |
| 未声明 reconcile | 回落 L1：stall notice + 用户取消，不伪造终态 |

## 6. 代码与测试锚点

- `src/event/types.ts`：Event identity/scope/source、事件 kind 全集、三态 patch、终态词汇（含 declined 一等成员）、`StallNotice`（L1）。
- `src/adapters/types.ts`：`HarnessAdapter` 终态硬约定、`AdapterCapabilities`、`Reconcilable` / `ReconcileVerdict` / `isReconcilable`（L2）。
- `src/adapters/codex/adapter.ts`：item/turn 通知归一、`finishTurn`/`failTurn` 终态合成、空回合上报、悲观 failed 映射、`reconcile` + `mapThreadStatus`（L2，`thread/read.status`）。
- `src/adapters/claude/adapter.ts`：SDK 消息流归一、error 流、cancel 映射 interrupt；未声明 reconcile，回落 L1。
- `src/controller/index.ts` 与 `src/controller/turn.ts`：按 turn id 幂等 `finalize`、cancel 宽限 `synthesizeTerminal`、L1 `checkStalls`/`refreshActivity` 进展时钟、L2 `reconcileStalled`（idle 裁决才自愈收口）。
- `src/store/reduce.ts`：事件流 reduce 成会话状态，upsert 自愈与 id owner 不变量、`ActiveTurnState.stalled`（L1）。
- `tests/harness-initiated-turn.test.ts`：observed turn 投影单通道契约。
- `tests/lifecycle.test.ts`：终态合成与 finalize 幂等。
- `tests/stall.test.ts`：L1 停滞观测（发一次、恢复补 cleared、绝不 finalize）。
- `tests/reconcile.test.ts`：L2 对账（`mapThreadStatus` 映射、idle 自愈、active/失败不收口、无能力回落）。
