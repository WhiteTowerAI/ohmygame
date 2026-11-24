import { randomUUID } from "node:crypto";
import { mkdir, mkdtemp, readFile, realpath, rename, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { isOfficialRepository, PLUGIN_ARCHIVE_MAX_BYTES, PLUGIN_NPM_REGISTRIES, releaseJoins, type PluginNpmRegistry, type PluginOrigin, type PluginAddSource, type PluginAddPreview, type PluginSourceUpdate, isNewerPluginVersion, isPluginVersion, npmPackagePluginIds } from "../shared/plugins.js";
import { PluginPackError, restoreTemplateGitignores, stagePublished, unpackPlugin } from "./plugin-pack.js";
import { isAppWidePlugin, OHMYGAME_PUBLISHER, pluginApiIssue } from "../shared/plugin-manifest.js";
import { indexPluginPackage, localizePluginString, pluginAdds, type PluginIndexEntry } from "./plugin-index.js";
import { assertAddablePlugin, type PluginServices } from "./plugin-services.js";
import { PluginMarketError, type MarketRelease, type PluginMarket } from "./plugin-market.js";
import { downloadRelease, PluginReleaseError, unpackRelease } from "./plugin-releases.js";
import { capabilityGrants, missingGrants, updatesWithoutAsking } from "./project-plugins.js";

// The Add plugin dialog's sources: the market, GitHub and this computer. Each
// gives a package in a temporary folder, which is read and checked but never
// run: install scripts don't apply.
// Reviewing and adding are two requests, and adding fetches again, so it takes
// the digest the person reviewed and refuses a package that isn't that one.
//
// Approvals and settings belong to a plugin's id, so a package can only join an
// installed plugin when it comes from the same place. From anywhere else, the
// person uninstalls first, which clears them.

export class PluginSourceError extends Error {
  readonly statusCode = 400;
  constructor(
    message: string,
    /** The plugin and this version of the app don't match, and which of them has to change. */
    readonly code?: "needs-app-update" | "needs-plugin-update",
  ) {
    super(message);
  }
}

/** GitHub's answers about a repository are small. */
const METADATA_MAX_BYTES = 1024 * 1024;
const REQUEST_TIMEOUT_MS = 30_000;
const DOWNLOAD_TIMEOUT_MS = 5 * 60_000;
/**
 * How often a plugin added from a GitHub branch or tag is checked for a new
 * commit: GitHub answers 60 requests an hour from one address that doesn't
 * sign in, and adding plugins needs some of them.
 */
const GITHUB_CHECK_MS = 6 * 60 * 60_000;

export interface PluginSourceNetwork {
  /** Fetches metadata. */
  fetch: typeof fetch;
  /** Downloads a package over HTTPS to a new file. */
  download: (url: string, file: string, maxBytes: number, signal?: AbortSignal) => Promise<void>;
}

interface FetchedPackage {
  /** The folder holding the package; `removeAfter` goes when it has been read. */
  root: string;
  source?: PluginAddSource;
  origin?: PluginOrigin;
  /** Refuses a package that isn't what its source says. */
  check?: (entry: PluginIndexEntry) => void;
  removeAfter?: string;
}

/**
 * The versions the person removed can't be read. Quiet updates stop until it
 * can, and nothing replaces it; removing a plugin goes ahead.
 */
export class DeclinedUnreadableError extends Error {}

/** The shape of `declined-updates.json`. */
const DECLINED_VERSION = 1;

export class PluginSources {
  #origins: Promise<Record<string, PluginOrigin>> | undefined;
  /** Checking a package may join, recording its origin and installing it happen as one step. */
  #adding: Promise<unknown> = Promise.resolve();
  /** Changes to the versions the person removed, one at a time. */
  #declinedWrites: Promise<unknown> = Promise.resolve();
  /** The commit each GitHub branch or tag was at when last asked, by `repository@ref`. */
  readonly #gitHubChecks = new Map<string, { at: number; commit: string }>();

  constructor(
    private readonly services: PluginServices,
    private readonly originsPath: string,
    private readonly network: PluginSourceNetwork = { fetch: (...request) => fetch(...request), download: downloadRelease },
    private readonly market?: Pick<PluginMarket, "release"> & Partial<Pick<PluginMarket, "vouchedRelease" | "listing">>,
  ) {}

  /** `locale`, the app's language, also decides where a market plugin downloads from first. */
  inspect(source: PluginAddSource, locale: string | undefined): Promise<PluginAddPreview> {
    return this.#reading(() => this.#fetch(source, locale), (fetched, entry) => this.#preview(fetched, entry, locale));
  }

  install(source: PluginAddSource, digest: string, locale?: string): Promise<PluginIndexEntry> {
    return this.#reading(() => this.#fetch(source, locale), (fetched, entry) => this.#install(fetched, entry, digest));
  }

  inspectFile(file: Buffer, locale: string | undefined): Promise<PluginAddPreview> {
    return this.#reading(() => this.#unpackUpload(file), (fetched, entry) => this.#preview(fetched, entry, locale));
  }

  installFile(file: Buffer, digest: string): Promise<PluginIndexEntry> {
    return this.#reading(() => this.#unpackUpload(file), (fetched, entry) => this.#install(fetched, entry, digest));
  }

  /**
   * Looks where each plugin's newest version came from for a newer package:
   * the market's index for a release from it (or OhMyGame's own from npm),
   * GitHub for a branch or tag, at most every few hours. One that can't be
   * checked now, or that the market blocked or turned away, is left out; one
   * from npm or this computer can only be added again.
   */
  async updates(): Promise<PluginSourceUpdate[]> {
    await this.services.ready();
    const newest = [...new Set(this.services.index.entries().map((entry) => entry.id))].map((id) => this.services.index.get(id)!);
    const listing = await this.market?.listing?.(undefined).catch(() => undefined);
    const found = await Promise.all(newest.map(async (entry): Promise<PluginSourceUpdate | undefined> => {
      const origin = await this.origin(entry.id, entry.version);
      try {
        if ((origin?.type === "github" && origin.release !== undefined) || origin?.type === "npm") {
          const listed = listing?.plugins.find((plugin) => plugin.id === entry.id);
          const repository = listed?.repository?.replace(/^https:\/\/github\.com\//, "");
          if (!listed || !repository || !releaseJoins(origin, repository) || !isNewerPluginVersion(listed.version, entry.version) || this.services.index.get(entry.id, listed.version)) return undefined;
          // A version the market blocked or turned away would only be refused when added.
          if (!(await this.market!.release(entry.id, listed.version))) return undefined;
          return { id: entry.id, version: listed.version, source: { type: "market", id: entry.id, version: listed.version } };
        }
        if (origin?.type === "github") {
          const key = `${origin.repository.toLowerCase()}@${origin.ref ?? ""}`;
          let checked = this.#gitHubChecks.get(key);
          if (!checked || Date.now() - checked.at >= GITHUB_CHECK_MS) {
            checked = { at: Date.now(), commit: await this.#resolveCommit(origin.repository, origin.ref) };
            this.#gitHubChecks.set(key, checked);
          }
          const commit = checked.commit;
          const url = `https://github.com/${origin.repository}${origin.ref ? `/tree/${origin.ref}` : ""}`;
          return commit !== origin.commit ? { id: entry.id, commit, source: { type: "github", url, commit } } : undefined;
        }
      } catch {
        // Offline, or GitHub limiting requests: the next check tries again.
      }
      return undefined;
    }));
    return found.filter((update) => update !== undefined);
  }

  /**
   * Installs the updates `updates` found that need nothing from the person:
   * from the market, signed in a freshly read market index, not at or below a
   * version the person removed, and quiet as `#quietUpdate` decides. The rest
   * wait for the person, as does one that can't be fetched now. Returns what
   * it installed; `onError` hears why one that qualified failed.
   */
  async updateQuietly(updates: readonly PluginSourceUpdate[], onError?: (id: string, cause: unknown) => void): Promise<PluginIndexEntry[]> {
    const installed: PluginIndexEntry[] = [];
    for (const update of updates) {
      const source = update.source;
      if (source.type !== "market") continue;
      try {
        // Only a version the market signed, by an index read just now, so one it blocked since isn't taken.
        const vouched = await this.market?.vouchedRelease?.(source.id, source.version);
        if (!vouched || await this.#wentBackFrom(declinedKeys(source.id, vouched.origin), source.version)) continue;
        const entry = await this.#reading(() => this.#fetchMarket(source, vouched), (fetched, entry) => {
          const origin = fetched.origin;
          if (origin?.type !== "github" || entry.id !== update.id || entry.version !== update.version) return Promise.resolve(undefined);
          const run = this.#adding.then(() => this.#updateQuietly(fetched.root, entry, origin, async () => {}));
          this.#adding = run.catch(() => undefined);
          return run;
        });
        if (entry) installed.push(entry);
      } catch (cause) {
        // Offline, blocked, or the package changed: the person's update, or the next start, tries again.
        onError?.(update.id, cause);
      }
    }
    return installed;
  }

  /**
   * Records that the person removed a version of a plugin from the market, or
   * one the app brought along from npm, so no update brings it, or an older
   * one, back by itself. It's kept by `declinedKeys`, and adding a version
   * from that source again forgets what's at or below it. Only those update
   * by themselves, so others need nothing kept.
   */
  async decline(id: string, version: string): Promise<void> {
    const [key] = declinedKeys(id, await this.origin(id, version));
    if (!key) return;
    await this.#changeDeclined((declined) => {
      declined[key] = [...new Set([...(declined[key] ?? []), version])].sort();
    });
  }

  /**
   * Whether the person went back from this version, or a newer one, under
   * any of `keys`. A file that can't be read says nothing, so it throws and no
   * update happens by itself.
   */
  async #wentBackFrom(keys: readonly string[], version: string): Promise<boolean> {
    const declined = await this.#loadDeclined();
    return keys.some((key) => (declined[key] ?? []).some((removed) => !isNewerPluginVersion(version, removed)));
  }

  /** Versions the person removed, by `declinedKeys`. Missing is none; unreadable throws, so nothing replaces it. */
  async #loadDeclined(): Promise<Record<string, string[]>> {
    let text: string;
    try {
      text = await readFile(this.#declinedFile, "utf8");
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return {};
      throw new DeclinedUnreadableError(`${this.#declinedFile} can't be read: ${(cause as Error).message}`);
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch {
      throw new DeclinedUnreadableError(`${this.#declinedFile} isn't valid JSON`);
    }
    const plugins = value && typeof value === "object" && !Array.isArray(value) && (value as { version?: unknown }).version === DECLINED_VERSION
      ? (value as { plugins?: unknown }).plugins : undefined;
    if (!plugins || typeof plugins !== "object" || Array.isArray(plugins))
      throw new DeclinedUnreadableError(`${this.#declinedFile} isn't a version-${DECLINED_VERSION} file this app can read`);
    return Object.fromEntries(Object.entries(plugins).flatMap(([id, versions]) =>
      Array.isArray(versions) ? [[id, versions.filter((item): item is string => typeof item === "string" && isPluginVersion(item))]] : []));
  }

  /** Changes the removed versions one writer at a time. */
  #changeDeclined(change: (declined: Record<string, string[]>) => void): Promise<void> {
    const run = this.#declinedWrites.then(async () => {
      const declined = await this.#loadDeclined();
      change(declined);
      await mkdir(path.dirname(this.#declinedFile), { recursive: true });
      const temporary = `${this.#declinedFile}.${randomUUID()}.tmp`;
      await writeFile(temporary, `${JSON.stringify({ version: DECLINED_VERSION, plugins: declined }, null, 2)}\n`);
      await rename(temporary, this.#declinedFile);
    });
    this.#declinedWrites = run.catch(() => undefined);
    return run;
  }

  /** Where versions the person removed are kept, beside the origins. */
  get #declinedFile(): string {
    return path.join(path.dirname(this.originsPath), "declined-updates.json");
  }

  /**
   * Host-curated offline seed. Unlike Add, it never changes switches or
   * grants. Once a managed copy exists it belongs to the person, so the seed
   * leaves it alone, unless `mayUpdate` (the app seeded it and the person
   * hasn't removed it) and the pinned version is a quiet update
   * (`#quietUpdate`). Returns undefined when it installs nothing. It comes
   * from OhMyGame's npm scope or, now, from its signed GitHub releases.
   */
  installPreinstalled(root: string, origin: Extract<PluginOrigin, { type: "npm" | "github" }>, before: () => Promise<void>, { mayUpdate = false }: { mayUpdate?: boolean } = {}): Promise<PluginIndexEntry | undefined> {
    const run = this.#adding.then(async () => {
      await this.services.ready();
      const entry = await validPackage(root);
      if (origin.type === "npm" ? origin.registry !== "npmjs" || !origin.package.startsWith("@ohmygame/") || !npmPackagePluginIds(origin.package)?.includes(entry.id) || origin.version !== entry.version
        : origin.release === undefined || !isOfficialRepository(origin.repository) || !entry.id.startsWith(`${OHMYGAME_PUBLISHER}/`))
        throw new PluginSourceError(`Invalid preinstalled ${origin.type} identity`);
      // An installed managed version belongs to the person/updater now. Even
      // a missing seeded version must not cause a downgrade or replacement.
      const hasManaged = () => this.services.index.versions(entry.id).some((item) => this.#managed(item));
      if (hasManaged()) return mayUpdate ? this.#updateQuietly(root, entry, origin, before) : undefined;
      const bundled = this.services.index.versions(entry.id);
      if (bundled.length && !bundled.some((installed) => installed.version === entry.version))
        throw new PluginSourceError("Bundled relocation must keep its installed version; review a version update separately");
      const origins = Object.entries(await this.#loadOrigins()).filter(([key]) => key.startsWith(`${entry.id}@`));
      if (origins.some(([, previous]) => !isSameSource(previous, origin)))
        throw new PluginSourceError("Preinstallation cannot reuse data from another plugin source");
      const previousOrigin = await this.origin(entry.id, entry.version);
      let recorded = false;
      try {
        return await this.services.installManaged(root, { consent: false, before: async () => {
          // Another installer may have finished while this waited for the package lock.
          if (hasManaged()) throw new PluginSourceError("Plugin was installed while preinstallation was waiting");
          await before();
          await this.#recordOrigin(`${entry.id}@${entry.version}`, origin);
          recorded = true;
        } });
      } catch (cause) {
        // The same-version bundled entry still exists when copying/indexing
        // fails. Do not leave it claiming npm ownership. A committed package
        // whose later notification failed must keep its new origin, however.
        if (recorded && !hasManaged()) await this.#recordOrigin(`${entry.id}@${entry.version}`, previousOrigin);
        throw cause;
      }
    });
    this.#adding = run.catch(() => undefined);
    return run;
  }

  /** Whether a version is in the managed store, rather than bundled or in development. */
  #managed(item: PluginIndexEntry): boolean {
    const relative = path.relative(this.services.packagesDirectory, item.root);
    return Boolean(relative) && !relative.startsWith("..") && !path.isAbsolute(relative);
  }

  /**
   * Whether a version, pinned by the app or newest on the market, may replace
   * what's installed as the person's own update would, without asking: it's
   * newer than every installed version, all of which came from this same
   * source into the managed store, this app runs it, and it runs no code of
   * its own and asks for nothing new (`updatesWithoutAsking`). Anything else
   * waits for the person.
   */
  async #quietUpdate(entry: PluginIndexEntry, origin: PluginOrigin): Promise<boolean> {
    if (pluginApiIssue(entry.manifest)) return false;
    const installed = this.services.index.versions(entry.id);
    if (!installed.length || installed.some((item) => !isNewerPluginVersion(entry.version, item.version) || !this.#managed(item))) return false;
    // Read only for a real update, so a damaged file doesn't trouble every start's seed.
    if (await this.#wentBackFrom(declinedKeys(entry.id, origin), entry.version)) return false;
    const origins = await this.#loadOrigins();
    if (installed.some((item) => !isSameSource(origins[`${item.id}@${item.version}`], origin))) return false;
    return updatesWithoutAsking(entry.manifest, this.services.grants.plugin(entry.id)?.allowed ?? [], this.services.index.get(entry.id)?.manifest);
  }

  async #updateQuietly(root: string, entry: PluginIndexEntry, origin: PluginOrigin, before: () => Promise<void>): Promise<PluginIndexEntry | undefined> {
    if (!(await this.#quietUpdate(entry, origin))) return undefined;
    const key = `${entry.id}@${entry.version}`;
    const previousOrigin = await this.origin(entry.id, entry.version);
    let recorded = false;
    try {
      return await this.services.installUpdate(root, async () => {
        // The person may have changed the plugin while this waited for the package lock.
        if (!(await this.#quietUpdate(entry, origin))) throw new PluginSourceError("The plugin changed while its update was waiting");
        await before();
        await this.#recordOrigin(key, origin);
        recorded = true;
      });
    } catch (cause) {
      if (recorded && !this.services.index.get(entry.id, entry.version)) await this.#recordOrigin(key, previousOrigin);
      throw cause;
    }
  }

  /** Where a package the person added came from; a local one has no origin. */
  async origin(id: string, version: string): Promise<PluginOrigin | undefined> {
    return (await this.#loadOrigins())[`${id}@${version}`];
  }

  async #reading<T>(fetchPackage: () => Promise<FetchedPackage>, use: (fetched: FetchedPackage, entry: PluginIndexEntry) => Promise<T>): Promise<T> {
    await this.services.ready();
    const fetched = await fetchPackage();
    try {
      const entry = await validPackage(fetched.root);
      try {
        assertAddablePlugin(entry.id, fetched.origin);
      } catch (cause) {
        throw new PluginSourceError((cause as Error).message);
      }
      fetched.check?.(entry);
      return await use(fetched, entry);
    } finally {
      if (fetched.removeAfter) await rm(fetched.removeAfter, { recursive: true, force: true });
    }
  }

  async #preview(fetched: FetchedPackage, entry: PluginIndexEntry, locale: string | undefined): Promise<PluginAddPreview> {
    await this.#assertCanJoin(entry, fetched.origin);
    const language = locale === "zh-CN" ? "zh-CN" : "en";
    return {
      ...(fetched.source ? { source: fetched.source } : {}),
      digest: entry.digest,
      id: entry.id,
      version: entry.version,
      displayName: localizePluginString(entry, entry.manifest.displayName, language),
      description: localizePluginString(entry, entry.manifest.description, language),
      appWide: isAppWidePlugin(entry.manifest),
      asks: capabilityGrants(entry.manifest),
      adds: pluginAdds(entry, (value) => localizePluginString(entry, value, language)),
      settings: Boolean(entry.manifest.configuration),
      installedVersions: this.services.index.versions(entry.id).map((installed) => installed.version),
      // What was allowed stays with the plugin, so a new version asks only for what it adds.
      ...(this.services.index.versions(entry.id).length
        ? { newAsks: missingGrants(capabilityGrants(entry.manifest), this.services.grants.plugin(entry.id)?.allowed ?? []) }
        : {}),
      ...(fetched.origin ? { origin: fetched.origin } : {}),
    };
  }

  async #install(fetched: FetchedPackage, entry: PluginIndexEntry, digest: string, before?: () => Promise<void>): Promise<PluginIndexEntry> {
    if (entry.digest !== digest) throw new PluginSourceError("This package changed after you reviewed it. Review it again.");
    const run = this.#adding.then(async () => {
      await this.#assertCanJoin(entry, fetched.origin);
      const present = this.services.index.get(entry.id, entry.version);
      if (present?.digest === entry.digest) return present;
      // Settings and data kept at uninstall go back only to the source they came from.
      if (!this.services.index.versions(entry.id).length) {
        if (!(await this.#keptFor(entry.id, fetched.origin))) await this.services.forgetKeptData(entry.id);
        // From now on what's kept belongs to this package's source alone.
        await this.#forgetOrigins(entry.id);
      }
      // The origin goes first: if it can't be saved nothing is installed, and
      // one left by an install that fails belongs to no installed version.
      await this.#recordOrigin(`${entry.id}@${entry.version}`, fetched.origin);
      const added = await this.services.installAdded(fetched.root, before, fetched.origin);
      // The person chose this version, so what they removed at or below it no longer holds updates back.
      // Installed is installed, though, if that can't be saved.
      const keys = declinedKeys(entry.id, fetched.origin);
      if (keys.length) await this.#changeDeclined((declined) => {
        for (const key of keys) {
          const kept = (declined[key] ?? []).filter((version) => isNewerPluginVersion(version, entry.version));
          if (kept.length) declined[key] = kept;
          else delete declined[key];
        }
      }).catch(() => undefined);
      return added;
    });
    this.#adding = run.catch(() => undefined);
    return run;
  }

  /**
   * The exact package already installed changes nothing, so it's always fine.
   * Other contents under one version would change what projects already run
   * and have approved, so a new release needs a new version.
   */
  async #assertCanJoin(entry: PluginIndexEntry, origin: PluginOrigin | undefined): Promise<void> {
    const present = this.services.index.get(entry.id, entry.version);
    // A folder in development is watched and keeps changing, so even the same
    // contents can't make it one with a plugin from elsewhere; and it replaces
    // its own version in place.
    const developing = origin?.type === "development";
    if (!developing && present?.digest === entry.digest) return;
    for (const installed of this.services.index.versions(entry.id)) {
      const previous = await this.origin(installed.id, installed.version);
      if (!isSameSource(previous, origin))
        throw new PluginSourceError(`${entry.id} is already installed from ${sourceName(previous)}. Its approvals and settings stay with that source, so uninstall it first to add it from here.`);
    }
    if (present && present.digest !== entry.digest && !developing) throw new PluginSourceError(`Version ${entry.version} of ${entry.id} is already installed with different contents. A new release needs a new version.`);
  }

  /** The folder each plugin in development is added from, by id. */
  async developmentFolders(): Promise<Map<string, string>> {
    await this.services.ready();
    const folders = new Map<string, string>();
    for (const entry of this.services.index.entries()) {
      const origin = await this.origin(entry.id, entry.version);
      if (origin?.type === "development") folders.set(entry.id, origin.folder);
    }
    return folders;
  }

  /**
   * Adds a plugin in development from its folder again, without a review: the
   * person chose to develop it. What it asks for beyond what they allowed
   * still waits for them. Says whether the package changed.
   */
  async refreshDevelopment(id: string): Promise<boolean> {
    const folder = (await this.developmentFolders()).get(id);
    if (!folder) throw new PluginSourceError(`${id} isn't in development.`);
    return this.#reading(() => this.#directory({ type: "directory", path: folder, development: true }), async (fetched, entry) => {
      if (entry.id !== id) throw new PluginSourceError(`The folder now holds ${entry.id}, not ${id}. Uninstall ${id} to develop another plugin.`);
      if (this.services.index.get(entry.id, entry.version)?.digest === entry.digest) return false;
      // Uninstalled, or added from elsewhere, while the folder was being copied.
      await this.#install(fetched, entry, entry.digest, async () => {
        if ((await this.developmentFolders()).get(id) !== folder) throw new PluginSourceError(`${id} isn't in development from ${folder} anymore.`);
      });
      return true;
    });
  }

  /** Whether every package this id came from before is the same source as `origin`. */
  async #keptFor(id: string, origin: PluginOrigin | undefined): Promise<boolean> {
    const before = Object.entries(await this.#loadOrigins()).filter(([key]) => key.startsWith(`${id}@`)).map(([, value]) => value);
    return before.length > 0 && before.every((previous) => isSameSource(previous, origin));
  }

  #fetch(source: PluginAddSource, locale: string | undefined): Promise<FetchedPackage> {
    if (source.type === "market") return this.#fetchMarket(source, undefined, locale);
    if (source.type === "github") return this.#fetchGitHub(source);
    return this.#directory(source);
  }

  async #directory(source: Extract<PluginAddSource, { type: "directory" }>): Promise<FetchedPackage> {
    if (!path.isAbsolute(source.path)) throw new PluginSourceError("Choose a folder by its full path.");
    const real = await realpath(source.path).catch(() => undefined);
    const info = real ? await stat(real).catch(() => undefined) : undefined;
    if (!real || !info?.isDirectory()) throw new PluginSourceError(`There is no folder at ${source.path}.`);
    // What npm would publish from it, in a private copy that can't change
    // between the review's checks and the install.
    return this.#inTemporaryFolder(async (folder) => {
      const root = path.join(folder, "package");
      await stagePublished(real, root).catch((cause: unknown) => {
        if (cause instanceof PluginPackError) throw new PluginSourceError(`This isn't a valid plugin: ${cause.message}`);
        throw cause;
      });
      return { root, source, ...(source.development ? { origin: { type: "development" as const, folder: real } } : {}) };
    });
  }

  async #unpackUpload(file: Buffer): Promise<FetchedPackage> {
    return this.#inTemporaryFolder(async (folder) => {
      const archive = path.join(folder, "package.tgz");
      await writeFile(archive, file, { flag: "wx" });
      return { root: await unpack(archive, folder, true) };
    });
  }

  /**
   * A version the market signed, from the first place it downloads from: the
   * mirror, GitHub or a proxy, as the person chose. A copy that fails to
   * download or doesn't match the signed digest gives way to the next.
   */
  async #fetchMarket(source: Extract<PluginAddSource, { type: "market" }>, vouched?: MarketRelease, locale?: string): Promise<FetchedPackage> {
    let found = vouched;
    try {
      found ??= await this.market?.release(source.id, source.version, locale);
    } catch (cause) {
      if (cause instanceof PluginMarketError) throw new PluginSourceError(cause.message);
      throw cause;
    }
    // A card can outlive its entry, and without one nothing here is signed.
    if (!found) throw new PluginSourceError(`${source.id} ${source.version} isn't on the plugin market any more.`);
    const { release, urls, origin } = found;
    return this.#inTemporaryFolder(async (folder) => {
      const archive = path.join(folder, "package.zip");
      const unpacked = path.join(folder, "package");
      let root: string | undefined;
      // A copy that isn't the signed one says more than a later place that can't be reached.
      let refused: PluginReleaseError | undefined;
      for (const [index, url] of urls.entries()) {
        await rm(archive, { force: true });
        await rm(unpacked, { recursive: true, force: true });
        await mkdir(unpacked);
        try {
          root = await unpackRelease(release, archive, unpacked, (file) => this.network.download(url, file, release.size, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)));
          break;
        } catch (cause) {
          if (cause instanceof PluginReleaseError) refused ??= cause;
          if (index < urls.length - 1) continue;
          if (refused) throw new PluginSourceError(refused.message);
          downloadFailed(cause);
        }
      }
      await restoreTemplateGitignores(root!);
      return {
        root: root!,
        source: { type: "market", id: release.id, version: release.version },
        origin,
        check: (entry) => {
          if (entry.id !== release.id || entry.version !== release.version)
            throw new PluginSourceError(`The package is ${entry.id} ${entry.version}, not the ${release.id} ${release.version} the market signed.`);
        },
      };
    });
  }

  async #fetchGitHub(source: Extract<PluginAddSource, { type: "github" }>): Promise<FetchedPackage> {
    const { repository, ref } = parseGitHubUrl(source.url);
    const commit = source.commit ?? await this.#resolveCommit(repository, ref);
    if (!/^[0-9a-f]{40}$/.test(commit)) throw new PluginSourceError(`${commit} isn't a full commit id.`);
    return this.#inTemporaryFolder(async (folder) => {
      const archive = path.join(folder, "package.tgz");
      await this.network.download(`https://codeload.github.com/${repository}/tar.gz/${commit}`, archive, PLUGIN_ARCHIVE_MAX_BYTES, AbortSignal.timeout(DOWNLOAD_TIMEOUT_MS)).catch(downloadFailed);
      return {
        root: await unpack(archive, folder, false),
        source: { type: "github", url: source.url, commit },
        origin: { type: "github", repository, commit, ...(ref ? { ref } : {}) },
      };
    });
  }

  /**
   * A branch or tag by its exact name, or the default branch. GitHub's general
   * commit lookup also takes short ids and `describe` forms, which reach commits
   * in the repository's forks, so a fork could pose as the repository it forked.
   */
  async #resolveCommit(repository: string, ref: string | undefined): Promise<string> {
    const base = `https://api.github.com/repos/${repository}`;
    const name = ref ?? (await this.#gitHubJson<{ default_branch?: unknown }>(base, repository))?.default_branch;
    if (typeof name !== "string") throw new PluginSourceError(`Could not find ${repository} on GitHub. Private repositories can't be added.`);
    const refPath = name.split("/").map(encodeURIComponent).join("/");
    let target = await this.#gitHubJson<GitObject>(`${base}/git/ref/heads/${refPath}`, repository);
    target ??= await this.#gitHubJson<GitObject>(`${base}/git/ref/tags/${refPath}`, repository);
    if (!target) throw new PluginSourceError(`${repository} has no branch or tag named ${name}.`);
    // An annotated tag points at a tag object, which points at the commit.
    for (let depth = 0; target?.object?.type === "tag" && depth < 5; depth += 1)
      target = await this.#gitHubJson<GitObject>(`${base}/git/tags/${target.object.sha}`, repository);
    if (target?.object?.type !== "commit" || typeof target.object.sha !== "string") throw new PluginSourceError(`${name} in ${repository} doesn't lead to a commit.`);
    return target.object.sha;
  }

  /** The answer, or undefined when GitHub has no such thing. */
  async #gitHubJson<T>(url: string, repository: string): Promise<T | undefined> {
    const response = await this.#request(url, { accept: "application/vnd.github+json", "x-github-api-version": "2022-11-28", "user-agent": "OhMyGame" }, "Could not reach GitHub");
    if (response.status === 404) return undefined;
    if (response.status === 403 || response.status === 429) throw new PluginSourceError("GitHub is limiting requests right now. Try again later.");
    if (!response.ok) throw new PluginSourceError(`GitHub answered ${response.status} about ${repository}.`);
    return await readJson(response) as T;
  }

  async #request(url: string, headers: Record<string, string>, failure: string): Promise<Response> {
    try {
      return await this.network.fetch(url, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS) });
    } catch (cause) {
      throw new PluginSourceError(`${failure}: ${cause instanceof Error ? cause.message : String(cause)}`);
    }
  }

  async #inTemporaryFolder(fill: (folder: string) => Promise<FetchedPackage>): Promise<FetchedPackage> {
    const folder = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-source-"));
    try {
      return { ...await fill(folder), removeAfter: folder };
    } catch (cause) {
      await rm(folder, { recursive: true, force: true });
      throw cause;
    }
  }

  #loadOrigins(): Promise<Record<string, PluginOrigin>> {
    return this.#origins ??= readFile(this.originsPath, "utf8")
      .then((text) => {
        const value: unknown = JSON.parse(text);
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid plugin origins; file left unchanged");
        return value as Record<string, PluginOrigin>;
      })
      .catch((cause: NodeJS.ErrnoException) => {
        this.#origins = undefined;
        if (cause.code === "ENOENT") return {};
        throw cause;
      });
  }

  /** Adding the same version from elsewhere replaces it, origin included. */
  async #recordOrigin(key: string, origin: PluginOrigin | undefined): Promise<void> {
    const { [key]: _replaced, ...others } = await this.#loadOrigins();
    await this.#saveOrigins(origin ? { ...others, [key]: origin } : others);
  }

  async #forgetOrigins(id: string): Promise<void> {
    const origins = await this.#loadOrigins();
    await this.#saveOrigins(Object.fromEntries(Object.entries(origins).filter(([key]) => !key.startsWith(`${id}@`))));
  }

  async #saveOrigins(next: Record<string, PluginOrigin>): Promise<void> {
    await mkdir(path.dirname(this.originsPath), { recursive: true });
    const temporary = `${this.originsPath}.${randomUUID()}.tmp`;
    try {
      await writeFile(temporary, `${JSON.stringify(next, null, 2)}\n`, { flag: "wx" });
      await rename(temporary, this.originsPath);
      this.#origins = Promise.resolve(next);
    } finally {
      await rm(temporary, { force: true });
    }
  }
}

