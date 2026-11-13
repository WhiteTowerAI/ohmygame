import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  BROWSER_MAX_SHORTCUTS,
  BROWSER_MAX_TABS,
  BROWSER_MAX_VISITS,
  BROWSER_SEARCH_ENGINES,
  isBrowserUrl,
  type BrowserSettings,
  type BrowserShortcut,
  type BrowserVisit,
  type ProjectBrowser,
  type SavedBrowserTab,
} from "../shared/browser.js";

// The Browser panel's records, in the app's data folder: the settings every
// project shares in `browser-settings.json`, and each project's tabs and
// visited sites in `browser.json` beside its other records, never in its
// folder. A file this version can't read is left as it is: the browser opens
// without it and doesn't save over it.

export class BrowserStoreError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400,
  ) {
    super(message);
  }
}

/** What a new browser offers before the person changes it: places to find things for a game. */
export const DEFAULT_BROWSER_SETTINGS: BrowserSettings = {
  shortcuts: [
    { title: "MDN Web Docs", url: "https://developer.mozilla.org/" },
    { title: "itch.io", url: "https://itch.io/" },
    { title: "OpenGameArt", url: "https://opengameart.org/" },
    { title: "Kenney", url: "https://kenney.nl/assets" },
    { title: "Freesound", url: "https://freesound.org/" },
  ],
  searchEngine: "bing",
};

const MAX_TITLE = 300;

/** One JSON file, read once, written whole; a file this version can't read stays untouched. */
class VersionedFile<T> {
  #value: T | undefined;
  #problem: string | undefined;
  #loading: Promise<void> | undefined;
  #queue: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly file: string,
    private readonly parse: (value: unknown) => T | undefined,
  ) {}

  async read(): Promise<{ value: T | undefined; problem: string | undefined }> {
    this.#loading ??= (async () => {
      let text: string;
      try {
        text = await readFile(this.file, "utf8");
      } catch (cause) {
        if ((cause as NodeJS.ErrnoException).code !== "ENOENT")
          this.#problem = `${this.file} can't be read.`;
        return;
      }
      try {
        const stored = JSON.parse(text) as { version?: unknown };
        this.#value = stored?.version === 1 ? this.parse(stored) : undefined;
      } catch {
        this.#value = undefined;
      }
      if (this.#value === undefined)
        this.#problem = `${this.file} isn't a file this version of OhMyGame can read.`;
    })();
    await this.#loading;
    return { value: this.#value, problem: this.#problem };
  }

  /** Changes the value in turn with other changes; refused while the file can't be read. */
  update(change: (current: T | undefined) => T): Promise<T> {
    const run = this.#queue.then(async () => {
      const { value, problem } = await this.read();
      if (problem)
        throw new BrowserStoreError(
          `${problem} Fix or remove it to change it.`,
          409,
        );
      const next = change(value);
      await mkdir(path.dirname(this.file), { recursive: true });
      const temporary = `${this.file}.${process.pid}.tmp`;
      await writeFile(
        temporary,
        `${JSON.stringify({ version: 1, ...next }, null, 2)}\n`,
      );
      await rename(temporary, this.file);
      this.#value = next;
      return next;
    });
    this.#queue = run.catch(() => {});
    return run;
  }
}

export class BrowserSettingsStore {
  readonly #file: VersionedFile<BrowserSettings>;

  constructor(dataDirectory: string) {
    this.#file = new VersionedFile(
      path.join(dataDirectory, "browser-settings.json"),
      parseSettings,
    );
  }

  async get(): Promise<BrowserSettings & { problem?: string }> {
    const { value, problem } = await this.#file.read();
    return {
      ...(value ?? DEFAULT_BROWSER_SETTINGS),
      ...(problem ? { problem } : {}),
    };
  }

  async set(input: unknown): Promise<BrowserSettings> {
    const settings = parseSettings(input);
    if (!settings)
      throw new BrowserStoreError(
        `Shortcuts need a title and a web address, at most ${BROWSER_MAX_SHORTCUTS} of them.`,
      );
    return this.#file.update(() => settings);
  }
}

/** Each project's tabs and visits, by its records folder. */
export class ProjectBrowserStore {
  readonly #files = new Map<string, VersionedFile<ProjectBrowser>>();

