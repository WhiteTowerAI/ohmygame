import { DefaultPackageManager, SettingsManager, type PackageManager } from "@earendil-works/pi-coding-agent";
import path from "node:path";
import type { PiPackageCatalog, PiPackageResourceType, PiPackageSummary } from "../shared/contracts.js";
import { isOpenGameManagedPiPackage } from "./pi-agent.js";

const NPM_SEARCH_URL = "https://registry.npmjs.org/-/v1/search";
const NPM_REGISTRY_URL = "https://registry.npmjs.org";
const REQUEST_TIMEOUT_MS = 10_000;
const CACHE_TTL_MS = 10 * 60 * 1000;
const DEFAULT_PAGE_SIZE = 20;
const MAX_PAGE_SIZE = 40;

interface NpmSearchPackage {
  name?: unknown;
  description?: unknown;
}

interface NpmManifest {
  description?: unknown;
  keywords?: unknown;
  pi?: { extensions?: unknown; skills?: unknown; prompts?: unknown; themes?: unknown };
}

interface NpmSearchResponse {
  objects?: Array<{ package?: NpmSearchPackage }>;
}

interface CachedCatalog {
  key: string;
  value: PiPackageCatalog;
  expiresAt: number;
}

export class PiPackageCatalogService {
  readonly #packageManager: PackageManager;
  readonly #fetch: typeof fetch;
  #cache?: CachedCatalog;

  constructor(fetchImpl: typeof fetch = fetch, packageManager?: PackageManager, agentDir?: string) {
    this.#fetch = fetchImpl;
    this.#packageManager = packageManager ?? createUserPackageManager(agentDir ?? process.env.PI_CODING_AGENT_DIR ?? path.resolve(process.cwd(), ".data", "pi-agent"));
  }

  async list(query = "", page = 1, pageSize = DEFAULT_PAGE_SIZE): Promise<PiPackageCatalog> {
    const safePage = Number.isInteger(page) && page > 0 ? page : 1;
    const safePageSize = Number.isInteger(pageSize) ? Math.min(Math.max(pageSize, 1), MAX_PAGE_SIZE) : DEFAULT_PAGE_SIZE;
    const normalizedQuery = query.trim();
    const key = `${normalizedQuery}\0${safePage}\0${safePageSize}`;
    if (this.#cache?.key === key && this.#cache.expiresAt > Date.now()) return this.#cache.value;

    const url = new URL(NPM_SEARCH_URL);
    url.searchParams.set("text", normalizedQuery ? `keywords:pi-package ${normalizedQuery}` : "keywords:pi-package");
    url.searchParams.set("size", String(safePageSize));
    url.searchParams.set("from", String((safePage - 1) * safePageSize));

    const response = await this.#request(url);
    if (!response.ok) throw new Error(`Pi package catalog request failed (${response.status})`);
    const payload = await response.json() as NpmSearchResponse;
    const candidates = payload.objects ?? [];
    const packages = (await Promise.all(candidates.map((item) => this.#resolveNpmCandidate(item.package)))).filter(
      (item): item is PiPackageSummary => item !== undefined,
    );
    const value: PiPackageCatalog = {
      packages,
      hasMore: candidates.length === safePageSize,
    };
    this.#cache = { key, value, expiresAt: Date.now() + CACHE_TTL_MS };
    return value;
  }

  listInstalled(): PiPackageSummary[] {
    return this.#userPackages().map((configured) => ({
      name: displayName(configured.source),
      sourceType: sourceType(configured.source),
      resourceTypes: [],
      compatibility: "not-verified",
      installed: true,
      installSpec: configured.source,
    }));
  }

  async install(name: string): Promise<void> {
    const packageName = normalizePackageName(name);
    if (!packageName) throw new Error("Invalid Pi package name");
    if (isOpenGameManagedPiPackage(`npm:${packageName}`)) throw new Error("Pi package is managed by OpenGame");
    const summary = await this.#resolveNpmCandidate({ name: packageName });
    if (!summary) throw new Error("Package is not published as a Pi package");
    const source = `npm:${packageName}`;
    await this.#packageManager.installAndPersist(source);
    this.#cache = undefined;
  }

