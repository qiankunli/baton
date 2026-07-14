# Provider 交互抽象方案

> 状态：Proposal；更新：2026-07-11。
> 本文用于记录动工前的边界、取舍和演进顺序。落地后以 `src/**` 中的类型、reducer 与契约测试为事实来源；本文保留 why，并删减已经能从单处代码直接读出的具体形状。

> 用户输入从 Composer 到 queue / steer / interrupt 的产品语义，本身就是 Adapter 行为契约的一部分；`user-input-lifecycle.md` 是该主题的专项设计与状态跟踪入口。对偶地，provider 输出从 wire 归一到终态收口（含丢事件自愈、静默悬挂对账）见 `provider-output-lifecycle.md`。本文继续给出完整交互面的总体分层、结构契约和 provider 映射，三者不是互斥边界。

本文解决两个问题：

1. chat-tui 如何覆盖 coding agent 常见的输入、输出与用户确认，同时继续保持纯 UI 组件边界；
2. baton Adapter 如何把 Claude Code、Codex 及未来 provider 归一成稳定语义，并以 ACP v2 作为主要词汇来源。

方案关注契约和演进顺序，不要求第一期实现所有 provider 能力。

## 1. 问题模型

coding agent 的交互不能只建模成“用户发 text，agent 回 block”。完整链路包含四类流量：

| 类别 | 典型行为 | owner |
|---|---|---|
| 用户内容 | text、image、file/resource、@ mention、skill | chat-tui 采集；baton 解释；adapter 映射 |
| 工作控制 | 新 turn、steer、follow-up、interrupt、切模型/模式 | baton runtime；adapter 暴露可选能力 |
| agent 产出 | message、thought、tool、diff、plan、usage、error、notice | adapter 归一；baton 持久化；chat-tui 投影 |
| agent 请求用户 | permission、structured question、elicitation | baton 分别建模；chat-tui 分别展示和回传 |

三层对象不能穿透：

```text
provider wire ── Adapter ──> baton semantic events ── projection ──> chat-tui view
provider wire <─ Adapter <── baton actions         <─ intents    <── chat-tui input
```

- chat-tui 不知道 ProviderSession、turn、ACP 或 Claude/Codex wire 消息。
- baton core 不依赖 chat-tui 的展示类型。
- Adapter 不返回 chat-tui block，也不把 provider DTO 直接写进 core state；原消息只放 envelope `raw`。

### 1.1 方案选择

| 方案 | 优点 | 问题 | 结论 |
|---|---|---|---|
| chat-tui 直接理解 Claude/Codex | 能快速复刻原生体验 | provider 分支进入组件库；无法独立复用 | 否决 |
| chat-tui 与 baton 全面采用 ACP DTO | 少设计一层类型 | ACP 是 wire protocol，且不覆盖 steer/process/subagent 等全部原生能力 | 否决 |
| UI view/intent + baton semantic event/action + provider adapter | 各层依赖稳定、支持本地/远端同构、可按能力渐进扩展 | 需要维护明确 projection | 采用 |

选中第三种方案，因为 projection 的显式成本小于 provider DTO 穿透后在 UI、存储、恢复和测试里形成的长期耦合。

## 2. 参考实现的可复用经验

### 2.1 pi-tui / pi-agent

- pi-tui 是低层组件系统：component、focus、overlay、editor、select/settings、markdown、image 各自独立。它不试图定义 agent event。这印证 chat-tui 应组合稳定 UI primitive，而不是复制 provider schema。
- Editor 把文本、slash/file completion、大段 paste marker、图片附件视为 composer 能力；输入不应永远压成一个裸 string。
- pi-agent 明确区分 `steer()` 和 `followUp()`：steer 在当前 agent run 的安全边界注入，follow-up 只在 agent 本应停止后继续。两者即使都暂存在队列里，语义也不同。
- pi-agent 的 lifecycle 是 agent / turn / message / tool 四层事件，工具支持 start/update/end 和结构化 details；这比只看最终 message 更适合驱动 UI。
- AgentMessage 与 LLM Message 分离，通过转换层过滤 UI-only message。对应到 baton，就是统一历史不能等同于任一 provider 的 model-visible history。

### 2.2 OpenCode

