import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  fetchHost,
  PLUGIN_UI_FETCH_RESPONSE_MAX_BYTES,
  PLUGIN_UI_FETCH_TIMEOUT_MS,
  type PluginUiCapabilities,
  type PluginUiFetchResponse,
} from "../shared/plugin-ui-protocol.js";
import { PROJECT_PANEL_ERRORS_DIRECTORY, PROJECT_PANELS_DIRECTORY } from "../shared/project-layout.js";
import {
  parseProjectPanelManifest,
  PROJECT_PANEL_FILE,
  PROJECT_PANEL_NAME,
  PROJECT_PANELS_MAX,
  projectPanelAsksText,
  type ProjectPanelManifest,
  type ProjectPanelState,
} from "../shared/project-panels.js";
import { realFolders } from "./project-layout.js";

/** A panel `listProjectPanels` found, with what the app needs to show it. */
export interface FoundProjectPanel extends ProjectPanelState {
  manifest?: ProjectPanelManifest;
  /** Changes whenever one of its files does, so its page loads again. */
  revision?: string;
}

const APPROVALS_FILE = "panel-approvals.json";
const PANEL_FILES_MAX = 500;
const ERROR_LOG_MAX_BYTES = 32 * 1024;

/**
 * The project's panels, by folder name. A folder reached through a symbolic
 * link is left out: a panel is the project's own files. `allowed` is what the
 * person allowed for each, by name.
 */
export async function listProjectPanels(workspacePath: string, allowed: Readonly<Record<string, string>>): Promise<FoundProjectPanel[]> {
  if (!(await realFolders(workspacePath, PROJECT_PANELS_DIRECTORY))) return [];
  const directory = path.join(workspacePath, ...PROJECT_PANELS_DIRECTORY.split("/"));
  const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
  const names = entries.filter((entry) => entry.isDirectory() && PROJECT_PANEL_NAME.test(entry.name)).map((entry) => entry.name).sort().slice(0, PROJECT_PANELS_MAX);
  return Promise.all(names.map(async (name): Promise<FoundProjectPanel> => {
    const folder = path.join(directory, name);
    let value: unknown;
    try {
      value = JSON.parse(await readFile(path.join(folder, PROJECT_PANEL_FILE), "utf8"));
    } catch (cause) {
      const missing = (cause as NodeJS.ErrnoException).code === "ENOENT";
      return { name, status: "invalid", issues: [missing ? `${PROJECT_PANEL_FILE} is missing` : `${PROJECT_PANEL_FILE} is not JSON`] };
    }
    const parsed = parseProjectPanelManifest(value);
    if (!parsed.ok) return { name, status: "invalid", issues: parsed.issues };
    const entry = await lstat(path.join(folder, ...parsed.manifest.entry.split("/"))).catch(() => undefined);
    if (!entry?.isFile()) return { name, status: "invalid", issues: [`${parsed.manifest.entry} is missing`] };
    const revision = await folderRevision(folder);
    if (!revision) return { name, status: "invalid", issues: [`the panel's folder holds more than ${PANEL_FILES_MAX} files and folders`] };
    const key = askKey(parsed.manifest.capabilities);
    return {
      name,
      status: allowed[name] === key ? "allowed" : "needs-approval",
      asks: parsed.manifest.capabilities,
      key,
      manifest: parsed.manifest,
      revision,
    };
  }));
}

/** The folder a panel's page is served from, when it is the project's own. */
export async function projectPanelFolder(workspacePath: string, name: string): Promise<string | undefined> {
  if (!PROJECT_PANEL_NAME.test(name)) return undefined;
  const relative = `${PROJECT_PANELS_DIRECTORY}/${name}`;
  if (!(await realFolders(workspacePath, relative))) return undefined;
  const folder = path.join(workspacePath, ...relative.split("/"));
  return (await stat(folder).catch(() => undefined))?.isDirectory() ? folder : undefined;
}

function askKey(capabilities: PluginUiCapabilities): string {
  return createHash("sha256").update(projectPanelAsksText(capabilities)).digest("hex").slice(0, 32);
}

/** A hash of the panel's files, so its page reloads when one changes; undefined past `PANEL_FILES_MAX`, as it would miss changes. */
async function folderRevision(folder: string): Promise<string | undefined> {
  const hash = createHash("sha256");
  let count = 0;
  const walk = async (current: string, relative: string): Promise<void> => {
    for (const entry of (await readdir(current, { withFileTypes: true })).sort((left, right) => left.name.localeCompare(right.name))) {
      if (++count > PANEL_FILES_MAX) return;
      if (entry.isSymbolicLink()) continue;
      const child = path.join(current, entry.name);
      const name = relative ? `${relative}/${entry.name}` : entry.name;
      if (entry.isDirectory()) await walk(child, name);
      else if (entry.isFile()) {
        const stats = await stat(child);
        hash.update(`${name}\0${stats.size}\0${stats.mtimeMs}\n`);
      }
    }
  };
  await walk(folder, "").catch(() => {});
  return count > PANEL_FILES_MAX ? undefined : hash.digest("hex").slice(0, 16);
}

