# Session Paths：会话树、写令牌与上下文收录

> 状态：设计稿，尚未实现。对应 AGENTS.md「后续演进」中的"草稿会话"与"上下文收录"两个方向，本文是这两个方向收敛后的统一模型。
> 讨论来源：2026-07 主线/草稿需求探讨（对比了 Codex `/side`、Claude Code `/branch`、ChatGPT branch、pi 会话树、opencode fork 等业界实现）。

## 1. 理念与概念

### 原始需求

AI coding 过程中冒出新想法，想在不打断主线的前提下额外探索，探索结果有三种去向：

1. 想法成立且更优 → 新想法成为主干，原主线跑完放那；
2. 想法成立但主线仍是主干 → 想法的结论合入主线，主线已有工作不丢；
3. 想法不成立 → 不管（丢弃即闲置，不删除）。

业界普遍只做了分叉（Codex `/side`、Claude Code `/branch`、ChatGPT branch），难点在合入。

### Path：会话即森林中的一条路径

BatonSession 之间通过 `forkedFrom {sessionId, throughSeq}`（已有能力，见 `docs/resume-fork.md`）连成树，多个根构成森林。任何 session 都可以在某个完整 turn 的水位上 fork 出新 session，各自独立前进——每条这样的会话线称为一条 **path**。

关键立场：**path 之间没有类型上的贵贱**。不存在 `kind: "draft"` 这种二等身份；fork 出来的就是普通 BatonSession，持久化、可 resume、可被 `@` 引用、可换 harness。"草稿"只是 path 的一种用法，不是一种类型。

### 主线 = 写令牌持有者，不是荣誉头衔

git 分支平等是因为每个分支有自己的文件视图；而 N 条 path 共享同一个 cwd——**会话可以分叉，文件系统只有一份**。这是会话树与 git 类比中唯一的根本不对称，也是本设计唯一需要硬约束守住的边界。

因此"主线"不定义为类型，而定义为一个物理事实：

> **主线 = 当前持有写令牌的 path。全局同时只有一个写令牌。选主 = 转移写令牌。**

- 未持有写令牌的 path 以只读执行策略运行（harness 侧映射为 read-only sandbox / 禁用修改型工具）；
- 任何 path 都可以通过 `elect` 转正，满足"用户选择最有价值的 path 继续推进"（对应去向 1），而不是默认首个 session 永远是主线；
- 由于任何时刻只有一个写者，**cwd 的变更历史始终线性**，即使会话历史是一棵树。

### Context-import：统一的收录原语

path 之间的"合入"不做 event-stream merge，而是一个通用事件原语（示意）：

```
_baton_context_import {
  sourceSessionId, fromSeq, throughSeq,
  mode: "summary" | "transcript",   // 保真度旋钮，默认 summary
  content,                          // 摘要文本，或带出处标记的原文 block
}
```

收录草稿（去向 2）、选主交接（去向 1）、深度引用其他会话，都是这同一个事件类型。它只追加到目标 session，不修改来源 session——不产生跨 session 一致性问题；来源 path 之后继续变化，也不会改变已收录的内容。

### Tab：纯呈现层

tab 是 workspace controller 中 `slots[]` 的视图，数据模型中不存在 "tab" 概念。TUI 关闭后 tab 布局丢失无妨，会话森林还在，`/tree` / `/sessions` 以树形呈现父子关系。

## 2. 流程：两步走

### 第一步：pi 对齐（单 controller，不动存储，不做并发）

借 pi 的核心交互——**merge 不是独立操作，是 path 切换的副作用**：

```text
Path A ── turn ── turn ──(在水位处 fork / 或 /tree 选中已有 path)──→ 切到 Path B
                                    │
              切换（离开 B 回 A，或离开 A 去 B）时三选一：
                ├── 不摘要            → 纯切换（去向 3：丢弃即闲置）
                ├── 默认摘要          → 对被离开 path 自 fork 点后的增量
                └── 自定义 focus 摘要    生成 context-import(summary)，
                                        挂到落脚 path（去向 1/2 由切换方向决定）
```

- 单 active path：切换即停旧启新，同时只有一个 controller 在跑；
- 三种去向全覆盖：留在 B 不回头 = B 成主干；切回 A 时给 B 挂摘要 = 合入主线；切走不摘要 = 丢弃（path 留在树里，随时可回）；
- diff 集中在：一个新事件类型 + `/tree` 树形 picker + 切换钩子，store / controller / reduce 地基不动。

### 第二步：并发与写令牌（baton 的差异化，pi 没有的）

```text
Path A（持写令牌）── Turn N running ─── Turn N done ── ...
   │
   └─ fork → Path B（只读）并行探索、可换 harness
            ├── leave  ：切回 A；B 保留，可再打开 / @ 引用
            ├── accept ：B 的增量 context-import 进 A；B 保留
            └── elect  ：A 的增量 context-import 进 B（反向交接），
                         写令牌 A → B，B 成为新主线
```

- workspace controller 持多 slot（tab 切换 = 换 focus），后台 path 完成 / 失败 / 待审批时前台提示；
- fork 只从"最后一个完整 turn"的水位复制，不复制流式中途的半截 turn；
- accept / elect 要求相关 path idle，运行中排队合入留给后续演进；
- transcript 保真度档也放本步。

## 3. 关键设计

### 为什么不改成 pi 式单文件树存储（entry 级 id/parentId）

pi 的单文件树不是"更好的设计"，是它架构的必然产物：pi 每次调用模型都沿树从 active leaf 到根**从零组装 messages[]**，完全自持上下文组装，树上任意跳转零成本。baton 的前提相反：上下文活在各 harness 的 native session 里（线性、只追加、不可回退），catch-up 的语义是"已见 seq 前缀 + 增量注入"。树上跳转后"已见集合"不再是前缀，且灌进 native session 的旧路径上下文收不回来——唯一干净做法是丢弃 harness session 按新路径重建，而这正是 `forkSession` 已经在做的事。**单文件树在 harness 层什么都买不到。**

