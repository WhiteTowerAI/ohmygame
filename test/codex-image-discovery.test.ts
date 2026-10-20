import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
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
  const binary = path.join(directory, "codex");
  const calls = path.join(directory, "calls");
  const release = path.join(directory, "release");
  await writeFile(
    binary,
    `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync(${JSON.stringify(calls)}, process.argv[2] + '\\n');
if (process.argv[2] === '--version') { console.log('codex-cli 0.163.0'); process.exit(0); }
if (process.argv[2] === 'login') { console.log('Logged in using ChatGPT'); process.exit(0); }
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const message = JSON.parse(line);
  if (!message.id) return;
  if (message.method === 'modelProvider/capabilities/read') {
    fs.appendFileSync(${JSON.stringify(calls)}, 'capabilities\\n');
    const timer = setInterval(() => {
      if (!fs.existsSync(${JSON.stringify(release)})) return;
      clearInterval(timer);
      send({id:message.id,result:{imageGeneration:true}});
    }, 10);
  } else send({id:message.id,result:{}});
});
`,
  );
  await chmod(binary, 0o755);
  // Exercise a real stalled app-server process without depending on shell-path
  // discovery, local credentials or the timing of version/auth subprocesses.
  const connect = vi
    .spyOn(AgentRuntimeService.prototype, "codexImageConnection")
    .mockResolvedValue({
      path: binary,
      signature: binary,
      source: "path",
      env: { PATH: process.env.PATH ?? "" },
      auth: { status: "signed-in", billing: "subscription" },
      error: undefined,
    });
  await writeFile(
    path.join(directory, "agent-runtimes.json"),
    JSON.stringify({
      runtimes: { "codex-cli": { binaryPath: binary, enabled: false } },
    }),
  );
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
  return { app, calls, release, connect };
}

it("does not start a disabled CLI while listing providers, initializing onboarding or toggling another provider", async () => {
  const { app, calls, connect } = await fixture(false);
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
  await expect(readFile(calls, "utf8")).rejects.toMatchObject({
    code: "ENOENT",
  });
  expect(connect).not.toHaveBeenCalled();
  const enabled = await app.inject({
    method: "PATCH",
    url: "/settings/models/providers/codex-cli/enabled",
    payload: { enabled: true },
  });
  expect(enabled.statusCode).toBe(200);
  expect(enabled.json()).toMatchObject({ enabled: true, configured: false });
});

// These cases execute POSIX script fixtures; Windows cannot start them as native CLIs.
it.skipIf(process.platform === "win32")("serves all provider operations during a stalled background probe and adopts its eventual result", async () => {
  const { app, calls, release } = await fixture(true);
  const providers = await app.inject({
    method: "GET",
    url: "/settings/providers",
  });
  expect(providers.statusCode).toBe(200);
  expect(providers.json()).toContainEqual(
    expect.objectContaining({ id: "codex-cli", configured: false }),
  );
  await expect
    .poll(
      async () =>
        (await readFile(calls, "utf8").catch(() => "")).includes(
          "capabilities\n",
        ),
      { timeout: 5_000 },
    )
    .toBe(true);
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
  expect((await readFile(calls, "utf8")).match(/capabilities/g)).toHaveLength(
    1,
  );
  await writeFile(release, "");
  await expect
    .poll(
      async () =>
        (await app.inject({ method: "GET", url: "/settings/providers" }))
          .json()
          .find((provider: { id: string }) => provider.id === "codex-cli")
          ?.configured,
    )
    .toBe(true);
  expect((await readFile(calls, "utf8")).match(/capabilities/g)).toHaveLength(
    1,
  );
});
