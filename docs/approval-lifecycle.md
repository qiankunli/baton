# 审批生命周期

本文是 `harness-interaction-design.md` 中**用户确认（审批）主题的专项设计与统一跟踪入口**，与 `user-input-lifecycle.md`（输入）、`harness-output-lifecycle.md`（输出）并列为交互面的第三条轴。审批既不是纯输入也不是纯输出：它是 harness 向用户**请求执行某操作**、用户（或被委托方）作出决策、再由 baton 如实留痕的一条独立生命周期。

**范围约定：所有 harness 的权限 / 审批问题都落在本文**——交互审批、审批选项、权限模式、自动审批/委托、静默处置的诚实兜底等，无论 Claude Code、Codex 还是将来接入的新 harness，都在此记录并扩展 §1 末尾的跨 harness 现状表；harness 专有的 wire 细节下沉到对应 adapter 注释，本文只留“有这件事、归一到哪、为什么”。

## 1. 理念与概念

本文聚焦 **permission**——它是 Request ↔ Response 交互轴（harness 询问用户 ↔ 用户答复，见 `harness-interaction-design.md` §3.5）里的一个 `kind`；choice(question) / elicitation 是同轴的另两个 kind，各自独立。本文的 ApprovalReview 则是 `Response{kind:permission}` 的**委托代批回执**变体。

原始需求不是“弹个确认框”，而是保证用户始终清楚：**谁批准了什么、以什么依据、最终执行到哪一步**。

核心原则是**审批诚实（approval honesty）**：绝不能让“被 harness 侧策略静默处置”的操作，在 UI 上看起来像用户亲自批准或正常完成。#85（declined 状态、pinned approval 路由）是这条线的第一步。

关键概念：

- **approver（审批人）**：谁来批。baton **不替 harness 定这个默认**——缺省跟随 harness 自己的解析（codex 自身默认是 `user`），用户可显式覆盖。无论谁批，当前授权方必须全局可见，每次自动决定必须有权威回执。
- **委托（delegation）**：auto-review 是把越界审批交给 codex reviewer subagent；它只更换 reviewer，不扩大 sandbox 边界。委托必须 **全局可见、逐条可追溯**，否则就退回到“静默”这个被禁用的原点。

产品状态（描述语义，不冻结代码 enum）：

| 状态 | owner | 语义 |
|---|---|---|
| requested | Adapter | harness 请求执行某操作，等待决策 |
| pending（card） | controller + Store | 已 emit `permission_request`，UI 出审批卡等用户；卡不可 dismiss |
| resolved | Adapter + Store | 决策作出（approve/deny），`permission_resolved` 留痕 |
| auto-reviewed | Adapter + Store | reviewer 自动决策，带 risk / authorization / rationale 的权威回执 |

### 各 harness 审批现状（新 harness 接入时扩展本表）

| 审批维度 | baton 统一入口 | Claude Code | Codex | 现状 |
|---|---|---|---|---|
| 交互审批（请求→决策→留痕） | `permission_request` / `approvalHandler` / `permission_resolved` | SDK `canUseTool` 回调 | app-server 审批请求 | 已支持；两家归一到同一对事件 |
| 审批选项 | `PermissionOption[]`（含 `always`） | 仅当 SDK 给出 permission suggestions 才提供 `always` | `availableDecisions` | 已支持；baton 按 harness 实际候选映射，不自造 always |
| 权限模式 | 尚无统一入口 | SDK 有 default / acceptEdits / plan / bypassPermissions | `approvals_reviewer` + sandbox 策略 | 未统一暴露；各家模式尚未进 baton 配置面 |
| 自动审批 / 委托 | 跟随 harness 默认 + 权威回执 | 无逐条 reviewer；acceptEdits / bypass 是另一形态的委托（模式而非 reviewer） | `thread/start.approvalsReviewer` + `item/autoApprovalReview/*` | Codex 自身默认 `user`；事件 UNSTABLE |
| 静默处置的诚实兜底 | notice / 回执 | 暂无对应场景 | 现为启发式 notice，待权威回执取代 | 见 §2.3、§3.2 |

## 2. 当前主流程

### 2.1 交互审批

