import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { ProviderImages } from "../src/daemon/provider-images.js";
import { OpenAIImageSettingsStore } from "../src/daemon/openai-image-settings.js";
import { openAIImageConnection } from "../src/daemon/openai-image-routes.js";
import type { SaveOpenAIImageConnectionRequest } from "../src/shared/contracts.js";

const endpoint = "/settings/models/providers/openai/images";
const config: SaveOpenAIImageConnectionRequest = {
  mode: "separate",
  baseUrl: "https://relay.test/v1",
  apiKey: "image-test-key",
  models: [
    {
      id: "my-image-alias",
      name: "Relay image",
      template: "gpt-image-2",
      enabled: true,
    },
  ],
};
const directories: string[] = [];
const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
  vi.unstubAllEnvs();
});

async function fixture(
  credential?: unknown,
  discovery = vi.fn<typeof fetch>(async () =>
    Response.json({ data: [{ id: "gpt-image-2" }, { id: "text-model" }] }),
  ),
) {
  vi.stubEnv("OPENAI_API_KEY", "");
  const directory = await mkdtemp(
    path.join(tmpdir(), "ohmygame-openai-images-"),
  );
  directories.push(directory);
  if (credential)
    await writeFile(
      path.join(directory, "auth.json"),
      JSON.stringify({ openai: credential }),
    );
  const runtime = await ModelRuntime.create({
    authPath: path.join(directory, "auth.json"),
    modelsPath: path.join(directory, "models.json"),
    modelsStorePath: path.join(directory, "catalog.json"),
    allowModelNetwork: false,
  });
  const generation = vi.fn<typeof fetch>(async () =>
    Response.json({
      data: [{ b64_json: Buffer.from("image").toString("base64") }],
    }),
  );
  const app = createApp({
    dataDirectory: directory,
    piAgentDirectory: directory,
    createModelRuntime: async () => runtime,
    modelDiscoveryFetch: discovery,
    imageFetch: generation,
  });
  apps.push(app);
  await app.ready();
  const store = new OpenAIImageSettingsStore(directory);
  const images = new ProviderImages(
    async () => runtime,
    generation,
    undefined,
    undefined,
    {
      openAIConnection: () =>
        openAIImageConnection(store, async () => runtime).resolve(),
    },
  );
  const save = async (value = config) => {
    const response = await app.inject({
      method: "PUT",
      url: endpoint,
      payload: value,
    });
    expect(response.statusCode, response.body).toBe(200);
    await store.load();
    return response.json();
  };
  return {
    app,
    runtime,
    directory,
    discovery,
    store,
    images,
    generation,
    save,
  };
}