- Message 与 Part 分离；part 覆盖 text、reasoning、file、tool、retry、compaction、snapshot/patch、subtask，错误也有结构化分类。统一历史不需要把所有东西伪装成 message text。
- input file 带 source，可区分 file、symbol、resource；比发送前把 `@foo` 展开成纯字符串更适合持久化、重放和重新投影。
- Permission 与 Question 是两个独立 service，各自拥有 pending map、request/reply/reject 生命周期。这个边界应直接吸收，不能把 question 塞进 approval。
- provider runtime 先归一成共同 LLM event，再交给 session processor；request lowering 与 transport/execution 分离。Adapter 同理应把 wire 翻译集中在 provider 目录，不把 provider 分支泄漏到 runtime。
- tool state 保存 input、output、attachments、time、error、metadata；UI 投影可按需要裁剪，但持久层仍保留足够语义。

### 2.3 Codex

- `turn/start`、`turn/steer`、`turn/interrupt` 是三个独立操作；steer 带 `expectedTurnId` 防止把输入注入错误的活跃 turn。
- UserInput 是 tagged union：text（含 text elements）、remote/local image、skill、mention；inline mention 需要稳定 range/element，而不是发送时重新猜字符串。
- request-user-input UI 是独立状态机，支持多问题、option、自由文本、secret、未答确认、请求队列和 auto-resolution。它与 approval overlay 分开。
- pending input 明确区分 pending steer、rejected steer（降级到 turn 末尾）和普通 queued follow-up，并把实际调度结果告诉用户。
- command execution 具有 cwd、process id、output、exit code、duration；独立 process API 还区分 stdout/stderr、stdin、PTY resize、kill 和 output cap。
- app-server 还有 subagent、web search、image、context compaction、warning/error/retry、model reroute 等输出，说明“未知 item 全归 other tool”只能作为降级，不应成为长期模型。

### 2.4 ACP v2

Adapter 内部语义优先对齐 ACP v2：

- prompt response 只确认接受；running/output/requires_action/idle 全部经 update 报告；
- message、tool call、plan 按稳定 ID upsert；omit / null / value / chunk 语义明确；
- ContentBlock 复用 MCP 的 text/image/audio/resource/resource_link；
- permission 有独立 request/response，title 不覆盖 tool title；
- dynamic command 与 session config 都是完整快照更新；model/mode/thought level 是 config category，而不是硬编码多套 UI；
- enum/tagged union 前向兼容，未知值保留，baton 扩展使用 `_baton_` 前缀。

不照搬两点：

1. ACP 是 wire protocol，baton 是本地产品 core；不需要为内部调用引入 JSON-RPC 形状。
2. ACP stable v2 仍不覆盖所有 Codex 能力（如同 turn steer、subagent、process）。这些用 baton 可选 capability / `_baton_` event 增量扩展，不反向污染稳定核心。

## 3. chat-tui 方案

### 3.1 边界

chat-tui 继续采用“view snapshot 进，typed intents 出”。它只回答：

- 当前能输入什么、默认提交行为是什么；
- transcript / activity / notice 怎么展示；
- 当前是否有 permission、question 或 elicitation 需要回答；
- 哪些 command / config option 可选。

它不判断 provider 是否支持 steer，不维护 turn 队列，不执行 command，也不持久化 request。

### 3.2 Composer 输入

用结构化 `ComposerValue` 取代只有 `submit(text)` 的接口：

```ts
interface ComposerValue {
  text: string;
  elements: ComposerElement[];
  attachments: ComposerAttachment[];
}

type ComposerElement =
  | { id: string; kind: "mention"; start: number; end: number; label: string; value: string }
  | { id: string; kind: "paste"; start: number; end: number; text: string };

type ComposerAttachment =
  | { id: string; type: "image"; mimeType: string; data?: string; path?: string; name?: string }
  | { id: string; type: "file"; path: string; mimeType?: string; name?: string }
  | { id: string; type: "resource"; uri: string; name: string; mimeType?: string };
```

`elements` 使用 text range 保留 inline mention / paste 的身份；`attachments` 表示不占文本 range 的内容。chat-tui 只保证编辑后 range 正确，不解析 mention 指向 BatonSession 还是文件。

提交 intent 显式携带用户期望：

```ts
type SubmitDelivery = "prompt" | "steer" | "follow_up";

interface SubmitIntent {
  value: ComposerValue;
  delivery: SubmitDelivery;
}
```

- `prompt`：空闲时开始新工作；
- `steer`：在当前工作下一个安全边界注入；
- `follow_up`：当前工作自然结束后再开始。

view 通过 `composer.allowedDeliveries` 与 `composer.defaultDelivery` 控制 UI；不支持 steer 时不展示该选项。`queued` 不是用户意图，而是 harness 接受 intent 后的调度状态。

### 3.3 Command

Command 是动态 view state，不只在 `ChatShell` 初始化时注入：