async function validPackage(root: string): Promise<PluginIndexEntry> {
  const checked = await indexPluginPackage(root);
  // A plugin made for another version of the app is fine; it says which way to go.
  const version = checked.ok ? undefined : checked.issues.find((issue) => issue.fix);
  if (version) throw new PluginSourceError(version.message, version.fix === "update-app" ? "needs-app-update" : "needs-plugin-update");
  if (!checked.ok)
    throw new PluginSourceError(`This isn't a valid plugin: ${checked.issues.slice(0, 3).map((issue) => `${issue.path} ${issue.message}`.trim()).join("; ")}`);
  return checked.entry;
}

/**
 * A package from this computer has no source to vouch for it, so it never counts as the same.
 * npmmirror copies npm, so they're one source; another registry's scopes are its own.
 * OhMyGame's own plugins moved from its npm scope to WhiteTowerAI's GitHub
 * releases, which count as the same source, so their settings and grants
 * carry over (`releaseJoins`); no one else's do.
 */
function isSameSource(left: PluginOrigin | undefined, right: PluginOrigin | undefined): boolean {
  if (left?.type === "npm" && right?.type === "npm")
    return left.package.split("/")[0] === right.package.split("/")[0] && npmSource(left.registry) === npmSource(right.registry);
  if (left?.type === "github" && right?.type === "github") return left.repository.toLowerCase() === right.repository.toLowerCase();
  if (left?.type === "development" && right?.type === "development") return left.folder === right.folder;
  const [npm, github] = left?.type === "npm" ? [left, right] : [right, left];
  if (npm?.type === "npm" && github?.type === "github") return github.release !== undefined && releaseJoins(npm, github.repository);
  return false;
}