  async remove(source: string): Promise<void> {
    if (isOpenGameManagedPiPackage(source)) throw new Error("Pi package is managed by OpenGame");
    const configured = this.#userPackages().some((item) => item.source === source);
    if (!configured) throw new Error("Pi package is not installed");
    await this.#packageManager.removeAndPersist(source);
    this.#cache = undefined;
  }

  async #resolveNpmCandidate(candidate?: NpmSearchPackage): Promise<PiPackageSummary | undefined> {
    const name = stringValue(candidate?.name);
    if (!name) return undefined;
    if (isOpenGameManagedPiPackage(`npm:${name}`)) return undefined;
    const response = await this.#request(`${NPM_REGISTRY_URL}/${encodeURIComponent(name)}/latest`);
    if (response.status === 404) return undefined;
    if (!response.ok) throw new Error(`Pi package manifest request failed (${response.status})`);
    const manifest = await response.json() as NpmManifest;
    if (!arrayOfStrings(manifest.keywords).includes("pi-package")) return undefined;
    const resourceTypes = resourceTypesFromManifest(manifest.pi);
    return {
      name,
      sourceType: "npm",
      description: stringValue(manifest.description) ?? stringValue(candidate?.description),
      resourceTypes,
      compatibility: compatibilityFor(resourceTypes),
      installed: this.#userPackages().some((item) => npmNameFromSource(item.source) === name),
      installSpec: `npm:${name}`,
    };
  }

  async #request(input: string | URL): Promise<Response> {
    return this.#fetch(input, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
  }

  #userPackages(): ReturnType<PackageManager["listConfiguredPackages"]> {
    return this.#packageManager.listConfiguredPackages().filter(
      (item) => item.scope === "user" && !isOpenGameManagedPiPackage(item.source),
    );
  }
}

function createUserPackageManager(agentDir: string): PackageManager {
  return new DefaultPackageManager({
    // Plugins is application-level, so it manages Pi's user packages. Project packages
    // remain scoped to their project and are loaded there by Pi.
    cwd: agentDir,
    agentDir,
    settingsManager: SettingsManager.create(agentDir, agentDir),
  });
}

function normalizePackageName(value: string): string | undefined {
  const name = value.trim();
  return /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/i.test(name) ? name : undefined;
}

function npmNameFromSource(source: string): string | undefined {
  if (!source.startsWith("npm:")) return undefined;
  const value = source.slice(4);
  const separator = value.startsWith("@") ? value.indexOf("@", value.indexOf("/") + 1) : value.indexOf("@");
  return separator >= 0 ? value.slice(0, separator) : value;
}

function displayName(source: string): string {
  return source.startsWith("npm:") ? npmNameFromSource(source) ?? source : source.replace(/^(git|local|https?):/, "");
}

function sourceType(source: string): PiPackageSummary["sourceType"] {
  if (source.startsWith("npm:")) return "npm";
  if (source.startsWith("git:")) return "git";
  if (source.startsWith("http://") || source.startsWith("https://")) return "url";
  return "local";
}

function resourceTypesFromManifest(pi?: NpmManifest["pi"]): PiPackageResourceType[] {
  if (!pi) return [];
  const types: PiPackageResourceType[] = [];
  if (Array.isArray(pi.extensions)) types.push("extension");
  if (Array.isArray(pi.skills)) types.push("skill");
  if (Array.isArray(pi.prompts)) types.push("prompt");
  if (Array.isArray(pi.themes)) types.push("theme");
  return types;
}

function compatibilityFor(types: PiPackageResourceType[]): PiPackageSummary["compatibility"] {
  if (types.length === 1 && types[0] === "theme") return "not-applicable";
  if (types.includes("extension")) return "not-verified";
  return types.length ? "compatible" : "not-verified";
}

function stringValue(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function arrayOfStrings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];
}
