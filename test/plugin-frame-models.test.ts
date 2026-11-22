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
    await vi.waitFor(() => expect(calls.has("models:b")).toBe(true));
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

  it("isolates models vs assistant call keys, cancels assistant calls via models.cancel, and tracks unnamed calls", async () => {
    const signals: Record<string, AbortSignal> = {};
    const page: PluginPageContext = {
      ...context((_req, signal) => new Promise((_r, rej) => {
        signals[signals.m1 ? "m2" : "m1"] = signal;
        signal.addEventListener("abort", () => rej(new Error("Cancelled")), { once: true });
      })),
      assistant: {
        run: (_req, _onEvent, signal) => new Promise((_r, rej) => {
          signals.a1 = signal;
          signal.addEventListener("abort", () => rej(new Error("Cancelled")), { once: true });
        }),
        history: async () => [],
        clear: async () => {},
      },
    };
    const calls = new Map<string, AbortController>();
    const active = new Set<AbortController>();
    const m1 = handlePluginUiRequest({ id: 1, method: "models.complete", params: { messages: [{ role: "user", text: "hi" }], call: "shared" } }, page, calls, undefined, active);
    const a1 = handlePluginUiRequest({ id: 2, method: "assistant.run", params: { call: "shared" } }, page, calls, undefined, active);
    const unnamed = handlePluginUiRequest({ id: 3, method: "models.complete", params: { messages: [{ role: "user", text: "unnamed" }] } }, page, calls, undefined, active);
    await vi.waitFor(() => expect(Boolean(signals.m1 && signals.a1 && signals.m2)).toBe(true));
    expect(signals.m1.aborted).toBe(false);
    expect(signals.a1.aborted).toBe(false);
    expect(signals.m2.aborted).toBe(false);
    await handlePluginUiRequest({ id: 4, method: "models.cancel", params: { call: "shared" } }, page, calls);
    await expect(m1).rejects.toThrow("Cancelled");
    await expect(a1).rejects.toThrow("Cancelled");
    expect(signals.m2.aborted).toBe(false);
    expect(active.size).toBe(1);
    for (const c of active) c.abort();
    await expect(unnamed).rejects.toThrow("Cancelled");
  });
});
