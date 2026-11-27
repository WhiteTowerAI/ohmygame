// @vitest-environment happy-dom
import { describe, expect, it, vi } from "vitest";
import { handlePluginUiRequest, type PluginPageContext } from "../src/renderer/plugin-frame.js";

function context(complete: NonNullable<PluginPageContext["models"]>["complete"], visible = true): PluginPageContext {
  return {
    plugin: { id: "acme/fx", version: "1.0.0", panel: "main" },
    locale: "en",
    capabilities: { models: true },
    commands: [],
    project: () => ({ name: "Effects", type: "web" }),
    storage: { get: async () => null, set: async () => {} },
    files: { list: async () => [], read: async () => new Blob(), write: async () => "", createFolder: async () => "", move: async () => "", delete: async () => {} },
    runCommand: async () => null,
    history: async () => [],
    usage: async () => [],
    toast: () => {},
    confirm: async () => false,
    models: { list: async () => [], complete },
    visible: () => visible,
  };
}

describe("a page's model requests", () => {
  it("sends a Blob's bytes as base64 with its type, and stops a call the page cancels", async () => {
    const complete = vi.fn((request: Record<string, unknown>, signal: AbortSignal) => new Promise<unknown>((resolve, reject) => {
      if ((request.messages as Array<{ text: string }>)[0]!.text === "wait") {
        if (signal.aborted) reject(new Error("Cancelled"));
        signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
      }
      else resolve({ text: "ok" });
    }));
    const calls = new Map<string, AbortController>();
    const page = context(complete);
    const image = new Blob([new Uint8Array([104, 105])], { type: "image/png" });
    await expect(handlePluginUiRequest({ id: 1, method: "models.complete", params: { messages: [{ role: "user", text: "look", images: [{ data: image }] }], call: "a" } }, page, calls)).resolves.toEqual({ text: "ok" });
    expect(complete.mock.calls[0]![0]).toEqual({ messages: [{ role: "user", text: "look", images: [{ data: "aGk=", type: "image/png" }] }] });
    expect(calls.size).toBe(0);

    const waiting = handlePluginUiRequest({ id: 2, method: "models.complete", params: { messages: [{ role: "user", text: "wait" }], call: "b" } }, page, calls);
    await vi.waitFor(() => expect(calls.has("b")).toBe(true));
    await handlePluginUiRequest({ id: 3, method: "models.cancel", params: { call: "b" } }, page, calls);
    await expect(waiting).rejects.toThrow("Cancelled");
  });

  it("asks nothing while the panel is hidden, or without the capability", async () => {
    const complete = vi.fn(async () => ({ text: "ok" }));
    await expect(handlePluginUiRequest({ id: 1, method: "models.complete", params: { messages: [{ role: "user", text: "x" }] } }, context(complete, false))).rejects.toThrow("hidden");
    await expect(handlePluginUiRequest({ id: 2, method: "models.list" }, { ...context(complete), capabilities: {} })).rejects.toThrow("needs the models capability");
    // Too many images, or one too large, are refused before any is read.
    const many = Array.from({ length: 9 }, () => ({ data: new Blob(["x"], { type: "image/png" }) }));
    await expect(handlePluginUiRequest({ id: 3, method: "models.complete", params: { messages: [{ role: "user", text: "x", images: many }] } }, context(complete))).rejects.toThrow("at most 8 images");
    const huge = { data: new Blob([new Uint8Array(6 * 1024 * 1024)], { type: "image/png" }) };
    await expect(handlePluginUiRequest({ id: 4, method: "models.complete", params: { messages: [{ role: "user", text: "x", images: [huge] }] } }, context(complete))).rejects.toThrow("MB");
    expect(complete).not.toHaveBeenCalled();
  });
});

