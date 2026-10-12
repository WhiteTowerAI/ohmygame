import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import sharp from "sharp";
import { Type } from "typebox";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createProviderImageReadTool,
  DEEPSEEK_FILE_VERIFICATION_TTL_MS,
  DEEPSEEK_REQUEST_LIMIT,
  DeepSeekImageFiles,
  installDeepSeekImageFiles,
  isDeepSeekFileModel,
} from "../src/daemon/deepseek-image-files.js";

const directories: string[] = [];
afterEach(async () => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function temporaryDirectory() {
  const dir = await mkdtemp(path.join(tmpdir(), "ohmygame-deepseek-"));
  directories.push(dir);
  return dir;
}
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { "content-type": "application/json" },
  });
const inline = (bytes: Buffer) => ({
  type: "image_url",
  image_url: { url: `data:image/png;base64,${bytes.toString("base64")}` },
});
const imagePayload = (bytes: Buffer) => ({
  model: "deepseek-flash",
  messages: [
    {
      role: "user",
      content: [{ type: "text", text: "Keep every detail" }, inline(bytes)],
    },
  ],
});
function send(
  fetch: typeof globalThis.fetch,
  payload: unknown,
  key = "key-a",
  signal?: AbortSignal,
  endpoint = "https://api.deepseek.com/chat/completions",
) {
  return fetch(endpoint, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      authorization: `Bearer ${key}`,
    },
    body: JSON.stringify(payload),
    signal,
  });
}

class FakeDeepSeek {
  uploads: Array<{ bytes: Buffer; authorization: string; lifetime: string }> =
    [];
  files = new Map<string, { id: string; bytes: number; expires_at: number }>();
  modelBodies: Record<string, any>[] = [];
  uploadStatus = 200;
  verificationStatus = 200;
  verifications = 0;
  nextFileId = 1;
  onUpload?: (signal: AbortSignal) => Promise<void>;
  modelResponse: (body: Record<string, any>) => Response | Promise<Response> =
    () => json({ ok: true });
  fetch: typeof globalThis.fetch = vi.fn(async (input, init) => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    if (url.pathname === "/files" && request.method === "POST") {
      await this.onUpload?.(request.signal);
      request.signal.throwIfAborted();
      if (this.uploadStatus !== 200)
        return json({ error: { message: "storage full" } }, this.uploadStatus);
      const form = await request.formData();
      expect(form.get("purpose")).toBe("user_data");
      expect(form.get("expires_after[anchor]")).toBe("created_at");
      expect(request.redirect).toBe("error");
      const bytes = Buffer.from(await (form.get("file") as Blob).arrayBuffer());
      this.uploads.push({
        bytes,
        authorization: request.headers.get("authorization")!,
        lifetime: String(form.get("expires_after[seconds]")),
      });
      const file = {
        id: `file-api-${this.nextFileId++}`,
        bytes: bytes.length,
        expires_at: Date.now() / 1000 + 7 * 86400,
      };
      this.files.set(file.id, file);
      return json(file);
    }
    if (url.pathname.startsWith("/files/")) {
      this.verifications++;
      expect(request.redirect).toBe("error");
      if (this.verificationStatus !== 200)
        return json({ error: {} }, this.verificationStatus);
      const file = this.files.get(url.pathname.slice("/files/".length));
      return json(
        file ?? { error: { message: "file missing" } },
        file ? 200 : 404,
      );
    }
    const body = await request.json();
    this.modelBodies.push(body);
    return this.modelResponse(body);
  });
}