/**
 * What the person allowed each of a project's panels to ask for. It is kept
 * with the project's own storage, never in its folder, so a panel or a
 * project from elsewhere can't allow itself.
 */
export class ProjectPanelApprovals {
  readonly #writes = new Map<string, Promise<unknown>>();

  async read(storagePath: string): Promise<Record<string, string>> {
    try {
      const value = JSON.parse(await readFile(path.join(storagePath, APPROVALS_FILE), "utf8")) as { version?: unknown; panels?: unknown };
      if (value.version !== 1 || !value.panels || typeof value.panels !== "object") return {};
      return Object.fromEntries(Object.entries(value.panels).filter(([name, key]) => PROJECT_PANEL_NAME.test(name) && typeof key === "string"));
    } catch {
      return {};
    }
  }

  /** Allows what a panel asks for now, named by the key the person was shown. */
  allow(storagePath: string, name: string, key: string): Promise<void> {
    const run = (this.#writes.get(storagePath) ?? Promise.resolve()).catch(() => {}).then(async () => {
      const panels = { ...(await this.read(storagePath)), [name]: key };
      const destination = path.join(storagePath, APPROVALS_FILE);
      const temporary = `${destination}.${randomUUID()}.tmp`;
      try {
        await writeFile(temporary, `${JSON.stringify({ version: 1, panels }, null, 2)}\n`, { flag: "wx" });
        await rename(temporary, destination);
      } finally {
        await rm(temporary, { force: true });
      }
    });
    this.#writes.set(storagePath, run);
    return run;
  }
}

/** Keeps the latest errors of a panel's page where the project's agent can read them. */
export async function recordProjectPanelError(workspacePath: string, name: string, text: string): Promise<void> {
  if (!PROJECT_PANEL_NAME.test(name) || !(await realFolders(workspacePath, PROJECT_PANEL_ERRORS_DIRECTORY))) return;
  const directory = path.join(workspacePath, ...PROJECT_PANEL_ERRORS_DIRECTORY.split("/"));
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${name}.log`);
  const before = await readFile(file, "utf8").catch(() => "");
  const next = `${before}${new Date().toISOString()} ${text.slice(0, 4000)}\n`;
  // Only the latest errors are worth reading; the oldest lines go first.
  const kept = next.length > ERROR_LOG_MAX_BYTES ? next.slice(next.indexOf("\n", next.length - ERROR_LOG_MAX_BYTES) + 1) : next;
  const stats = await lstat(file).catch(() => undefined);
  if (stats && !stats.isFile()) return;
  await writeFile(file, kept);
}

export class ProjectPanelFetchError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

/**
 * Makes a panel's `net.fetch` request, only to a host its `panel.json` names
 * and the person allowed. Nothing of the person's goes along: no cookies, and
 * a redirect comes back to the page rather than being followed elsewhere.
 */
export async function projectPanelFetch(
  capabilities: PluginUiCapabilities,
  request: { url: string; method?: string; headers?: Record<string, string>; body?: string },
  fetcher: typeof fetch = fetch,
): Promise<PluginUiFetchResponse> {
  const host = fetchHost(request.url);
  if (!host) throw new ProjectPanelFetchError("net.fetch needs an https: address without a port or user name");
  if (!capabilities.net?.includes(host)) throw new ProjectPanelFetchError(`This panel may not reach ${host}; add it to net in panel.json`, 403);
  const method = request.method ?? "GET";
  let response: Response;
  try {
    response = await fetcher(request.url, {
      method,
      headers: request.headers ?? {},
      ...(request.body !== undefined && method !== "GET" && method !== "HEAD" ? { body: request.body } : {}),
      redirect: "manual",
      credentials: "omit",
      signal: AbortSignal.timeout(PLUGIN_UI_FETCH_TIMEOUT_MS),
    });
  } catch (cause) {
    throw new ProjectPanelFetchError(`${host} could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`, 502);
  }
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > PLUGIN_UI_FETCH_RESPONSE_MAX_BYTES) throw new ProjectPanelFetchError("The answer is larger than 5 MB", 502);
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > PLUGIN_UI_FETCH_RESPONSE_MAX_BYTES) throw new ProjectPanelFetchError("The answer is larger than 5 MB", 502);
      chunks.push(chunk);
    }
  }
  const headers: Record<string, string> = {};
  for (const name of ["content-type", "content-length", "etag", "last-modified", "location", "retry-after"]) {
    const value = response.headers.get(name);
    if (value !== null) headers[name] = value;
  }
  return { status: response.status, statusText: response.statusText, url: request.url, headers, body: Buffer.concat(chunks).toString("utf8") };
}