function npmSource(registry: PluginNpmRegistry): string {
  return (PLUGIN_NPM_REGISTRIES as readonly string[]).includes(registry) ? "npmjs" : registry;
}

/**
 * What versions the person removed are kept under: an npm package, as the app
 * brought some along from npm; or a release from the market by the plugin's
 * id, which for OhMyGame's own also goes by the npm package it came from
 * before. Other sources don't update by themselves, so they have none.
 */
function declinedKeys(id: string, origin: PluginOrigin | undefined): string[] {
  if (origin?.type === "npm") return [origin.package];
  if (origin?.type !== "github" || origin.release === undefined) return [];
  // compat: since beta.5.11, remove from beta.7 and 2026-12-30. Versions removed while OhMyGame's plugins came from npm stay declined.
  return id.startsWith(`${OHMYGAME_PUBLISHER}/`) ? [id, `@${id}`] : [id];
}

function sourceName(origin: PluginOrigin | undefined): string {
  if (origin?.type === "npm") return npmSource(origin.registry) === "npmjs" ? `npm (${origin.package})` : `${new URL(origin.registry).host} (${origin.package})`;
  if (origin?.type === "github") return `GitHub (${origin.repository})`;
  if (origin?.type === "development") return `the folder ${origin.folder}, in development`;
  return "another package on this computer";
}

