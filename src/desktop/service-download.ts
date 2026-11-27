import { createWriteStream } from "node:fs";
import { rename, rm } from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import type { ReadableStream as WebReadableStream } from "node:stream/web";
import type { DaemonRuntime, ServiceDownloadResult } from "../shared/desktop-runtime.js";

/** The files the window may save this way: a project's archive and its web build. */
const SAVEABLE = /^\/projects\/[^/?#]+\/(?:export|build)$/;

export function serviceDownloadPath(value: unknown): string | undefined {
  return typeof value === "string" && SAVEABLE.test(value) ? value : undefined;
}

/**
 * Saves a ZIP the background service builds straight to a file the person
 * chooses. The window would otherwise hold the whole file in memory before
 * saving it, which fails for a large project. The service is asked first, so
 * a refusal is reported before any dialog; the file is written beside its
 * target and renamed once complete, so a failed save leaves nothing behind.
 */
export async function saveServiceDownload(options: {
  runtime: DaemonRuntime | undefined;
  path: string;
  version?: string;
  fileName: string;
  chooseFile: (defaultName: string) => Promise<string | undefined>;
  fetch?: (url: string, init: RequestInit) => Promise<Response>;
}): Promise<ServiceDownloadResult> {
  const { runtime } = options;
  if (!runtime) throw new Error("The background service is not running.");
  const controller = new AbortController();
  const response = await (options.fetch ?? fetch)(`${runtime.url}${options.path}`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${runtime.token}`,
      ...(options.version === undefined ? {} : { "x-workspace-version": options.version }),
    },
    signal: controller.signal,
  });
  if (!response.ok) {
    const text = await response.text().catch(() => "");
    let body: unknown = {};
    try { body = JSON.parse(text); } catch { /* not JSON: the window shows a generic message */ }
    return { status: "refused", code: response.status, body };
  }
  if (!response.body) throw new Error("The background service sent an empty file.");
  const target = await options.chooseFile(safeFileName(options.fileName));
  if (!target) {
    controller.abort();
    return { status: "canceled" };
  }
  const partial = `${target}.download`;
  try {
    await pipeline(
      Readable.fromWeb(response.body as WebReadableStream<Uint8Array>),
      createWriteStream(partial, { flags: "w" }),
    );
    await rename(partial, target);
  } catch (cause) {
    controller.abort();
    await rm(partial, { force: true });
    throw cause;
  }
  return { status: "saved" };
}

/** A file name the save dialog can suggest: no folders, nothing the file system refuses. */
function safeFileName(name: string): string {
  const base = path.basename(name.replace(/\\/g, "/")).replace(/[<>:"|?*\u0000-\u001f]/g, "_").trim();
  return base || "download.zip";
}