Adapter emit `permission_request` → controller 的 `approvalHandler` 注册 resolver（pending 真相源是事件流，不在 handler 里另存状态）→ chat-tui 渲染审批卡 → 用户经 `resolveApproval` 决策 → Adapter 的 await 点返回 → `permission_resolved` 落盘留痕。

### 2.2 审批人跟随 codex，不由 baton 定默认

`thread/start` 原生收 `approvalsReviewer`。**baton 缺省不下发**——codex 自己的解析链（`~/.codex/config.toml`、profile、云端下发的企业 requirements）照常生效；codex 自身默认是 `user`，且 guardian feature 开着也不变。baton 没有比上游更激进的理由，也没有立场替用户的 codex 配置做主。配置 `codexApprovalReviewer: auto_review | user` 是一次 opt-in 覆盖，仅在显式设置时作为 thread 参数下发。

**生效值只认 codex 回吐**（`thread/start|resume` 响应的 `approvalsReviewer`），不由 baton 从配置或启动参数反推。反推必错：企业 requirements（`allowed_approvals_reviewers`）能把用户 config.toml 里写死的值、也能把 baton 请求的值打回。曾经的做法是往 argv 注入 `-c approvals_reviewer=...` 并在 config 层复刻一遍解析来喂 Harness Status——既盖掉了用户的 codex 配置，footer 又会在托管机器上撒谎。问不出来时 `approvalRoute` 返回 null，投影静默而不是编一个（不变量 #2）。

人工审批时，adapter 优先按 app-server 的 `availableDecisions` 生成选项并把结构化 decision 原样回传；老版本未提供该字段、**或一项都认不出**时退回稳定四选项——非空但全不可映射会得到零选项审批卡，用户无从作答、turn 永久挂起。

**认不出就不给，但必须说出来。** amendment 类候选读不出作用对象时（字段改名、新增形状）一律丢弃而非猜：它们都是永久授权，标签说不清放行了什么就不能让用户点；network amendment 尤其致命——`action` 读不出时若默认成 allow，一条 deny 规则会被渲染成放行。但悲观丢弃只是不变量 #2 的前半句，「绝不失声」要求把降级本身留痕：codex 迭代频繁、新增 decision 属于常态，静默丢弃会让用户长期少一个本可用的选项而毫不知情，也让「baton 落后于上游」这件事无人发现。故按 decision 形状键发 `_baton_notice`（thread 内每形状只提示一次，避免每次审批刷屏）。`availableDecisions` **字段缺失**是老版本没这个能力，不是认不出，不提示。

用户选中的 optionId 若不在候选里（响应错配、陈旧 id），回传 `decline` 而非把 optionId 原样透传：结构化候选的 optionId 是 baton 铸的合成 id（`acceptWithExecpolicyAmendment:1`），不是 codex wire 值。

选项的语义由 harness 给的 `name` 承载（如 `Allow and remember: make -C devloop bump-version`），两根正交轴 `polarity` / `lifetime` 只是渲染提示。**授权“作用于什么”闭不了包**，不进枚举：codex 自己的 `acceptForSession` 对 command 是“session 审批缓存”、对 file change 是“同一批文件”；execpolicy amendment 作用于命令前缀，network amendment 作用于 host **且可以是 deny**。把这些压进单一 `kind` 的年代，“永久拉黑某 host”被映射成 `allow_always` + “Allow and remember: deny evil.com”——最危险的选项长得最安全。

### 2.3 未知审批旁路的兜底

正常 auto-review 由 §3 的权威回执留痕。若某个 item 变成 `declined`，却既没有向用户发过 requestApproval，也没有收到 auto-review 回执，adapter 会启发式 emit `_baton_notice`（“Approval bypassed by harness-side policy”）。它只用于未知或旧版 harness 策略的悲观对账，不与权威回执重复。

## 3. auto-review 回执

### 3.1 目标与语义边界

- **目标**：把 auto-review 从“静默”变“留痕”——approve 与 deny **都**产生权威回执，携带目标操作、风险等级、授权等级与理由。
- **取代而非共存**：Codex 的 `review.status ∈ {inProgress, approved, denied, aborted}`，**没有“升级给用户”这一档**（`userAuthorization` 是 reviewer 评估的授权等级，不是回退给用户）。因此开 auto-review = 该 turn 的审批卡**完全不触发**，baton 只观测回执。依据：app-server README 的 `approvalsReviewer` 与 `item/autoApprovalReview/*` 段（均标 **UNSTABLE**）。
- **委托是 opt-in、可撤回**：缺省跟随 codex（其自身默认 `user`）；`codexApprovalReviewer: auto_review` 显式委托，改回 `user` 或删掉该项即撤回。

