import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { CODEX_IMAGE_MODEL } from "../src/daemon/agent-runtimes/codex-image-provider.js";
import { createAssetGenerationNode } from "../src/shared/asset-canvas.js";
import type {
  ProjectState,
  ToolJob,
  ProviderSummary,
  ImageModelCatalog,
} from "../src/shared/contracts.js";
import type {
  CanvasBoardDetail,
  CanvasWorkspaceDetail,
} from "../src/shared/canvas-workspace.js";

const cleanup: Array<() => Promise<unknown>> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

// These cases execute POSIX script fixtures; Windows cannot start them as native CLIs.
it.skipIf(process.platform === "win32")("passes multiple canvas references to Codex while its chat agent is off, saves the image and preserves the image toggle across restarts", async () => {
  const directory = await mkdtemp(
    path.join(tmpdir(), "ohmygame-codex-canvas-"),
  );
  cleanup.push(() => rm(directory, { recursive: true, force: true }));
  const binary = path.join(directory, "codex");
  const png =
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=";
  await writeFile(
    binary,
    `#!/usr/bin/env node
const fs = require('node:fs');
if (process.argv[2] === '--version') { console.log('codex-cli 0.163.0'); process.exit(0); }
if (process.argv[2] === 'login') { console.log(fs.existsSync(${JSON.stringify(path.join(directory, "signed-out"))}) ? 'Not logged in' : 'Logged in using ChatGPT'); process.exit(0); }
const send = value => process.stdout.write(JSON.stringify(value) + '\\n');
require('node:readline').createInterface({input:process.stdin}).on('line', line => {
  const m = JSON.parse(line);
  if (!m.id) return;
  const result = m.method === 'modelProvider/capabilities/read' ? {imageGeneration:true}
    : m.method === 'config/read' ? {config:{}}
    : m.method === 'thread/start' ? {thread:{id:'canvas-image'},activePermissionProfile:{id:m.params.permissions}} : {};
  send({id:m.id,result});
  if (m.method === 'turn/start') {
    fs.appendFileSync(${JSON.stringify(path.join(directory, "turns"))}, 'image\\n');
    fs.writeFileSync(${JSON.stringify(path.join(directory, "input.json"))}, JSON.stringify(m.params.input));
    send({method:'item/completed',params:{threadId:'canvas-image',item:{id:'image-1',type:'imageGeneration',status:'completed',result:'${png}'}}});
    send({method:'turn/completed',params:{threadId:'canvas-image',turn:{status:'completed'}}});
  }
});
`,
  );
  await chmod(binary, 0o755);
  await writeFile(
    path.join(directory, "agent-runtimes.json"),
    JSON.stringify({
      runtimes: { "codex-cli": { binaryPath: binary, enabled: false } },
    }),
  );
  let app = createApp({
    dataDirectory: directory,
    piAgentDirectory: path.join(directory, "pi"),
  });
  cleanup.push(() => app.close());
  const call = (
    method: "GET" | "POST" | "PUT" | "PATCH",
    url: string,
    payload?: object,
  ) => app.inject({ method, url, ...(payload ? { payload } : {}) });
  const ref = { provider: "codex-cli", id: "codex-image" };
  // Explicit catalog discovery waits; provider summaries only return a snapshot.
  expect(
    (await call("GET", "/image-models/catalog")).json<ImageModelCatalog>()
      .models,
  ).toContainEqual(CODEX_IMAGE_MODEL);
  expect(
    (await call("GET", "/settings/providers")).json<ProviderSummary[]>(),
  ).toContainEqual(
    expect.objectContaining({
      id: "codex-cli",
      configured: true,
      capabilities: ["image"],
    }),
  );
  expect(
    (await call("GET", "/image-models/catalog")).json<ImageModelCatalog>()
      .models,
  ).toContainEqual(CODEX_IMAGE_MODEL);
  expect((await call("PUT", "/image-models/default", ref)).statusCode).toBe(
    204,
  );
  const project = (
    await call("POST", "/projects", {
      name: "Codex canvas",
      type: "asset-canvas",
    })
  ).json<ProjectState>();
  const base = `/projects/${project.id}/canvas`;
  const workspace = (
    await call("GET", `${base}/workspace`)
  ).json<CanvasWorkspaceDetail>();
  const boardUrl = `${base}/boards/${workspace.boards[0]!.id}`;
  const board = (await call("GET", boardUrl)).json<CanvasBoardDetail>();
  const node = createAssetGenerationNode("image", { x: 0, y: 0 });
  const references = await Promise.all(
    ["content", "style"].map(async (name) => {
      const uploaded = await call("POST", "/library/assets", {
        name,
        purpose: "reference",
        image: { data: png, mediaType: "image/png" },
      });
      expect(uploaded.statusCode, uploaded.body).toBe(201);
      return {
        type: "library" as const,
        assetId: uploaded.json<{ id: string }>().id,
      };
    }),
  );
  if (node.type === "image") {
    node.data.prompt = "An orange cat";
    node.data.images = references;
    node.data.resolution = "4K";
    node.data.aspectRatio = "16:9";
  }
  board.board.nodes.push(node);
  board.board.editorLayout.nodes[node.id] = node.position;
  expect((await call("PUT", boardUrl, board)).statusCode).toBe(200);
  const generated = await call("POST", `${boardUrl}/nodes/${node.id}/generate`);
  expect(generated.statusCode, generated.body).toBe(202);
  expect(generated.json<ToolJob>().model).toEqual(ref);
  await expect
    .poll(
      async () =>
        (await call("GET", `${base}/jobs`)).json<ToolJob[]>()[0]?.status,
      { timeout: 10_000 },
    )
    .toBe("succeeded");
  const saved = (await call("GET", boardUrl))
    .json<CanvasBoardDetail>()
    .board.nodes.find((item) => item.id === node.id)!;
  if (saved.type !== "image") throw new Error("Expected an image node");
  expect(saved.data.assetId).toBeTruthy();
  const assets = (await call("GET", "/library/assets")).json<
    Array<{ id: string; origin: string }>
  >();
  expect(assets).toContainEqual(
    expect.objectContaining({ id: saved.data.assetId, origin: "generated" }),
  );
  expect(await readFile(path.join(directory, "turns"), "utf8")).toBe("image\n");
  const inputs = JSON.parse(
    await readFile(path.join(directory, "input.json"), "utf8"),
  ) as Array<{ type: string; url?: string }>;
  expect(inputs.filter((input) => input.type === "image")).toHaveLength(2);
  expect(
    inputs
      .filter((input) => input.type === "image")
      .every((input) => input.url?.startsWith("data:image/")),
  ).toBe(true);
  expect(
    (
      await call("PATCH", "/settings/models/providers/codex-cli/enabled", {
        enabled: false,
      })
    ).statusCode,
  ).toBe(200);
  expect(
    (await call("GET", "/image-models/catalog"))
      .json<ImageModelCatalog>()
      .models.some((item) => item.provider === "codex-cli"),
  ).toBe(false);
  await app.close();
  app = createApp({
    dataDirectory: directory,
    piAgentDirectory: path.join(directory, "pi"),
  });
  expect(
    (await call("GET", "/settings/providers")).json<ProviderSummary[]>(),
  ).toContainEqual(
    expect.objectContaining({
      id: "codex-cli",
      configured: false,
      enabled: false,
    }),
  );
  await writeFile(path.join(directory, "signed-out"), "");
  const rechecked = await call(
    "POST",
    "/settings/models/providers/codex-cli/images/recheck",
  );
  expect(rechecked.json<ProviderSummary>()).toMatchObject({
    configured: false,
    enabled: false,
    error: expect.stringContaining("Sign in"),
  });
  expect(await readFile(path.join(directory, "turns"), "utf8")).toBe("image\n");
});
