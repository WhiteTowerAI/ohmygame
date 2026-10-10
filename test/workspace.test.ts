import { mkdir, mkdtemp, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { getWorkspaceMedia, listWorkspaceFiles, readWorkspaceFile } from "../src/daemon/workspace.js";

describe("workspace inspection", () => {
  it("lists source files and ignores generated directories", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "ohmygame-workspace-"));
    await mkdir(path.join(workspace, "src"));
    await mkdir(path.join(workspace, "node_modules"));
    await mkdir(path.join(workspace, "dist"));
    await writeFile(path.join(workspace, "src", "main.ts"), "export const game = true;\n");
    await writeFile(path.join(workspace, "src", "cover.PNG"), "image");
    await writeFile(path.join(workspace, "src", "logo.svg"), "<svg/>");
    await writeFile(path.join(workspace, "src", "model.glb"), "model");
    await writeFile(path.join(workspace, "node_modules", "dependency.js"), "ignored");
    await writeFile(path.join(workspace, "dist", "bundle.js"), "ignored");

    await expect(listWorkspaceFiles(workspace)).resolves.toEqual([
      { path: "src/cover.PNG", size: 5, mediaType: "image" },
      { path: "src/logo.svg", size: 6, mediaType: "image" },
      { path: "src/main.ts", size: 26 },
      { path: "src/model.glb", size: 5, mediaType: "model" },
    ]);
  });

  it("adds stored local Asset metadata", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "ohmygame-workspace-"));
    await mkdir(path.join(workspace, "assets", "generated"), { recursive: true });
    await mkdir(path.join(workspace, ".data"));
    await writeFile(path.join(workspace, "assets", "generated", "image.webp"), "image");
    await writeFile(path.join(workspace, ".data", "assets.json"), JSON.stringify({
      version: 1,
      prompts: { "assets/generated/image.webp": "A forest shrine" },
      previews: { "assets/generated/image.webp": ".data/asset-previews/image.jpg" },
      libraryAssets: {},
    }));

    await expect(listWorkspaceFiles(workspace)).resolves.toEqual([
      {
        path: "assets/generated/image.webp", size: 5, mediaType: "image", prompt: "A forest shrine", previewPath: ".data/asset-previews/image.jpg",
      },
    ]);
  });

  it("reads bounded text and reports binary files", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "ohmygame-workspace-"));
    await writeFile(path.join(workspace, "large.txt"), "x".repeat(300 * 1024));
    await writeFile(path.join(workspace, "image.bin"), Buffer.from([0xff, 0xfe, 0x00]));

    const text = await readWorkspaceFile(workspace, "large.txt");
    expect(text).toMatchObject({ binary: false, truncated: true, size: 300 * 1024 });
    expect(text.content).toHaveLength(256 * 1024);
    await expect(readWorkspaceFile(workspace, "image.bin")).resolves.toMatchObject({ binary: true, size: 3 });
  });

  it("keeps bounded text readable when the limit splits a multi-byte character", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "ohmygame-workspace-"));
    // The 256 KB limit falls inside a character in both text files.
    await writeFile(path.join(workspace, "story.md"), "中".repeat(100_000));
    await writeFile(path.join(workspace, "emoji.md"), `xx${"😀".repeat(80_000)}`);
    await writeFile(path.join(workspace, "noise.bin"), Buffer.alloc(300 * 1024, 0xff));
    await writeFile(path.join(workspace, "cut.txt"), Buffer.from([0x78, 0xe4, 0xb8]));

    const text = await readWorkspaceFile(workspace, "story.md");
    expect(text).toMatchObject({ binary: false, truncated: true, size: 300_000 });
    expect(text.content).toBe("中".repeat(Math.floor((256 * 1024) / 3)));
    const emoji = await readWorkspaceFile(workspace, "emoji.md");
    expect(emoji).toMatchObject({ binary: false, truncated: true, size: 320_002 });
    expect(emoji.content).toBe(`xx${"😀".repeat(Math.floor((256 * 1024 - 2) / 4))}`);
    await expect(readWorkspaceFile(workspace, "noise.bin")).resolves.toEqual({ path: "noise.bin", binary: true, truncated: true, size: 300 * 1024 });
    await expect(readWorkspaceFile(workspace, "cut.txt")).resolves.toEqual({ path: "cut.txt", binary: true, size: 3 });
  });

  it("rejects traversal and symbolic links", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "ohmygame-workspace-"));
    const outside = path.join(await mkdtemp(path.join(tmpdir(), "ohmygame-outside-")), "secret.txt");
    await writeFile(outside, "secret");
    await symlink(outside, path.join(workspace, "link.txt"));

    await expect(readWorkspaceFile(workspace, "../secret.txt")).rejects.toThrow("Invalid workspace path");
    await expect(readWorkspaceFile(workspace, path.resolve(outside))).rejects.toThrow("Invalid workspace path");
    await expect(readWorkspaceFile(workspace, "link.txt")).rejects.toThrow("Symbolic links cannot be opened");
  });

  it("resolves supported media and rejects other raw files", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "ohmygame-workspace-"));
    await writeFile(path.join(workspace, "sound.mp3"), "audio");
    await writeFile(path.join(workspace, "logo.svg"), "<svg/>");
    await writeFile(path.join(workspace, "model.glb"), "model");
    await writeFile(path.join(workspace, "notes.txt"), "text");

    await expect(getWorkspaceMedia(workspace, "sound.mp3")).resolves.toMatchObject({
      absolutePath: expect.stringMatching(/sound\.mp3$/),
      contentType: "audio/mpeg",
      size: 5,
    });
    await expect(getWorkspaceMedia(workspace, "notes.txt")).rejects.toThrow("not a supported media asset");
    await expect(getWorkspaceMedia(workspace, "logo.svg")).resolves.toMatchObject({ contentType: "image/svg+xml", mediaType: "image" });
    await expect(getWorkspaceMedia(workspace, "model.glb")).resolves.toMatchObject({ contentType: "model/gltf-binary" });
  });
});
