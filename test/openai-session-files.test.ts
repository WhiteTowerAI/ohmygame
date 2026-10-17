import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { SessionManager } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OpenAISessionFiles } from "../src/daemon/openai-session-files.js";
import { OpenAISessionTransport, type ResponseSocket } from "../src/daemon/openai-session-transport.js";
import { SessionImages } from "../src/daemon/session-images.js";

const dirs: string[] = [];
afterEach(async () => { vi.useRealTimers(); await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))); });
const json = (value: unknown, status = 200) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
const image = { type: "input_image", detail: "auto", image_url: "data:image/png;base64,YWJj" };
const payload = () => ({ model: "gpt-5.6", stream: true, store: false, input: [{ role: "user", content: [{ ...image }] }] });
async function directory() { const dir = await mkdtemp(path.join(tmpdir(), "ohmygame-openai-files-")); dirs.push(dir); return dir; }
class API {
  uploads = 0;
  verifications = 0;
  auth: string[] = [];
  forms: FormData[] = [];
  bodies: any[] = [];
  uploadStatus = 200;
  missing = false;
  model: (body: any) => Response = () => json({ ok: true });
  uploadWait?: (signal: AbortSignal) => Promise<void>;
  fetch: typeof globalThis.fetch = vi.fn(async (input, init) => {
    const request = new Request(input, init); const url = new URL(request.url);
    this.auth.push(request.headers.get("authorization") ?? "");
    if (url.pathname === "/v1/files" && request.method === "POST") {
      this.uploads++; const id = `file-${this.uploads}`;
      this.forms.push(await request.formData());
      await this.uploadWait?.(request.signal);
      const file = this.forms.at(-1)!.get("file") as File;
      return json({ id, bytes: file.size, expires_at: Date.now() / 1000 + 86400 }, this.uploadStatus);
    }
    if (url.pathname.startsWith("/v1/files/")) {
      this.verifications++;
      return this.missing ? json({ error: "missing" }, 404) : json({ id: url.pathname.split("/").at(-1), bytes: 3, expires_at: Date.now() / 1000 + 86400 });
    }
    const body = await request.json(); this.bodies.push(body); return this.model(body);
  });
}
const headers = (key = "sk-key-a", project?: string) => new Headers({ authorization: `Bearer ${key}`, ...(project ? { "openai-project": project } : {}) });
const replace = (files: OpenAISessionFiles, api: API, key?: string, project?: string, signal = new AbortController().signal) => files.replace(payload(), headers(key, project), api.fetch, signal);

