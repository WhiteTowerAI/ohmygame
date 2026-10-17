import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { OnboardingStore } from "../src/daemon/onboarding.js";
import { MediaProviderKeyStore } from "../src/daemon/media-provider-settings.js";
import { ProviderModelSettingsStore } from "../src/daemon/provider-model-settings.js";
import { INITIAL_ONBOARDING_STATE } from "../src/shared/onboarding.js";

const directories: string[] = [];
const apps: ReturnType<typeof createApp>[] = [];
afterEach(async () => {
  await Promise.all(apps.splice(0).map((app) => app.close()));
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-onboarding-"));
  directories.push(directory);
  const auth = { configured: false };
  const model = {
    provider: "test",
    id: "test-model",
    name: "Test model",
    reasoning: false,
  };
  const runtime = {
    getProviders: () => [
      {
        id: "test",
        name: "Test",
        auth: { apiKey: { name: "API key", login: vi.fn() } },
      },
    ],
    getProviderAuthStatus: () => auth,
    listCredentials: async () => [],
    getAvailable: async () => (auth.configured ? [model] : []),
  } as unknown as ModelRuntime;
  const create = (accessToken?: string) => {
    const app = createApp({
      dataDirectory: directory,
      piAgentDirectory: directory,
      createModelRuntime: async () => runtime,
      accessToken,
    });
    apps.push(app);
    return app;
  };
  return { directory, auth, model, create };
}

describe("onboarding persistence", () => {
  it("resumes the current step and serializes writes without migration overwriting user choices", async () => {
    const { directory } = await fixture();
    const store = new OnboardingStore(directory);
    await store.load();
    expect(store.get()).toEqual(INITIAL_ONBOARDING_STATE);
    await Promise.all([
      store.update({ status: "pending", step: "connect" }),
      store.initialize({ status: "completed", step: "connect" }),
    ]);
    const restored = new OnboardingStore(directory);
    await restored.load();
    expect(restored.get()).toEqual({
      version: 1,
      status: "pending",
      step: "connect",
    });
    expect(
      (await stat(path.join(directory, "onboarding.json"))).mode & 0o777,
    ).toBe(0o600);
    await Promise.all([
      store.update({ status: "skipped", step: "connect" }),
      store.update({ status: "pending", step: "welcome" }),
    ]);
    expect(
      JSON.parse(
        await readFile(path.join(directory, "onboarding.json"), "utf8"),
      ),
    ).toEqual(store.get());
    expect(store.get().status).toBe("pending");
  });

  it("keeps state unchanged after a failed write and permits a later retry", async () => {
    const { directory } = await fixture();
    const blocked = path.join(directory, "blocked");
    await writeFile(blocked, "file instead of a directory");
    const store = new OnboardingStore(blocked);
    await expect(
      store.update({ status: "skipped", step: "welcome" }),
    ).rejects.toThrow();
    expect(store.get()).toEqual(INITIAL_ONBOARDING_STATE);
    await rm(blocked);
    await mkdir(blocked);
    await store.update({ status: "skipped", step: "welcome" });
    expect(store.get().status).toBe("skipped");
  });
});

describe("onboarding API", () => {
  it("starts a new install at welcome, remembers skip after restart, and supports reopening", async () => {
    const { create } = await fixture();
    const app = create();
    expect((await app.inject("/settings/onboarding")).json()).toEqual(
      INITIAL_ONBOARDING_STATE,
    );
    const skipped = await app.inject({
      method: "PUT",
      url: "/settings/onboarding",
      payload: { status: "skipped", step: "welcome" },
    });
    expect(skipped.statusCode).toBe(200);
    expect((await create().inject("/settings/onboarding")).json().status).toBe(
      "skipped",
    );
    await app.inject({
      method: "PUT",
      url: "/settings/onboarding",
      payload: { status: "pending", step: "connect" },
    });
    expect((await create().inject("/settings/onboarding")).json()).toEqual({
      version: 1,
      status: "pending",
      step: "connect",
    });
  });

  it.each(["project", "language provider"])(
    "migrates an existing %s installation once",
    async (setup) => {
      const { auth, create } = await fixture();
      const app = create();
      if (setup === "project") {
        expect(
          (await app.inject({ method: "POST", url: "/projects", payload: {} }))
            .statusCode,
        ).toBe(201);
      } else auth.configured = true;
      expect((await app.inject("/settings/onboarding")).json().status).toBe(
        "completed",
      );
      auth.configured = false;
      expect(
        (await create().inject("/settings/onboarding")).json().status,
      ).toBe("completed");
    },
  );

  it("keeps media-only installations in first-run setup", async () => {
    const { directory, create } = await fixture();
    const media = new MediaProviderKeyStore(directory, "meshy", "Meshy");
    await media.update("test-key");
    expect((await create().inject("/settings/onboarding")).json()).toEqual(
      INITIAL_ONBOARDING_STATE,
    );
  });

  it("requires an available, enabled and visible language model to complete", async () => {
    const { directory, auth, model, create } = await fixture();
    const complete = (app: ReturnType<typeof createApp>) =>
      app.inject({
        method: "PUT",
        url: "/settings/onboarding",
        payload: { status: "completed", step: "connect" },
      });
    expect((await complete(create())).statusCode).toBe(409);
    auth.configured = true;
    const preferences = new ProviderModelSettingsStore(directory, directory);
    await preferences.setEnabled("test", false);
    expect((await complete(create())).statusCode).toBe(409);
    await preferences.setEnabled("test", true);
    await preferences.setVisibility("test", [model.id], false);
    expect((await complete(create())).statusCode).toBe(409);
    await preferences.setVisibility("test", [model.id], true);
    expect((await complete(create())).json().status).toBe("completed");
  });

  it("rejects invalid state and protects reads and writes with the daemon token", async () => {
    const { create } = await fixture();
    const app = create("private-token");
    expect((await app.inject("/settings/onboarding")).statusCode).toBe(401);
    expect(
      (
        await app.inject({
          method: "PUT",
          url: "/settings/onboarding",
          payload: { status: "skipped", step: "welcome" },
        })
      ).statusCode,
    ).toBe(401);
    for (const payload of [
      { status: "unknown", step: "welcome" },
      { status: "pending", step: "unknown" },
      { status: "skipped" },
    ]) {
      expect(
        (
          await app.inject({
            method: "PUT",
            url: "/settings/onboarding",
            payload,
            headers: { authorization: "Bearer private-token" },
          })
        ).statusCode,
      ).toBe(400);
    }
  });

  it("recovers from a damaged flag without preventing startup", async () => {
    const { directory, create } = await fixture();
    await writeFile(path.join(directory, "onboarding.json"), '{"version":99}');
    const app = create();
    expect((await app.inject("/settings/onboarding")).json()).toEqual(
      INITIAL_ONBOARDING_STATE,
    );
    expect((await app.inject("/projects")).statusCode).toBe(200);
  });
});
