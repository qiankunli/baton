import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { homedir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { withFileLock } from "../../store/file-lock.ts";
import type { PluginPackage } from "../package.ts";
import { validatePluginPackage } from "../package.ts";
import {
  type MarketplaceManifest,
  type MarketplacePluginEntry,
  type PluginManifest,
  readMarketplaceManifest,
  readPluginManifest,
  resolveExistingWithin,
  validatePackageVersion,
  validatePluginId,
} from "./manifest.ts";

export type MarketplaceSource =
  | {
      readonly kind: "local";
      readonly path: string;
    }
  | {
      readonly kind: "git";
      readonly url: string;
      readonly ref?: string;
      readonly revision: string;
    };

export interface MarketplaceRegistration {
  readonly name: string;
  readonly source: MarketplaceSource;
  readonly addedAt: string;
}

export interface RegisteredMarketplace extends MarketplaceRegistration {
  readonly rootDir: string;
  readonly manifest: MarketplaceManifest;
}

export interface AvailablePluginPackage {
  readonly marketplace: string;
  readonly packageDir: string;
  readonly manifest: PluginManifest;
}

export interface PackageProvenance {
  readonly marketplace: string;
  readonly installedAt: string;
  readonly marketplaceSource: MarketplaceSource;
}

export interface InstalledPluginPackage {
  readonly packageDir: string;
  readonly manifest: PluginManifest;
  readonly provenance: PackageProvenance;
}

export interface InstallPluginResult extends InstalledPluginPackage {
  readonly alreadyInstalled: boolean;
}

export interface MarketplaceRegistryOptions {
  rootDir?: string;
  cwd?: string;
  now?: () => Date;
  gitTimeoutMs?: number;
}

interface RegistryFile {
  version: 1;
  marketplaces: MarketplaceRegistration[];
}

const EMPTY_REGISTRY: RegistryFile = {
  version: 1,
  marketplaces: [],
};

const INSTALL_RECEIPT_PATH = ".baton-plugin/install.json";

function jsonObject(name: string, value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`${name} must be a JSON object`);
  }
  return value as Record<string, unknown>;
}

function nonEmptyString(name: string, value: unknown): string {
  if (typeof value !== "string" || !value.trim()) throw new Error(`${name} must not be empty`);
  return value;
}

function isoTimestamp(name: string, value: unknown): string {
  const text = nonEmptyString(name, value);
  if (Number.isNaN(Date.parse(text))) throw new Error(`${name} must be an ISO timestamp`);
  return text;
}

function parseSource(value: unknown): MarketplaceSource {
  const source = jsonObject("marketplace source", value);
  if (source.kind === "local") {
    return Object.freeze({
      kind: "local",
      path: nonEmptyString("marketplace source.path", source.path),
    });
  }
  if (source.kind === "git") {
    const ref =
      source.ref === undefined ? undefined : nonEmptyString("marketplace source.ref", source.ref);
    return Object.freeze({
      kind: "git",
      url: nonEmptyString("marketplace source.url", source.url),
      ref,
      revision: nonEmptyString("marketplace source.revision", source.revision),
    });
  }
  throw new Error("marketplace source.kind must be local or git");
}

function parseRegistration(value: unknown): MarketplaceRegistration {
  const registration = jsonObject("marketplace registration", value);
  const name = nonEmptyString("marketplace registration.name", registration.name);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) {
    throw new Error("marketplace registration.name must be a stable identifier");
  }
  return Object.freeze({
    name,
    source: parseSource(registration.source),
    addedAt: isoTimestamp("marketplace registration.addedAt", registration.addedAt),
  });
}

function parseRegistry(value: unknown): RegistryFile {
  const registry = jsonObject("marketplace registry", value);
  if (registry.version !== 1) throw new Error("marketplace registry version must be 1");
  if (!Array.isArray(registry.marketplaces)) {
    throw new Error("marketplace registry marketplaces must be an array");
  }
  const marketplaces = registry.marketplaces.map(parseRegistration);
  const names = new Set<string>();
  for (const marketplace of marketplaces) {
    if (names.has(marketplace.name)) {
      throw new Error(`marketplace registry contains duplicate name: ${marketplace.name}`);
    }
    names.add(marketplace.name);
  }
  return { version: 1, marketplaces };
}

function writeJsonAtomic(path: string, value: unknown): void {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.${Date.now()}.${Math.random()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
    renameSync(temporary, path);
  } finally {
    rmSync(temporary, { force: true });
  }
}

function sameSource(left: MarketplaceSource, right: MarketplaceSource): boolean {
  if (left.kind !== right.kind) return false;
  if (left.kind === "local" && right.kind === "local") return left.path === right.path;
  return (
    left.kind === "git" &&
    right.kind === "git" &&
    left.url === right.url &&
    left.ref === right.ref
  );
}