### 3.2 事件归一

- 消费 `item/autoApprovalReview/started` 与 `/completed`（payload `{threadId, turnId, targetItemId, review, action}`）。
- `started` → **只**驱动临时 “Reviewing approval…” 运行相位（`_baton_run_status`），不落回执。
- `completed` → 铸造一条 `approval_review_update` 落事件流，携带 `reviewId`（一等 id，`arv_` 前缀，adapter 铸）+ `decision / riskLevel? / userAuthorization? / rationale? / actionType? / toolCallId?` + 原始 `raw`；approved 走 §3.5 的 warning、denied 走 declined。
- **一等回执，按 `reviewId` 归档（kernel.md §6）**：codex 不给 review 自身 id，故只在终态铸一条回执、无需关联 started/completed；无 `targetItemId` 的 review（如网络策略审查）也留痕、同一操作上的多次决策各自成条，不再按被审 `toolCallId` 覆盖或丢弃。回执是 timeline 的一等公民（首见即入 timeline），投影按 `reviewId` 渲染、未知 decision fail-closed 到 failed。
- **收敛 §2.3 的启发式 notice**：有了权威事件后，declined 的兜底 notice 由 `approval_review_update` 承接，不再让同一事实存在两条代码路径。

### 3.3 UNSTABLE 隔离（硬约束）

上游明说“shape expected to change soon / protocol still being designed”。因此：wire→归一映射**只**封在 Codex adapter；`raw` 原样保留；`review` 内字段**全部按可选处理、缺失容忍**；配 capability marker，未声明该能力的老 codex 静默降级为“不显示回执”，不报错。

### 3.4 全局可见

codex 报告生效 reviewer 为委托时，Harness Status 常驻 `approvals:auto-review`——让用户**随时**知道审批权已委托，而不是只在逐条回执里被动发现。该状态取自 adapter 的 `approvalRoute()`（harness 自报的生效值），不读 baton config：config 是意图，且投影层不得按 harness 分支（不变量 #3）。曾经这里硬编码 `config.codexApprovalReviewer`，于是跟 claude 对话时 footer 也显示 codex 的委托状态。

### 3.5 chat-tui 呈现

新增通用 block status `warning`（黄色 ⚠，非本特性专属，泛用于“完成但需留痕/注意”）：

- auto-**approved** → `warning`（已执行，但由自动 reviewer 批准，需审计留痕）；
- auto-**denied** → 复用现有 `declined`。

**一个状态不表达两种语义**：不要用 warning 同时表示批准和拒绝。

## 4. 待决

- reviewer 事件 UNSTABLE，字段/形状可能变——靠“隔离 + raw + 容忍缺失”收口，若上游大改只需改 adapter 一处映射。
- 是否按 `riskLevel`（low→critical）分呈现层级（critical 更醒目）。
- ~~resume 后重放 `approval_review_update` 的展示一致性（回执是过去时，不应复活为待决）~~：回执按 `reviewId` 归档、入 timeline 一等位、不派生 requires_action，live 与 resume 同走一条 reduce/投影路径，已一致。

## 5. 代码与测试锚点

- `src/adapters/codex/adapter.ts`：reviewer 下发与生效值回吐（`approvalRoute`）、`autoApprovalReview/*` 消费、归一与 §2.3 启发式 notice 收敛。
- `src/adapters/types.ts`：`ApprovalHandler` / `PermissionRequest` 交互审批契约。
- `src/session/controller.ts`：`approvalHandler` resolver 注册、pending 事件流真相源。
- `src/events/types.ts`：`permission_request` / `permission_resolved` / `approval_review_update`。
- `src/tui/protocol.ts`：审批卡、review 回执与 Harness Status 委托提示投影。
- chat-tui `src/types/index.ts`：`TranscriptBlockStatus.warning`；`components/transcript.tsx` 的状态图标/配色。
- `tests/approval-contract.test.ts` 等：审批契约与回执归一。
