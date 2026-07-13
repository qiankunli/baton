# 审批生命周期

本文是 `provider-interaction-design.md` 中**用户确认（审批）主题的专项设计与统一跟踪入口**，与 `user-input-lifecycle.md`（输入）、`provider-output-lifecycle.md`（输出）并列为交互面的第三条轴。审批既不是纯输入也不是纯输出：它是 provider 向用户**请求执行某操作**、用户（或被委托方）作出决策、再由 baton 如实留痕的一条独立生命周期。

**范围约定：所有 provider 的权限 / 审批问题都落在本文**——交互审批、审批选项、权限模式、自动审批/委托、静默处置的诚实兜底等，无论 Claude Code、Codex 还是将来接入的新 provider，都在此记录并扩展 §1 末尾的跨 provider 现状表；provider 专有的 wire 细节下沉到对应 adapter 注释，本文只留“有这件事、归一到哪、为什么”。

## 1. 理念与概念

原始需求不是“弹个确认框”，而是保证用户始终清楚：**谁批准了什么、以什么依据、最终执行到哪一步**。

核心原则是**审批诚实（approval honesty）**：绝不能让“被 provider 侧策略静默处置”的操作，在 UI 上看起来像用户亲自批准或正常完成。#85（declined 状态、pinned approval 路由）是这条线的第一步。

关键概念：

- **approver（审批人）**：默认是**用户本人**。baton 强制把 codex 的 `approvals_reviewer` 钉成 `"user"`，因为若交给 provider 的自动 reviewer，审批请求根本不会发给 baton，甚至会静默替用户拒绝——那等于 baton 失去了对“谁批准”的知情与留痕。
- **委托（delegation）**：approver 可以被显式交出。auto-review 就是用户把某一档审批权交给 codex 的 reviewer subagent。委托必须 **opt-in、全局可见、逐条可追溯**，否则就退回到“静默”这个被禁用的原点。

产品状态（描述语义，不冻结代码 enum）：

| 状态 | owner | 语义 |
|---|---|---|
| requested | Adapter | provider 请求执行某操作，等待决策 |
| pending（card） | runtime + Store | 已 emit `permission_request`，UI 出审批卡等用户；卡不可 dismiss |
| resolved | Adapter + Store | 决策作出（approve/deny），`permission_resolved` 留痕 |
| auto-reviewed | Adapter + Store（本次新增） | reviewer 自动决策，带 risk / authorization / rationale 的权威回执 |

### 各 provider 审批现状（新 provider 接入时扩展本表）

| 审批维度 | baton 统一入口 | Claude Code | Codex | 现状 |
|---|---|---|---|---|
| 交互审批（请求→决策→留痕） | `permission_request` / `approvalHandler` / `permission_resolved` | SDK `canUseTool` 回调 | app-server 审批请求 | 已支持；两家归一到同一对事件 |
| 审批选项 | `PermissionOption[]`（含 `always`） | 仅当 SDK 给出 permission suggestions 才提供 `always` | 原生选项 | 已支持；baton 不自造 always |
| 权限模式 | 尚无统一入口 | SDK 有 default / acceptEdits / plan / bypassPermissions | `approvals_reviewer` + sandbox 策略 | 未统一暴露；各家模式尚未进 baton 配置面 |
| 自动审批 / 委托 | 可选 opt-in + 权威回执 | 无逐条 reviewer；acceptEdits / bypass 是另一形态的委托（模式而非 reviewer） | `approvals_reviewer="auto_review"` + `item/autoApprovalReview/*` | 已支持 Codex opt-in；事件 UNSTABLE |
| 静默处置的诚实兜底 | notice / 回执 | 暂无对应场景 | 现为启发式 notice，待权威回执取代 | 见 §2.3、§3.2 |

## 2. 当前主流程

### 2.1 交互审批（默认路径）

Adapter emit `permission_request` → runtime 的 `approvalHandler` 注册 resolver（pending 真相源是事件流，不在 handler 里另存状态）→ chat-tui 渲染审批卡 → 用户经 `resolveApproval` 决策 → Adapter 的 await 点返回 → `permission_resolved` 落盘留痕。

### 2.2 默认 `reviewer=user` + 显式委托

