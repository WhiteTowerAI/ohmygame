import {
  mkdir,
  mkdtemp,
  readFile,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { importCodexImage } from "../src/daemon/agent-runtimes/codex-images.js";
import type { DriverContext } from "../src/daemon/agent-runtimes/driver-context.js";
import { AssetLibrary } from "../src/daemon/asset-library.js";
import { ProjectManager } from "../src/daemon/projects.js";

const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=",
  "base64",
);
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

async function setup() {
  const home = await mkdtemp(path.join(tmpdir(), "codex-image-"));
  roots.push(home);
  const root = path.join(home, "generated_images", "thread-1");
  await mkdir(root, { recursive: true });
  const saveGeneratedImage = vi.fn(async () => "assets/generated/cat.png");
  const context = {
    env: { CODEX_HOME: home },
    saveGeneratedImage,
  } as unknown as DriverContext;
  return { home, root, context, saveGeneratedImage };
}

describe("Codex image import", () => {
  it("registers one durable project asset and Library record through the existing importer", async () => {
    const { home, context } = await setup();
    const library = new AssetLibrary(home);
    await library.load();
    const projects = new ProjectManager(home, library);
    await projects.load();
    const project = await projects.create("Native image", "general");
    context.saveGeneratedImage = (name, bytes, prompt) =>
      projects.addGeneratedAsset(project.id, name, bytes, { prompt });
    const item = {
      id: "cat",
      result: png.toString("base64"),
      revisedPrompt: "Orange cat",
    };
    const result = await importCodexImage(item, "thread-1", context);
    expect(await importCodexImage(item, "thread-1", context)).toEqual(result);
    const artifact = (result.details as { artifact: { path: string } })
      .artifact;
    expect(
      await readFile(path.join(project.workspacePath, artifact.path)),
    ).toEqual(png);
    const restored = new AssetLibrary(home);
    await restored.load();
    expect(restored.list()).toEqual([
      expect.objectContaining({ origin: "generated", prompt: "Orange cat" }),
    ]);
    expect(await projects.generatedAssetPrompt(project.id, artifact.path)).toBe(
      "Orange cat",
    );
  });

  it("imports inline data without reading the external savedPath and uses stable names", async () => {
    const { context, saveGeneratedImage } = await setup();
    const item = {
      id: "cat",
      result: `data:image/png;base64,${png.toString("base64")}`,
      savedPath: "/unrelated/private.png",
    };
    await importCodexImage(item, "thread-1", context);
    await importCodexImage(item, "thread-1", context);
    expect(saveGeneratedImage.mock.calls[0]).toEqual(
      saveGeneratedImage.mock.calls[1],
    );
    expect(saveGeneratedImage).toHaveBeenCalledWith(
      expect.stringMatching(/\.png$/),
      png,
      undefined,
    );
  });

  it("imports file-only results from this thread's generated-images directory", async () => {
    const { root, context, saveGeneratedImage } = await setup();
    const savedPath = path.join(root, "cat.png");
    await writeFile(savedPath, png);
    await importCodexImage(
      { id: "cat", result: "", savedPath },
      "thread-1",
      context,
    );
    expect(saveGeneratedImage).toHaveBeenCalledWith(
      expect.any(String),
      png,
      undefined,
    );
  });

  it.each(["outside", "symlink"])(
    "refuses %s file-only results",
    async (kind) => {
      const { home, root, context, saveGeneratedImage } = await setup();
      const outside = path.join(home, "private.png");
      await writeFile(outside, png);
      const link = path.join(root, "link.png");
      await symlink(outside, link);
      await expect(
        importCodexImage(
          { id: "cat", savedPath: kind === "symlink" ? link : outside },
          "thread-1",
          context,
        ),
      ).rejects.toThrow("outside this thread");
      expect(saveGeneratedImage).not.toHaveBeenCalled();
    },
  );

  it("refuses a generated-images thread directory redirected by a symlink", async () => {
    const { home, root, context, saveGeneratedImage } = await setup();
    const other = path.join(home, "other");
    await mkdir(other);
    await writeFile(path.join(other, "cat.png"), png);
    await rm(root, { recursive: true });
    await symlink(other, root);
    await expect(
      importCodexImage(
        { id: "cat", savedPath: path.join(root, "cat.png") },
        "thread-1",
        context,
      ),
    ).rejects.toThrow("outside this thread");
    expect(saveGeneratedImage).not.toHaveBeenCalled();
  });

  it.each([
    { kind: "URL", result: "https://example.com/cat.png" },
    {
      kind: "non-image bytes",
      result: Buffer.from("not an image").toString("base64"),
    },
    { kind: "oversized bytes", result: "A".repeat(45 * 1024 * 1024) },
  ])("rejects $kind inline output", async ({ result }) => {
    const { context, saveGeneratedImage } = await setup();
    await expect(
      importCodexImage({ id: "cat", result }, "thread-1", context),
    ).rejects.toThrow();
    expect(saveGeneratedImage).not.toHaveBeenCalled();
  });
});