```ts
interface CommandView {
  id: string;
  name: string;
  description: string;
  owner: "harness" | "provider";
  input?: { type: "text"; hint: string };
  availability: "always" | "idle" | "running";
}

type CommandIntent =
  | { type: "known"; commandId: string; argument: string }
  | { type: "unknown"; name: string; argument: string; raw: string };
```

- baton 自有命令与 provider command 共用补全 UI，但 `id/owner` 不同；
- provider command 列表可随 session 状态动态替换，对齐 ACP `available_commands_update`；
- chat-tui 把未知 `/xxx` 作为 `unknown` command intent 交给 harness，不自动降级成普通 submit；harness 可以报错、提示候选项，或显式选择按文本提交。

### 3.4 Session config

把现有 model picker 提升为通用 config view，形状对齐 ACP v2 的稳定子集：

```ts
type ConfigOptionView =
  | {
      id: string;
      type: "select";
      name: string;
      description?: string;
      category?: string;
      value: string;
      options: Array<{ value: string; name: string; description?: string }>;
    }
  | {
      id: string;
      type: "boolean";
      name: string;
      description?: string;
      category?: string;
      value: boolean;
    };
```

category 只影响摆放，不影响正确性。首批处理 `model`、`mode`、`model_config`、`thought_level`；未知 category 仍可放通用 settings overlay。

### 3.5 Provider 请求用户

这条 **Request ↔ Response 交互轴**（provider 询问用户 ↔ 用户对 request 的答复）是与输入轴正交的第三根用户交互轴，**不限于权限**：

- **Request**（provider → 用户，solicited）：provider 阻塞并征求用户，`kind ∈ {permission, question(给候选/选择), elicitation(取数据)}`。三种 request contract 各自独立（下面各小节 + §4.7），不合成万能字段。
- **Response**（用户 → provider）：用户对某个 Request 的答复，经 stable request id `refersTo` 该 Request，走统一 `respond(requestId, response)`（§4.7 `Interactive.respond`）。
- **与 Input 的关系**：Response 与 Input（prompt / steer）同为"用户 → provider 信号"，区别在 Input 是 **unsolicited**（自发、不 refers 任何 request）、Response 是 **solicited**（必 refers 一个 Request）。二者同族不同型——状态机不同（Input 驱动 / 注入 turn；Response 解阻 pending request），不塞进一个扁平 `type`。
- **ApprovalReview 的归位**：它是 `Response{kind:permission}` 的**委托变体回执**——用户把审批权交给 reviewer（auto-review）时，reviewer 代答留下的审计回执（见 `approval-lifecycle.md`）。它也 refersTo 一个 permission Request，但作者是 reviewer 不是用户，是这条轴的一个**叶子 / 特例**，不是通名。命名待定（Request/Response 是当前占位，欢迎更贴切的词）。

协议层分别定义三种 view/intent，只在 overlay 调度层组成 union：

```ts
type ActionRequestView = PermissionRequestView | QuestionRequestView | ElicitationRequestView;
```

#### Permission

- title、description、subject preview、provider 给出的 options；
- 必须选择明确结果；interrupt/带外解决时按 request id 关闭；
- 不能用 Esc 静默表示 allow 或 ignore。

#### Question

- 一次请求包含多个 question；
- question 支持 single/multi select、freeform/Other、secret、preview；
- 回答按 question id 返回，允许 reject/cancel；
- request 可带 toolCallId 与 auto-resolution metadata。

#### Elicitation

- 首批只实现 `form`：string、number、boolean、single/multi select、required、secret；
- URL elicitation 作为独立 view，不把打开 URL 伪装成普通 option；
- accept / decline / cancel 三态保留。

chat-tui 可以复用 select、editor、settings 等 primitive，但 request contract 不互相复用。OpenCode 的独立 Question/Permission service 与 Codex 的独立 overlay 都证明这种分离更稳。

### 3.6 输出 view

TranscriptItem 保持展示模型，但扩成三个顶层类别：

```ts
type TranscriptItem = MessageView | ActivityView | NoticeView;

interface MessageView {
  type: "message";
  id: string;
  role: "user" | "agent";
  author?: string;
  content: DisplayBlock[];
}

interface ActivityView {
  type: "activity";
  id: string;
  kind: string;
  status: "pending" | "in_progress" | "completed" | "failed" | "cancelled";
  title: string;
  subtitle?: string;
  content?: DisplayBlock[];
  parentId?: string;
}

interface NoticeView {
  type: "notice";
  id: string;
  level: "info" | "warning" | "error";
  title: string;
  detail?: string;
  retrying?: boolean;
}
```

