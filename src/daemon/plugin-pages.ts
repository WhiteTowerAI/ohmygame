import { lstat, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { networkCovers } from "../shared/plugin-manifest.js";
import {
  fetchHost,
  PLUGIN_UI_FETCH_RESPONSE_MAX_BYTES,
  PLUGIN_UI_FETCH_TIMEOUT_MS,
  type PluginUiFetchResponse,
} from "../shared/plugin-ui-protocol.js";
import { PROJECT_PLUGIN_ERRORS_DIRECTORY } from "../shared/project-layout.js";
import { realFolders } from "./project-layout.js";

// What a plugin's page asks the app for beyond the project's files: the
// network, at the hosts its manifest lists, and, for a plugin the project
// carries, a place in the project for the errors it didn't catch.

const ERROR_LOG_MAX_BYTES = 32 * 1024;

/** Where a page's uncaught errors are kept, in the project, for a plugin it carries. */
export function projectPluginErrorLog(id: string): string {
  return `${PROJECT_PLUGIN_ERRORS_DIRECTORY}/${id.replace("/", "__")}.log`;
}

/** Keeps the latest errors of a page of a plugin the project carries, where the project's agent reads them. */
export async function recordProjectPluginError(workspacePath: string, id: string, text: string): Promise<void> {
  if (!(await realFolders(workspacePath, PROJECT_PLUGIN_ERRORS_DIRECTORY))) return;
  await mkdir(path.join(workspacePath, ...PROJECT_PLUGIN_ERRORS_DIRECTORY.split("/")), { recursive: true });
  const file = path.join(workspacePath, ...projectPluginErrorLog(id).split("/"));
  const before = await readFile(file, "utf8").catch(() => "");
  const next = `${before}${new Date().toISOString()} ${text.slice(0, 4000)}\n`;
  // Only the latest errors are worth reading; the oldest lines go first.
  const kept = next.length > ERROR_LOG_MAX_BYTES ? next.slice(next.indexOf("\n", next.length - ERROR_LOG_MAX_BYTES) + 1) : next;
  const stats = await lstat(file).catch(() => undefined);
  if (stats && !stats.isFile()) return;
  await writeFile(file, kept);
}

export class PluginPageFetchError extends Error {
  constructor(message: string, readonly statusCode = 400) {
    super(message);
  }
}

/**
 * Makes a page's `net.fetch` request, only to a host its manifest's
 * `capabilities.network` lists, which the person saw when adding the plugin.
 * Nothing of the person's goes along: no cookies, and a redirect comes back
 * to the page rather than being followed elsewhere.
 */
export async function pluginPageFetch(
  network: readonly string[],
  request: { url: string; method?: string; headers?: Record<string, string>; body?: string },
  fetcher: typeof fetch = fetch,
): Promise<PluginUiFetchResponse> {
  const host = fetchHost(request.url);
  if (!host) throw new PluginPageFetchError("net.fetch needs an https: address without a port or user name");
  if (!networkCovers(network, new URL(request.url)))
    throw new PluginPageFetchError(`This page may not reach ${host}; add it to capabilities.network in the plugin's manifest`, 403);
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
    throw new PluginPageFetchError(`${host} could not be reached: ${cause instanceof Error ? cause.message : String(cause)}`, 502);
  }
  const length = Number(response.headers.get("content-length") ?? 0);
  if (length > PLUGIN_UI_FETCH_RESPONSE_MAX_BYTES) throw new PluginPageFetchError("The answer is larger than 5 MB", 502);
  const chunks: Uint8Array[] = [];
  let size = 0;
  if (response.body) {
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      size += chunk.byteLength;
      if (size > PLUGIN_UI_FETCH_RESPONSE_MAX_BYTES) throw new PluginPageFetchError("The answer is larger than 5 MB", 502);
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
