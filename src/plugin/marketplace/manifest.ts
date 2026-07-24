import { existsSync, readFileSync, realpathSync } from "node:fs";
import { isAbsolute, relative, resolve, sep } from "node:path";

export const MARKETPLACE_MANIFEST_PATH = ".baton-plugin/marketplace.json";
export const PLUGIN_MANIFEST_PATH = ".baton-plugin/plugin.json";

export interface MarketplaceOwner {
  readonly name: string;
  readonly url?: string;
}

export interface MarketplacePluginEntry {
  readonly pluginId: string;
  /** Marketplace 根目录内的相对 Package 路径。 */
  readonly source: string;
}

export interface MarketplaceManifest {
  readonly name: string;
  readonly owner?: MarketplaceOwner;
  readonly description?: string;
  readonly plugins: readonly MarketplacePluginEntry[];
}

export interface PluginManifest {
  readonly manifestVersion: 1;
  readonly pluginId: string;
  readonly version: string;
  /** Package 根目录内的进程内激活模块。模块必须 default export PluginPackage。 */
  readonly entry: string;
  readonly displayName?: string;
  readonly description?: string;
}

function jsonObject(name: string, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(name: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) {
    throw new Error(`${name} must not be empty`);
  }
  return value;
}

function optionalString(name: string, value: unknown): string | undefined {
  if (value === undefined) return undefined;
  return nonEmptyString(name, value);
}

function stablePathSegment(name: string, value: unknown): string {
  const text = nonEmptyString(name, value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(text) || text === "." || text === "..") {
    throw new Error(`${name} must be a stable identifier without path separators`);
  }
  return text;
}

export function validatePluginId(value: unknown): string {
  const pluginId = nonEmptyString("pluginId", value);
  if (!/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(pluginId)) {
    throw new Error("pluginId must be a stable owner-namespaced identifier");
  }
  return pluginId;
}

export function validatePackageVersion(value: unknown): string {
  return stablePathSegment("plugin version", value);
}

function relativePath(name: string, value: unknown): string {
  const path = nonEmptyString(name, value);
  if (isAbsolute(path)) throw new Error(`${name} must be relative`);
  return path;
}

function parseOwner(value: unknown): MarketplaceOwner | undefined {
  if (value === undefined) return undefined;
  const owner = jsonObject("marketplace owner", value);
  return Object.freeze({
    name: nonEmptyString("marketplace owner.name", owner.name),
    url: optionalString("marketplace owner.url", owner.url),
  });
}

export function parseMarketplaceManifest(value: unknown): MarketplaceManifest {
  const manifest = jsonObject("marketplace manifest", value);
  if (!Array.isArray(manifest.plugins)) {
    throw new Error("marketplace manifest plugins must be an array");
  }
  const seen = new Set<string>();
  const plugins = manifest.plugins.map((value, index): MarketplacePluginEntry => {
    const entry = jsonObject(`marketplace plugin ${index}`, value);
    const pluginId = validatePluginId(entry.pluginId);
    if (seen.has(pluginId)) {
      throw new Error(`marketplace contains duplicate pluginId: ${pluginId}`);
    }
    seen.add(pluginId);
    return Object.freeze({
      pluginId,
      source: relativePath(`marketplace plugin ${index}.source`, entry.source),
    });
  });
  return Object.freeze({
    name: stablePathSegment("marketplace name", manifest.name),
    owner: parseOwner(manifest.owner),
    description: optionalString("marketplace description", manifest.description),
    plugins: Object.freeze(plugins),
  });
}

export function parsePluginManifest(value: unknown): PluginManifest {
  const manifest = jsonObject("plugin manifest", value);
  if (manifest.manifestVersion !== 1) {
    throw new Error("plugin manifest manifestVersion must be 1");
  }
  return Object.freeze({
    manifestVersion: 1,
    pluginId: validatePluginId(manifest.pluginId),
    version: validatePackageVersion(manifest.version),
    entry: relativePath("plugin manifest entry", manifest.entry),
    displayName: optionalString("plugin manifest displayName", manifest.displayName),
    description: optionalString("plugin manifest description", manifest.description),
  });
}

function readJson(path: string, label: string): unknown {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`could not read ${label} at ${path}: ${detail}`);
  }
  return value;
}

export function readMarketplaceManifest(rootDir: string): MarketplaceManifest {
  const path = resolveWithin(rootDir, MARKETPLACE_MANIFEST_PATH, "marketplace manifest");
  if (!existsSync(path)) throw new Error(`marketplace manifest not found: ${path}`);
  return parseMarketplaceManifest(readJson(path, "marketplace manifest"));
}

export function readPluginManifest(packageDir: string): PluginManifest {
  const path = resolveWithin(packageDir, PLUGIN_MANIFEST_PATH, "plugin manifest");
  if (!existsSync(path)) throw new Error(`plugin manifest not found: ${path}`);
  return parsePluginManifest(readJson(path, "plugin manifest"));
}

/**
 * Manifest 路径只能指向自身根目录内的文件。realpath 校验同时封住 `..` 和逃逸 symlink。
 */
export function resolveExistingWithin(rootDir: string, path: string, label: string): string {
  const resolved = resolveWithin(rootDir, path, label);
  if (!existsSync(resolved)) throw new Error(`${label} not found: ${resolved}`);
  const canonicalRoot = realpathSync(rootDir);
  const canonical = realpathSync(resolved);
  const fromRoot = relative(canonicalRoot, canonical);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`${label} must stay inside ${canonicalRoot}`);
  }
  return canonical;
}

function resolveWithin(rootDir: string, path: string, label: string): string {
  if (isAbsolute(path)) throw new Error(`${label} path must be relative`);
  const root = resolve(rootDir);
  const resolved = resolve(root, path);
  const fromRoot = relative(root, resolved);
  if (fromRoot === ".." || fromRoot.startsWith(`..${sep}`) || isAbsolute(fromRoot)) {
    throw new Error(`${label} must stay inside ${root}`);
  }
  return resolved;
}
