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
import {
  isPackageInstalled,
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
  theme: Theme;
  onBack: () => void;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function loadBrowserData(registry: MarketplaceRegistry): PluginBrowserData {
  const errors: PluginBrowserError[] = [];
  let available: readonly AvailablePluginPackage[] = [];
  let installed: readonly InstalledPluginPackage[] = [];
  let marketplaces: readonly RegisteredMarketplace[] = [];
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
  return { available, installed, marketplaces, errors };
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
        theme={props.theme}
        height={pluginPanelHeight(terminal.height)}
        onBack={props.onBack}
      />
    </box>
  );
}

interface PluginPanelProps {
  registry: MarketplaceRegistry;
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
  const [data, setData] = useState<PluginBrowserData>(() => loadBrowserData(props.registry));
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
    if (key.name === "tab") {
      key.preventDefault();
      if (key.shift) tabs.current?.moveLeft();
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
          theme={props.theme}
          notice={notice}
          onInstalled={(nextNotice) => {
            setData(loadBrowserData(props.registry));
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
            {"type to search · ↑↓ select · enter view · tab switch section · esc back"}
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
  theme: Theme;
  notice?: PluginNotice;
  onInstalled: (notice: PluginNotice) => void;
  onBack: () => void;
}

function PluginDetail(props: PluginDetailProps): ReactNode {
  const canInstall =
    props.item.kind === "available-package" &&
    !isPackageInstalled(props.item.package, props.data.installed);
  const actions = [
    ...(canInstall
      ? [{ name: "Install package", description: "Copy this immutable Package into Baton", value: "install" }]
      : []),
    { name: "Back to plugin list", description: "Return to the current section", value: "back" },
  ];

  return (
    <box style={{ flexGrow: 1, flexDirection: "column", marginTop: 1 }}>
      <scrollbox style={{ flexGrow: 1 }} focused={false}>
        {detailContent(props.item, props.theme)}
        {props.notice ? (
          <text fg={props.notice.tone === "success" ? props.theme.success : props.theme.error}>
            {`\n${props.notice.text}`}
          </text>
        ) : null}
      </scrollbox>
      <select
        focused
        showDescription={false}
        style={{ height: actions.length, flexShrink: 0, marginTop: 1 }}
        options={actions}
        selectedTextColor={props.theme.accent}
        selectedBackgroundColor={props.theme.border}
        onSelect={(_index, option) => {
          if (!option) return;
          if (option.value === "back") {
            props.onBack();
            return;
          }
          if (props.item.kind !== "available-package") return;
          try {
            const result = props.registry.install(props.item.package.manifest.pluginId, {
              marketplace: props.item.package.marketplace,
            });
            props.onInstalled({
              text: result.alreadyInstalled
                ? `${result.manifest.pluginId}@${result.manifest.version} was already installed`
                : `Installed ${result.manifest.pluginId}@${result.manifest.version}`,
              tone: "success",
            });
          } catch (error) {
            props.onInstalled({ text: `Install failed: ${errorMessage(error)}`, tone: "error" });
          }
        }}
      />
      <text fg={props.theme.dim}>{"↑↓ select · enter action · esc back"}</text>
    </box>
  );
}

function detailContent(item: PluginBrowserItem, theme: Theme): ReactNode {
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
