# Backlog：暂缓能力与演进触发条件

有意识推迟的能力。每条记录"是什么、为什么值得做、什么条件下启动"，避免两类错误：过早实现（v1 范围膨胀）与彻底遗忘（条件成熟时重新踩一遍调研）。条目成熟进入里程碑后从本文移除；纯设计疑问归 `design.md` §7 开放问题。

## Provider 与 AgentTarget 分层

tutti 把"协议/runtime 类型"（Provider，如 codex）与"可选择、可启动的具体实例"（AgentTarget，如 local:codex）分成两层；target 承载 launch 引用、显示名、启用状态与来源。这样同一 provider 可以有本地 CLI、远端 VM、企业包装器、不同 persona 等多个可选目标。参考 tutti `services/tuttid/biz/agenttarget/model.go`。

baton v1 只有两个内置 provider，现在引入只会增加 session/schema/UI 复杂度。

**触发条件**：同一 provider 出现第二种启动配置的真实需求（如 `codex` 本地 CLI 与远端实例并存、`claude` 多套包装器/persona），或需要接入第三方动态注册的 agent。

## Capability 组合式 runtime preparation

tutti 把 agent 启动前准备抽成独立模块，用 `DeploymentProfile + CapabilityPack` 一次性组合 system policy、skills、环境变量、provider 本地文件与 session cleanup。核心洞察不是抽包，而是**一项能力的 prompt、skill 和 env 必须一起启停**，否则三套配置各自漂移。参考 tutti `packages/agent/runtimeprep/`。

**触发条件**：baton 开始做 skill 注入、browser/computer 类 capability，或同一套 adapter 需要部署到多种宿主环境时。

## Opaque reference（NodeRef / ReferenceHandle）

tutti 把跨来源引用统一成 `NodeRef { sourceId, nodeId }`，`nodeId` 对聚合层完全不透明；复杂产物用懒解析的 `ReferenceHandle`，避免把整个 artifact 提前塞进 prompt。参考 tutti `docs/architecture/agent-reference-sources.md`。

与 M5 的 `mention:// + CLI 回查`（design.md §5.6）方向一致：mention 的惰性解析本就要求引用先是"可回查的句柄"而非内容本身。

**触发条件**：M5 落地 `mention://` 时对齐该约束；`@` 来源从 BatonSession 扩展到文件、issue、构建产物时按此建模。

## 基于首轮语义摘要的会话标题

baton v1 直接取第一条真实用户输入的首个非空行作为会话预览和 terminal tab name，确定、即时且零额外成本。后续可参考 OpenCode：首轮提交后异步调用轻量模型生成更短的语义标题，再更新会话列表与 terminal title；生成失败继续使用 v1 预览，不能阻塞用户输入或 provider 执行，用户显式命名仍具有最高优先级。Codex 当前默认标题是运行状态与项目名的组合，不以首问作为标题。

现在引入会增加一次模型调用的成本、延迟与非确定性，而首行预览已满足基本的会话发现和 Otty tab 识别需求。

**触发条件**：实际使用中频繁出现首问过长、包含路径/附件或多行背景，导致 session picker、`@` 候选和 terminal tab 难以区分；且已有稳定、低成本的标题模型可异步调用时。