describe("a page's media requests", () => {
  it("sends images to work from as base64, hands back each file as a Blob, and stops a call the page cancels", async () => {
    const generate = vi.fn((request: Record<string, unknown>, signal: AbortSignal) => new Promise<{ files: Array<{ name: string; data: string; type: string }> }>((resolve, reject) => {
      if (request.prompt === "wait") signal.addEventListener("abort", () => reject(new Error("Cancelled")), { once: true });
      else resolve({ files: [{ name: "output.png", data: "aGk=", type: "image/png" }] });
    }));
    const page: PluginPageContext = { ...context(vi.fn()), capabilities: { media: true }, media: { models: async () => ({ models: [] }), generate } };
    const calls = new Map<string, AbortController>();
    const image = new Blob([new Uint8Array([104, 105])], { type: "image/png" });
    const made = await handlePluginUiRequest({ id: 1, method: "media.generate", params: { media: "image", prompt: "A spark", aspectRatio: "1:1", images: [image], call: "a" } }, page, calls) as { files: Array<{ data: Blob }> };
    expect(generate.mock.calls[0]![0]).toEqual({ media: "image", prompt: "A spark", aspectRatio: "1:1", images: [{ data: "aGk=", type: "image/png" }] });
    expect(made.files[0]!.data).toBeInstanceOf(Blob);
    expect(made.files[0]!.data.type).toBe("image/png");
    expect(new Uint8Array(await made.files[0]!.data.arrayBuffer())).toEqual(new Uint8Array([104, 105]));

    const waiting = handlePluginUiRequest({ id: 2, method: "media.generate", params: { media: "image", prompt: "wait", call: "b" } }, page, calls);
    await vi.waitFor(() => expect(calls.has("b")).toBe(true));
    await handlePluginUiRequest({ id: 3, method: "media.cancel", params: { call: "b" } }, page, calls);
    await expect(waiting).rejects.toThrow("Cancelled");
  });

  it("makes nothing while the panel is hidden, or without the capability", async () => {
    const generate = vi.fn(async () => ({ files: [] }));
    const page: PluginPageContext = { ...context(vi.fn(), false), capabilities: { media: true }, media: { models: async () => ({ models: [] }), generate } };
    await expect(handlePluginUiRequest({ id: 1, method: "media.generate", params: { media: "image", prompt: "x", call: "a" } }, page)).rejects.toThrow("hidden");
    await expect(handlePluginUiRequest({ id: 2, method: "media.models", params: { media: "image" } }, { ...page, capabilities: {} })).rejects.toThrow("media capability");
    expect(generate).not.toHaveBeenCalled();
  });
});

describe("a page's assets", () => {
  it("adds to the project's assets, saying where with assets.add and by id with the old library.add", async () => {
    const add = vi.fn(async (name: string) => ({ id: "asset-1", path: `.ohmygame/media/imported/${name}`, name, mediaType: "image" }));
    const page = { ...context(async () => ({})), capabilities: { library: true }, assets: { add } };
    const data = new Blob([new Uint8Array(4)], { type: "image/png" });
    await expect(handlePluginUiRequest({ id: 1, method: "assets.add", params: { name: " burst.png ", data, prompt: "burst" } }, page)).resolves.toEqual({ path: ".ohmygame/media/imported/burst.png", name: "burst.png", mediaType: "image" });
    expect(add).toHaveBeenCalledWith("burst.png", data, "burst");
    await expect(handlePluginUiRequest({ id: 2, method: "library.add", params: { name: "burst.png", data } }, page)).resolves.toEqual({ id: "asset-1", name: "burst.png", mediaType: "image" });
    // Only while the person can see the page, and with the capability.
    await expect(handlePluginUiRequest({ id: 3, method: "assets.add", params: { name: "burst.png", data } }, { ...page, visible: () => false })).rejects.toThrow("isn't showing");
    await expect(handlePluginUiRequest({ id: 4, method: "assets.add", params: { name: "burst.png", data } }, { ...page, capabilities: {} })).rejects.toThrow("needs the library capability");
  });
});
