import type {
  AvailablePluginPackage,
  InstalledPluginPackage,
  RegisteredMarketplace,
} from "../../plugin/marketplace/index.ts";
import type { PluginInstance } from "../../plugin/instance.ts";

export type PluginTab = "discover" | "installed" | "marketplaces" | "errors";

export interface PluginBrowserError {
  readonly source: Exclude<PluginTab, "errors">;
  readonly message: string;
}

export interface PluginBrowserData {
  readonly available: readonly AvailablePluginPackage[];
  readonly installed: readonly InstalledPluginPackage[];
  readonly instances: readonly PluginInstance[];
  readonly activeInstanceIds: readonly string[];
  readonly marketplaces: readonly RegisteredMarketplace[];
  readonly errors: readonly PluginBrowserError[];
}

interface BrowserItemBase {
  readonly key: string;
  readonly name: string;
  readonly description: string;
}

export type PluginBrowserItem =
  | (BrowserItemBase & {
      readonly kind: "available-package";
      readonly package: AvailablePluginPackage;
      readonly installed: boolean;
    })
  | (BrowserItemBase & {
      readonly kind: "installed-package";
      readonly package: InstalledPluginPackage;
    })
  | (BrowserItemBase & {
      readonly kind: "marketplace";
      readonly marketplace: RegisteredMarketplace;
    })
  | (BrowserItemBase & {
      readonly kind: "error";
      readonly error: PluginBrowserError;
    });

export function isPackageInstalled(
  available: AvailablePluginPackage,
  installed: readonly InstalledPluginPackage[],
): boolean {
  return installed.some(
    ({ manifest }) =>
      manifest.pluginId === available.manifest.pluginId &&
      manifest.version === available.manifest.version,
  );
}

export function packageInstances(
  pluginId: string,
  version: string,
  data: Pick<PluginBrowserData, "instances">,
): PluginInstance[] {
  return data.instances.filter(
    (instance) =>
      instance.pluginId === pluginId && instance.packageVersion === version,
  );
}

function instanceDescription(
  pluginId: string,
  version: string,
  data: PluginBrowserData,
): string | undefined {
  const instances = packageInstances(pluginId, version, data);
  if (instances.length === 0) return undefined;
  const enabled = instances.filter((instance) => instance.enabled);
  const active = enabled.filter((instance) =>
    data.activeInstanceIds.includes(instance.pluginInstanceId),
  );
  if (enabled.length === 0) return "disabled in this session";
  if (active.length === enabled.length) {
    return `${active.length} active in this session`;
  }
  return `${active.length}/${enabled.length} active in this session`;
}

export function pluginBrowserItems(
  tab: PluginTab,
  data: PluginBrowserData,
  query = "",
): PluginBrowserItem[] {
  const items: PluginBrowserItem[] =
    tab === "discover"
      ? data.available.map((available) => {
          const installed = isPackageInstalled(available, data.installed);
          return {
            kind: "available-package",
            key: `available:${available.marketplace}:${available.manifest.pluginId}@${available.manifest.version}`,
            name: `${available.manifest.displayName ?? available.manifest.pluginId}${installed ? "  ✓ installed" : ""}`,
            description: [
              `${available.manifest.pluginId}@${available.manifest.version}`,
              available.marketplace,
              instanceDescription(
                available.manifest.pluginId,
                available.manifest.version,
                data,
              ),
              available.manifest.description,
            ]
              .filter(Boolean)
              .join(" · "),
            package: available,
            installed,
          };
        })
      : tab === "installed"
        ? data.installed.map((installed) => ({
            kind: "installed-package",
            key: `installed:${installed.manifest.pluginId}@${installed.manifest.version}`,
            name: installed.manifest.displayName ?? installed.manifest.pluginId,
            description: [
              `${installed.manifest.pluginId}@${installed.manifest.version}`,
              `from ${installed.provenance.marketplace}`,
              instanceDescription(
                installed.manifest.pluginId,
                installed.manifest.version,
                data,
              ),
              installed.manifest.description,
            ]
              .filter(Boolean)
              .join(" · "),
            package: installed,
          }))
        : tab === "marketplaces"
          ? data.marketplaces.map((marketplace) => ({
              kind: "marketplace",
              key: `marketplace:${marketplace.name}`,
              name: marketplace.name,
              description: [
                `${marketplace.manifest.plugins.length} plugin${marketplace.manifest.plugins.length === 1 ? "" : "s"}`,
                marketplace.manifest.description,
                marketplace.source.kind === "local"
                  ? marketplace.source.path
                  : marketplace.source.url,
              ]
                .filter(Boolean)
                .join(" · "),
              marketplace,
            }))
          : data.errors.map((error, index) => ({
              kind: "error",
              key: `error:${error.source}:${index}`,
              name: `Could not load ${error.source}`,
              description: error.message,
              error,
            }));
  const normalized = query.trim().toLowerCase();
  if (!normalized) return items;
  return items.filter(({ name, description }) =>
    `${name}\n${description}`.toLowerCase().includes(normalized),
  );
}

/** 保留上方会话历史；小终端优先保证管理面板仍可操作。 */
export function pluginPanelHeight(terminalHeight: number): number {
  const available = Math.max(1, terminalHeight - 2);
  return Math.min(Math.max(12, Math.floor(terminalHeight * 0.45)), available);
}