interface GitObject {
  object?: { type?: unknown; sha?: unknown };
}

/** A repository's page, optionally at a branch or tag. */
export function parseGitHubUrl(input: string): { repository: string; ref?: string } {
  const text = input.trim().replace(/^(?:https:\/\/)?(?:www\.)?github\.com\//i, "");
  const match = /^([A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?)\/([A-Za-z0-9._-]+?)(?:\.git)?(?:\/tree\/([A-Za-z0-9][A-Za-z0-9._-]*(?:\/[A-Za-z0-9_-][A-Za-z0-9._-]*)*))?\/?$/.exec(text);
  if (!match || text === input.trim() || /^\.+$/.test(match[2]!) || match[3]?.includes(".."))
    throw new PluginSourceError(`Enter a GitHub repository, like https://github.com/publisher/plugin, not "${input.trim()}".`);
  return { repository: `${match[1]}/${match[2]}`, ...(match[3] ? { ref: match[3] } : {}) };
}


async function readJson(response: Response): Promise<unknown> {
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > METADATA_MAX_BYTES) throw new PluginSourceError("GitHub's answer is too large.");
  const text = await response.text();
  if (Buffer.byteLength(text) > METADATA_MAX_BYTES) throw new PluginSourceError("GitHub's answer is too large.");
  try {
    return JSON.parse(text);
  } catch {
    throw new PluginSourceError("GitHub's answer isn't readable.");
  }
}

function downloadFailed(cause: unknown): never {
  throw new PluginSourceError(`The download failed: ${cause instanceof Error ? cause.message : String(cause)}`);
}

function unpack(archive: string, folder: string, published: boolean): Promise<string> {
  return unpackPlugin(archive, folder, { published, error: (reason) => new PluginSourceError(`This package can't be unpacked (${reason}).`) });
}
