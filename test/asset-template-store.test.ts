import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AssetTemplateStore } from "../src/daemon/asset-templates.js";

describe("AssetTemplateStore", () => {
  it("persists local templates and their publication", async () => {
    const directory = await mkdtemp(path.join(tmpdir(), "open-game-asset-templates-"));
    const store = new AssetTemplateStore(directory);
    const saved = await store.create({
      mode: "image",
      name: " Character Sheet ",
      description: "Consistent character views",
      promptLabel: "Prompt",
      promptPlaceholder: "Describe a character",
      previewTemplateId: " character-sheet ",
      defaultPrompt: "Create three views",
      defaults: { imageResolution: "2K", imageAspectRatio: "16:9", imageOutputs: 1 },
    });
    await store.setPublication(saved.id, {
      templateId: "remote-template",
      releaseId: "release-1",
      publishedAt: new Date(0).toISOString(),
      status: "listed",
    });
    const cover = Buffer.from("RIFF\u0004\u0000\u0000\u0000WEBP");
    await store.setCover(saved.id, cover);

    const restarted = new AssetTemplateStore(directory);
    expect(await restarted.list()).toEqual([expect.objectContaining({
      id: saved.id,
      name: "Character Sheet",
      previewTemplateId: "character-sheet",
      source: "local",
      hasCover: true,
      publication: { templateId: "remote-template", releaseId: "release-1", publishedAt: new Date(0).toISOString(), status: "listed" },
    })]);
    expect(await restarted.cover(saved.id)).toEqual(cover);

    await restarted.delete(saved.id);
    expect(await restarted.list()).toEqual([]);
    expect(await restarted.cover(saved.id)).toBeUndefined();
  });
});