DisplayBlock 只增加跨产品稳定的展示 primitive：

```ts
type DisplayBlock =
  | { type: "text"; text: string }
  | { type: "markdown"; text: string }
  | { type: "code"; code: string; language?: string }
  | { type: "lines"; lines: string[]; stream?: "stdout" | "stderr" }
  | { type: "diff"; changes: DiffChangeView[]; patch?: string }
  | { type: "image"; mimeType: string; data?: string; path?: string; alt?: string }
  | { type: "resource_link"; uri: string; name: string; description?: string }
  | { type: "plan"; entries: PlanEntryView[] }
  | { type: "progress"; current?: number; total?: number; label?: string };
```

消息的来源与展示格式正交：role/author 只表达谁在说话，plain/markdown 由 projection
显式选择；流式 Markdown 的开始与完成边界也由 projection 提供，chat-tui 不从文本内容或
provider 名猜测格式。工具输出、命令、diff 与 plan 继续走各自的展示 primitive。

边界：

- `kind` 继续开放，允许 tool、thought、plan、subagent、process、hook 等 activity；
- 不把 Claude/Codex item type 加进 chat-tui；
- `renderItem` 保留为 escape hatch，但标准能力必须可序列化，保证未来远端 harness 与本地 harness 同构；
- footer/status 可继续接受预格式化字符串作为 escape hatch，但 run state 与 usage 应有最小结构化 view：

```ts
interface RunStateView {
  state: "idle" | "running" | "requires_action";
  label?: string;
  stopReason?: string;
  canCancel: boolean;
}

interface UsageView {
  contextUsed?: number;
  contextSize?: number;
  inputTokens?: number;
  outputTokens?: number;
  cost?: { amount: number; currency: string };
}
```

`busy` 由 `runState.state === "running"` 派生，不再作为独立真相源。存在 pending blocking request 时，projection 必须产出 `requires_action`；反向不强制成立，因为登录、外部设备确认等 provider action 可能还没有对应的结构化 request。此时 UI 必须展示通用 action-required notice，不能留下没有卡片的空白状态。

### 3.7 Overlay 与 pending input

- harness 持有 request/queue 真相源，chat-tui 只显示当前 active request；
- request 以稳定 id 关闭，支持用户作答、用户 cancel、provider 带外解决、turn cancel、timeout 五种终态；timeout 的计时和终态决策由 baton runtime 持有，chat-tui 只展示 deadline/countdown，adapter 只负责把最终响应映射回 provider；
- approval/question/elicitation 优先于 command/config picker；
- pending input 分别展示 requested delivery 与 effective delivery，例如 steer 被 provider 拒绝后降级为 follow-up，不能仍标记为 steer；
- recall 按 pending input id，而不是只有“最后一条”的隐式操作。

## 4. Adapter 方案

### 4.1 核心生命周期

当前 `prompt(..., sink)` 直到 turn 结束才 resolve，且 sink 只活在 prompt 调用期。这会阻塞四类能力：prompt admission、provider 主动事件、后台 task、多 client/reconnect replay。

改为 ACP v2 风格：session 建立时绑定事件出口，submit 只确认接收。

```ts
interface AgentAdapter {
  readonly provider: string;
  readonly capabilities: AdapterCapabilities;

  open(options: OpenOptions, sink: EventSink): Promise<ProviderSessionRef>;
  submit(ref: ProviderSessionRef, input: PromptInput): Promise<PromptReceipt>;
  cancel(ref: ProviderSessionRef): Promise<void>;
  close(ref: ProviderSessionRef): Promise<void>;
}

type PromptReceipt = { accepted: true };
```

`submit()` resolve 不代表 turn 完成。用户输入的 owner 是 runtime，provider 执行过程的 owner 是 Adapter：

```text
runtime 出队（driven turn）
  → user_message upsert + state_update(running)   // runtime 落盘：用户输入是 BatonSession 的事实，
                                                   //   不等 provider 冷启动；正典历史存原始输入，
                                                   //   <baton-sync> 注入只进 provider transport
  → （冷启动时）_baton_run_status(starting)        // preparing 阶段对用户可见、可取消
submit accepted                                    // admission；Adapter 不得为 prompt 重复发
                                                   //   user_message / running
  → message/tool/plan/... updates
  → state_update(requires_action ↔ running)  // 可重复
  → state_update(idle, stopReason)
```

为什么 user_message 不归 Adapter：provider 首启（spawn → initialize → thread resume/start）可达数秒，若由 `submit()` 发用户消息，Transcript 会被冷启动绑住；且 prepend 注入路径下 `submit()` 拿到的 blocks 已掺入 `<baton-sync>`，由它落盘会污染正典历史。steer 是例外——只有 provider 确认接受后消息才成为事实，成功路径仍由 Adapter 发 `delivery:"steer"` 的 user_message。