describe("OpenAI session image files", () => {
  it("uploads once, persists mappings, and scopes them by credentials and project", async () => {
    const dir = await directory(); const api = new API(); const files = new OpenAISessionFiles(dir);
    const request = payload(); await files.replace(request, headers(), api.fetch, new AbortController().signal);
    expect(request.input[0].content[0]).toEqual({ type: "input_image", detail: "auto", file_id: "file-1" });
    expect(api.forms[0].get("purpose")).toBe("vision");
    expect(api.forms[0].get("expires_after[seconds]")).toBe("604800");
    expect(Buffer.from(await (api.forms[0].get("file") as File).arrayBuffer()).toString()).toBe("abc");
    await replace(new OpenAISessionFiles(dir), api); expect(api.uploads).toBe(1);
    await replace(files, api, "sk-key-b"); await replace(files, api, "sk-key-a", "project-b");
    expect(api.uploads).toBe(3);
  });

  it("verifies cached IDs after the TTL and reuploads missing files", async () => {
    vi.useFakeTimers(); const api = new API(); const files = new OpenAISessionFiles(await directory());
    await replace(files, api);
    vi.setSystemTime(Date.now() + 6 * 60 * 1000); await replace(files, api);
    expect(api.verifications).toBe(1); expect(api.uploads).toBe(1);
    vi.setSystemTime(Date.now() + 6 * 60 * 1000); api.missing = true; await replace(files, api);
    expect(api.uploads).toBe(2);
  });

  it("keeps the entire inline payload intact when only some uploads succeed", async () => {
    const api = new API(); const files = new OpenAISessionFiles(await directory());
    await replace(files, api);
    api.uploadStatus = 403;
    const request = payload(); request.input[0].content.push({ ...image, image_url: "data:image/png;base64,ZGVm" });
    const original = structuredClone(request);
    await expect(files.replace(request, headers(), api.fetch, new AbortController().signal)).rejects.toThrow("upload failed");
    expect(request).toEqual(original);
    api.uploadStatus = 200;
    const repeated = payload(); repeated.input[0].content.push({ ...image });
    const used = await files.replace(repeated, headers(), api.fetch, new AbortController().signal);
    expect(used).toHaveLength(1); expect(api.uploads).toBe(2);
    expect(repeated.input[0].content).toEqual(Array.from({ length: 2 }, () => ({ type: "input_image", detail: "auto", file_id: "file-1" })));
  });

  it("deduplicates concurrent uploads and lets one caller abort without cancelling another", async () => {
    const api = new API(); const files = new OpenAISessionFiles(await directory());
    let release!: () => void;
    api.uploadWait = () => new Promise<void>((resolve) => { release = resolve; });
    const abort = new AbortController();
    const first = replace(files, api, undefined, undefined, abort.signal);
    const second = replace(files, api);
    await vi.waitFor(() => expect(api.uploads).toBe(1));
    abort.abort(new Error("cancelled")); await expect(first).rejects.toThrow("cancelled");
    release(); await second;
    expect(api.uploads).toBe(1); await replace(files, api); expect(api.uploads).toBe(1);
  });

  it("recovers an explicitly stale file once on the model request, keeping originals intact", async () => {
    const dir = await directory(); const api = new API();
    api.model = (body) => body.input[0].content[0].file_id === "file-1"
      ? json({ error: { code: "file_not_found", message: "file-1 not found" } }, 400) : json({ ok: true });
    const original = payload();
    const transport = new OpenAISessionTransport(new SessionImages(SessionManager.inMemory(dir), dir), new OpenAISessionFiles(dir));
    const fetch = transport.wrapFetch(api.fetch, { transport: "sse" });
    const response = await fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { ...Object.fromEntries(headers()), "content-type": "application/json" }, body: JSON.stringify(original) });
    expect(response.status).toBe(200); expect(api.uploads).toBe(2); expect(api.bodies).toHaveLength(2);
    expect(api.bodies[1].input[0].content[0].file_id).toBe("file-2");
    expect(original).toEqual(payload()); transport.dispose();
  });

  it("uses bounded inline fallback and backs off unsupported uploads", async () => {
    const dir = await directory(); const api = new API(); api.uploadStatus = 403;
    const transport = new OpenAISessionTransport(new SessionImages(SessionManager.inMemory(dir), dir), new OpenAISessionFiles(dir));
    const fetch = transport.wrapFetch(api.fetch, { transport: "sse" });
    const send = (body: unknown) => fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { ...Object.fromEntries(headers()), "content-type": "application/json" }, body: JSON.stringify(body) });
    expect((await send(payload())).status).toBe(200); expect((await send(payload())).status).toBe(200);
    expect(api.uploads).toBe(1); expect(api.bodies[0].input[0].content[0]).toEqual(image);
    const large = payload(); large.input[0].content[0].image_url = `data:image/png;base64,${"a".repeat(21 * 1024 * 1024)}`;
    expect((await send(large)).status).toBe(413); expect(api.bodies).toHaveLength(2);
    transport.dispose();
  });

  it("never treats unrelated model errors as expired files", async () => {
    const dir = await directory(); const api = new API(); api.model = () => json({ error: { code: "invalid_image", message: "invalid image format" } }, 400);
    const transport = new OpenAISessionTransport(new SessionImages(SessionManager.inMemory(dir), dir), new OpenAISessionFiles(dir));
    const response = await transport.wrapFetch(api.fetch, { transport: "sse" })("https://api.openai.com/v1/responses", { method: "POST", headers: { ...Object.fromEntries(headers()), "content-type": "application/json" }, body: JSON.stringify(payload()) });
    expect(response.status).toBe(400); expect(api.uploads).toBe(1); expect(api.bodies).toHaveLength(1); transport.dispose();
  });

  it("preserves all image occurrences when Files removes the inline budget pressure", async () => {
    const dir = await directory(); const api = new API();
    const manager = SessionManager.inMemory(dir);
    const transport = new OpenAISessionTransport(new SessionImages(manager, dir), new OpenAISessionFiles(dir));
    const request = payload(); request.input[0].content = Array.from({ length: 70 }, () => ({ ...image }));
    const response = await transport.wrapFetch(api.fetch, { transport: "sse" })("https://api.openai.com/v1/responses", { method: "POST", headers: { ...Object.fromEntries(headers()), "content-type": "application/json" }, body: JSON.stringify(request) });
    expect(response.status).toBe(200);
    expect(api.bodies[0].input[0].content).toHaveLength(70);
    expect(api.bodies[0].input[0].content.every((image: any) => image.file_id === "file-1")).toBe(true);
    expect(api.uploads).toBe(1); expect(manager.getEntries()).toHaveLength(0);
    transport.dispose();
  });

  it.each([false, true])("invalidates file errors before or after the first WS event, without replaying a started response: %s", async (started) => {
    const dir = await directory(); const api = new API(); const requests: any[] = [];
    class FileSocket extends EventTarget implements ResponseSocket {
      readyState = 0;
      constructor() { super(); queueMicrotask(() => { this.readyState = 1; this.dispatchEvent(new Event("open")); }); }
      send(data: string) {
        const request = JSON.parse(data); requests.push(request);
        queueMicrotask(() => {
          const emit = (data: unknown) => this.dispatchEvent(new MessageEvent("message", { data: JSON.stringify(data) }));
          if (request.input[0].content[0].file_id === "file-1") {
            if (started) emit({ type: "response.created", response: { id: "failed-1" } });
            emit({ type: "response.failed", response: { id: "failed-1", error: { code: "file_not_found", message: "file-1 not found" } } });
          } else emit({ type: "response.completed", response: { id: "resp-success", status: "completed", output: [] } });
        });
      }
      close() { this.readyState = 3; this.dispatchEvent(new Event("close")); }
    }
    const transport = new OpenAISessionTransport(new SessionImages(SessionManager.inMemory(dir), dir), new OpenAISessionFiles(dir), () => new FileSocket());
    const fetch = transport.wrapFetch(api.fetch);
    const send = () => fetch("https://api.openai.com/v1/responses", { method: "POST", headers: { ...Object.fromEntries(headers()), "content-type": "application/json" }, body: JSON.stringify(payload()) });
    const response = await send();
    if (started) {
      await expect(response.text()).rejects.toThrow("file_not_found: file-1 not found"); expect(requests).toHaveLength(1);
      expect(await (await send()).text()).toContain("resp-success");
    } else expect(await response.text()).toContain("resp-success");
    expect(api.uploads).toBe(2); expect(requests).toHaveLength(2); expect(api.bodies).toHaveLength(0);
    transport.dispose();
  });
});
