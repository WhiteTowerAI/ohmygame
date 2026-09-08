import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AssetStudioDraftStore } from "../src/daemon/asset-studio-draft.js";
import type { AssetStudioDraft } from "../src/shared/asset-studio-draft.js";

describe("Asset Studio draft", () => {
  it("persists the latest configuration privately across restarts", async () => {
    const dataDirectory = await temporaryData();
    const store = new AssetStudioDraftStore(dataDirectory);
    await store.load();
    const first = draft({ imagePrompt: "first" });
    const latest = draft({ imagePrompt: "latest", panelView: "history" });

    await Promise.all([store.update(first), store.update(latest)]);

    const restored = new AssetStudioDraftStore(dataDirectory);
    await restored.load();
    expect(restored.get()).toEqual(latest);
    const file = path.join(dataDirectory, "asset-studio-draft.json");
    expect((await stat(file)).mode & 0o777).toBe(0o600);
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ version: 1, ...latest });
  });

  it("rejects unknown fields", async () => {
    const store = new AssetStudioDraftStore(await temporaryData());
    await expect(store.update({ ...draft(), references: [] })).rejects.toThrow("Invalid Asset Studio draft");
  });
});

function draft(overrides: { imagePrompt?: string; panelView?: AssetStudioDraft["panelView"] } = {}): AssetStudioDraft {
  return {
    mode: "image",
    templateIds: {},
    panelView: overrides.panelView ?? "templates",
    image: { prompt: overrides.imagePrompt ?? "", resolution: "1K", aspectRatio: "1:1", outputs: 1 },
    video: { prompt: "", resolution: "720p", aspectRatio: "adaptive", duration: 6 },
    model3D: {
      prompt: "",
      model: "meshy-t2",
      source: "image",
      multiView: false,
      quality: "standard",
      targetPolycount: 4_000,
      texture: true,
      pose: "auto",
      imageEnhancement: true,
    },
  };
}

function temporaryData(): Promise<string> {
  return mkdtemp(path.join(tmpdir(), "open-game-asset-studio-draft-"));
}