Codex adapter 默认在启动参数注入 `-c approvals_reviewer="user"`；配置 `codexApprovalReviewer: auto_review` 才显式委托。若 `codexCommand` 已写 `approvals_reviewer`，则命令级取值优先，footer 也按实际生效值展示。

### 2.3 当前对 auto-review 的兜底：启发式，不是权威

今天若用户自行开了 auto-review，baton 收不到 reviewer 的任何事件，只能在某个 item 变成 `declined` **且从未就它问过用户**时，启发式地 emit 一条 `_baton_notice` 警告（“Approval bypassed by provider-side policy”）。这是**猜**出来的、且只覆盖 declined、拿不到风险/理由。本次要用权威事件取代它。

## 3. auto-review 回执

### 3.1 目标与语义边界

- **目标**：把 auto-review 从“静默”变“留痕”——approve 与 deny **都**产生权威回执，携带目标操作、风险等级、授权等级与理由。
- **取代而非共存**：Codex 的 `review.status ∈ {inProgress, approved, denied, aborted}`，**没有“升级给用户”这一档**（`userAuthorization` 是 reviewer 评估的授权等级，不是回退给用户）。因此开 auto-review = 该 turn 的审批卡**完全不触发**，baton 只观测回执。依据：app-server README 的 `approvalsReviewer` 与 `item/autoApprovalReview/*` 段（均标 **UNSTABLE**）。
- **强制 opt-in**：默认仍 `user`；只有 `codexApprovalReviewer: auto_review`（或命令级显式覆盖）才开启委托。

### 3.2 事件归一

- 消费 `item/autoApprovalReview/started` 与 `/completed`（payload `{threadId, turnId, targetItemId, review, action}`），归一成 baton 内部事件 `approval_review_update` 落事件流，携带 `status / riskLevel? / userAuthorization? / rationale? / action / targetItemId` + 原始 `raw`。
- `started` → 临时 “Reviewing approval…” 运行相位；`completed` → 时间线上留一条审计回执（approved 走 §3.5 的 warning，denied 走 declined）。
- **收敛 §2.3 的启发式 notice**：有了权威事件后，declined 的兜底 notice 应由 `approval_review_update` 承接，不再让同一事实存在两条代码路径。

### 3.3 UNSTABLE 隔离（硬约束）

上游明说“shape expected to change soon / protocol still being designed”。因此：wire→归一映射**只**封在 Codex adapter；`raw` 原样保留；`review` 内字段**全部按可选处理、缺失容忍**；配 capability marker，未声明该能力的老 codex 静默降级为“不显示回执”，不报错。

### 3.4 全局可见

auto-review 开启时，footer / Agent Status 常驻一条 `approvals: auto-review`——让用户**随时**知道审批权已委托，而不是只在逐条回执里被动发现。委托是显式且持续可见的。

### 3.5 chat-tui 呈现

新增通用 block status `warning`（黄色 ⚠，非本特性专属，泛用于“完成但需留痕/注意”）：

- auto-**approved** → `warning`（已执行，但由自动 reviewer 批准，需审计留痕）；
- auto-**denied** → 复用现有 `declined`。

**一个状态不表达两种语义**：不要用 warning 同时表示批准和拒绝。

## 4. 待决

- reviewer 事件 UNSTABLE，字段/形状可能变——本次靠“隔离 + raw + opt-in + 容忍缺失”先做，若上游大改只需改 adapter 一处映射。
- 是否按 `riskLevel`（low→critical）分呈现层级（critical 更醒目）。
- resume 后重放 `approval_review_update` 的展示一致性（回执是过去时，不应复活为待决）。

## 5. 代码与测试锚点

- `src/adapters/codex/adapter.ts`：reviewer 注入、`autoApprovalReview/*` 消费、归一与 §2.3 启发式 notice 收敛。
- `src/adapters/types.ts`：`ApprovalHandler` / `PermissionRequest` 交互审批契约。
- `src/session/runtime.ts`：`approvalHandler` resolver 注册、pending 事件流真相源。
- `src/events/types.ts`：`permission_request` / `permission_resolved` / `approval_review_update`。
- `src/tui/protocol.ts`：审批卡、review 回执与 footer 委托提示投影。
- chat-tui `src/types/index.ts`：`TranscriptBlockStatus.warning`；`components/transcript.tsx` 的状态图标/配色。
- `tests/approval-contract.test.ts` 等：审批契约与回执归一。