更重要的是 baton 已经有这棵树：fork 复制的前缀与源共享 turn / interaction / message 等**领域对象 ID**（git-branch 语义；Event envelope 因换 ledger 重新签发），"哪些 turn 是同一节点"良定义。pi 是邻接表表示，baton 是物化路径表示（每个 session 文件 = 根到某叶的一条路径），**差别是物理表示，不是逻辑模型**，`/tree` 视图可直接从 forkedFrom + 共享前缀推导渲染。且物化路径对多 path 并发反而更优：一条路径一个文件，会话锁、并发 append、crash recovery、harness session 天然按 path 隔离；pi 的单文件 + 单 active leaf 无法让两条分支同时运行。

反向代价清单（如果硬改）：`seq` 是地基假设，reduce、syncedSeq/catch-up、崩溃恢复、turn-summary、会话锁、`@` 消歧全要重写，外加存量迁移；改完 harness 层收益为零、并发更难。结论：**抄 pi 的行为（树导航、切走时摘要），不抄它的表示。**

### 为什么不做 event-stream merge

fork 后两条 path 各自前进，硬拼时间线会：复制公共前缀、混乱对象 ID 与时间顺序、让 path 里跑过的工具调用看起来像在主线执行过、难以解释 harness 的 syncedSeq。合入的语义是**知识收录**，不是历史缝合。

### 为什么 transcript 模式是合法的——打标即诚实

baton 主线本就是异构聚合：各 harness 只见过自己产生的 turn，其余靠 catch-up 转写注入，"消费自己没产生的历史"是常态。因此原样合入分叉 turn 不是新的对象类别，真正的问题只在"假装原生"。只要 import 的 block 带出处标记（来自哪个 session、fork 自哪个水位），对人和模型都诚实——**"伪造"和"引用"的区别只是一个标签**。这也是 fast-forward 特判被删掉的原因：统一走 context-import，无需区分主线是否前进过。

需要说清的代价：baton 维持着一个软不变量——每个 turn 生成时见过它之前的一切（catch-up 保证）。import 的 transcript block 不满足这一点，但打标之后退化为可接受的质量问题，不是正确性问题。

### 为什么 summary 是默认——经济性与策展，不是正确性

- **token 永久负债**：主线每次 harness 接力 / catch-up 都要重放历史，transcript 模式 import 的全部 turn（含工具噪音、试错岔路）会被未来每次注入反复付费；
- **主线信噪比**：主线是用户认可的正典历史，不是全量流水账；path 的价值密度通常前低后高，值钱的是收敛出的结论。

transcript 模式留给"细节本身就是产出"的场景（path 里产出了精确方案 / 关键推理），UI 应在选择时提示该段的 turn 数与 token 量级，让用户知情付费。

### 为什么 elect 必须带反向交接

fork 后旧主线可能又跑了 turn、写了文件；checkout 到新 path 时 cwd 里躺着旧主线的改动，新 path 的会话历史对此一无所知。所以 elect 不只是移指针：先把旧主线自 fork 点后的增量 context-import 进新主线，再转移写令牌。

### 为什么写令牌先于 worktree

多 path 并行写代码的正确解是每 path 一个独立文件视图（worktree），但那是另一期的复杂度。写令牌以最小机制守住"同 cwd 不并发写"，且让约束靠机制生效而不靠文档自觉；将来引入 worktree 时，写令牌语义自然放宽为"每个文件视图一个写者"。

### 业界对照（为什么选这个落点）

| 产品 | 分叉 | 合回 |
|---|---|---|
| Codex `/side` | 临时 fork | 无，退出即弃 |
| Claude Code `/branch` `/fork` | 会话副本 / 后台 subagent | 明确无 merge-back |
| ChatGPT "Branch in new chat" | 从任意消息分叉 | 无 |
| opencode `Session.fork` | fork 到消息点 + parentID | 无（会话内靠 revert/unrevert） |
| pi 会话树 | 单文件 entry 级树 + `/tree` `/fork` `/clone` | `branch_summary`：切走时可选摘要挂到新位置 |

业界共识是**分叉自由、合回罕见**；做了合回的（pi `branch_summary`、学术方案 ContextBranch 的 inject）全部选择摘要/快照，无人做 raw event merge。pi 最优雅处在于 merge 方向无关（合入哪边 = 切到哪边）且无特权主干（主干 = active leaf 所在路径），第一步全盘借用；但 pi 单 active leaf、分支不并发跑、摘要只有一档且只在切换瞬间一次性生成——并发多 slot、写令牌、transcript 档、可重复 import 是 baton 第二步的增量。

## 4. 实施顺序

第一步（pi 对齐，不动存储）：

1. `/tree`：从 forkedFrom + 共享前缀渲染跨文件树视图，选中即打开对应 path，或在水位处 fork 新 path；
2. `_baton_context_import` 事件（先只 summary 档）+ reducer 卡片展示 + harness catch-up 注入；
3. path 切换钩子：离开时三选一（不摘要 / 默认摘要 / 自定义 focus），单 controller，切换即停旧启新。

第二步（并发与写令牌）：

4. workspace controller 持 `slots[]`（先限 2-3 个），tab 切换 = 换 focus，后台 path 状态提示；
5. 写令牌：非持有者映射只读执行策略 + fork boundary 提示（继承历史仅作参考）；
6. `accept` / `elect` / `leave` 显式动作；transcript 保真度档；
7. 之后再考虑：运行中排队合入、重复增量收录、worktree 多写者。