出队与撤回的边界随之明确：消息在队列中可 recall；一旦出队即由 runtime 落盘、成为正典历史，冷启动期间只能 cancel（立即合成 `idle/cancelled` 终态，启动继续在后台完成、slot 留给后续 turn 复用）。启动或 admission 失败同样合成结构化终态（`_baton_error_update` + `idle/error` + summary）——不存在"输入消失且无历史"的半状态。为保证 preparing 总有退出路径，启动期 wire 请求（codex 的 initialize / thread resume/start）必须带显式超时；turn/start 不设（老版本 app-server 合法地阻塞到 turn 结束）。

baton runtime 以 state event 驱动 active/idle，不以 Promise 生命周期推断。cancel 的确认同样是最终 `idle/cancelled`，发送 cancel 后仍接受之前已在路上的 update。

生命周期必须满足“每个 baton turn 只发生一次逻辑终结”，而不是假设物理事件只会到达一次：reconnect、replay 和 transport race 都可能产生重复终态。Adapter 在正常 idle、wire fatal error、子进程退出和 transport close 上都必须报告或合成终态；runtime 按 baton turn id 幂等 finalize，并忽略已完成 turn 的重复/迟到终态。

finalize 是统一的有序路径：持久化终态 → 生成一次 `_baton_turn_summary` → 更新同步元数据 → 释放该 turn 的等待者 → 推进输入队列。Adapter 丢失时 runtime 只在确定 transport 已关闭，或 cancel grace period 到期后合成 terminal error；不设置任意的全局 turn 时长 watchdog，因为合法的长任务不应被误杀。没有 active baton turn 的后台事件也不能结束队首之外的工作。

### 4.2 Prompt 输入

Adapter 接收 ACP/MCP 风格的 prompt block，而不是输入输出共用的开放 `ContentBlock`：

```ts
type PromptBlock =
  | TextBlock
  | ImageBlock
  | AudioBlock
  | EmbeddedResourceBlock
  | ResourceLinkBlock;

interface PromptInput {
  batonMessageId: string;
  blocks: PromptBlock[];
}
```

- `DiffBlock`、tool result 等输出内容不能作为普通 prompt block 混入；
- BatonSession / file / skill mention 先由 baton context 层解析为 provider 可见的 prompt block；
- adapter 按 capability 映射，禁止用 `textOf()` 静默丢弃不支持的 block；不支持时在 admission 前返回带 block type 的明确错误。

### 4.3 Steer 与 follow-up

follow-up 是 baton runtime 的队列策略，不进入基础 Adapter。same-turn steer 是可选 capability：

```ts
interface Steerable {
  steer(
    ref: ProviderSessionRef,
    input: PromptInput,
    expectedTurnId: string,
  ): Promise<{ effective: "steer" | "rejected" }>;
}
```

- Codex 映射 `turn/steer(expectedTurnId)`；
- Claude 只有确认 SDK streaming input 的实际安全边界后才声明；
- adapter 不支持或原生拒绝时，runtime 可按用户策略降级成 follow-up，并记录 effective delivery；
- `expectedTurnId` 防止 race：用户提交时看到的 turn 已结束，就不能把 steer 注入新 turn。

这里的 `expectedTurnId` 始终是 baton turn id。runtime 在接受输入、进入 pending 队列时就分配该 id，而不是等真正 dequeue 执行；adapter 维护 baton turn id 到 provider turn id 的映射，并在 Codex 等 wire 调用中换成 provider id。provider id 不进入 chat-tui 或 runtime action contract。

### 4.4 Capability

保留“小核心 + 可选能力”，同时提供可展示 descriptor：

```ts
interface AdapterCapabilities {
  prompt: {
    image?: CapabilityMarker;
    audio?: CapabilityMarker;
    embeddedResource?: CapabilityMarker;
    resourceLink?: CapabilityMarker;
  };
  steer?: CapabilityMarker;
  commands?: CapabilityMarker;
  config?: CapabilityMarker;
  interactions?: {
    permission?: CapabilityMarker;
    question?: CapabilityMarker;
    elicitation?: { supported: true; form?: CapabilityMarker; url?: CapabilityMarker };
  };
}

interface CapabilityMarker {
  supported: true;
}
```