describe("OpenAI image connections", () => {
  it("keeps ChatGPT sign-in intact while generating and editing through a separate relay", async () => {
    const { app, runtime, directory, save, images, generation } = await fixture(
      {
        type: "oauth",
        access: "chat-access",
        refresh: "chat-refresh",
        expires: Date.now() + 3_600_000,
      },
    );
    expect(runtime.isUsingOAuth("openai")).toBe(true);
    const before = await readFile(path.join(directory, "auth.json"), "utf8");
    const settings = await save();
    expect(settings).toMatchObject({
      mode: "separate",
      configured: true,
      connectionAvailable: false,
    });
    expect(settings).not.toHaveProperty("apiKey");
    expect(
      (await app.inject({ method: "GET", url: "/settings/providers" })).json(),
    ).toContainEqual(
      expect.objectContaining({
        id: "openai",
        credentialType: "oauth",
        languageConfigured: true,
        imageConfigured: true,
      }),
    );
    expect(await readFile(path.join(directory, "auth.json"), "utf8")).toBe(
      before,
    );
    expect((await images.catalog()).models).toContainEqual(
      expect.objectContaining({
        id: "my-image-alias",
        provider: "openai",
        maxReferenceImages: 16,
      }),
    );
    await images.generate({
      prompt: "Game icon",
      imageModel: { provider: "openai", id: "my-image-alias" },
      resolution: "1K",
      aspectRatio: "1:1",
    });
    await images.generate({
      prompt: "Edit icon",
      imageModel: { provider: "openai", id: "my-image-alias" },
      resolution: "1K",
      aspectRatio: "1:1",
      images: [
        {
          mediaType: "image/png",
          data: Buffer.from("reference").toString("base64"),
        },
      ],
    });
    expect(generation.mock.calls.map(([url]) => url)).toEqual([
      "https://relay.test/v1/images/generations",
      "https://relay.test/v1/images/edits",
    ]);
    expect(generation.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer image-test-key",
    });
    expect(
      JSON.parse(String(generation.mock.calls[0]?.[1]?.body)),
    ).toMatchObject({ model: "my-image-alias" });
    expect((generation.mock.calls[1]?.[1]?.body as FormData).get("model")).toBe(
      "my-image-alias",
    );
    expect(runtime.isUsingOAuth("openai")).toBe(true);
  });

  it("fetches with the draft key and URL without saving, filtering out text models", async () => {
    const { app, discovery, directory } = await fixture();
    const response = await app.inject({
      method: "POST",
      url: `${endpoint}/discover`,
      payload: {
        mode: "separate",
        baseUrl: "https://draft.test/v1/",
        apiKey: "draft-key",
      },
    });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json().models).toEqual([
      {
        id: "gpt-image-2",
        name: "gpt-image-2",
        template: "gpt-image-2",
        enabled: false,
      },
    ]);
    expect(String(discovery.mock.calls[0]?.[0])).toBe(
      "https://draft.test/v1/models",
    );
    expect(discovery.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer draft-key",
    });
    await expect(
      readFile(path.join(directory, "openai-images.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
    expect(
      (await app.inject({ method: "GET", url: "/settings/providers" })).json(),
    ).toContainEqual(
      expect.objectContaining({ id: "openai", configured: false }),
    );
    expect(
      (await app.inject({ method: "GET", url: "/image-models/catalog" })).json()
        .providers,
    ).not.toContainEqual(expect.objectContaining({ provider: "openai" }));
  });

  it("starts with the default connection when saved image settings are unreadable", async () => {
    vi.stubEnv("OPENAI_API_KEY", "");
    const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-openai-images-"));
    directories.push(directory);
    await writeFile(path.join(directory, "openai-images.json"), JSON.stringify({ version: 2, mode: "future" }));
    const runtime = await ModelRuntime.create({
      authPath: path.join(directory, "auth.json"),
      modelsPath: path.join(directory, "models.json"),
      modelsStorePath: path.join(directory, "catalog.json"),
      allowModelNetwork: false,
    });
    const app = createApp({ dataDirectory: directory, piAgentDirectory: directory, createModelRuntime: async () => runtime });
    apps.push(app);
    await app.ready();
    const response = await app.inject({ method: "GET", url: endpoint });
    expect(response.statusCode, response.body).toBe(200);
    expect(response.json()).toMatchObject({ mode: "connection", configured: false, models: [] });
  });

  it("supports image-only connections and restores saved models and visibility after restart", async () => {
    const { app, directory, save } = await fixture();
    await save({
      ...config,
      models: [
        ...config.models,
        {
          id: "hidden",
          name: "Hidden",
          template: "gpt-image-1",
          enabled: false,
        },
      ],
    });
    const restored = new OpenAIImageSettingsStore(directory);
    await restored.load();
    expect(restored.models()?.map((model) => model.id)).toEqual([
      "my-image-alias",
    ]);
    const images = new ProviderImages(
      async () => {
        throw new Error("Chat runtime unavailable");
      },
      vi.fn(),
      undefined,
      undefined,
      {
        openAIConnection: () =>
          openAIImageConnection(restored, async () => {
            throw new Error("Chat runtime unavailable");
          }).resolve(),
      },
    );
    expect((await images.catalog()).models.map((model) => model.id)).toEqual([
      "my-image-alias",
    ]);
    expect(
      (await app.inject({ method: "GET", url: "/image-models/catalog" }))
        .json()
        .models.map((model: { id: string }) => model.id),
    ).toEqual(["my-image-alias"]);
    expect(
      (await app.inject({ method: "GET", url: "/settings/providers" })).json(),
    ).toContainEqual(
      expect.objectContaining({
        id: "openai",
        configured: true,
        languageConfigured: false,
        imageConfigured: true,
      }),
    );
    expect(
      (await stat(path.join(directory, "openai-images.json"))).mode & 0o777,
    ).toBe(0o600);
    expect(
      (await app.inject({ method: "GET", url: endpoint })).body,
    ).not.toContain("image-test-key");
    await expect(
      readFile(path.join(directory, "models.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses the image connection through the application's generation tool and honours its default", async () => {
    const { app, generation, save } = await fixture();
    await save();
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/image-models/default",
          payload: { provider: "openai", id: "my-image-alias" },
        })
      ).statusCode,
    ).toBe(204);
    const created = await app.inject({
      method: "POST",
      url: "/tools/generate-image/jobs",
      payload: { prompt: "Game icon", resolution: "1K", aspectRatio: "1:1" },
    });
    expect(created.statusCode, created.body).toBe(202);
    await vi.waitFor(async () => {
      const jobs = (
        await app.inject({ method: "GET", url: "/tool-jobs" })
      ).json();
      expect(
        jobs.find((job: { id: string }) => job.id === created.json().id),
      ).toMatchObject({ status: "succeeded" });
    });
    expect(generation).toHaveBeenCalledTimes(1);
    expect(generation.mock.calls[0]?.[0]).toBe(
      "https://relay.test/v1/images/generations",
    );
  });

  it("reuses a saved key only for its paired endpoint and preserves working settings after failures", async () => {
    const { app, save, directory, discovery } = await fixture();
    await save();
    const original = await readFile(
      path.join(directory, "openai-images.json"),
      "utf8",
    );
    const draft = { mode: "separate", baseUrl: config.baseUrl };
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${endpoint}/discover`,
          payload: draft,
        })
      ).statusCode,
    ).toBe(200);
    expect(discovery.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer image-test-key",
    });
    discovery.mockResolvedValueOnce(new Response("{}", { status: 401 }));
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${endpoint}/discover`,
          payload: draft,
        })
      ).statusCode,
    ).toBe(400);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: endpoint,
          payload: {
            ...config,
            apiKey: undefined,
            baseUrl: "https://other.test/v1",
          },
        })
      ).statusCode,
    ).toBe(400);
    const calls = discovery.mock.calls.length;
    expect(
      (
        await app.inject({
          method: "POST",
          url: `${endpoint}/discover`,
          payload: { ...draft, baseUrl: "https://other.test/v1" },
        })
      ).statusCode,
    ).toBe(400);
    expect(discovery).toHaveBeenCalledTimes(calls);
    expect(
      await readFile(path.join(directory, "openai-images.json"), "utf8"),
    ).toBe(original);
  });

  it("supports explicit chat-key reuse without fetching again during generation", async () => {
    const { images, generation, save, runtime, directory } = await fixture({
      type: "api_key",
      key: "chat-key",
    });
    await save({ ...config, mode: "connection", apiKey: undefined });
    const restored = new OpenAIImageSettingsStore(directory);
    await restored.load();
    expect(restored.get().configured).toBe(false);
    await images.generate({
      prompt: "Icon",
      imageModel: { provider: "openai", id: "my-image-alias" },
      resolution: "1K",
      aspectRatio: "1:1",
    });
    expect(generation).toHaveBeenCalledTimes(1);
    expect(generation.mock.calls[0]?.[0]).toBe(
      "https://api.openai.com/v1/images/generations",
    );
    expect(generation.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer chat-key",
    });
    expect(runtime.isUsingOAuth("openai")).toBe(false);
  });

  it("removes only the image connection and requires explicit chat-key reuse afterwards", async () => {
    const { app, directory, save, images, store, generation } = await fixture({
      type: "api_key",
      key: "chat-key",
    });
    const before = await readFile(path.join(directory, "auth.json"), "utf8");
    await save();
    expect(
      (await app.inject({ method: "DELETE", url: endpoint })).json(),
    ).toMatchObject({ mode: "disabled", configured: false, models: [] });
    await store.load();
    await expect(
      images.generate({
        prompt: "Icon",
        imageModel: { provider: "openai", id: "my-image-alias" },
      }),
    ).rejects.toThrow("unavailable");
    expect(generation).not.toHaveBeenCalled();
    expect(await readFile(path.join(directory, "auth.json"), "utf8")).toBe(
      before,
    );
    expect(
      (
        await app.inject({
          method: "DELETE",
          url: "/settings/models/providers/openai",
        })
      ).statusCode,
    ).toBe(204);
    await expect(
      readFile(path.join(directory, "openai-images.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("uses the chosen credential on failures without falling back to the chat key", async () => {
    const { images, generation, save } = await fixture({
      type: "api_key",
      key: "chat-key",
    });
    await save();
    generation.mockResolvedValue(new Response("{}", { status: 401 }));
    await expect(
      images.generate({ prompt: "Icon", resolution: "1K", aspectRatio: "1:1" }),
    ).rejects.toThrow("API key was rejected");
    expect(generation).toHaveBeenCalledTimes(1);
    expect(generation.mock.calls[0]?.[1]?.headers).toMatchObject({
      authorization: "Bearer image-test-key",
    });
  });

  it.each([
    { apiKey: 3 },
    { baseUrl: "file:///tmp/private" },
    { baseUrl: "https://user:pass@relay.test/v1" },
    { models: [{ ...config.models[0], template: "unknown" }] },
    { models: [config.models[0], config.models[0]] },
  ])("rejects invalid image configuration %j", async (patch) => {
    const { app } = await fixture();
    expect(
      (
        await app.inject({
          method: "PUT",
          url: endpoint,
          payload: { ...config, ...patch },
        })
      ).statusCode,
    ).toBe(400);
  });
});
