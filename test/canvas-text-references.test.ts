import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import type { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { resolveCanvasTextReferences } from "../src/daemon/canvas-text-references.js";
import type { RuntimeModel } from "../src/daemon/agent.js";
import type { CanvasBoardDetail } from "../src/shared/canvas-workspace.js";

const fixtures: Array<{ app: ReturnType<typeof createApp>; directory: string }> = [];
afterEach(async () => {
  for (const fixture of fixtures.splice(0)) { await fixture.app.close(); await rm(fixture.directory, { recursive: true, force: true }); }
});
const model: RuntimeModel = { provider: "openai", id: "vision", name: "Vision", api: "openai-completions", baseUrl: "https://fixture.example/v1",
  reasoning: false, input: ["text", "image"], contextWindow: 128_000, maxTokens: 16_384,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } };

async function fixture() {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-text-references-"));
  const message = { role: "assistant", content: [{ type: "text", text: "Generated document" }], stopReason: "stop" } as Awaited<ReturnType<ModelRuntime["completeSimple"]>>;
  const completeSimple = vi.fn<ModelRuntime["completeSimple"]>().mockResolvedValue(message);
  const streamSimple = vi.fn<ModelRuntime["streamSimple"]>(() => ({ async *[Symbol.asyncIterator]() { yield { type: "done", reason: "stop", message } as const; } }) as unknown as ReturnType<ModelRuntime["streamSimple"]>);
  const runtime = { getModel: () => model, hasConfiguredAuth: () => true, completeSimple, streamSimple } as unknown as ModelRuntime;
  const app = createApp({ dataDirectory: directory, createModelRuntime: async () => runtime });
  fixtures.push({ app, directory });
  const project = (await app.inject({ method: "POST", url: "/projects", payload: { type: "asset-canvas" } })).json();
  const base = `/projects/${project.id}/canvas`;
  const workspace = (await app.inject({ method: "GET", url: `${base}/workspace` })).json();
  const boardId: string = workspace.boards[0].id;
  const brief = (await app.inject({ method: "POST", url: `${base}/documents`, payload: { title: "Brief" } })).json();
  const output = (await app.inject({ method: "POST", url: `${base}/documents`, payload: { title: "Rules" } })).json();
  await writeFile(path.join(project.workspacePath, "canvas", "documents", `${brief.document.id}.md`), "## Latest brief\n\nA forest adventure");
  await mkdir(path.join(project.workspacePath, "assets"), { recursive: true });
  await writeFile(path.join(project.workspacePath, "assets", "forest.png"), Buffer.from("image bytes"));
  await writeFile(path.join(project.workspacePath, "canvas", "assets.json"), JSON.stringify({ version: 1, assets: { forest: { name: "Forest image", path: "assets/forest.png" } } }));
  const detail = (await app.inject({ method: "GET", url: `${base}/boards/${boardId}` })).json<CanvasBoardDetail>();
  const position = { x: 0, y: 0 }, references = ["text", "brief", "image"].map((nodeId) => ({ type: "node" as const, nodeId }));
  detail.board.nodes = [
    { id: "text", type: "text", title: "Characters", position, data: { text: "A curious fox", instruction: "" } },
    { id: "brief", type: "document", position, data: { documentId: brief.document.id } },
    { id: "image", type: "image", position, data: { prompt: "forest", images: [], assetId: "forest", resolution: "1K", aspectRatio: "1:1" } },
    { id: "summary", type: "text", position, data: { text: "", instruction: "Summarize", references } },
    { id: "rules", type: "document", position, data: { documentId: output.document.id, references } },
  ];
  detail.board.editorLayout.nodes = Object.fromEntries(detail.board.nodes.map((node) => [node.id, position]));
  const saved = await app.inject({ method: "PUT", url: `${base}/boards/${boardId}`, payload: detail });
  expect(saved.statusCode, saved.body).toBe(200);
  return { app, base, project, boardId, output, detail: saved.json<CanvasBoardDetail>(), completeSimple, streamSimple };
}

describe("canvas generation reference resolution", () => {
  it("feeds saved text, current Markdown and actual image bytes through both generation endpoints", async () => {
    const { app, base, project, boardId, output, completeSimple, streamSimple } = await fixture();
    const references = await resolveCanvasTextReferences(project.workspacePath, { boardId, nodeId: "summary" });
    expect(references).toEqual([
      { type: "text", label: "Characters", text: "A curious fox" },
      { type: "text", label: "Brief", text: "## Latest brief\n\nA forest adventure" },
      { type: "image", label: "Image", image: { mediaType: "image/png", data: Buffer.from("image bytes").toString("base64") } },
    ]);
    const selected = { provider: model.provider, id: model.id };
    const text = await app.inject({ method: "POST", url: `${base}/text/generate`, payload: { instruction: "Summarize", model: selected, referenceSource: { boardId, nodeId: "summary" } } });
    expect(text.statusCode, text.body).toBe(200);
    const document = await app.inject({ method: "POST", url: `${base}/documents/${output.document.id}/generate`, payload: {
      instruction: "Revise", revision: output.revision, model: selected, referenceSource: { boardId, nodeId: "rules" },
    } });
    expect(document.statusCode, document.body).toBe(200);
    expect(document.json()).toMatchObject({ status: "complete", markdown: "Generated document", revision: output.revision });
    for (const [, context] of [...completeSimple.mock.calls, ...streamSimple.mock.calls]) {
      expect(context.messages[0]!.content).toEqual(expect.arrayContaining([
        { type: "text", text: expect.stringContaining("Latest brief") },
        { type: "image", data: Buffer.from("image bytes").toString("base64"), mimeType: "image/png" },
      ]));
    }
    expect(await readFile(path.join(project.workspacePath, "canvas", "documents", `${output.document.id}.md`), "utf8")).toBe("");
  });

  it("rejects a missing generation node, mismatched document and an image without output", async () => {
    const { app, base, project, boardId, output, detail, completeSimple } = await fixture();
    await expect(resolveCanvasTextReferences(project.workspacePath, { boardId, nodeId: "missing" })).rejects.toThrow("generation node is missing");
    const mismatch = await app.inject({ method: "POST", url: `${base}/documents/${output.document.id}/generate`, payload: {
      instruction: "Revise", revision: output.revision, model: { provider: model.provider, id: model.id }, referenceSource: { boardId, nodeId: "brief" },
    } });
    expect(mismatch.statusCode).toBe(400);
    const image = detail.board.nodes.find((node) => node.id === "image")!;
    if (image.type === "image") delete image.data.assetId;
    expect((await app.inject({ method: "PUT", url: `${base}/boards/${boardId}`, payload: detail })).statusCode).toBe(200);
    await expect(resolveCanvasTextReferences(project.workspacePath, { boardId, nodeId: "summary" })).rejects.toThrow("no saved output");
    expect(completeSimple).not.toHaveBeenCalled();
  });
});