descriptor 用显式 marker object，给以后扩字段留空间；不能使用 TypeScript 的 `{}`，因为它会接受几乎所有非 nullish 值。行为仍由 `Steerable`、`CommandDiscoverable`、`SessionConfigurable`、`Interactive` 等接口承载。契约测试校验“声明支持就必须实现对应接口”。

### 4.5 Dynamic command

```ts
interface CommandDiscoverable {
  listCommands(ref: ProviderSessionRef): Promise<AvailableCommand[]>;
}
```

- Adapter 首次发现和中途变化都发完整 `available_commands_update`；
- baton registry 合并 baton commands 与当前 provider commands，ID/owner 不冲突；
- 对齐 ACP，provider command 首期仍作为特殊 prompt text 执行，但必须通过已发现 command descriptor，不允许任意文本透传；
- Claude 映射 SDK `supportedCommands()` / commands-changed；Codex 只映射 app-server 明确暴露的能力，不能假设原生 TUI slash command 在 app-server 中等价存在。

### 4.6 Session config

用通用 config capability 替代只覆盖 model 的特例增长：

```ts
interface SessionConfigurable {
  getConfig(ref: ProviderSessionRef): Promise<SessionConfigOption[]>;
  setConfig(
    ref: ProviderSessionRef,
    configId: string,
    value: ConfigValue,
  ): Promise<SessionConfigOption[]>;
}
```

- 返回完整配置快照，允许 model 改变后 reasoning 选项联动变化；
- 首批 category：model、mode、model_config、thought_level；
- approval/sandbox 虽可展示为 config，但 adapter 必须保留 provider 安全语义和约束，不把任意 key/value 直接写入 wire；
- 现有 `/model` 成为 category=model 的快捷入口，而不是独立状态真相源。

### 4.7 用户响应

事件模型分别新增：

```text
permission_request / permission_resolved
question_request   / question_resolved
elicitation_request / elicitation_resolved
```

Adapter 维护 provider request id 到 pending responder 的映射，并实现：

```ts
interface Interactive {
  respond(
    ref: ProviderSessionRef,
    response: InteractionResponse,
  ): Promise<void>;
}
```

`InteractionResponse` 是 permission/question/elicitation 三种严格判别 response 的联合，只复用 request-id 路由；各自 payload 和终态仍保持独立。

不再把 `ApprovalHandler` callback 注入 adapter constructor：

- callback 使 request 绕开统一 runtime action，难以做带外解决、恢复和多 UI client；
- request event 先持久化并令 session `requires_action`，UI 回答再经 stable request id 进入 `respond()`；
- turn cancel 必须级联 cancel 所有 pending request；provider 发 resolved notification 时也要关闭对应 UI；
- unknown response 不能按 allow 处理。

**cancel-cascade（已实现）**：turn 收口（尤其被 Esc 打断）时，runtime 把该 turn 仍挂起的 request 一并了结——`finalize` 遍历 `pendingRequests`（按 `requestId → turnId` 归属，onAdapterEvent 见 `*_request` 时记），用 `RequestOutcome` 的 `{kind:"cancelled"}` 变体解开 adapter 的 `await requestHandler`；adapter 收到即发 `*_resolved(cancelled)`（→ reduce 清 `pendingPermissions`、`requires_action` 落下）并回 provider abort/deny（codex `cancel`＝Deny and interrupt turn，claude `deny`）。这让 **live cancel 与 crash-recovery 走同一套 "dangling → cancelled" 语义**，不再只在重开时清理。

设计取舍（对照参考实现）：**interrupt 是 out-of-band 控制信号，不进 queue**——因为它要打断的正是 queue 里排在最前、且可能正阻塞在 pending request 上的那个 turn，排队会死锁。三家印证同一形态:codex 内核把 interrupt/approval-response 都做成 `Op`（一条提交通道、turn 在独立 task 上跑，故 interrupt 能并发送达）；opencode 用 `Fiber.interrupt` + `ensuring(pending.delete)`；pi 用 `AbortSignal`。codex 还有一处精妙顺序——**先 abort task，再 clear pending waiters**，避免取消以 model 可见的 tool rejection 抢在 turn 中断之前冒出；baton 的 `finalize` 天然在 `adapter.cancel` 之后，顺序一致。

### 4.8 事件模型

保留已有 ACP v2 主干：

- `state_update`
- `user/agent/thought_message(_chunk)`
- `tool_call_update` / `tool_call_content_chunk`
- `plan_update`
- `usage_update`（保留 baton 既有 token delta 语义）

补齐以下一等事件：

