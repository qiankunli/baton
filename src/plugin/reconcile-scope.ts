import type {
  ReconcileResourceOwner,
  ReconcileScope,
} from "./controller.ts";

export function reconcileResourceOwner(
  scope: ReconcileScope,
): ReconcileResourceOwner {
  const owner = scope.resourceOwner ?? "plugin";
  if (owner !== "plugin" && owner !== "baton") {
    throw new Error(`reconcile resourceOwner is invalid: ${String(owner)}`);
  }
  return owner;
}

export function reconcileScopeId(scope: ReconcileScope): string {
  return JSON.stringify([
    scope.batonSessionId,
    scope.pluginInstanceId,
    reconcileResourceOwner(scope),
    scope.resourceKind,
  ]);
}

export function reconcileScopeLabel(scope: ReconcileScope): string {
  const kind =
    reconcileResourceOwner(scope) === "plugin"
      ? scope.resourceKind
      : `baton:${scope.resourceKind}`;
  return `${scope.batonSessionId}/${scope.pluginInstanceId}/${kind}`;
}

export function sameReconcileScope(
  left: ReconcileScope,
  right: ReconcileScope,
): boolean {
  return (
    left.batonSessionId === right.batonSessionId &&
    left.pluginInstanceId === right.pluginInstanceId &&
    left.resourceKind === right.resourceKind &&
    reconcileResourceOwner(left) === reconcileResourceOwner(right)
  );
}
