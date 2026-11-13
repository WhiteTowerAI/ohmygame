import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import { readCanvasAssets } from "../src/daemon/canvas-assets.js";
import { writeCanvasJson } from "../src/daemon/canvas-files.js";

const directories: string[] = [];
afterEach(async () => { await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))); });

it("migrates the retired PixelLab skeleton payload without losing its asset", async () => {
  const workspace = await mkdtemp(path.join(tmpdir(), "ohmygame-canvas-assets-"));
  directories.push(workspace);
  await writeCanvasJson(workspace, "assets.json", {
    version: 1,
    assets: { hero: { name: "Hero", path: "assets/hero.png", skeleton: { keypoints: [{ x: 0.5, y: 0.5, label: "NOSE" }] } } },
  });

  await expect(readCanvasAssets(workspace)).resolves.toEqual({ version: 1, assets: { hero: { name: "Hero", path: "assets/hero.png" } } });
  expect(await readFile(path.join(workspace, "canvas", "assets.json"), "utf8")).not.toContain("skeleton");
});
