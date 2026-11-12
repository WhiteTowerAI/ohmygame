import { describe, expect, it } from "vitest";
import { runMediaAdapter, type MediaFetchRequest } from "../src/daemon/plugin-media-sandbox.js";

const call = (source: string, fields: Partial<Parameters<typeof runMediaAdapter>[0]> = {}) => runMediaAdapter({
  source, file: "./media.js", kind: "image", step: "start", args: [{ prompt: "a cat" }],
  fetch: async () => ({ status: 200, headers: {}, body: "{}" }),
  ...fields,
});

describe("plugin media sandbox", () => {
  it("runs a step with its input and host, and returns plain data", async () => {
    const requests: MediaFetchRequest[] = [];
    const result = await call(`
      export default { image: { async start(input, host) {
        const response = await host.fetch("https://api.example.com/images", { method: "POST", auth: true, json: { prompt: input.prompt } });
        const answer = await response.json();
        host.log("made " + answer.id);
        return { outputs: [{ url: answer.url }], status: response.status, ok: response.ok, type: response.headers["content-type"] };
      } } };
    `, {
      fetch: async (request) => {
        requests.push(request);
        return { status: 201, headers: { "content-type": "application/json" }, body: JSON.stringify({ id: "x1", url: "https://cdn.example.com/x1.png" }) };
      },
    });
    expect(requests).toEqual([{ url: "https://api.example.com/images", method: "POST", auth: true, json: { prompt: "a cat" } }]);
    expect(result).toEqual({ outputs: [{ url: "https://cdn.example.com/x1.png" }], status: 201, ok: true, type: "application/json" });
  });

  it("has nothing of its own to reach out with", async () => {
    const result = await call(`
      export default { image: { start: () => [typeof fetch, typeof require, typeof process, typeof setTimeout, typeof globalThis.__ohmygameFetch, typeof XMLHttpRequest] } };
    `);
    expect(result).toEqual(["undefined", "undefined", "undefined", "undefined", "undefined", "undefined"]);
    await expect(call(`import fs from "node:fs"; export default { image: { start: () => 1 } };`)).rejects.toThrow(/could not load module/);
  });

  it("fails a call that throws, lacks the step, or returns what isn't data", async () => {
    await expect(call(`export default { image: { start() { throw new Error("vendor says no"); } } };`)).rejects.toThrow("./media.js image.start failed: vendor says no");
    await expect(call(`export default { video: { start: () => 1 } };`)).rejects.toThrow(/has no image\.start/);
    await expect(call(`export default { image: { start: () => ({ big: 1n }) } };`)).rejects.toThrow(/image\.start failed/);
    // A getter runs in the sandbox, inside its limits, not in the app.
    await expect(call(`export default { image: { start: () => ({ get url() { throw new Error("got"); } }) } };`)).rejects.toThrow(/got/);
  });

  it("stops a script that runs too long or uses too much memory", async () => {
    await expect(call(`export default { image: { start() { for (;;) {} } } };`)).rejects.toThrow(/ran for more than 2 seconds/);
    await expect(call(`export default { image: { start() { const all = []; for (;;) all.push("x".repeat(1 << 20) + all.length); } } };`)).rejects.toThrow();
  }, 20_000);

  it("doesn't count waiting on the network, and stops waiting when the request is stopped", async () => {
    const slow = await call(`export default { image: { async start(input, host) { await host.fetch("https://a.example.com/"); await host.fetch("https://a.example.com/"); return "done"; } } };`, {
      fetch: () => new Promise((resolve) => setTimeout(() => resolve({ status: 200, headers: {}, body: "" }), 1_200)),
    });
    expect(slow).toBe("done");
    const controller = new AbortController();
    const pending = call(`export default { image: { async start(input, host) { await host.fetch("https://a.example.com/"); return "late"; } } };`, {
      signal: controller.signal,
      fetch: (_request, signal) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))),
    });
    setTimeout(() => controller.abort(new Error("stopped by the person")), 50);
    await expect(pending).rejects.toThrow("stopped by the person");
  }, 20_000);

  it("passes a failed request to the script as an error it can catch", async () => {
    const result = await call(`export default { image: { async start(input, host) {
      try { await host.fetch("https://elsewhere.example.com/"); } catch (error) { return { caught: error.message }; }
    } } };`, { fetch: async () => { throw new Error("elsewhere.example.com isn't in capabilities.network"); } });
    expect(result).toEqual({ caught: "elsewhere.example.com isn't in capabilities.network" });
  });
});
