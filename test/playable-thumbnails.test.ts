import { mkdir, mkdtemp, readdir, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import {
  listPlayableThumbnails,
  PlayableThumbnailError,
  readGraphNodeIds,
  readPlayableCover,
  readPlayableThumbnail,
  writePlayableThumbnail,
} from "../src/daemon/playable-thumbnails.js";
import { writePlayableFixtureWorkspace } from "./playable-fixture.js";

const IMAGE = Buffer.concat([Buffer.from("RIFF"), Buffer.alloc(4), Buffer.from("WEBPVP8 ")]);

describe("Node thumbnail cache", () => {
  it("stores a thumbnail with its hash under .ohmygame/thumbnails", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "ohmygame-thumbnails-"));
    const nodeIds = new Set(["menu", "archive"]);

    expect(await listPlayableThumbnails(workspace)).toEqual({});
    expect(await readPlayableThumbnail(workspace, "menu")).toBeUndefined();

    const entry = await writePlayableThumbnail(workspace, "menu", "0123abcd0123ab", IMAGE, nodeIds);
    expect(entry.hash).toBe("0123abcd0123ab");
    expect(await listPlayableThumbnails(workspace)).toEqual({ menu: entry });
    expect(await readPlayableThumbnail(workspace, "menu")).toEqual(IMAGE);
    expect((await readdir(path.join(workspace, ".ohmygame", "thumbnails"))).sort()).toEqual(["menu.json", "menu.webp"]);
  });

  it("covers the project with the Start Scene's thumbnail, or else the first one captured", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "ohmygame-thumbnails-"));
    const nodeIds = new Set(["menu", "archive"]);
    const graph = (entryNodeId: string) => JSON.stringify({ entryNodeId, nodes: [{ id: "menu" }, { id: "archive" }] });
    await writeFile(path.join(workspace, "graph.json"), graph("menu"));
    expect(await readPlayableCover(workspace)).toBeUndefined();

    const archive = Buffer.concat([IMAGE, Buffer.from("archive")]);
    await writePlayableThumbnail(workspace, "archive", "0123abcd", archive, nodeIds);
    expect(await readPlayableCover(workspace)).toEqual(archive);

    await writePlayableThumbnail(workspace, "menu", "0123abcd", IMAGE, nodeIds);
    expect(await readPlayableCover(workspace)).toEqual(IMAGE);
    await writeFile(path.join(workspace, "graph.json"), graph("archive"));
    expect(await readPlayableCover(workspace)).toEqual(archive);
  });

  it("drops the thumbnails of Nodes the graph no longer has", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "ohmygame-thumbnails-"));
    await writePlayableThumbnail(workspace, "menu", "0123abcd", IMAGE, new Set(["menu", "archive"]));
    await writePlayableThumbnail(workspace, "archive", "0123abcd", IMAGE, new Set(["archive"]));

    expect(Object.keys(await listPlayableThumbnails(workspace))).toEqual(["archive"]);
    expect(await readPlayableThumbnail(workspace, "menu")).toBeUndefined();
  });

  it("ignores broken cache entries", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "ohmygame-thumbnails-"));
    await mkdir(path.join(workspace, ".ohmygame", "thumbnails"), { recursive: true });
    await writeFile(path.join(workspace, ".ohmygame", "thumbnails", "menu.json"), "{");
    await writeFile(path.join(workspace, ".ohmygame", "thumbnails", "lobby.json"), JSON.stringify({ hash: "no" }));

    expect(await listPlayableThumbnails(workspace)).toEqual({});
  });

  it("rejects unknown Nodes, invalid IDs and hashes, and a linked cache", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "ohmygame-thumbnails-"));
    const nodeIds = new Set(["menu"]);

    await expect(writePlayableThumbnail(workspace, "lobby", "0123abcd", IMAGE, nodeIds)).rejects.toThrow(PlayableThumbnailError);
    await expect(writePlayableThumbnail(workspace, "../menu", "0123abcd", IMAGE, nodeIds)).rejects.toThrow("Node ID is invalid");
    await expect(writePlayableThumbnail(workspace, "menu", "XYZ", IMAGE, nodeIds)).rejects.toThrow("hash is invalid");
    await expect(readPlayableThumbnail(workspace, "../../etc/passwd")).rejects.toThrow("Node ID is invalid");

    const outside = await mkdtemp(path.join(tmpdir(), "ohmygame-thumbnails-outside-"));
    const linked = await mkdtemp(path.join(tmpdir(), "ohmygame-thumbnails-"));
    await symlink(outside, path.join(linked, ".ohmygame"));
    await expect(writePlayableThumbnail(linked, "menu", "0123abcd", IMAGE, nodeIds)).rejects.toThrow(PlayableThumbnailError);
    expect(await readdir(outside)).toEqual([]);
  });

  it("reads Node IDs from graph.json alone", async () => {
    const workspace = await mkdtemp(path.join(tmpdir(), "ohmygame-thumbnails-"));
    await expect(readGraphNodeIds(workspace)).rejects.toThrow("no graph.json");
    await writePlayableFixtureWorkspace(workspace);
    expect(await readGraphNodeIds(workspace)).toEqual(new Set(["menu", "lobby", "archive"]));
  });
});