| 事件 | 原因 |
|---|---|
| `available_commands_update` | provider command 动态变化 |
| `config_option_update` | model/mode/reasoning 等完整配置快照 |
| `question_request/resolved` | agent structured question 不等于 permission |
| `elicitation_request/resolved` | MCP/provider form 或 URL flow |
| `context_usage_update` | 当前 context used/size/cost 的完整快照，映射 ACP v2 `usage_update` |
| `_baton_error_update` | 保留 error code/message/retryable/willRetry，不能只塞 stopReason |
| `_baton_notice` | warning、deprecation、auth/config 提示 |

当前 baton 的 `usage_update` 是 input/output/cache/reasoning token **增量**，与 ACP v2 `usage_update` 的 context used/size/cost **快照**同名不同义。兼容已有 `session.jsonl` 优先：不复用旧名字改变语义，也不只为词汇对齐升级 envelope version。保留 `usage_update` 的 delta 契约，新增 `context_usage_update` 表示快照，并由 adapter mapping 明确它对应 ACP v2 `usage_update`。旧 session replay 必须继续得到与旧 reducer 相同的累计 usage。

`DiffBlock` 同样收敛到 ACP v2 的 `changes[] + patch {format,diff}`，补齐 copy、fileType、mimeType；本地 path image 在进入 adapter 前按 provider capability 保留 path 或解析为 data/URI，禁止由 `textOf()` 静默丢弃。

后续有第二个 provider 证明语义稳定后，再提升这些 extension：

- `_baton_task_update`
- `_baton_subagent_update`
- `_baton_context_update`（compaction/context usage）

工具仍用 ACP `tool_call_update` 做最大公约数。command exit code/duration、web citations、subagent children 等细节先放结构化 `rawInput/rawOutput` 与 `raw`；当 chat-tui 确实需要跨 provider 展示，才增加新的通用字段或 content block，避免一个 provider 一个 block。

### 4.9 Error、未知事件与 raw

- provider error 必须同时产生结构化 error event；若结束工作，再产生 `idle` + 对应 stopReason；
- retrying error 不得错误地把 session 切 idle；
- mapped event 的 wire 原文继续保存在 `raw`；
- 完全未知的 notification 不进入主 session timeline，进入有界 adapter diagnostic log，并记录 method/type 与计数；不能无声 `default: break`；
- adapter mapping contract test 固定当前支持的 request / notification 清单，provider schema 升级时显式看到新增未映射项。

### 4.10 Store 与 reduce 不变量

1. ID owner 明确：BatonSession/turn 用 baton ID；provider message/tool/request ID 保留映射，不能临时重造导致 upsert 断裂。
2. prompt acceptance 与 turn completion 分离；崩溃恢复能判断“已接受未完成”。
3. request/resolved 可重放；reducer 不重新触发 provider side effect。
4. omit / null / value / chunk 语义保持 ACP v2 三态，禁止用普通 optional 合并丢掉 null。
5. replay、wire live event、外部 observer 最终进入同一 reducer，但 source 写入 envelope，方便去重和诊断。
6. terminal wire event 可以重复，baton turn finalize 必须幂等；summary、同步元数据和队列推进每个 turn 只发生一次。
7. 已落盘事件的名字和语义不可静默翻转；确需翻转时升级 envelope version 并提供读侧迁移。

## 5. 两层契约的对应关系

| baton semantic state/action | chat-tui view/intent |
|---|---|
| PromptBlock + delivery policy | ComposerValue + SubmitIntent |
| available commands snapshot | CommandView[] + CommandIntent |
| config options snapshot | ConfigOptionView[] + set-config intent |
| message events | MessageView + DisplayBlock[] |
| tool/plan/task/subagent events | ActivityView |
| error/warning events | NoticeView |
| permission request | PermissionRequestView + permission response intent |
| question request | QuestionRequestView + question response intent |
| elicitation request | ElicitationRequestView + elicitation response intent |
| runtime input state | InputView（requested/effective delivery） |

映射只存在于 baton `tui/protocol.ts` 一处；chat-tui 和 provider adapter 不互相依赖。

## 6. 实施顺序

### Phase 1：先立契约，不改行为

- baton 拆分 `PromptBlock` 与输出 content；
- 增加 capability descriptor、error/notice、command/config event schema；
- chat-tui 只增加当前阶段马上有消费方的最小 input/view 类型，并由兼容 projection 适配现有 `submit(text)` 和 block；audio、URL elicitation、cost currency、progress 等公开类型在对应 phase 出现真实消费方时再落代码，不在 Phase 1 预冻结；
- 为 upsert、unknown value、capability/interface 一致性补契约测试。

### Phase 2：生命周期改造

