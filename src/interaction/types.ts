/**
 * Baton 持有的、需要外部参与者给出结果后才能继续的持久交互。
 *
 * Interaction 是跨 Harness / Plugin 的稳定对象；permission、question、hook trust 只是
 * kind。Event source 表示谁报告了生命周期事实，requester 表示谁在等待结果，两者不能混用。
 */

export type InteractionRequester =
  | { type: "harness"; harnessTargetId: string }
  | { type: "plugin"; pluginInstanceId: string }
  | { type: "baton" };

/**
 * 审批选项的两根正交轴都只用于忠实展示 Harness 给出的候选。
 * 授权覆盖的操作与资源属于 Permission Policy，不从这两个字段反推。
 */
export interface PermissionOption {
  optionId: string;
  /** Harness 原话标签；它是当前候选语义的权威来源。 */
  name: string;
  polarity: "allow" | "reject";
  /** 只表达持续时间，不表达授权覆盖的资源。 */
  lifetime: "once" | "session" | "persistent";
}

export interface PermissionInteraction {
  kind: "permission";
  title: string;
  description?: string;
  toolCallId?: string;
  options: PermissionOption[];
}

export interface QuestionOption {
  label: string;
  description: string;
  preview?: string;
}

export interface QuestionPrompt {
  questionId: string;
  header: string;
  question: string;
  options?: QuestionOption[];
  multiSelect?: boolean;
  allowOther?: boolean;
  secret?: boolean;
}

export interface QuestionInteraction {
  kind: "question";
  questions: QuestionPrompt[];
}

export interface HookTrustCandidate {
  key: string;
  source: string;
  sourcePath: string;
  trustStatus: "untrusted" | "modified";
  command: string;
  matcher?: string;
  pluginId?: string;
  currentHash?: string;
  handlerType?: string;
  timeoutSec?: number;
  statusMessage?: string;
}

/**
 * Harness 启动前发现 hooks 尚未被信任：询问用户是否信任当前精确定义。
 * 这是启动信任，不是单次工具执行权限，故仍是独立 kind。
 */
export interface HookTrustInteraction {
  kind: "hook_trust";
  harnessName: string;
  hooks: HookTrustCandidate[];
}

/** Producer 提交的 kind-specific 内容；Controller 在可信边界补 identity 与 requester。 */
export type InteractionDraft = PermissionInteraction | QuestionInteraction | HookTrustInteraction;

export type Interaction = InteractionDraft & {
  interactionId: string;
  requester: InteractionRequester;
};

/**
 * Interaction 的终结结果。resolved 只表示不再等待外部参与者，不代表随后触发的
 * Harness 操作或 Plugin Action 已经执行成功。
 */
export type InteractionResolution =
  | { kind: "permission"; outcome: "selected"; optionId: string }
  | { kind: "question"; outcome: "answered"; answers: Record<string, string[]> }
  | { kind: "hook_trust"; outcome: "trusted" | "skipped" }
  | {
      kind: "cancelled";
      reason: "user" | "requester" | "turn" | "timeout" | "recovery";
    };

export interface InteractionResolved {
  interactionId: string;
  resolution: InteractionResolution;
}