describe("DeepSeek image file transport", () => {
  it("passes the exact original text-only JSON through without uploading files", async () => {
    const original = JSON.stringify(
      {
        messages: [{ role: "user", content: "保留完整文本" }],
        tools: [{ name: "read" }],
      },
      null,
      2,
    );
    let received: string | undefined;
    const delegate: typeof globalThis.fetch = vi.fn(async (input, init) => {
      received = await new Request(input, init).text();
      return json({ ok: true });
    });
    const dir = await temporaryDirectory();
    const fetch = new DeepSeekImageFiles(dir).wrapFetch(delegate);
    expect(
      (
        await fetch("https://api.deepseek.com/chat/completions", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: original,
        })
      ).status,
    ).toBe(200);
    expect(received).toBe(original);
    expect(delegate).toHaveBeenCalledOnce();
    expect(await readdir(dir)).toEqual([]);
  });

  it("checks the full text-only request size including JSON whitespace before sending", async () => {
    const delegate: typeof globalThis.fetch = vi.fn();
    const fetch = new DeepSeekImageFiles(await temporaryDirectory()).wrapFetch(
      delegate,
    );
    const response = await fetch("https://api.deepseek.com/responses", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ input: [] }).padEnd(DEEPSEEK_REQUEST_LIMIT + 1),
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("48 MiB");
    expect(delegate).not.toHaveBeenCalled();
  });

  it("preserves all history while taking an image-heavy request below the 48 MiB limit", async () => {
    const api = new FakeDeepSeek();
    const fetch = new DeepSeekImageFiles(await temporaryDirectory()).wrapFetch(
      api.fetch,
    );
    const images = Array.from({ length: 25 }, (_, index) =>
      Buffer.alloc(1_600_000, index),
    );
    const payload = {
      messages: images.map((bytes, index) => ({
        role: "user",
        content: [{ type: "text", text: `Screenshot ${index}` }, inline(bytes)],
      })),
      tools: [{ name: "read" }],
    };
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThan(
      DEEPSEEK_REQUEST_LIMIT,
    );
    expect((await send(fetch, payload)).status).toBe(200);
    const body = api.modelBodies[0];
    expect(Buffer.byteLength(JSON.stringify(body))).toBeLessThan(10_000);
    expect(body.messages).toHaveLength(25);
    expect(body.tools).toEqual(payload.tools);
    for (let index = 0; index < images.length; index++) {
      expect(body.messages[index].content[0]).toEqual(
        payload.messages[index].content[0],
      );
      expect(body.messages[index].content[1]).toEqual({
        type: "file",
        file_id: expect.stringMatching(/^file-api-/),
      });
      expect(
        api.uploads.some((upload) => upload.bytes.equals(images[index])),
      ).toBe(true);
    }
    expect(payload.messages[0].content[1]).toEqual(inline(images[0]));
  });

  it("deduplicates original bytes, reuses disk cache after restart and isolates credentials", async () => {
    const api = new FakeDeepSeek();
    const dir = await temporaryDirectory();
    const bytes = Buffer.from("original PNG bytes");
    const payload = {
      messages: [{ role: "user", content: [inline(bytes), inline(bytes)] }],
    };
    await send(new DeepSeekImageFiles(dir).wrapFetch(api.fetch), payload);
    expect(api.uploads).toHaveLength(1);
    await send(new DeepSeekImageFiles(dir).wrapFetch(api.fetch), payload);
    expect(api.uploads).toHaveLength(1);
    await send(
      new DeepSeekImageFiles(dir).wrapFetch(api.fetch),
      payload,
      "key-b",
    );
    expect(api.uploads).toHaveLength(2);
    expect(api.uploads.map((upload) => upload.authorization)).toEqual([
      "Bearer key-a",
      "Bearer key-b",
    ]);
    const accounts = await readdir(dir);
    for (const account of accounts) {
      for (const file of await readdir(path.join(dir, account))) {
        const cache = await readFile(path.join(dir, account, file), "utf8");
        expect(cache).not.toContain("key-");
        expect(cache).not.toContain(bytes.toString("base64"));
      }
    }
  });

  it("retains repeated image occurrences and counts each toward the image limit", async () => {
    const api = new FakeDeepSeek();
    const fetch = new DeepSeekImageFiles(await temporaryDirectory()).wrapFetch(
      api.fetch,
    );
    const bytes = Buffer.from("repeated original image");
    const payload = {
      messages: [
        {
          role: "user",
          content: Array.from({ length: 600 }, () => inline(bytes)),
        },
      ],
    };
    expect((await send(fetch, payload)).status).toBe(200);
    expect(api.uploads).toHaveLength(1);
    expect(api.uploads[0].bytes.equals(bytes)).toBe(true);
    expect(api.modelBodies[0].messages[0].content).toEqual(
      Array.from({ length: 600 }, () => ({
        type: "file",
        file_id: "file-api-1",
      })),
    );
    payload.messages[0].content.push(inline(bytes));
    const response = await send(fetch, payload);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("600 images");
    expect(api.modelBodies).toHaveLength(1);
    expect(
      payload.messages[0].content.every(
        (block) => block.image_url.url === inline(bytes).image_url.url,
      ),
    ).toBe(true);
  });

  it("reuploads files that were deleted or expired without discarding the local image", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const api = new FakeDeepSeek();
    const dir = await temporaryDirectory();
    const fetch = new DeepSeekImageFiles(dir).wrapFetch(api.fetch);
    const payload = imagePayload(Buffer.from("image"));
    await send(fetch, payload);
    api.files.clear();
    now += DEEPSEEK_FILE_VERIFICATION_TTL_MS;
    await send(fetch, payload);
    expect(api.uploads).toHaveLength(2);
    const accountDir = path.join(dir, (await readdir(dir))[0]);
    const cachePath = path.join(accountDir, (await readdir(accountDir))[0]);
    const cached = JSON.parse(await readFile(cachePath, "utf8"));
    await writeFile(cachePath, JSON.stringify({ ...cached, expiresAt: 1 }));
    await send(fetch, payload);
    expect(api.uploads).toHaveLength(3);
    expect(
      api.modelBodies.map((body) => body.messages[0].content[1].file_id),
    ).toEqual(["file-api-1", "file-api-2", "file-api-3"]);
  });

  it("handles Responses user images and tool outputs, preserving text and image detail", async () => {
    const api = new FakeDeepSeek();
    const fetch = new DeepSeekImageFiles(await temporaryDirectory()).wrapFetch(
      api.fetch,
    );
    const url = inline(Buffer.from("image")).image_url.url;
    const payload = {
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Inspect" },
            { type: "input_image", image_url: url, detail: "original" },
          ],
        },
        {
          type: "function_call_output",
          call_id: "call-1",
          output: [{ type: "input_image", image_url: url }],
        },
      ],
    };
    await send(
      fetch,
      payload,
      "key-a",
      undefined,
      "https://api.deepseek.com/v1/responses",
    );
    expect(api.uploads).toHaveLength(1);
    expect(api.modelBodies[0].input).toEqual([
      {
        role: "user",
        content: [
          { type: "input_text", text: "Inspect" },
          { type: "input_image", file_id: "file-api-1", detail: "original" },
        ],
      },
      {
        type: "function_call_output",
        call_id: "call-1",
        output: [{ type: "input_image", file_id: "file-api-1" }],
      },
    ]);
  });

  it("reuses verification for five minutes across restarts, then verifies once per distinct image", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const api = new FakeDeepSeek();
    const dir = await temporaryDirectory();
    const payload = {
      messages: [
        {
          role: "user",
          content: [inline(Buffer.from("image")), inline(Buffer.from("image"))],
        },
      ],
    };
    await send(new DeepSeekImageFiles(dir).wrapFetch(api.fetch), payload);
    await send(new DeepSeekImageFiles(dir).wrapFetch(api.fetch), payload);
    expect(api.verifications).toBe(0);
    now += DEEPSEEK_FILE_VERIFICATION_TTL_MS - 1;
    await send(new DeepSeekImageFiles(dir).wrapFetch(api.fetch), payload);
    expect(api.verifications).toBe(0);
    now++;
    await send(new DeepSeekImageFiles(dir).wrapFetch(api.fetch), payload);
    expect(api.verifications).toBe(1);
    await send(new DeepSeekImageFiles(dir).wrapFetch(api.fetch), payload);
    expect(api.verifications).toBe(1);
    expect(api.uploads).toHaveLength(1);
  });

  it("verifies a legacy cache and refreshes expiring files even inside the verification window", async () => {
    const api = new FakeDeepSeek();
    const dir = await temporaryDirectory();
    const fetch = new DeepSeekImageFiles(dir).wrapFetch(api.fetch);
    const payload = imagePayload(Buffer.from("image"));
    await send(fetch, payload);
    const accountDir = path.join(dir, (await readdir(dir))[0]);
    const cachePath = path.join(accountDir, (await readdir(accountDir))[0]);
    const cached = JSON.parse(await readFile(cachePath, "utf8"));
    delete cached.verifiedAt;
    await writeFile(cachePath, JSON.stringify(cached));
    await send(fetch, payload);
    expect(api.verifications).toBe(1);
    const verified = JSON.parse(await readFile(cachePath, "utf8"));
    await writeFile(
      cachePath,
      JSON.stringify({ ...verified, expiresAt: Date.now() / 1000 + 30 }),
    );
    await send(fetch, payload);
    expect(api.uploads).toHaveLength(2);
    expect(api.verifications).toBe(1);
  });

  it("recovers a deleted file once from the exact original bytes and preserves Responses tool outputs", async () => {
    const api = new FakeDeepSeek();
    const dir = await temporaryDirectory();
    const fetch = new DeepSeekImageFiles(dir).wrapFetch(api.fetch);
    const image = Buffer.from("original screenshot");
    const payload = {
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Compare both images" },
            {
              type: "input_image",
              image_url: inline(image).image_url.url,
              detail: "original",
            },
          ],
        },
        {
          type: "function_call_output",
          call_id: "call-1",
          output: [
            { type: "input_image", image_url: inline(image).image_url.url },
          ],
        },
      ],
      tools: [{ type: "function", name: "snapshot" }],
    };
    await send(
      fetch,
      payload,
      "key-a",
      undefined,
      "https://api.deepseek.com/responses",
    );
    api.files.clear();
    api.modelBodies = [];
    api.modelResponse = (body) => {
      const id = body.input[0].content[1].file_id;
      return api.files.has(id)
        ? json({ ok: true })
        : json(
            {
              error: {
                code: "file_not_found",
                message: `File ${id} was deleted`,
              },
            },
            400,
          );
    };
    expect(
      (
        await send(
          fetch,
          payload,
          "key-a",
          undefined,
          "https://api.deepseek.com/responses",
        )
      ).status,
    ).toBe(200);
    expect(api.verifications).toBe(0);
    expect(api.uploads).toHaveLength(2);
    expect(api.uploads[1].bytes.equals(image)).toBe(true);
    expect(api.modelBodies).toHaveLength(2);
    expect(api.modelBodies[0].input[0].content[1].file_id).toBe("file-api-1");
    expect(api.modelBodies[1]).toEqual({
      input: [
        {
          role: "user",
          content: [
            { type: "input_text", text: "Compare both images" },
            { type: "input_image", file_id: "file-api-2", detail: "original" },
          ],
        },
        {
          type: "function_call_output",
          call_id: "call-1",
          output: [{ type: "input_image", file_id: "file-api-2" }],
        },
      ],
      tools: payload.tools,
    });
    expect(payload.input[0].content?.[1]).toHaveProperty("image_url");
  });

  it("refreshes only the rejected file and never confuses file-api-1 with file-api-10", async () => {
    const api = new FakeDeepSeek();
    const fetch = new DeepSeekImageFiles(await temporaryDirectory()).wrapFetch(
      api.fetch,
    );
    const first = Buffer.from("first image");
    const second = Buffer.from("second image");
    await send(fetch, imagePayload(first));
    api.nextFileId = 10;
    await send(fetch, imagePayload(second));
    const payload = {
      messages: [{ role: "user", content: [inline(first), inline(second)] }],
    };
    api.modelBodies = [];
    api.modelResponse = () =>
      api.modelBodies.length === 1
        ? json({ error: { message: "file_id file-api-1 expired" } }, 400)
        : json({ ok: true });
    expect((await send(fetch, payload)).status).toBe(200);
    expect(api.uploads).toHaveLength(3);
    expect(api.uploads[2].bytes.equals(first)).toBe(true);
    expect(api.modelBodies[1].messages[0].content).toEqual([
      { type: "file", file_id: "file-api-11" },
      { type: "file", file_id: "file-api-10" },
    ]);
  });

  it("refreshes all used IDs when no ID is named and stops after a second stale response", async () => {
    const api = new FakeDeepSeek();
    const fetch = new DeepSeekImageFiles(await temporaryDirectory()).wrapFetch(
      api.fetch,
    );
    const payload = {
      messages: [
        {
          role: "user",
          content: [inline(Buffer.from("one")), inline(Buffer.from("two"))],
        },
      ],
    };
    api.modelResponse = () =>
      json(
        {
          error: { code: "file_not_found", message: "image file has expired" },
        },
        400,
      );
    const response = await send(fetch, payload);
    expect(response.status).toBe(400);
    expect(await response.json()).toEqual({
      error: { code: "file_not_found", message: "image file has expired" },
    });
    expect(api.modelBodies).toHaveLength(2);
    expect(api.uploads).toHaveLength(4);
  });

  it("keeps newer file mappings when a delayed failure rejects an older generation", async () => {
    const api = new FakeDeepSeek();
    const fetch = new DeepSeekImageFiles(await temporaryDirectory()).wrapFetch(
      api.fetch,
    );
    const payload = imagePayload(Buffer.from("image"));
    await send(fetch, payload);
    let release!: () => void;
    let started!: () => void;
    const startedRequest = new Promise<void>((resolve) => {
      started = resolve;
    });
    const releasedRequest = new Promise<void>((resolve) => {
      release = resolve;
    });
    let delayed = false;
    api.modelResponse = async (body) => {
      const id = body.messages[0].content[1].file_id;
      if (id !== "file-api-1") return json({ ok: true });
      if (!delayed) {
        delayed = true;
        started();
        await releasedRequest;
      }
      return json({ error: { message: "file_id file-api-1 expired" } }, 400);
    };
    const first = send(fetch, payload);
    await startedRequest;
    expect((await send(fetch, payload)).status).toBe(200);
    release();
    expect((await first).status).toBe(200);
    expect(api.uploads).toHaveLength(2);
    await send(fetch, payload);
    expect(api.uploads).toHaveLength(2);
  });

  it.each([
    { error: { message: "invalid image file format" } },
    { error: { message: "file_id has invalid image format" } },
    { error: { message: "file-api-unknown expired" } },
    { error: { message: "tool call not found" } },
  ])(
    "preserves unrelated model errors without reuploading: %j",
    async (error) => {
      const api = new FakeDeepSeek();
      const fetch = new DeepSeekImageFiles(
        await temporaryDirectory(),
      ).wrapFetch(api.fetch);
      api.modelResponse = () => json(error, 400);
      const response = await send(fetch, imagePayload(Buffer.from("image")));
      expect(response.status).toBe(400);
      expect(await response.json()).toEqual(error);
      expect(api.uploads).toHaveLength(1);
      expect(api.modelBodies).toHaveLength(1);
    },
  );

  it("preserves an HTML 413 response without retrying or falling back", async () => {
    const api = new FakeDeepSeek();
    const fetch = new DeepSeekImageFiles(await temporaryDirectory()).wrapFetch(
      api.fetch,
    );
    const html =
      "<html><h1>413 Request Entity Too Large</h1><hr>openresty</html>";
    api.modelResponse = () =>
      new Response(html, {
        status: 413,
        headers: { "content-type": "text/html" },
      });
    const response = await send(fetch, imagePayload(Buffer.from("image")));
    expect(response.status).toBe(413);
    expect(await response.text()).toBe(html);
    expect(api.uploads).toHaveLength(1);
    expect(api.modelBodies).toHaveLength(1);
  });

  it("falls back to the byte-identical incoming JSON when Files is unavailable after a partial upload", async () => {
    const api = new FakeDeepSeek();
    const dir = await temporaryDirectory();
    const fetch = new DeepSeekImageFiles(dir).wrapFetch(api.fetch);
    const first = Buffer.from("first image");
    const second = Buffer.from("second image");
    await send(fetch, imagePayload(first));
    api.modelBodies = [];
    api.uploadStatus = 503;
    const payload = {
      model: "deepseek-flash",
      messages: [
        {
          role: "user",
          content: [{ type: "text", text: "完整历史" }, inline(first)],
        },
        { role: "tool", content: "Screenshot result", tool_call_id: "call-1" },
        { role: "user", content: [inline(second)] },
      ],
      tools: [{ name: "snapshot" }],
    };
    const original = JSON.stringify(payload, null, 2);
    let received!: string;
    const delegate: typeof globalThis.fetch = async (input, init) => {
      const request = new Request(input, init);
      if (new URL(request.url).pathname.endsWith("/chat/completions"))
        received = await request.clone().text();
      return api.fetch(request);
    };
    const preservingFetch = new DeepSeekImageFiles(dir).wrapFetch(delegate);
    expect(
      (
        await preservingFetch("https://api.deepseek.com/chat/completions", {
          method: "POST",
          headers: {
            authorization: "Bearer key-a",
            "content-type": "application/json",
          },
          body: original,
        })
      ).status,
    ).toBe(200);
    expect(received).toBe(original);
    expect(api.modelBodies).toEqual([payload]);
    expect(received).not.toContain("file_id");
  });

  it("falls back on upload network failure and verification outages", async () => {
    const api = new FakeDeepSeek();
    const dir = await temporaryDirectory();
    const fetch = new DeepSeekImageFiles(dir).wrapFetch(api.fetch);
    const payload = imagePayload(Buffer.from("image"));
    api.onUpload = async () => {
      throw new TypeError("fetch failed");
    };
    expect((await send(fetch, payload)).status).toBe(200);
    expect(api.modelBodies[0]).toEqual(payload);
    api.onUpload = undefined;
    await send(fetch, payload);
    const accountDir = path.join(dir, (await readdir(dir))[0]);
    const cachePath = path.join(accountDir, (await readdir(accountDir))[0]);
    const cached = JSON.parse(await readFile(cachePath, "utf8"));
    await writeFile(cachePath, JSON.stringify({ ...cached, verifiedAt: 0 }));
    api.verificationStatus = 503;
    expect((await send(fetch, payload)).status).toBe(200);
    expect(api.modelBodies[2]).toEqual(payload);
  });

  it("blocks inline fallback for a UTF-8 body over 48 MiB while keeping every original image", async () => {
    const api = new FakeDeepSeek();
    api.uploadStatus = 503;
    const fetch = new DeepSeekImageFiles(await temporaryDirectory()).wrapFetch(
      api.fetch,
    );
    const payload = imagePayload(Buffer.from("image"));
    payload.messages[0].content.unshift({
      type: "text",
      text: "字".repeat(Math.ceil(DEEPSEEK_REQUEST_LIMIT / 3)),
    });
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThan(
      DEEPSEEK_REQUEST_LIMIT,
    );
    const response = await send(fetch, payload);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Inline fallback is unavailable");
    expect(api.modelBodies).toHaveLength(0);
    expect(payload.messages[0].content.at(-1)).toEqual(
      inline(Buffer.from("image")),
    );
  });

  it("blocks fallback for a single image above the 32 MiB inline limit even if JSON fits", async () => {
    const api = new FakeDeepSeek();
    api.uploadStatus = 503;
    const fetch = new DeepSeekImageFiles(await temporaryDirectory()).wrapFetch(
      api.fetch,
    );
    const payload = imagePayload(Buffer.alloc(32 * 1024 * 1024 + 1));
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeLessThan(
      DEEPSEEK_REQUEST_LIMIT,
    );
    const response = await send(fetch, payload);
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("32 MiB inline image limit");
    expect(api.modelBodies).toHaveLength(0);
  });

  it("allows a complete inline body exactly at the 48 MiB boundary", async () => {
    const api = new FakeDeepSeek();
    api.uploadStatus = 503;
    const fetch = new DeepSeekImageFiles(await temporaryDirectory()).wrapFetch(
      api.fetch,
    );
    const payload = imagePayload(Buffer.from("image"));
    const text = { type: "text", text: "" };
    payload.messages[0].content[0] = text;
    const remaining =
      DEEPSEEK_REQUEST_LIMIT - Buffer.byteLength(JSON.stringify(payload));
    text.text = "x".repeat(remaining);
    expect(Buffer.byteLength(JSON.stringify(payload))).toBe(
      DEEPSEEK_REQUEST_LIMIT,
    );
    expect((await send(fetch, payload)).status).toBe(200);
    expect(api.modelBodies).toHaveLength(1);
    expect(api.modelBodies[0].messages[0].content[0].text.length).toBe(
      remaining,
    );
    expect(api.modelBodies[0].messages[0].content[1]).toEqual(
      inline(Buffer.from("image")),
    );
  });

  it("falls back after the file resolution deadline without treating it as caller cancellation", async () => {
    vi.spyOn(AbortSignal, "timeout").mockImplementation(() =>
      AbortSignal.abort(
        new DOMException("Files deadline exceeded", "TimeoutError"),
      ),
    );
    const api = new FakeDeepSeek();
    const fetch = new DeepSeekImageFiles(await temporaryDirectory()).wrapFetch(
      api.fetch,
    );
    const payload = imagePayload(Buffer.from("image"));
    expect((await send(fetch, payload)).status).toBe(200);
    expect(api.uploads).toHaveLength(0);
    expect(api.modelBodies).toEqual([payload]);
  });

  it.each([400, 401, 403, 413])(
    "does not use inline fallback for a permanent upload failure (HTTP %i)",
    async (status) => {
      const api = new FakeDeepSeek();
      api.uploadStatus = status;
      const fetch = new DeepSeekImageFiles(
        await temporaryDirectory(),
      ).wrapFetch(api.fetch);
      const response = await send(fetch, imagePayload(Buffer.from("image")));
      expect(response.status).toBe(400);
      expect(await response.text()).toContain(
        `image upload failed (HTTP ${status})`,
      );
      expect(api.modelBodies).toHaveLength(0);
    },
  );

  it("cancels a recovery upload without issuing an inline fallback or a second model POST", async () => {
    const api = new FakeDeepSeek();
    const fetch = new DeepSeekImageFiles(await temporaryDirectory()).wrapFetch(
      api.fetch,
    );
    const payload = imagePayload(Buffer.from("image"));
    await send(fetch, payload);
    api.modelBodies = [];
    api.modelResponse = () =>
      json({ error: { message: "file_id file-api-1 expired" } }, 400);
    let started!: () => void;
    const startedUpload = new Promise<void>((resolve) => {
      started = resolve;
    });
    api.onUpload = (signal) =>
      new Promise((_resolve, reject) => {
        started();
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    const controller = new AbortController();
    const result = send(fetch, payload, "key-a", controller.signal).catch(
      (error) => error,
    );
    await startedUpload;
    controller.abort();
    expect(await result).toBeInstanceOf(Error);
    expect(api.modelBodies).toHaveLength(1);
    expect(api.uploads).toHaveLength(1);
  });

  it("blocks upload/verification failures and oversized text before sending a model request", async () => {
    let now = Date.now();
    vi.spyOn(Date, "now").mockImplementation(() => now);
    const api = new FakeDeepSeek();
    const fetch = new DeepSeekImageFiles(await temporaryDirectory()).wrapFetch(
      api.fetch,
    );
    api.uploadStatus = 413;
    let response = await send(fetch, imagePayload(Buffer.from("image")));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("image upload failed (HTTP 413)");
    expect(api.modelBodies).toHaveLength(0);
    api.uploadStatus = 200;
    await send(fetch, imagePayload(Buffer.from("image")));
    api.modelBodies = [];
    api.verificationStatus = 401;
    now += DEEPSEEK_FILE_VERIFICATION_TTL_MS;
    response = await send(fetch, imagePayload(Buffer.from("image")));
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("verification failed (HTTP 401)");
    response = await send(fetch, {
      messages: [
        {
          role: "user",
          content: "字".repeat(Math.ceil(DEEPSEEK_REQUEST_LIMIT / 3)),
        },
      ],
    });
    expect(response.status).toBe(400);
    expect(await response.text()).toContain("Text/history is too large");
    expect(api.modelBodies).toHaveLength(0);
  });

  it("shares an upload without letting one cancelled session abort the other", async () => {
    const api = new FakeDeepSeek();
    const fetch = new DeepSeekImageFiles(await temporaryDirectory()).wrapFetch(
      api.fetch,
    );
    let release!: () => void;
    let started!: () => void;
    const uploadStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    const uploadReleased = new Promise<void>((resolve) => {
      release = resolve;
    });
    api.onUpload = async () => {
      started();
      await uploadReleased;
    };
    const controller = new AbortController();
    const first = send(
      fetch,
      imagePayload(Buffer.from("image")),
      "key-a",
      controller.signal,
    );
    const firstResult = first.catch((error) => error);
    await uploadStarted;
    const second = send(fetch, imagePayload(Buffer.from("image")));
    // Let the second request finish parsing and subscribe to the shared operation.
    await new Promise((resolve) => setImmediate(resolve));
    controller.abort();
    release();
    expect(await firstResult).toBeInstanceOf(Error);
    expect((await second).status).toBe(200);
    expect(api.uploads).toHaveLength(1);
    expect(api.modelBodies).toHaveLength(1);
  });

  it("aborts an unshared upload and can retry it later", async () => {
    const api = new FakeDeepSeek();
    const fetch = new DeepSeekImageFiles(await temporaryDirectory()).wrapFetch(
      api.fetch,
    );
    let started!: () => void;
    const uploadStarted = new Promise<void>((resolve) => {
      started = resolve;
    });
    api.onUpload = (signal) =>
      new Promise((_resolve, reject) => {
        started();
        signal.addEventListener("abort", () => reject(signal.reason), {
          once: true,
        });
      });
    const controller = new AbortController();
    const result = send(
      fetch,
      imagePayload(Buffer.from("image")),
      "key-a",
      controller.signal,
    ).catch((error) => error);
    await uploadStarted;
    controller.abort();
    expect(await result).toBeInstanceOf(Error);
    expect(api.modelBodies).toHaveLength(0);
    api.onUpload = undefined;
    expect((await send(fetch, imagePayload(Buffer.from("image")))).status).toBe(
      200,
    );
  });

  it("passes other providers through unchanged and preserves model HTTP errors", async () => {
    const api = new FakeDeepSeek();
    const fetch = new DeepSeekImageFiles(await temporaryDirectory()).wrapFetch(
      api.fetch,
    );
    const payload = imagePayload(Buffer.from("image"));
    await send(
      fetch,
      payload,
      "key-a",
      undefined,
      "https://gateway.example/v1/chat/completions",
    );
    expect(api.uploads).toHaveLength(0);
    expect(api.modelBodies[0]).toEqual(payload);
    const nonJsonRequest = new Request(
      "https://api.deepseek.com/chat/completions",
      {
        method: "POST",
        headers: { "content-type": "text/plain" },
        body: JSON.stringify(payload),
      },
    );
    expect((await fetch(nonJsonRequest)).status).toBe(200);
    expect(api.uploads).toHaveLength(0);
    expect(api.modelBodies[1]).toEqual(payload);
    api.modelResponse = () => json({ error: { message: "rate limited" } }, 429);
    expect((await send(fetch, { messages: [] })).status).toBe(429);
    api.modelResponse = () => {
      throw new Error("network unavailable");
    };
    await expect(send(fetch, { messages: [] })).rejects.toThrow(
      "network unavailable",
    );
    expect(
      isDeepSeekFileModel({
        api: "openai-responses",
        baseUrl: "https://api.deepseek.com/v1",
      }),
    ).toBe(true);
    expect(
      isDeepSeekFileModel({
        api: "openai-completions",
        baseUrl: "https://api.deepseek.com.attacker.example",
      }),
    ).toBe(false);
  });
});

