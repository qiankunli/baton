import type { PluginResource } from "./resource.ts";
import { PluginResourceStore } from "./resource.ts";

export interface PluginResourceClient {
  get<TSpec, TStatus>(
    resourceKind: string,
    resourceId: string,
  ): Readonly<PluginResource<TSpec, TStatus>>;
  list<TSpec, TStatus>(
    resourceKind?: string,
  ): readonly Readonly<PluginResource<TSpec, TStatus>>[];
  patchStatus<TSpec, TStatus>(
    resource: Readonly<PluginResource<TSpec, TStatus>>,
    patch: Partial<TStatus>,
  ): Readonly<PluginResource<TSpec, TStatus>>;
}

function deepFreeze<T>(value: T): T {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  Object.freeze(value);
  for (const child of Object.values(value)) deepFreeze(child);
  return value;
}

/** Restricts Resource reads and status writes to one PluginInstance-owned store. */
export function createPluginResourceClient(
  store: PluginResourceStore,
): PluginResourceClient {
  const assertOwned = (resource: {
    kind: string;
    metadata: {
      batonSessionId: string;
      pluginInstanceId: string;
      resourceId: string;
      resourceVersion: number;
    };
  }): void => {
    if (
      resource.metadata.batonSessionId !== store.batonSessionId ||
      resource.metadata.pluginInstanceId !== store.pluginInstanceId
    ) {
      throw new Error(
        `plugin ResourceClient cannot access ${resource.kind}/${resource.metadata.resourceId} outside ${store.pluginInstanceId}`,
      );
    }
  };

  return Object.freeze({
    get<TSpec, TStatus>(resourceKind: string, resourceId: string) {
      return deepFreeze(store.get<TSpec, TStatus>(resourceKind, resourceId));
    },
    list<TSpec, TStatus>(resourceKind?: string) {
      return store
        .list<TSpec, TStatus>(resourceKind)
        .map((resource) => deepFreeze(resource));
    },
    patchStatus<TSpec, TStatus>(
      resource: Parameters<PluginResourceClient["patchStatus"]>[0],
      patch: Partial<TStatus>,
    ) {
      assertOwned(resource);
      return deepFreeze(
        store.patchStatus<TSpec, TStatus>(
          resource.kind,
          resource.metadata.resourceId,
          patch,
          {
            expectedResourceVersion: resource.metadata.resourceVersion,
          },
        ),
      );
    },
  });
}
