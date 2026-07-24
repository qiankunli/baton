import { describe, expect, test } from "bun:test";

import type {
  AvailablePluginPackage,
  InstalledPluginPackage,
  RegisteredMarketplace,
} from "../src/plugin/marketplace/index.ts";
import {
  pluginBrowserItems,
  pluginPanelHeight,
  type PluginBrowserData,
} from "../src/tui/plugins/model.ts";

const available: AvailablePluginPackage = {
  marketplace: "reqloop",
  packageDir: "/marketplace/requirement-loop",
  manifest: {
    manifestVersion: 1,
    pluginId: "qiankun/requirement-loop",
    version: "0.2.0",
    entry: "./src/index.ts",
    displayName: "Requirement Loop",
    description: "Requirement workflow",
  },
};

const installed: InstalledPluginPackage = {
  packageDir: "/baton/plugins/packages/qiankun%2Frequirement-loop/0.2.0",
  manifest: available.manifest,
  provenance: {
    marketplace: "reqloop",
    installedAt: "2026-07-24T10:00:00.000Z",
    marketplaceSource: { kind: "local", path: "/marketplace" },
  },
};

const marketplace: RegisteredMarketplace = {
  name: "reqloop",
  rootDir: "/marketplace",
  source: { kind: "local", path: "/marketplace" },
  addedAt: "2026-07-24T09:00:00.000Z",
  manifest: {
    name: "reqloop",
    description: "Requirement plugins",
    plugins: [{ pluginId: available.manifest.pluginId, source: "./requirement-loop" }],
  },
};

function data(overrides: Partial<PluginBrowserData> = {}): PluginBrowserData {
  return {
    available: [available],
    installed: [],
    marketplaces: [marketplace],
    errors: [],
    ...overrides,
  };
}

describe("Plugin manager projection", () => {
  test("groups Package, Marketplace, and load errors behind one browser item kind", () => {
    expect(pluginBrowserItems("discover", data())).toMatchObject([
      {
        kind: "available-package",
        name: "Requirement Loop",
        installed: false,
      },
    ]);
    expect(pluginBrowserItems("installed", data({ installed: [installed] }))[0]).toMatchObject({
      kind: "installed-package",
      name: "Requirement Loop",
    });
    expect(pluginBrowserItems("marketplaces", data())[0]).toMatchObject({
      kind: "marketplace",
      name: "reqloop",
    });
    expect(
      pluginBrowserItems(
        "errors",
        data({ errors: [{ source: "discover", message: "manifest is invalid" }] }),
      )[0],
    ).toMatchObject({ kind: "error", name: "Could not load discover" });
  });

  test("marks exact installed versions and searches across identity and description", () => {
    const rows = pluginBrowserItems("discover", data({ installed: [installed] }));
    expect(rows[0]).toMatchObject({ installed: true, name: "Requirement Loop  ✓ installed" });
    expect(pluginBrowserItems("discover", data(), "QIANKUN/REQUIREMENT")).toHaveLength(1);
    expect(pluginBrowserItems("discover", data(), "missing")).toHaveLength(0);
  });

  test("keeps a usable bottom panel while leaving transcript rows visible", () => {
    expect(pluginPanelHeight(60)).toBe(27);
    expect(pluginPanelHeight(24)).toBe(12);
    expect(pluginPanelHeight(10)).toBe(8);
  });
});
