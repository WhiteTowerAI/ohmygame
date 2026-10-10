import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { LegacyMcpConfiguration } from "../src/daemon/legacy-mcp.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(
    directories
      .splice(0)
      .map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function environment() {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-legacy-mcp-"));
  directories.push(directory);
  return {
    directory,
    filePath: path.join(directory, "mcp.json"),
    legacy: new LegacyMcpConfiguration(directory),
  };
}
describe("legacy MCP import", () => {
  it("reads JSONC and backs it up exactly once without modifying the original", async () => {
    const { legacy, filePath } = await environment();
    const original =
      '{ // user comment\n"mcpServers": { "remote": { "url": "https://example.com/mcp" }, }, }';
    await writeFile(filePath, original);
    expect(await legacy.readAndBackup()).toMatchObject({
      remote: { url: "https://example.com/mcp" },
    });
    expect(await readFile(filePath, "utf8")).toBe(original);
    const updated = '{"mcpServers":{}}';
    await writeFile(filePath, updated);
    await legacy.readAndBackup();
    expect(await readFile(`${filePath}.pre-plugins.bak`, "utf8")).toBe(
      original,
    );
    expect(await readFile(filePath, "utf8")).toBe(updated);
  });
  it("leaves a missing legacy file absent without creating a synthetic backup", async () => {
    const { legacy, filePath } = await environment();
    expect(await legacy.readAndBackup()).toEqual({});
    await expect(readFile(filePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(readFile(`${filePath}.pre-plugins.bak`)).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });
  it("rejects invalid configurations without modifying or backing them up", async () => {
    const { legacy, filePath } = await environment();
    await writeFile(filePath, "{ invalid");
    await expect(legacy.readAndBackup()).rejects.toThrow("config is invalid");
    expect(await readFile(filePath, "utf8")).toBe("{ invalid");
    await expect(readFile(`${filePath}.pre-plugins.bak`)).rejects.toMatchObject(
      { code: "ENOENT" },
    );
  });
});