- `start + prompt(sink)` 改为 `open(sink) + submit`；
- runtime 完全由 state event 驱动 busy/idle；
- 建立按 baton turn id 幂等的统一 finalizer，覆盖正常 idle、fatal wire error、子进程退出、transport close 和 cancel grace timeout；
- cancel 等待 `idle/cancelled` 确认；
- Claude/Codex adapter mapping tests 覆盖完整 lifecycle。

### Phase 3：用户交互闭环

- permission 从 constructor callback 迁移到 request event + `respond()`；
- Claude AskUserQuestion 与 Codex requestUserInput 已通过独立 question event + chat-tui overlay 闭环；下一步把 constructor callback 迁移到统一 `respond()`；
- provider user dialog 尚未接入；
- 再接 MCP elicitation form / URL，验证 cancel、timeout、带外 resolved。

### Phase 4：输入与控制

- composer attachment/element；
- Codex rich UserInput，Claude 对应 SDK block；
- dynamic provider commands；
- generic config option；
- Codex steer + rejected-steer 降级，Claude 未验证前不声明 steer。

### Phase 5：富输出

- markdown/image/resource/diff display block；
- process stdout/stderr、exit/duration；
- error/retry/compaction/context usage；
- subagent/task 在出现第二个可对齐 provider 后升格为正式事件。

## 7. 验收矩阵

每个 provider adapter 运行同一组契约用例：

1. text prompt：accepted → user message → running → agent chunks/upsert → idle；
2. image/resource：支持则无损映射，不支持则 admission 明确失败；
3. tool：pending → in_progress → chunks → final replacement → completed/failed；
4. permission/question/elicitation：request → requires_action → response/cancel/带外 resolved → running；
5. cancel：允许尾部 update，最终只能以 idle/cancelled 确认；
6. steer：正确 turn 成功，stale turn 拒绝，可选降级 follow-up；
7. config/commands：全量快照替换，动态更新后 UI 无旧项；
8. unknown enum/tagged union：不崩溃、保 raw、不误当 allow/success；
9. error/retry：retrying 保持 running，terminal error 才结束；
10. transport/进程失败：close 或 kill 后该 baton turn 只逻辑终结一次，summary 只生成一次，队列继续推进；
11. duplicate/replay terminal：不重复 summary、同步元数据或队列推进，迟到终态不能关闭更新的 active turn；
12. replay：与 live reduce 得到相同 view state，不重复触发 side effect；旧版 `usage_update` delta 日志累计结果不变。

chat-tui 侧用纯逻辑与 snapshot 覆盖：

- composer range/attachment 编辑；
- delivery 切换与 pending requested/effective 状态；
- command ownership 与 dynamic replacement；
- config select/boolean；
- permission/question/elicitation 的 focus、cancel、secret、multi-select、timeout；
- DisplayBlock 在窄终端、长内容和未知 kind 下的降级。

## 8. 非目标

- 不把 chat-tui 做成 ACP client；
- 不让 baton core 直接依赖 Claude SDK / Codex app-server schema；
- 不追求第一版完整复刻任一 provider 原生 TUI；
- 不为每个 provider event 新建 chat-tui block；
- 不在真实消费方出现前冻结 chat-tui 的公开类型；
- 不把 permission、question、elicitation 合成一个字段任意的万能 request；
- 不承诺所有未知 raw event 永久进入 session.jsonl。

## 9. 参考

- [badlogic/pi-mono · packages/tui](https://github.com/badlogic/pi-mono/tree/main/packages/tui)
- [badlogic/pi-mono · packages/agent](https://github.com/badlogic/pi-mono/tree/main/packages/agent)
- [OpenCode message/session model](https://github.com/anomalyco/opencode/tree/dev/packages/opencode/src/session)
- [OpenCode question and permission](https://github.com/anomalyco/opencode/tree/dev/packages/opencode/src)
- [Codex app-server protocol v2](https://github.com/openai/codex/tree/main/codex-rs/app-server-protocol/src/protocol/v2)
- [Codex TUI bottom pane](https://github.com/openai/codex/tree/main/codex-rs/tui/src/bottom_pane)
- [ACP v2 prompt lifecycle](https://agentclientprotocol.com/protocol/v2/prompt-lifecycle)
- [ACP v2 content](https://agentclientprotocol.com/protocol/v2/content)
- [ACP v2 tool calls](https://agentclientprotocol.com/protocol/v2/tool-calls)
- [ACP v2 slash commands](https://agentclientprotocol.com/protocol/v2/slash-commands)
- [ACP v2 session config options](https://agentclientprotocol.com/protocol/v2/session-config-options)