  #file(storagePath: string): VersionedFile<ProjectBrowser> {
    let file = this.#files.get(storagePath);
    if (!file) {
      file = new VersionedFile(
        path.join(storagePath, "browser.json"),
        parseProjectBrowser,
      );
      this.#files.set(storagePath, file);
    }
    return file;
  }

  async get(
    storagePath: string,
  ): Promise<ProjectBrowser & { problem?: string }> {
    const { value, problem } = await this.#file(storagePath).read();
    return {
      ...(value ?? { tabs: [], visits: [] }),
      ...(problem ? { problem } : {}),
    };
  }

  async setTabs(
    storagePath: string,
    input: { tabs?: unknown; active?: unknown },
  ): Promise<ProjectBrowser> {
    const tabs = parseTabs(input.tabs);
    if (!tabs)
      throw new BrowserStoreError(
        `Tabs need an id and a web address or none, at most ${BROWSER_MAX_TABS} of them.`,
      );
    const active =
      typeof input.active === "string" &&
      tabs.some((tab) => tab.id === input.active)
        ? input.active
        : undefined;
    return this.#file(storagePath).update((current) => ({
      tabs,
      ...(active ? { active } : {}),
      visits: current?.visits ?? [],
    }));
  }

  /** Counts a visit to a page, keeping the sites visited most recently. */
  async visit(
    storagePath: string,
    url: unknown,
    title: unknown,
  ): Promise<void> {
    if (typeof url !== "string" || !isBrowserUrl(url))
      throw new BrowserStoreError("A visit needs a web address.");
    const name = typeof title === "string" ? title.slice(0, MAX_TITLE) : "";
    await this.#file(storagePath).update((current) => {
      const visits = current?.visits ?? [];
      const known = visits.find((visit) => visit.url === url);
      const visit: BrowserVisit = {
        url,
        title: name || known?.title || "",
        count: (known?.count ?? 0) + 1,
        last: new Date().toISOString(),
      };
      return {
        tabs: current?.tabs ?? [],
        ...(current?.active ? { active: current.active } : {}),
        visits: [visit, ...visits.filter((entry) => entry.url !== url)].slice(
          0,
          BROWSER_MAX_VISITS,
        ),
      };
    });
  }
}

function parseSettings(value: unknown): BrowserSettings | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { shortcuts, searchEngine } = value as Partial<BrowserSettings>;
  if (!Array.isArray(shortcuts) || shortcuts.length > BROWSER_MAX_SHORTCUTS)
    return undefined;
  if (
    typeof searchEngine !== "string" ||
    !(BROWSER_SEARCH_ENGINES as readonly string[]).includes(searchEngine)
  )
    return undefined;
  const parsed: BrowserShortcut[] = [];
  for (const shortcut of shortcuts as unknown[]) {
    const { title, url } = (shortcut ?? {}) as Partial<BrowserShortcut>;
    if (
      typeof title !== "string" ||
      !title.trim() ||
      title.length > MAX_TITLE ||
      typeof url !== "string" ||
      !isBrowserUrl(url)
    )
      return undefined;
    parsed.push({ title: title.trim(), url });
  }
  return {
    shortcuts: parsed,
    searchEngine: searchEngine as BrowserSettings["searchEngine"],
  };
}

function parseTabs(value: unknown): SavedBrowserTab[] | undefined {
  if (!Array.isArray(value) || value.length > BROWSER_MAX_TABS)
    return undefined;
  const tabs: SavedBrowserTab[] = [];
  const ids = new Set<string>();
  for (const entry of value as unknown[]) {
    const { id, url, title } = (entry ?? {}) as Partial<SavedBrowserTab>;
    if (
      typeof id !== "string" ||
      !/^[\w-]{1,100}$/.test(id) ||
      ids.has(id) ||
      typeof url !== "string" ||
      (url && !isBrowserUrl(url))
    )
      return undefined;
    ids.add(id);
    tabs.push({
      id,
      url,
      title: typeof title === "string" ? title.slice(0, MAX_TITLE) : "",
    });
  }
  return tabs;
}

function parseProjectBrowser(value: unknown): ProjectBrowser | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const { tabs, active, visits } = value as Partial<ProjectBrowser>;
  const parsedTabs = parseTabs(tabs);
  if (!parsedTabs || !Array.isArray(visits)) return undefined;
  const validVisits = visits.every(
    (visit): visit is BrowserVisit =>
      typeof visit?.url === "string" &&
      isBrowserUrl(visit.url) &&
      typeof visit.title === "string" &&
      Number.isInteger(visit.count) &&
      visit.count > 0 &&
      typeof visit.last === "string",
  );
  if (!validVisits || visits.length > BROWSER_MAX_VISITS) return undefined;
  return {
    tabs: parsedTabs,
    ...(typeof active === "string" ? { active } : {}),
    visits,
  };
}
