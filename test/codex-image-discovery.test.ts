import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { AgentRuntimeService } from "../src/daemon/agent-runtimes/service.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
  vi.restoreAllMocks();
});

async function fixture(enabled: boolean) {
  const directory = await mkdtemp(
    path.join(tmpdir(), "ohmygame-image-discovery-"),
  );
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const connection = {
    path: path.join(directory, "codex"),
    signature: "codex-fixture",
    source: "path" as const,
    env: {},
    auth: { status: "signed-in" as const, billing: "subscription" as const },
    error: undefined,
  };
  const connect = vi
    .spyOn(AgentRuntimeService.prototype, "codexImageConnection")
    .mockResolvedValue(connection);
  await writeFile(
    path.join(directory, "model-visibility.json"),
    JSON.stringify({
      version: 1,
      hidden: {},
      disabled: enabled ? [] : ["codex-cli"],
    }),
  );
  const app = createApp({
    dataDirectory: directory,
    piAgentDirectory: path.join(directory, "pi"),
  });
  cleanup.push(() => app.close());
  await app.ready();
  return { app, connection, connect };
}

it("does not check a disabled CLI while listing providers, initializing onboarding or toggling another provider", async () => {
  const { app, connect } = await fixture(false);
  const providers = await app.inject({
    method: "GET",
    url: "/settings/providers",
  });
  expect(providers.statusCode).toBe(200);
  expect(providers.json()).toContainEqual(
    expect.objectContaining({ id: "codex-cli", enabled: false }),
  );
  expect(
    (await app.inject({ method: "GET", url: "/settings/onboarding" }))
      .statusCode,
  ).toBe(200);
  expect(
    (
      await app.inject({
        method: "PATCH",
        url: "/settings/models/providers/hyper3d/enabled",
        payload: { enabled: false },
      })
    ).statusCode,
  ).toBe(200);
  expect(connect).not.toHaveBeenCalled();
  const enabled = await app.inject({
    method: "PATCH",
    url: "/settings/models/providers/codex-cli/enabled",
    payload: { enabled: true },
  });
  expect(enabled.statusCode).toBe(200);
  expect(enabled.json()).toMatchObject({ enabled: true, configured: false });
});

it("serves provider operations during a slow login check and adopts the saved sign-in", async () => {
  const { app, connection, connect } = await fixture(true);
  let release!: (value: typeof connection) => void;
  connect.mockImplementationOnce(
    () =>
      new Promise((resolve) => {
        release = resolve;
      }),
  );
  const providers = await app.inject({
    method: "GET",
    url: "/settings/providers",
  });
  expect(providers.statusCode).toBe(200);
  expect(providers.json()).toContainEqual(
    expect.objectContaining({
      id: "codex-cli",
      configured: false,
      authStatus: "unknown",
    }),
  );
  expect(
    (await app.inject({ method: "GET", url: "/settings/onboarding" }))
      .statusCode,
  ).toBe(200);
  expect(
    (
      await app.inject({
        method: "PATCH",
        url: "/settings/models/providers/hyper3d/enabled",
        payload: { enabled: false },
      })
    ).statusCode,
  ).toBe(200);
  expect(connect).toHaveBeenCalledOnce();
  release(connection);
  await expect
    .poll(async () =>
      (await app.inject({ method: "GET", url: "/settings/providers" }))
        .json()
        .find((provider: { id: string }) => provider.id === "codex-cli"),
    )
    .toMatchObject({ configured: true, authStatus: "signed-in" });
  expect(connect).toHaveBeenCalledOnce();
});
