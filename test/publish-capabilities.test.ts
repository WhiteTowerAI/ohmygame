import { createHash } from "node:crypto";
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { ZipFile } from "yazl";
import { ArtifactStore } from "../src/publish-server/artifacts.js";
import { nextListingState } from "../src/publish-server/listings.js";

describe("publish capabilities", () => {
  it("transitions listing state independently of a content type", () => {
    const initial = { status: "unlisted" as const, listedAt: null, updatedAt: "2026-01-01T00:00:00.000Z" };
    expect(nextListingState(initial, "listed", false, "2026-01-02T00:00:00.000Z")).toBe("not_ready");

    const listed = nextListingState(initial, "listed", true, "2026-01-02T00:00:00.000Z");
    if (listed === "not_ready") throw new Error("Expected a listed state");
    expect(listed).toEqual({
      status: "listed",
      listedAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-02T00:00:00.000Z",
    });
    expect(nextListingState(listed, "listed", true, "2026-01-03T00:00:00.000Z")).toEqual({
      status: "listed",
      listedAt: "2026-01-02T00:00:00.000Z",
      updatedAt: "2026-01-03T00:00:00.000Z",
    });
    expect(nextListingState(listed, "unlisted", true, "2026-01-04T00:00:00.000Z")).toEqual({
      status: "unlisted",
      listedAt: null,
      updatedAt: "2026-01-04T00:00:00.000Z",
    });
  });

  it("stores an immutable archive with content-specific required files", async () => {
    const store = new ArtifactStore(await mkdtemp(path.join(tmpdir(), "open-game-artifacts-")));
    await store.load(new Set());
    const archive = await zipFiles({ "plugin.json": "{}", "skills/example/SKILL.md": "# Example" });
    const upload = store.temporaryFile("upload", ".zip");
    const received = await store.receive(Readable.from(archive), upload);

    expect(received).toEqual({
      bytes: archive.length,
      sha256: createHash("sha256").update(archive).digest("hex"),
    });
    await store.installArchive(upload, "plugin-release", { requiredFiles: ["plugin.json"] });
    expect(await store.exists("plugin-release", "plugin.json")).toBe(true);
    expect(await store.file("plugin-release", "/")).toBeUndefined();
    expect(await readFile((await store.file("plugin-release", "/skills/example/SKILL.md"))!, "utf8")).toBe("# Example");
  });

  it("rejects an archive missing a content-specific required file", async () => {
    const store = new ArtifactStore(await mkdtemp(path.join(tmpdir(), "open-game-artifacts-")));
    await store.load(new Set());
    const archive = await zipFiles({ "README.md": "Plugin" });
    const upload = store.temporaryFile("upload", ".zip");
    await store.receive(Readable.from(archive), upload);

    await expect(store.installArchive(upload, "plugin-release", { requiredFiles: ["plugin.json"] }))
      .rejects.toThrow("Artifact must contain a non-empty plugin.json");
    expect(await store.exists("plugin-release", "plugin.json")).toBe(false);
  });
});

function zipFiles(files: Record<string, string>): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const zip = new ZipFile();
    const chunks: Buffer[] = [];
    zip.outputStream.on("data", (chunk: Buffer) => chunks.push(chunk));
    zip.outputStream.on("end", () => resolve(Buffer.concat(chunks)));
    zip.outputStream.on("error", reject);
    for (const [name, contents] of Object.entries(files)) zip.addBuffer(Buffer.from(contents), name);
    zip.end();
  });
}
