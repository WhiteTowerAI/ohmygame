import { mkdtemp, readdir, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { saveServiceDownload, serviceDownloadPath } from "../src/desktop/service-download.js";

const runtime = { url: "http://127.0.0.1:43110", token: "secret" };
let folder: string;

beforeEach(async () => {
  folder = await mkdtemp(path.join(tmpdir(), "ohmygame-service-download-"));
});
afterEach(async () => {
  await rm(folder, { recursive: true, force: true });
});

/** A response whose body arrives in chunks, failing after them if asked. */
function chunked(chunks: string[], fail?: Error): Response {
  const body = new ReadableStream<Uint8Array>({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      if (fail) controller.error(fail);
      else controller.close();
    },
  });
  return new Response(body, { headers: { "content-type": "application/zip" } });
}

describe("saving a file the background service builds", () => {
  it("accepts only a project's archive and web build", () => {
    expect(serviceDownloadPath("/projects/p-1/export")).toBe("/projects/p-1/export");
    expect(serviceDownloadPath("/projects/p-1/build")).toBe("/projects/p-1/build");
    for (const other of ["/projects/p-1/files/a", "/settings/model-auth", "/projects/p-1/export?x=1", "https://example.com/projects/p/export", 3]) {
      expect(serviceDownloadPath(other)).toBeUndefined();
    }
  });

  it("asks the service, then writes the file to the chosen place as it arrives", async () => {
    const fetch = vi.fn(async () => chunked(["PK", "zip ", "body"]));
    const target = path.join(folder, "Moon Garden.zip");
    const chooseFile = vi.fn(async () => target);

    await expect(saveServiceDownload({ runtime, path: "/projects/p-1/export", version: "v1", fileName: "Moon Garden.zip", chooseFile, fetch }))
      .resolves.toEqual({ status: "saved" });

    expect(fetch).toHaveBeenCalledWith("http://127.0.0.1:43110/projects/p-1/export", expect.objectContaining({
      method: "POST",
      headers: { authorization: "Bearer secret", "x-workspace-version": "v1" },
    }));
    expect(chooseFile).toHaveBeenCalledWith("Moon Garden.zip");
    expect(await readFile(target, "utf8")).toBe("PKzip body");
    expect(await readdir(folder)).toEqual(["Moon Garden.zip"]);
  });

  it("reports a refusal without asking where to save", async () => {
    const fetch = vi.fn(async () => Response.json({ error: "Wait for the agent to finish before exporting" }, { status: 409 }));
    const chooseFile = vi.fn();

    await expect(saveServiceDownload({ runtime, path: "/projects/p-1/export", fileName: "a.zip", chooseFile, fetch }))
      .resolves.toEqual({ status: "refused", code: 409, body: { error: "Wait for the agent to finish before exporting" } });
    expect(chooseFile).not.toHaveBeenCalled();
  });

  it("stops the download when the person cancels the save", async () => {
    let signal: AbortSignal | undefined;
    const fetch = vi.fn(async (_url: string, init?: RequestInit) => {
      signal = init?.signal ?? undefined;
      return chunked(["PK"]);
    });

    await expect(saveServiceDownload({ runtime, path: "/projects/p-1/build", fileName: "a.zip", chooseFile: async () => undefined, fetch }))
      .resolves.toEqual({ status: "canceled" });
    expect(signal?.aborted).toBe(true);
    expect(await readdir(folder)).toEqual([]);
  });

  it("leaves nothing behind when the download breaks partway", async () => {
    const fetch = vi.fn(async () => chunked(["PK", "partial"], new Error("connection reset")));
    const target = path.join(folder, "a.zip");

    await expect(saveServiceDownload({ runtime, path: "/projects/p-1/export", fileName: "a.zip", chooseFile: async () => target, fetch }))
      .rejects.toThrow("connection reset");
    expect(await readdir(folder)).toEqual([]);
  });

  it("suggests a plain file name and needs a running service", async () => {
    const chooseFile = vi.fn(async () => undefined);
    await saveServiceDownload({ runtime, path: "/projects/p-1/export", fileName: "../a:b.zip", chooseFile, fetch: async () => chunked([]) });
    expect(chooseFile).toHaveBeenCalledWith("a_b.zip");
    await expect(saveServiceDownload({ runtime: undefined, path: "/projects/p-1/export", fileName: "a.zip", chooseFile })).rejects.toThrow("not running");
  });
});