function packageDirectoryName(pluginId: string): string {
  return encodeURIComponent(pluginId);
}

function readJson(path: string, label: string): unknown {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as unknown;
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(`could not read ${label} at ${path}: ${detail}`);
  }
}

function parseProvenance(value: unknown): PackageProvenance {
  const provenance = jsonObject("package provenance", value);
  return Object.freeze({
    marketplace: nonEmptyString("package provenance.marketplace", provenance.marketplace),
    installedAt: isoTimestamp("package provenance.installedAt", provenance.installedAt),
    marketplaceSource: parseSource(provenance.marketplaceSource),
  });
}

function assertIdentity(
  catalogEntry: MarketplacePluginEntry,
  manifest: PluginManifest,
): void {
  if (catalogEntry.pluginId !== manifest.pluginId) {
    throw new Error(
      `marketplace pluginId ${catalogEntry.pluginId} does not match Package manifest ${manifest.pluginId}`,
    );
  }
}

async function runGit(
  args: readonly string[],
  options: { cwd?: string; timeoutMs: number },
): Promise<string> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), options.timeoutMs);
  try {
    const process = Bun.spawn(["git", ...args], {
      cwd: options.cwd,
      stdout: "pipe",
      stderr: "pipe",
      signal: controller.signal,
    });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(process.stdout).text(),
      new Response(process.stderr).text(),
      process.exited,
    ]);
    if (exitCode !== 0) {
      const detail = stderr.trim() || stdout.trim() || `exit code ${exitCode}`;
      throw new Error(`git ${args[0] ?? ""} failed: ${detail}`);
    }
    return stdout.trim();
  } catch (error) {
    if (controller.signal.aborted) {
      throw new Error(`git command timed out after ${options.timeoutMs}ms`);
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

/**
 * Marketplace 只负责把目录源解析为不可变 Package；Instance 和 Binding 仍归 session runtime。
 */
export class MarketplaceRegistry {
  readonly rootDir: string;
  private readonly cwd: string;
  private readonly now: () => Date;
  private readonly gitTimeoutMs: number;

  constructor(options: MarketplaceRegistryOptions = {}) {
    this.rootDir = options.rootDir ?? join(homedir(), ".baton");
    this.cwd = options.cwd ?? process.cwd();
    this.now = options.now ?? (() => new Date());
    this.gitTimeoutMs = options.gitTimeoutMs ?? 60_000;
    if (!Number.isSafeInteger(this.gitTimeoutMs) || this.gitTimeoutMs < 1) {
      throw new Error("gitTimeoutMs must be a positive integer");
    }
  }

  async add(source: string, options: { ref?: string } = {}): Promise<RegisteredMarketplace> {
    if (!source.trim()) throw new Error("marketplace source must not be empty");
    const localPath = resolve(this.cwd, source);
    if (existsSync(localPath)) {
      if (options.ref) throw new Error("--ref is only valid for Git marketplaces");
      return this.addLocal(realpathSync(localPath));
    }
    return await this.addGit(source, options.ref);
  }

  list(): RegisteredMarketplace[] {
    return this.readRegistry().marketplaces.map((registration) => {
      const rootDir = this.marketplaceRoot(registration);
      const manifest = readMarketplaceManifest(rootDir);
      if (manifest.name !== registration.name) {
        throw new Error(
          `registered marketplace ${registration.name} now declares name ${manifest.name}`,
        );
      }
      return Object.freeze({ ...registration, rootDir, manifest });
    });
  }

  available(options: { marketplace?: string } = {}): AvailablePluginPackage[] {
    const packages: AvailablePluginPackage[] = [];
    const marketplaces = this.list();
    for (const marketplace of marketplaces) {
      if (options.marketplace && marketplace.name !== options.marketplace) continue;
      for (const entry of marketplace.manifest.plugins) {
        const packageDir = resolveExistingWithin(
          marketplace.rootDir,
          entry.source,
          `Package ${entry.pluginId}`,
        );
        const manifest = readPluginManifest(packageDir);
        assertIdentity(entry, manifest);
        resolveExistingWithin(packageDir, manifest.entry, `Plugin entry ${manifest.pluginId}`);
        packages.push(Object.freeze({
          marketplace: marketplace.name,
          packageDir,
          manifest,
        }));
      }
    }
    if (options.marketplace && !marketplaces.some(({ name }) => name === options.marketplace)) {
      throw new Error(`marketplace not registered: ${options.marketplace}`);
    }
    return packages.sort((left, right) =>
      `${left.manifest.pluginId}@${left.manifest.version}`.localeCompare(
        `${right.manifest.pluginId}@${right.manifest.version}`,
      ),
    );
  }

  install(
    pluginId: string,
    options: { marketplace?: string } = {},
  ): InstallPluginResult {
    const matches = this.available({ marketplace: options.marketplace }).filter(
      ({ manifest }) => manifest.pluginId === pluginId,
    );
    if (matches.length === 0) {
      const scope = options.marketplace ? ` in marketplace ${options.marketplace}` : "";
      throw new Error(`Plugin not found${scope}: ${pluginId}`);
    }
    if (matches.length > 1) {
      throw new Error(
        `Plugin ${pluginId} is available from multiple marketplaces; choose one with --marketplace`,
      );
    }
    return this.installAvailable(matches[0] as AvailablePluginPackage);
  }

  installed(): InstalledPluginPackage[] {
    const root = this.packagesDir();
    if (!existsSync(root)) return [];
    const installed: InstalledPluginPackage[] = [];
    for (const pluginEntry of readdirSync(root, { withFileTypes: true })) {
      if (!pluginEntry.isDirectory()) continue;
      for (const versionEntry of readdirSync(join(root, pluginEntry.name), {
        withFileTypes: true,
      })) {
        if (!versionEntry.isDirectory()) continue;
        installed.push(this.readInstalled(join(root, pluginEntry.name, versionEntry.name)));
      }
    }
    return installed.sort((left, right) =>
      `${left.manifest.pluginId}@${left.manifest.version}`.localeCompare(
        `${right.manifest.pluginId}@${right.manifest.version}`,
      ),
    );
  }

  async load(pluginId: string, version: string): Promise<PluginPackage> {
    const installed = this.readInstalled(this.packageDir(pluginId, version));
    const entry = resolveExistingWithin(
      installed.packageDir,
      installed.manifest.entry,
      `Plugin entry ${pluginId}`,
    );
    const module = await import(pathToFileURL(entry).href) as { default?: unknown };
    const plugin = module.default as PluginPackage | undefined;
    if (!plugin) {
      throw new Error(`Plugin entry must default export a PluginPackage: ${entry}`);
    }
    validatePluginPackage(plugin);
    if (
      plugin.pluginId !== installed.manifest.pluginId ||
      plugin.version !== installed.manifest.version
    ) {
      throw new Error(
        `loaded Package identity ${plugin.pluginId}@${plugin.version} does not match manifest ${installed.manifest.pluginId}@${installed.manifest.version}`,
      );
    }
    return plugin;
  }

  private addLocal(rootDir: string): RegisteredMarketplace {
    const manifest = readMarketplaceManifest(rootDir);
    const registration: MarketplaceRegistration = Object.freeze({
      name: manifest.name,
      source: Object.freeze({ kind: "local", path: rootDir }),
      addedAt: this.timestamp(),
    });
    const stored = this.storeRegistration(registration);
    return Object.freeze({ ...stored, rootDir, manifest });
  }

  private async addGit(url: string, ref?: string): Promise<RegisteredMarketplace> {
    const marketplaceDir = this.marketplacesDir();
    mkdirSync(marketplaceDir, { recursive: true });
    const temporary = mkdtempSync(join(marketplaceDir, ".add-"));
    const checkout = join(temporary, "checkout");
    try {
      await runGit(["clone", "--quiet", url, checkout], { timeoutMs: this.gitTimeoutMs });
      if (ref) {
        await runGit(["checkout", "--quiet", "--detach", ref], {
          cwd: checkout,
          timeoutMs: this.gitTimeoutMs,
        });
      }
      const revision = await runGit(["rev-parse", "HEAD"], {
        cwd: checkout,
        timeoutMs: this.gitTimeoutMs,
      });
      const manifest = readMarketplaceManifest(checkout);
      const destination = join(marketplaceDir, manifest.name);
      const registration: MarketplaceRegistration = Object.freeze({
        name: manifest.name,
        source: Object.freeze({ kind: "git", url, ref, revision }),
        addedAt: this.timestamp(),
      });
      const stored = withFileLock(this.registryPath(), () => {
        const registry = this.readRegistry();
        const existing = registry.marketplaces.find(({ name }) => name === registration.name);
        if (existing) {
          if (sameSource(existing.source, registration.source)) return existing;
          throw new Error(`marketplace already registered: ${registration.name}`);
        }
        if (existsSync(destination)) {
          throw new Error(`marketplace checkout already exists: ${destination}`);
        }
        renameSync(checkout, destination);
        try {
          writeJsonAtomic(this.registryPath(), {
            version: 1,
            marketplaces: [...registry.marketplaces, registration],
          });
        } catch (error) {
          rmSync(destination, { recursive: true, force: true });
          throw error;
        }
        return registration;
      });
      return Object.freeze({
        ...stored,
        rootDir: this.marketplaceRoot(stored),
        manifest: readMarketplaceManifest(this.marketplaceRoot(stored)),
      });
    } finally {
      rmSync(temporary, { recursive: true, force: true });
    }
  }

  private storeRegistration(
    registration: MarketplaceRegistration,
  ): MarketplaceRegistration {
    return withFileLock(this.registryPath(), () => {
      const registry = this.readRegistry();
      const existing = registry.marketplaces.find(({ name }) => name === registration.name);
      if (existing) {
        if (sameSource(existing.source, registration.source)) return existing;
        throw new Error(`marketplace already registered: ${registration.name}`);
      }
      writeJsonAtomic(this.registryPath(), {
        version: 1,
        marketplaces: [...registry.marketplaces, registration],
      });
      return registration;
    });
  }

  private installAvailable(available: AvailablePluginPackage): InstallPluginResult {
    const marketplace = this.list().find(({ name }) => name === available.marketplace);
    if (!marketplace) throw new Error(`marketplace not registered: ${available.marketplace}`);
    const target = this.packageDir(
      available.manifest.pluginId,
      available.manifest.version,
    );
    return withFileLock(target, () => {
      if (existsSync(target)) {
        return Object.freeze({
          ...this.readInstalled(target),
          alreadyInstalled: true,
        });
      }
      mkdirSync(dirname(target), { recursive: true });
      const temporary = `${target}.${process.pid}.${Date.now()}.${Math.random()}.tmp`;
      const provenance: PackageProvenance = Object.freeze({
        marketplace: marketplace.name,
        installedAt: this.timestamp(),
        marketplaceSource: marketplace.source,
      });
      try {
        cpSync(available.packageDir, temporary, {
          recursive: true,
          dereference: true,
          filter(source) {
            const segments = relative(available.packageDir, source).split(/[\\/]/);
            return !segments.some((segment) => segment === ".git" || segment === "node_modules");
          },
        });
        const copiedManifest = readPluginManifest(temporary);
        if (
          copiedManifest.pluginId !== available.manifest.pluginId ||
          copiedManifest.version !== available.manifest.version
        ) {
          throw new Error("Package identity changed while it was being installed");
        }
        writeJsonAtomic(join(temporary, INSTALL_RECEIPT_PATH), provenance);
        renameSync(temporary, target);
      } finally {
        rmSync(temporary, { recursive: true, force: true });
      }
      return Object.freeze({
        ...this.readInstalled(target),
        alreadyInstalled: false,
      });
    });
  }

  private readInstalled(packageDir: string): InstalledPluginPackage {
    if (!existsSync(packageDir)) throw new Error(`Plugin Package is not installed: ${packageDir}`);
    const manifest = readPluginManifest(packageDir);
    const expected = this.packageDir(manifest.pluginId, manifest.version);
    if (resolve(packageDir) !== resolve(expected)) {
      throw new Error(
        `installed Package path does not match manifest identity: ${manifest.pluginId}@${manifest.version}`,
      );
    }
    resolveExistingWithin(packageDir, manifest.entry, `Plugin entry ${manifest.pluginId}`);
    const receiptPath = join(packageDir, INSTALL_RECEIPT_PATH);
    if (!existsSync(receiptPath)) {
      throw new Error(`Plugin Package install receipt not found: ${receiptPath}`);
    }
    return Object.freeze({
      packageDir,
      manifest,
      provenance: parseProvenance(readJson(receiptPath, "Package install receipt")),
    });
  }

  private readRegistry(): RegistryFile {
    const path = this.registryPath();
    if (!existsSync(path)) return { ...EMPTY_REGISTRY, marketplaces: [] };
    return parseRegistry(readJson(path, "marketplace registry"));
  }

  private marketplaceRoot(registration: MarketplaceRegistration): string {
    return registration.source.kind === "local"
      ? registration.source.path
      : join(this.marketplacesDir(), registration.name);
  }

  private packageDir(pluginId: string, version: string): string {
    return join(
      this.packagesDir(),
      packageDirectoryName(validatePluginId(pluginId)),
      validatePackageVersion(version),
    );
  }

  private pluginsDir(): string {
    return join(this.rootDir, "plugins");
  }

  private registryPath(): string {
    return join(this.pluginsDir(), "marketplaces.json");
  }

  private marketplacesDir(): string {
    return join(this.pluginsDir(), "marketplaces");
  }

  private packagesDir(): string {
    return join(this.pluginsDir(), "packages");
  }

  private timestamp(): string {
    const timestamp = this.now();
    if (Number.isNaN(timestamp.getTime())) {
      throw new Error("MarketplaceRegistry now() returned an invalid Date");
    }
    return timestamp.toISOString();
  }
}
