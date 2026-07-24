import type { SelectRenderable, TabSelectRenderable } from "@opentui/core";
import { useKeyboard, useTerminalDimensions } from "@opentui/react";
import {
  Transcript,
  type ChatProtocol,
  type ChatViewState,
  type Theme,
} from "chat-tui";
import {
  useCallback,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";

import {
  MarketplaceRegistry,
  type AvailablePluginPackage,
  type InstalledPluginPackage,
  type RegisteredMarketplace,
} from "../../plugin/marketplace/index.ts";
import type { PluginInstance } from "../../plugin/instance.ts";
import { Manager } from "../../plugin/manager.ts";
import {
  isPackageInstalled,
  packageInstances,
  pluginBrowserItems,
  pluginPanelHeight,
  type PluginBrowserData,
  type PluginBrowserError,
  type PluginBrowserItem,
  type PluginTab,
} from "./model.ts";

const TABS: ReadonlyArray<{ name: string; description: string; value: PluginTab }> = [
  { name: "Discover", description: "Packages available from registered Marketplaces", value: "discover" },
  { name: "Installed", description: "Plugin Packages installed on this machine", value: "installed" },
  { name: "Marketplaces", description: "Registered Plugin catalogs", value: "marketplaces" },
  { name: "Errors", description: "Marketplace and Package loading errors", value: "errors" },
];

interface PluginScreenProps {
  protocol: ChatProtocol;
  registry: MarketplaceRegistry;
  manager: Manager;
  theme: Theme;
  onBack: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loadBrowserData(
  registry: MarketplaceRegistry,
  manager: Manager,
): PluginBrowserData {
  const errors: PluginBrowserError[] = [];
  let available: readonly AvailablePluginPackage[] = [];
  let installed: readonly InstalledPluginPackage[] = [];
  let marketplaces: readonly RegisteredMarketplace[] = [];
  const instances = manager.listInstances();
  const activeInstanceIds = instances
    .filter((instance) => manager.isInstanceActive(instance.pluginInstanceId))
    .map((instance) => instance.pluginInstanceId);
  try {
    available = registry.available();
  } catch (error) {
    errors.push({ source: "discover", message: errorMessage(error) });
  }
  try {
    installed = registry.installed();
  } catch (error) {
    errors.push({ source: "installed", message: errorMessage(error) });
  }
  try {
    marketplaces = registry.list();
  } catch (error) {
    errors.push({ source: "marketplaces", message: errorMessage(error) });
  }
  return {
    available,
    installed,
    instances,
    activeInstanceIds,
    marketplaces,
    errors,
  };
}

function useProtocolView(protocol: ChatProtocol): ChatViewState {
  return useSyncExternalStore(
    useCallback((onChange) => protocol.subscribe(onChange), [protocol]),
    () => protocol.getView(),
  );
}

export function PluginScreen(props: PluginScreenProps): ReactNode {
  const view = useProtocolView(props.protocol);
  const terminal = useTerminalDimensions();
  return (
    <box style={{ flexDirection: "column", flexGrow: 1 }}>
      <Transcript
        header={view.header}
        items={view.transcript}
        showThoughts={view.showThoughts}
        theme={props.theme}
      />
      <PluginPanel
        registry={props.registry}
        manager={props.manager}
        theme={props.theme}
        height={pluginPanelHeight(terminal.height)}
        onBack={props.onBack}
      />
    </box>
  );
}

interface PluginPanelProps {
  registry: MarketplaceRegistry;
  manager: Manager;
  theme: Theme;
  height: number;
  onBack: () => void;
}

interface PluginNotice {
  readonly text: string;
  readonly tone: "success" | "error";
}

function PluginPanel(props: PluginPanelProps): ReactNode {
  const [tab, setTab] = useState<PluginTab>("discover");
  const [query, setQuery] = useState("");
  const [data, setData] = useState<PluginBrowserData>(() =>
    loadBrowserData(props.registry, props.manager),
  );
  const [detail, setDetail] = useState<PluginBrowserItem | null>(null);
  const [notice, setNotice] = useState<PluginNotice>();
  const tabs = useRef<TabSelectRenderable | null>(null);
  const list = useRef<SelectRenderable | null>(null);
  const items = pluginBrowserItems(tab, data, query);

  const openSelected = useCallback(() => {
    const key = String(list.current?.getSelectedOption()?.value ?? "");
    const selected = items.find((item) => item.key === key);
    if (selected) {
      setNotice(undefined);
      setDetail(selected);
    }
  }, [items]);

  useKeyboard((key) => {
    if (key.name === "escape") {
      key.preventDefault();
      if (detail) setDetail(null);
      else props.onBack();
      return;
    }
    if (detail) return;
    if (
      key.name === "tab" ||
      (!query && (key.name === "left" || key.name === "right"))
    ) {
      key.preventDefault();
      if (key.name === "left" || key.shift) tabs.current?.moveLeft();
      else tabs.current?.moveRight();
      return;
    }
    if (key.name === "up" || key.name === "down") {
      key.preventDefault();
      if (key.name === "up") list.current?.moveUp();
      else list.current?.moveDown();
      return;
    }
    if (key.name === "return" || key.name === "linefeed" || key.name === "kpenter") {
      key.preventDefault();
      openSelected();
    }
  });

  const chooseTab = (next: PluginTab) => {
    setTab(next);
    setQuery("");
    setDetail(null);
    setNotice(undefined);
  };

  return (
    <box
      border={["top"]}
      borderColor={props.theme.accent}
      style={{
        height: props.height,
        flexShrink: 0,
        flexDirection: "column",
        paddingLeft: 1,
        paddingRight: 1,
        backgroundColor: props.theme.overlayBackground,
      }}
    >
      <box style={{ height: 1, flexShrink: 0, flexDirection: "row" }}>
        <text fg={props.theme.accent} style={{ width: 12, flexShrink: 0 }}>
          Plugins
        </text>
        <tab-select
          ref={tabs}
          focused={false}
          options={[...TABS]}
          tabWidth={16}
          showDescription={false}
          showUnderline={false}
          showScrollArrows={false}
          wrapSelection
          textColor={props.theme.dim}
          selectedTextColor={props.theme.overlayBackground}
          selectedBackgroundColor={props.theme.accent}
          style={{ flexGrow: 1 }}
          onChange={(_index, option) => {
            if (option) chooseTab(option.value as PluginTab);
          }}
        />
      </box>

      {detail ? (
        <PluginDetail
          item={detail}
          data={data}
          registry={props.registry}
          manager={props.manager}
          theme={props.theme}
          notice={notice}
          onChanged={(nextNotice) => {
            setData(loadBrowserData(props.registry, props.manager));
            setNotice(nextNotice);
          }}
          onBack={() => {
            setDetail(null);
            setNotice(undefined);
          }}
        />
      ) : (
        <>
          <box
            border
            borderColor={props.theme.border}
            style={{ height: 3, flexShrink: 0, marginTop: 1 }}
          >
            <input
              focused
              value={query}
              width="100%"
              placeholder={`Search ${tab}`}
              onInput={setQuery}
              onSubmit={openSelected}
            />
          </box>
          {items.length > 0 ? (
            <select
              key={`${tab}:${query}`}
              ref={list}
              focused={false}
              style={{ flexGrow: 1, marginTop: 1 }}
              options={items.map((item) => ({
                name: item.name,
                description: item.description,
                value: item.key,
              }))}
              textColor="#ffffff"
              descriptionColor={props.theme.dim}
              selectedTextColor={props.theme.accent}
              selectedDescriptionColor="#ffffff"
              selectedBackgroundColor={props.theme.border}
              showScrollIndicator
              onSelect={openSelected}
            />
          ) : (
            <text fg={props.theme.dim} style={{ flexGrow: 1, marginTop: 1 }}>
              {emptyMessage(tab, query)}
            </text>
          )}
          <text fg={props.theme.dim}>
            {"type to search · ↑↓ select · enter view · ←→/tab switch section · esc back"}
          </text>
        </>
      )}
    </box>
  );
}

interface PluginDetailProps {
  item: PluginBrowserItem;
  data: PluginBrowserData;
  registry: MarketplaceRegistry;
  manager: Manager;
  theme: Theme;
  notice?: PluginNotice;
  onChanged: (notice: PluginNotice) => void;
  onBack: () => void;
}

function PluginDetail(props: PluginDetailProps): ReactNode {
  const [acting, setActing] = useState(false);
  const manifest =
    props.item.kind === "available-package" || props.item.kind === "installed-package"
      ? props.item.package.manifest
      : undefined;
  const instances = manifest
    ? packageInstances(manifest.pluginId, manifest.version, props.data)
    : [];
  const installed =
    props.item.kind === "installed-package" ||
    (props.item.kind === "available-package" &&
      isPackageInstalled(props.item.package, props.data.installed));
  const canInstall =
    props.item.kind === "available-package" &&
    !installed;
  const instanceAction =
    installed && instances.length === 0
      ? {
          name: "Enable in this session",
          description: "Create and activate one Plugin Instance",
          value: "enable",
        }
      : instances.length === 1
        ? instances[0]!.enabled
          ? {
              name: "Disable in this session",
              description: "Deactivate this Plugin Instance",
              value: "disable",
            }
          : {
              name: "Enable in this session",
              description: "Activate this Plugin Instance",
              value: "enable",
            }
        : undefined;
  const actions = [
    ...(canInstall
      ? [{ name: "Install package", description: "Copy this immutable Package into Baton", value: "install" }]
      : []),
    ...(instanceAction ? [instanceAction] : []),
    { name: "Back to plugin list", description: "Return to the current section", value: "back" },
  ];

  const runAction = async (value: string): Promise<void> => {
    if (acting) return;
    if (value === "back") {
      props.onBack();
      return;
    }
    if (!manifest) return;
    setActing(true);
    try {
      if (value === "install" && props.item.kind === "available-package") {
        const result = props.registry.install(props.item.package.manifest.pluginId, {
          marketplace: props.item.package.marketplace,
        });
        props.onChanged({
          text: result.alreadyInstalled
            ? `${result.manifest.pluginId}@${result.manifest.version} was already installed`
            : `Installed ${result.manifest.pluginId}@${result.manifest.version}`,
          tone: "success",
        });
        return;
      }
      if (value === "enable") {
        const instance =
          instances.length === 0
            ? await props.manager.createInstance({
                pluginId: manifest.pluginId,
                packageVersion: manifest.version,
              })
            : await props.manager.setInstanceEnabled(
                instances[0]!.pluginInstanceId,
                true,
              );
        props.onChanged({
          text: `Enabled ${manifest.pluginId}@${manifest.version} as ${instance.pluginInstanceId}`,
          tone: "success",
        });
        return;
      }
      if (value === "disable" && instances.length === 1) {
        await props.manager.setInstanceEnabled(
          instances[0]!.pluginInstanceId,
          false,
        );
        props.onChanged({
          text: `Disabled ${manifest.pluginId}@${manifest.version}`,
          tone: "success",
        });
      }
    } catch (error) {
      props.onChanged({
        text: `${value === "install" ? "Install" : "Plugin action"} failed: ${errorMessage(error)}`,
        tone: "error",
      });
    } finally {
      setActing(false);
    }
  };

  return (
    <box style={{ flexGrow: 1, flexDirection: "column", marginTop: 1 }}>
      <scrollbox style={{ flexGrow: 1 }} focused={false}>
        {detailContent(
          props.item,
          instances,
          props.data.activeInstanceIds,
          props.theme,
        )}
      </scrollbox>
      {props.notice ? (
        <text
          fg={props.notice.tone === "success" ? props.theme.success : props.theme.error}
          style={{ flexShrink: 0 }}
        >
          {props.notice.text}
        </text>
      ) : null}
      <select
        focused
        showDescription={false}
        style={{ height: actions.length, flexShrink: 0, marginTop: 1 }}
        options={actions}
        selectedTextColor={props.theme.accent}
        selectedBackgroundColor={props.theme.border}
        onSelect={(_index, option) => {
          if (option) void runAction(String(option.value));
        }}
      />
      <text fg={props.theme.dim}>
        {acting ? "working…" : "↑↓ select · enter action · esc back"}
      </text>
    </box>
  );
}

function instanceDetail(
  instance: PluginInstance,
  activeInstanceIds: readonly string[],
): string {
  const status = !instance.enabled
    ? "disabled"
    : activeInstanceIds.includes(instance.pluginInstanceId)
      ? "enabled · active"
      : "enabled · inactive";
  return `${instance.pluginInstanceId} (${status})`;
}

function detailContent(
  item: PluginBrowserItem,
  instances: readonly PluginInstance[],
  activeInstanceIds: readonly string[],
  theme: Theme,
): ReactNode {
  if (item.kind === "available-package" || item.kind === "installed-package") {
    const manifest = item.package.manifest;
    const origin =
      item.kind === "available-package"
        ? item.package.marketplace
        : item.package.provenance.marketplace;
    return (
      <text selectable>
        <strong>{manifest.displayName ?? manifest.pluginId}</strong>
        {`\nPlugin: ${manifest.pluginId}`}
        {`\nVersion: ${manifest.version}`}
        {`\nMarketplace: ${origin}`}
        {manifest.description ? `\n\n${manifest.description}` : ""}
        {instances.length === 0
          ? "\n\nSession: not enabled"
          : `\n\nInstance${instances.length === 1 ? "" : "s"}:\n${instances
              .map((instance) => instanceDetail(instance, activeInstanceIds))
              .join("\n")}`}
        <span fg={theme.dim}>{`\n\nPackage: ${item.package.packageDir}`}</span>
      </text>
    );
  }
  if (item.kind === "marketplace") {
    const source =
      item.marketplace.source.kind === "local"
        ? item.marketplace.source.path
        : `${item.marketplace.source.url}@${item.marketplace.source.revision}`;
    return (
      <text selectable>
        <strong>{item.marketplace.name}</strong>
        {item.marketplace.manifest.description
          ? `\n\n${item.marketplace.manifest.description}`
          : ""}
        {`\n\nPlugins: ${item.marketplace.manifest.plugins.length}`}
        <span fg={theme.dim}>{`\nSource: ${source}`}</span>
      </text>
    );
  }
  return (
    <text selectable>
      <strong>{`Could not load ${item.error.source}`}</strong>
      <span fg={theme.error}>{`\n\n${item.error.message}`}</span>
    </text>
  );
}

function emptyMessage(tab: PluginTab, query: string): string {
  if (query.trim()) return "No matching plugins";
  if (tab === "discover") {
    return "No plugins available. Add a Marketplace with: baton plugins marketplace add <source>";
  }
  if (tab === "installed") return "No Plugin Packages installed";
  if (tab === "marketplaces") {
    return "No Marketplaces registered. Add one with: baton plugins marketplace add <source>";
  }
  return "No Marketplace or Package errors";
}