describe("Pi session integration", () => {
  it("selects the current model and resize setting each time the read tool is reused", async () => {
    const dir = await temporaryDirectory();
    const bytes = await sharp({
      create: { width: 3000, height: 20, channels: 3, background: "blue" },
    })
      .png()
      .toBuffer();
    await writeFile(path.join(dir, "original.png"), bytes);
    const settings = SettingsManager.inMemory({ images: { autoResize: true } });
    const tool = createProviderImageReadTool(dir, settings);
    async function readImage(baseUrl: string) {
      const ctx = {
        cwd: dir,
        model: { api: "openai-completions", baseUrl, input: ["text", "image"] },
      } as Parameters<typeof tool.execute>[4];
      const result = await tool.execute(
        "read-1",
        { path: "original.png" },
        undefined,
        undefined,
        ctx,
      );
      const image = result.content.find((block) => block.type === "image");
      expect(image).toBeDefined();
      return Buffer.from(image!.data, "base64");
    }
    expect(await readImage("https://api.deepseek.com")).toEqual(bytes);
    expect(
      (await sharp(await readImage("https://api.openai.com/v1")).metadata())
        .width,
    ).toBeLessThan(3000);
    settings.setImageAutoResize(false);
    expect(await readImage("https://api.openai.com/v1")).toEqual(bytes);
    settings.setImageAutoResize(true);
    expect(
      (await sharp(await readImage("https://api.openai.com/v1")).metadata())
        .width,
    ).toBeLessThan(3000);
    expect(await readImage("https://api.deepseek.com")).toEqual(bytes);
  });

  function completion() {
    return new Response(
      `data: ${JSON.stringify({ id: "chat-1", object: "chat.completion.chunk", created: 1, model: "deepseek-flash", choices: [{ index: 0, delta: { content: "Done" }, finish_reason: "stop" }] })}\n\ndata: [DONE]\n\n`,
      { headers: { "content-type": "text/event-stream" } },
    );
  }
  async function makeSession(api: FakeDeepSeek, dir: string) {
    const runtime = await ModelRuntime.create({
      authPath: path.join(dir, "auth.json"),
      modelsPath: null,
      refreshOnCreate: false,
    });
    await runtime.setRuntimeApiKey("deepseek", "key-a");
    const model = runtime.getModel("deepseek", "deepseek-flash")!;
    expect(model).toBeDefined();
    const settings = SettingsManager.inMemory({
      images: { autoResize: true },
      compaction: { enabled: false },
      retry: { enabled: false },
      cacheWarming: "off",
    });
    const loader = new DefaultResourceLoader({
      cwd: dir,
      agentDir: dir,
      settingsManager: settings,
      noExtensions: true,
      noSkills: true,
      noPromptTemplates: true,
      noThemes: true,
      agentsFilesOverride: () => ({ agentsFiles: [] }),
    });
    await loader.reload();
    const screenshot = await sharp({
      create: { width: 3000, height: 20, channels: 3, background: "blue" },
    })
      .png()
      .toBuffer();
    await writeFile(path.join(dir, "original.png"), screenshot);
    const snapshot: ToolDefinition = {
      name: "snapshot",
      label: "Snapshot",
      description: "Screenshot",
      parameters: Type.Object({}),
      execute: async () => ({
        content: [
          {
            type: "image",
            data: screenshot.toString("base64"),
            mimeType: "image/png",
          },
        ],
        details: undefined,
      }),
    };
    const { session } = await createAgentSession({
      cwd: dir,
      agentDir: dir,
      modelRuntime: runtime,
      model,
      resourceLoader: loader,
      settingsManager: settings,
      sessionManager: SessionManager.inMemory(dir),
      customTools: [
        createProviderImageReadTool(dir, settings) as ToolDefinition,
        snapshot,
      ],
    });
    installDeepSeekImageFiles(session, dir);
    vi.stubGlobal("fetch", api.fetch);
    return { session, runtime, screenshot };
  }

  it("keeps original prompt, read and screenshot bytes in the transcript and sends only file IDs", async () => {
    const api = new FakeDeepSeek();
    const { session, runtime, screenshot } = await makeSession(
      api,
      await temporaryDirectory(),
    );
    const promptImage = await sharp({
      create: { width: 3000, height: 20, channels: 3, background: "red" },
    })
      .png()
      .toBuffer();
    let turns = 0;
    api.modelResponse = () => {
      const delta =
        turns++ === 0
          ? {
              tool_calls: [
                {
                  index: 0,
                  id: "call-1",
                  type: "function",
                  function: { name: "snapshot", arguments: "{}" },
                },
                {
                  index: 1,
                  id: "call-2",
                  type: "function",
                  function: {
                    name: "read",
                    arguments: '{"path":"original.png"}',
                  },
                },
              ],
            }
          : { content: "Done" };
      return new Response(
        `data: ${JSON.stringify({ id: "chat-1", object: "chat.completion.chunk", created: 1, model: "deepseek-flash", choices: [{ index: 0, delta, finish_reason: turns === 1 ? "tool_calls" : "stop" }] })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      );
    };
    try {
      await session.prompt("Inspect these images", {
        images: [
          {
            type: "image",
            mimeType: "image/png",
            data: promptImage.toString("base64"),
          },
        ],
      });
      expect(api.modelBodies).toHaveLength(2);
      expect(api.uploads).toHaveLength(2);
      expect(api.uploads[0].bytes).toEqual(promptImage);
      expect(api.uploads[1].bytes).toEqual(screenshot);
      const savedImages = session.messages.flatMap((message) =>
        (message.role === "user" || message.role === "toolResult") &&
        Array.isArray(message.content)
          ? message.content.filter((block) => block.type === "image")
          : [],
      );
      expect(savedImages.map((image) => image.data)).toEqual([
        promptImage.toString("base64"),
        screenshot.toString("base64"),
        screenshot.toString("base64"),
      ]);
      expect(JSON.stringify(api.modelBodies)).not.toContain("data:image/");
      expect(
        api.modelBodies[1].messages.filter(
          (message: any) => message.role === "tool",
        ),
      ).toHaveLength(2);
      expect(session.settingsManager.getImageAutoResize()).toBe(false);
      await runtime.setRuntimeApiKey("openai", "other-key");
      await session.setModel(
        runtime.getModel("openai", "gpt-5.4") ?? runtime.getModels("openai")[0],
      );
      expect(session.settingsManager.getImageAutoResize()).toBe(true);
    } finally {
      session.dispose();
    }
  });

  it("surfaces failed uploads as a non-retryable model error with no model POST", async () => {
    const api = new FakeDeepSeek();
    api.uploadStatus = 413;
    const { session, screenshot } = await makeSession(
      api,
      await temporaryDirectory(),
    );
    try {
      await session.prompt("Inspect", {
        images: [
          {
            type: "image",
            mimeType: "image/png",
            data: screenshot.toString("base64"),
          },
        ],
      });
      expect(api.modelBodies).toHaveLength(0);
      const message = session.messages.findLast(
        (message) => message.role === "assistant",
      );
      expect(message).toMatchObject({
        stopReason: "error",
        errorMessage: expect.stringContaining("image upload failed (HTTP 413)"),
      });
    } finally {
      session.dispose();
    }
  });

  it("recovers stale IDs through Pi and retains original prompt bytes", async () => {
    const api = new FakeDeepSeek();
    const { session, screenshot } = await makeSession(
      api,
      await temporaryDirectory(),
    );
    api.modelResponse = () =>
      api.modelBodies.length === 1
        ? json(
            {
              error: {
                code: "file_not_found",
                message: "File file-api-1 not found",
              },
            },
            400,
          )
        : completion();
    try {
      await session.prompt("Inspect", {
        images: [
          {
            type: "image",
            mimeType: "image/png",
            data: screenshot.toString("base64"),
          },
        ],
      });
      expect(api.modelBodies).toHaveLength(2);
      expect(api.uploads).toHaveLength(2);
      expect(api.uploads[1].bytes.equals(screenshot)).toBe(true);
      const message = session.messages.findLast(
        (message) => message.role === "assistant",
      );
      expect(message).toMatchObject({
        stopReason: "stop",
        content: [{ type: "text", text: "Done" }],
      });
      const user = session.messages.find((message) => message.role === "user");
      expect(user).toMatchObject({
        content: expect.arrayContaining([
          {
            type: "image",
            mimeType: "image/png",
            data: screenshot.toString("base64"),
          },
        ]),
      });
    } finally {
      session.dispose();
    }
  });

  it("falls back to original inline images when recovery upload fails, without exposing an intermediate model error", async () => {
    const api = new FakeDeepSeek();
    const { session, screenshot } = await makeSession(
      api,
      await temporaryDirectory(),
    );
    api.modelResponse = (body) => {
      if (JSON.stringify(body).includes('"file_id"')) {
        api.uploadStatus = 503;
        return json({ error: { message: "file-api-1 expired" } }, 400);
      }
      return completion();
    };
    try {
      await session.prompt("Inspect", {
        images: [
          {
            type: "image",
            mimeType: "image/png",
            data: screenshot.toString("base64"),
          },
        ],
      });
      expect(api.modelBodies).toHaveLength(2);
      expect(api.uploads).toHaveLength(1);
      expect(JSON.stringify(api.modelBodies[1])).not.toContain('"file_id"');
      expect(JSON.stringify(api.modelBodies[1])).toContain(
        screenshot.toString("base64"),
      );
      expect(
        session.messages.filter((message) => message.role === "assistant"),
      ).toHaveLength(1);
      expect(
        session.messages.findLast((message) => message.role === "assistant"),
      ).toMatchObject({ stopReason: "stop" });
    } finally {
      session.dispose();
    }
  });
});
