import { link, mkdir, mkdtemp, readFile, readdir, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createApp } from "../src/daemon/app.js";
import { readAssetMetadata, writeAssetMetadata } from "../src/daemon/asset-metadata.js";
import type { CanvasBoardDetail } from "../src/shared/canvas-workspace.js";
import type { LibraryAsset, ProjectState, WorkspaceFile } from "../src/shared/contracts.js";

const fixtures: { app: ReturnType<typeof createApp>; directory: string }[] = [];
afterEach(async () => {
  for (const { app, directory } of fixtures.splice(0)) {
    await app.close();
    await rm(directory, { recursive: true, force: true });
  }
});

async function setup() {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-workspace-files-"));
  const app = createApp({ dataDirectory: directory });
  fixtures.push({ app, directory });
  const response = await app.inject({ method: "POST", url: "/projects", payload: { name: "Files" } });
  const project = response.json<ProjectState>();
  return { app, project, base: `/projects/${project.id}/files` };
}

describe("project file management", () => {
  it("creates, renames and deletes files and folders without overwriting other files", async () => {
    const { app, project, base } = await setup();
    expect((await app.inject({ method: "POST", url: base, payload: { name: "src", kind: "folder" } })).statusCode).toBe(201);
    const payload = { parent: "src", name: "场景.ts", kind: "file" };
    expect((await app.inject({ method: "POST", url: base, payload })).json()).toEqual({ path: "src/场景.ts" });
    await writeFile(path.join(project.workspacePath, "src", "场景.ts"), "original");
    expect((await app.inject({ method: "POST", url: base, payload })).statusCode).toBe(409);
    await writeFile(path.join(project.workspacePath, "src", "existing.ts"), "existing");
    expect((await app.inject({ method: "PATCH", url: `${base}?path=src/场景.ts`, payload: { name: "existing.ts" } })).statusCode).toBe(409);
    expect(await readFile(path.join(project.workspacePath, "src", "场景.ts"), "utf8")).toBe("original");
    expect((await app.inject({ method: "PATCH", url: `${base}?path=src/场景.ts`, payload: { name: "main.ts" } })).json()).toEqual({ path: "src/main.ts" });
    expect((await app.inject({ method: "PATCH", url: `${base}?path=src`, payload: { name: "game" } })).json()).toEqual({ path: "game" });
    expect(await readFile(path.join(project.workspacePath, "game", "main.ts"), "utf8")).toBe("original");
    expect((await app.inject({ method: "DELETE", url: `${base}?path=game/main.ts` })).statusCode).toBe(204);
    expect((await app.inject({ method: "DELETE", url: `${base}?path=game` })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: base })).json()).toEqual([]);
  });

  it("renames files and folders when only the letter case changes", async () => {
    const { app, project, base } = await setup();
    await mkdir(path.join(project.workspacePath, "media"));
    await writeFile(path.join(project.workspacePath, "media", "hero.png"), "hero");
    await writeAssetMetadata(project.workspacePath, "media/hero.png", { origin: "generated", purpose: "asset" });
    expect((await app.inject({ method: "PATCH", url: `${base}?path=media/hero.png`, payload: { name: "Hero.png" } })).json()).toEqual({ path: "media/Hero.png" });
    expect((await app.inject({ method: "PATCH", url: `${base}?path=media`, payload: { name: "Media" } })).json()).toEqual({ path: "Media" });
    expect((await app.inject({ method: "PATCH", url: `/projects/${project.id}/assets?path=Media/Hero.png`, payload: { name: "HERO" } })).json()).toEqual({ path: "Media/HERO.png" });
    expect((await readdir(project.workspacePath)).filter((name) => name.toLowerCase() === "media")).toEqual(["Media"]);
    expect(await readdir(path.join(project.workspacePath, "Media"))).toEqual(["HERO.png"]);
    expect(await readFile(path.join(project.workspacePath, "Media", "HERO.png"), "utf8")).toBe("hero");
    expect((await readAssetMetadata(project.workspacePath)).origins).toEqual({ "Media/HERO.png": "generated" });
  });

  it("refuses a rename onto another entry that the new name resolves to", async () => {
    const { app, project, base } = await setup();
    const file = (name: string) => path.join(project.workspacePath, name);
    await writeFile(file("readme.md"), "readme");
    await writeFile(file("notes.md"), "notes");
    await link(file("readme.md"), file("copy.md"));
    await symlink("readme.md", file("alias.md"));
    for (const name of ["copy.md", "alias.md"]) expect((await app.inject({ method: "PATCH", url: `${base}?path=readme.md`, payload: { name } })).statusCode).toBe(409);
    // Only a case-insensitive file system resolves README.md to the existing readme.md.
    const caseInsensitive = await stat(file("README.md")).then(() => true, () => false);
    expect((await app.inject({ method: "PATCH", url: `${base}?path=notes.md`, payload: { name: "README.md" } })).statusCode).toBe(caseInsensitive ? 409 : 200);
    expect(await readFile(file("readme.md"), "utf8")).toBe("readme");
    expect((await readdir(project.workspacePath)).filter((name) => name.endsWith(".md")).sort()).toEqual(caseInsensitive ? ["alias.md", "copy.md", "notes.md", "readme.md"] : ["README.md", "alias.md", "copy.md", "readme.md"]);
  });

  it("keeps provenance across folder renames and leaves Library copies intact after deletion", async () => {
    const { app, project, base } = await setup();
    await mkdir(path.join(project.workspacePath, "media"));
    await mkdir(path.join(project.workspacePath, ".data", "asset-previews"), { recursive: true });
    await writeFile(path.join(project.workspacePath, "media", "hero.png"), "local bytes");
    await writeFile(path.join(project.workspacePath, ".data", "asset-previews", "hero.jpg"), "preview");
    await writeAssetMetadata(project.workspacePath, "media/hero.png", { origin: "generated", purpose: "asset", prompt: "hero", previewPath: ".data/asset-previews/hero.jpg" });
    const saved = await app.inject({ method: "POST", url: `/projects/${project.id}/assets/library?path=media/hero.png` });
    expect(saved.statusCode, saved.body).toBe(201);
    const asset = saved.json<LibraryAsset>();
    // Local provenance remains authoritative for generated files saved for the first time.
    expect((await app.inject({ method: "GET", url: base })).json<WorkspaceFile[]>()).toContainEqual(expect.objectContaining({ path: "media/hero.png", origin: "generated", purpose: "asset" }));
    expect((await app.inject({ method: "PATCH", url: `${base}?path=media`, payload: { name: "art" } })).statusCode).toBe(200);
    expect(await readAssetMetadata(project.workspacePath)).toMatchObject({ origins: { "art/hero.png": "generated" }, libraryAssets: { "art/hero.png": asset.id } });
    await writeFile(path.join(project.workspacePath, "art", "hero.png"), "edited local bytes");
    expect((await app.inject({ method: "GET", url: `/projects/${project.id}/files/raw?path=art/hero.png` })).body).toBe("edited local bytes");
    expect((await app.inject({ method: "GET", url: `/library/assets/${asset.id}/content` })).body).toBe("local bytes");
    expect((await app.inject({ method: "DELETE", url: `${base}?path=art` })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: `/library/assets/${asset.id}/content` })).statusCode).toBe(200);
    expect(await readAssetMetadata(project.workspacePath)).toMatchObject({ origins: {}, purposes: {}, libraryAssets: {}, prompts: {}, previews: {} });
    await expect(readFile(path.join(project.workspacePath, ".data", "asset-previews", "hero.jpg"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reads legacy upload/reference provenance and changes its use when it becomes a canvas asset", async () => {
    const { app, project, base } = await setup();
    const upload = await app.inject({ method: "POST", url: "/library/assets", payload: { name: "ref.png", purpose: "reference", image: { mediaType: "image/png", data: "iVBORw0KGgo=" } } });
    expect(upload.statusCode, upload.body).toBe(201);
    const asset = upload.json<LibraryAsset>();
    // Emulates historical project metadata containing only a Library link.
    await writeFile(path.join(project.workspacePath, "ref.png"), "image");
    await writeAssetMetadata(project.workspacePath, "ref.png", { libraryAssetId: asset.id });
    expect((await app.inject({ method: "GET", url: base })).json<WorkspaceFile[]>()[0]).toMatchObject({ origin: "uploaded", purpose: "reference" });
    const canvas = `/projects/${project.id}/canvas`;
    const workspace = (await app.inject({ method: "GET", url: `${canvas}/workspace` })).json();
    const boardUrl = `${canvas}/boards/${workspace.boards[0].id}`;
    const board = (await app.inject({ method: "GET", url: boardUrl })).json<CanvasBoardDetail>();
    board.board.nodes.push({ id: "portrait", type: "asset", position: { x: 0, y: 0 }, data: { assetId: asset.id, mediaType: "image" } });
    board.board.editorLayout.nodes.portrait = { x: 0, y: 0 };
    expect((await app.inject({ method: "PUT", url: boardUrl, payload: board })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: base })).json<WorkspaceFile[]>().find((file) => file.path === "ref.png")).toMatchObject({ origin: "uploaded", purpose: "asset" });
    expect((await app.inject({ method: "PATCH", url: `${base}?path=ref.png`, payload: { name: "portrait.png" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `${canvas}/workspace` })).json().assets[0].path).toBe("portrait.png");
    expect((await app.inject({ method: "DELETE", url: `${base}?path=portrait.png` })).statusCode).toBe(204);
    const after = await app.inject({ method: "GET", url: `${canvas}/workspace` });
    expect(after.statusCode, after.body).toBe(200);
    expect(after.json().assets).toEqual([]);
    expect((await app.inject({ method: "GET", url: boardUrl })).json<CanvasBoardDetail>().board.nodes).toEqual([]);
  });

  it("rejects traversal, root operations, symlinks and protected project metadata", async () => {
    const { app, project, base } = await setup();
    await writeFile(path.join(project.workspacePath, "main.ts"), "safe");
    const outside = await mkdtemp(path.join(tmpdir(), "ohmygame-workspace-outside-"));
    try {
      await writeFile(path.join(outside, "secret.txt"), "outside");
      await symlink(outside, path.join(project.workspacePath, "linked"));
      for (const entry of ["../project.json", ".", "linked/secret.txt", ".data/assets.json"]) {
        expect((await app.inject({ method: "DELETE", url: `${base}?path=${encodeURIComponent(entry)}` })).statusCode).toBe(400);
        expect((await app.inject({ method: "PATCH", url: `${base}?path=${encodeURIComponent(entry)}`, payload: { name: "new.ts" } })).statusCode).toBe(400);
      }
      expect((await app.inject({ method: "POST", url: base, payload: { parent: "linked", name: "new.txt", kind: "file" } })).statusCode).toBe(400);
      expect((await app.inject({ method: "POST", url: base, payload: { name: "../escape", kind: "file" } })).statusCode).toBe(400);
      expect(await readFile(path.join(outside, "secret.txt"), "utf8")).toBe("outside");
      expect((await app.inject({ method: "DELETE", url: "/projects/missing/files?path=main.ts" })).statusCode).toBe(404);
    } finally { await rm(outside, { recursive: true, force: true }); }
  });

  it("keeps Canvas document links attached to folder renames and removes deleted images", async () => {
    const { app, project, base } = await setup();
    await mkdir(path.join(project.workspacePath, "art"));
    await writeFile(path.join(project.workspacePath, "art", "local hero.png"), "local");
    const canvas = `/projects/${project.id}/canvas`;
    const document = (await app.inject({ method: "POST", url: `${canvas}/documents`, payload: { title: "Art" } })).json();
    await writeFile(path.join(project.workspacePath, "canvas", "assets.json"), JSON.stringify({ version: 1, assets: { hero: { name: "local hero.png", path: "art/local hero.png" } } }));
    expect((await app.inject({ method: "POST", url: `${canvas}/documents/${document.document.id}/images`, payload: { assetId: "hero" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "PATCH", url: `${base}?path=art`, payload: { name: "images" } })).statusCode).toBe(200);
    const markdownPath = path.join(project.workspacePath, "canvas", "documents", `${document.document.id}.md`);
    expect(await readFile(markdownPath, "utf8")).toContain("../../images/local%20hero.png");
    expect((await app.inject({ method: "DELETE", url: `${base}?path=images` })).statusCode).toBe(204);
    expect(await readFile(markdownPath, "utf8")).not.toContain("![local hero.png]");
    expect((await app.inject({ method: "GET", url: `${canvas}/workspace` })).json().assets).toEqual([]);
  });

  it("removes a folder's Canvas assets together and preserves unrelated boards and custom labels", async () => {
    const { app, project, base } = await setup();
    await mkdir(path.join(project.workspacePath, "art"));
    for (const name of ["hero", "background"]) await writeFile(path.join(project.workspacePath, "art", `${name}.png`), name);
    const canvas = `/projects/${project.id}/canvas`;
    const workspace = (await app.inject({ method: "GET", url: `${canvas}/workspace` })).json();
    await writeFile(path.join(project.workspacePath, "canvas", "assets.json"), JSON.stringify({ version: 1, assets: {
      hero: { name: "Main character", path: "art/hero.png" },
      background: { name: "background.png", path: "art/background.png" },
    } }));
    const boardUrl = `${canvas}/boards/${workspace.boards[0].id}`;
    const detail = (await app.inject({ method: "GET", url: boardUrl })).json<CanvasBoardDetail>();
    detail.board.nodes = ["hero", "background"].map((assetId) => ({ id: assetId, type: "asset", position: { x: 0, y: 0 }, data: { assetId, mediaType: "image" } }));
    detail.board.editorLayout.nodes = Object.fromEntries(detail.board.nodes.map((node) => [node.id, node.position]));
    expect((await app.inject({ method: "PUT", url: boardUrl, payload: detail })).statusCode).toBe(200);
    const boards = (await app.inject({ method: "POST", url: `${canvas}/boards`, payload: { name: "Unrelated" } })).json();
    const unrelatedPath = path.join(project.workspacePath, "canvas", "boards", `${boards.boards[1].id}.json`);
    const before = await stat(unrelatedPath, { bigint: true });
    expect((await app.inject({ method: "PATCH", url: `${base}?path=art/hero.png`, payload: { name: "player.png" } })).statusCode).toBe(200);
    expect((await app.inject({ method: "GET", url: `${canvas}/workspace` })).json().assets).toContainEqual(expect.objectContaining({ id: "hero", name: "Main character", path: "art/player.png" }));
    expect((await app.inject({ method: "DELETE", url: `${base}?path=art` })).statusCode).toBe(204);
    expect((await app.inject({ method: "GET", url: boardUrl })).json<CanvasBoardDetail>().board.nodes).toEqual([]);
    expect((await app.inject({ method: "GET", url: `${canvas}/workspace` })).json().assets).toEqual([]);
    expect((await stat(unrelatedPath, { bigint: true })).mtimeNs).toBe(before.mtimeNs);
  });
});
