import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { ProviderModelSettingsStore } from "../src/daemon/provider-model-settings.js";

const directories: string[] = [];
const apps: Array<ReturnType<typeof createApp>> = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((dir) => rm(dir, { recursive: true, force: true })),
  );
});
async function directory() {
  const dir = await mkdtemp(
    path.join(tmpdir(), "ohmygame-responses-settings-"),
  );
  directories.push(dir);
  return dir;
}

describe("Responses transport settings", () => {
  it("persists independent serialized provider choices and restores automatic mode", async () => {
    const dir = await directory();
    const store = new ProviderModelSettingsStore(dir, dir);
    await store.load();
    expect(store.responsesTransport("openai")).toBe("auto");
    await Promise.all([
      store.setResponsesTransport("openai", "sse"),
      store.setResponsesTransport("relay", "websocket"),
      store.setResponsesTransport("__proto__", "sse"),
      store.setVisibility("openai", ["hidden-model"], false),
    ]);
    const restored = new ProviderModelSettingsStore(dir, dir);
    await restored.load();
    expect(restored.responsesTransport("openai")).toBe("sse");
    expect(restored.responsesTransport("relay")).toBe("websocket");
    expect(restored.responsesTransport("__proto__")).toBe("sse");
    expect(restored.responsesTransport("constructor")).toBe("auto");
    expect(restored.isVisible({ provider: "openai", id: "hidden-model" })).toBe(
      false,
    );
    expect(
      (await stat(path.join(dir, "model-visibility.json"))).mode & 0o777,
    ).toBe(0o600);
    await expect(
      restored.removeProviderSettings("relay", async () => {
        throw new Error("Could not remove provider");
      }),
    ).rejects.toThrow("Could not remove provider");
    expect(restored.responsesTransport("relay")).toBe("websocket");
    expect(
      JSON.parse(
        await readFile(path.join(dir, "model-visibility.json"), "utf8"),
      ).responsesTransports.relay,
    ).toBe("websocket");
    await restored.setResponsesTransport("relay", "auto");
    expect(
      JSON.parse(
        await readFile(path.join(dir, "model-visibility.json"), "utf8"),
      ).responsesTransports,
    ).not.toHaveProperty("relay");
  });

  it.each([
    null,
    [],
    "invalid",
    { openai: "unknown", relay: "sse", websocket: "websocket" },
  ])(
    "ignores invalid optional transport preferences without losing provider settings: %j",
    async (responsesTransports) => {
      const dir = await directory();
      await writeFile(
        path.join(dir, "model-visibility.json"),
        JSON.stringify({
          version: 1,
          hidden: { openai: ["hidden-model"] },
          disabled: ["anthropic"],
          responsesTransports,
        }),
      );
      const store = new ProviderModelSettingsStore(dir, dir);
      await store.load();
      expect(store.responsesTransport("openai")).toBe("auto");
      expect(store.isVisible({ provider: "openai", id: "hidden-model" })).toBe(
        false,
      );
      expect(store.isEnabled("anthropic")).toBe(false);
      if (
        responsesTransports &&
        !Array.isArray(responsesTransports) &&
        typeof responsesTransports === "object"
      ) {
        expect(store.responsesTransport("relay")).toBe("sse");
        expect(store.responsesTransport("websocket")).toBe("websocket");
      }
    },
  );

  it("validates the API, supports Responses relays without models, restores choices after restart and clears deleted providers", async () => {
    const dir = await directory();
    async function appFixture() {
      const runtime = await ModelRuntime.create({
        authPath: path.join(dir, "auth.json"),
        modelsPath: path.join(dir, "models.json"),
        modelsStorePath: path.join(dir, "catalog.json"),
        allowModelNetwork: false,
      });
      const app = createApp({
        dataDirectory: dir,
        piAgentDirectory: dir,
        createModelRuntime: async () => runtime,
      });
      apps.push(app);
      return app;
    }
    const app = await appFixture();
    const url = "/settings/models/providers/openai/transport";
    expect((await app.inject({ method: "GET", url })).json()).toEqual({
      mode: "auto",
    });
    expect(
      (
        await app.inject({ method: "PUT", url, payload: { mode: "sse" } })
      ).json(),
    ).toEqual({ mode: "sse" });
    for (const payload of [{ mode: "invalid" }, {}]) {
      expect(
        (await app.inject({ method: "PUT", url, payload })).statusCode,
      ).toBe(400);
    }
    const created = await app.inject({
      method: "POST",
      url: "/settings/models/providers/custom",
      payload: {
        name: "Responses relay",
        api: "openai-responses",
        baseUrl: "https://relay.example/v1",
        authentication: "none",
        models: [],
      },
    });
    expect(created.statusCode, created.body).toBe(201);
    const id = created.json().id;
    const relayUrl = `/settings/models/providers/${id}/transport`;
    expect(
      (
        await app.inject({
          method: "PUT",
          url: relayUrl,
          payload: { mode: "websocket" },
        })
      ).json(),
    ).toEqual({ mode: "websocket" });
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/settings/models/providers/missing/transport",
          payload: { mode: "sse" },
        })
      ).statusCode,
    ).toBe(404);
    expect(
      (
        await app.inject({
          method: "GET",
          url: "/settings/models/providers/anthropic/transport",
        })
      ).statusCode,
    ).toBe(404);
    await app.close();
    const restored = await appFixture();
    expect((await restored.inject({ method: "GET", url })).json()).toEqual({
      mode: "sse",
    });
    expect(
      (await restored.inject({ method: "GET", url: relayUrl })).json(),
    ).toEqual({ mode: "websocket" });
    expect(
      (
        await restored.inject({
          method: "DELETE",
          url: `/settings/models/providers/${id}/custom`,
        })
      ).statusCode,
    ).toBe(204);
    expect(
      JSON.parse(
        await readFile(path.join(dir, "model-visibility.json"), "utf8"),
      ).responsesTransports,
    ).not.toHaveProperty(id);
  });
});
