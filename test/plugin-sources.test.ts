import { createHash } from "node:crypto";
import { cp, lstat, mkdir, mkdtemp, readdir, readFile, realpath, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractTarball } from "../src/daemon/archive-extraction.js";
import { PluginMarketError, type MarketRelease } from "../src/daemon/plugin-market.js";
import { PluginDevelopment } from "../src/daemon/plugin-development.js";
import { PluginServices } from "../src/daemon/plugin-services.js";
import { DeclinedUnreadableError, parseGitHubUrl, PluginSourceError, PluginSources, type PluginSourceNetwork } from "../src/daemon/plugin-sources.js";
import { createPluginArchive } from "../src/daemon/publish/archive.js";
import type { MarketPlugin, PluginMarketListing } from "../src/shared/plugins.js";

const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function temporary(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-sources-"));
  cleanup.push(directory);
  return directory;
}

/** One tar entry; `type` is its typeflag. */
function tarEntry(name: string, body: string | Buffer = "", { type = "0", mode = 0o644, link = "" }: { type?: string; mode?: number; link?: string } = {}): Buffer {
  const content = Buffer.from(body);
  const header = Buffer.alloc(512);
  header.write(name, 0, 100);
  header.write(mode.toString(8).padStart(7, "0"), 100);
  header.write("0000000", 108);
  header.write("0000000", 116);
  header.write(content.length.toString(8).padStart(11, "0"), 124);
  header.write("00000000000", 136);
  header.write("        ", 148);
  header.write(type, 156);
  header.write(link, 157, 100);
  header.write("ustar\0" + "00", 257);
  let sum = 0;
  for (const byte of header) sum += byte;
  header.write(`${sum.toString(8).padStart(6, "0")}\0 `, 148);
  const padding = Buffer.alloc((512 - (content.length % 512)) % 512);
  return Buffer.concat([header, content, padding]);
}
const tgz = (...entries: Buffer[]) => gzipSync(Buffer.concat([...entries, Buffer.alloc(1024)]));

const manifest = (id: string, version = "1.0.0", extra: object = {}) => JSON.stringify({
  id, version, engines: { "ohmygame-api": "^2.0.0" }, displayName: "Maker", description: "Makes things",
  contributes: { skills: "./skills/" }, ...extra,
});
const skill = "---\nname: make\ndescription: Make things when asked.\n---\nMake it.\n";
function pluginEntries(prefix: string, id = "acme/maker", version = "1.0.0", extra: object = {}): Buffer[] {
  return [
    tarEntry(`${prefix}.ohmygame-plugin/plugin.json`, manifest(id, version, extra)),
    tarEntry(`${prefix}skills/make/SKILL.md`, skill),
  ];
}

const limits = { maxEntries: 20, maxBytes: 4096, error: (reason: string) => new Error(reason) };
async function extract(bytes: Buffer, options: Partial<typeof limits> = {}): Promise<string> {
  const directory = await temporary();
  await writeFile(path.join(directory, "a.tgz"), bytes);
  const destination = path.join(directory, "out");
  await mkdir(destination);
  await extractTarball(path.join(directory, "a.tgz"), destination, { ...limits, ...options });
  return destination;
}

describe("extractTarball", () => {
  it("unpacks files and folders, keeps the executable bit, and follows long paths", async () => {
    const long = `${"deep/".repeat(30)}file.txt`;
    const paxRecord = (value: string) => {
      const text = ` path=${value}\n`;
      let length = text.length;
      while (`${length}${text}`.length !== length) length = `${length}${text}`.length;
      return `${length}${text}`;
    };
    const out = await extract(tgz(
      tarEntry("pax_global_header", "52 comment=abc\n", { type: "g" }),
      tarEntry("folder/", "", { type: "5", mode: 0o755 }),
      tarEntry("folder/run.sh", "echo hi", { mode: 0o755 }),
      tarEntry("././@LongLink", long, { type: "L" }),
      tarEntry("cut-short", "gnu"),
      tarEntry("PaxHeaders/x", paxRecord(`pax/${long}`), { type: "x" }),
      tarEntry("cut-short-too", "pax"),
    ));
    expect(await readFile(path.join(out, "folder/run.sh"), "utf8")).toBe("echo hi");
    if (process.platform !== "win32") expect((await stat(path.join(out, "folder/run.sh"))).mode & 0o111).not.toBe(0);
    expect(await readFile(path.join(out, long), "utf8")).toBe("gnu");
    expect(await readFile(path.join(out, "pax", long), "utf8")).toBe("pax");
  });

  it("takes paths that start with ./, as tar -C folder . writes them", async () => {
    const out = await extract(tgz(tarEntry("./", "", { type: "5", mode: 0o755 }), tarEntry("./folder/", "", { type: "5", mode: 0o755 }), tarEntry("./folder/file.txt", "hi"), tarEntry("./top.txt", "top")));
    expect(await readFile(path.join(out, "folder/file.txt"), "utf8")).toBe("hi");
    expect(await readFile(path.join(out, "top.txt"), "utf8")).toBe("top");
    await expect(extract(tgz(tarEntry("./../escape", "x")))).rejects.toThrow("invalid-path");
    await expect(extract(tgz(tarEntry("./", "x")))).rejects.toThrow("invalid-path");
  });

  it.each([
    ["a symbolic link", () => tarEntry("link", "", { type: "2", link: "/etc/passwd" }), "symbolic-link"],
    ["a hard link", () => tarEntry("link", "", { type: "1", link: "other" }), "symbolic-link"],
    ["a device", () => tarEntry("device", "", { type: "3" }), "invalid-tar"],
    ["a path out of the folder", () => tarEntry("../escape", "x"), "invalid-path"],
    ["a nested path out of the folder", () => tarEntry("a/../../escape", "x"), "invalid-path"],
    ["an absolute path", () => tarEntry("/escape", "x"), "invalid-path"],
    ["a backslash path", () => tarEntry("a\\..\\escape", "x"), "invalid-path"],
    ["a drive path", () => tarEntry("C:/escape", "x"), "invalid-path"],
  ])("rejects %s", async (_label, entry, reason) => {
    await expect(extract(tgz(entry()))).rejects.toThrow(reason);
  });

  it("rejects a long path that leaves the folder, and two entries with one path", async () => {
    await expect(extract(tgz(tarEntry("x", "../../escape", { type: "L" }), tarEntry("fine", "x")))).rejects.toThrow("invalid-path");
    await expect(extract(tgz(tarEntry("same", "a"), tarEntry("same", "b")))).rejects.toThrow("duplicate-path");
  });

  it("stops at its limits, a gzip bomb included", async () => {
    await expect(extract(tgz(tarEntry("big", Buffer.alloc(5000))))).rejects.toThrow("too-large");
    await expect(extract(tgz(tarEntry("a"), tarEntry("b"), tarEntry("c")), { maxEntries: 2 })).rejects.toThrow("too-large");
    await expect(extract(gzipSync(Buffer.alloc(50_000_000)), { maxEntries: 1 })).rejects.toThrow("too-large");
  });

  it("rejects what isn't a tar", async () => {
    await expect(extract(Buffer.from("not gzip"))).rejects.toThrow("invalid-tar");
    await expect(extract(gzipSync(Buffer.alloc(512, 1)))).rejects.toThrow("invalid-tar");
    const cut = tarEntry("cut", Buffer.alloc(2000)).subarray(0, 1000);
    await expect(extract(gzipSync(cut))).rejects.toThrow("invalid-tar");
  });
});

describe("source names", () => {
  it("reads GitHub repositories, at a ref or not", () => {
    expect(parseGitHubUrl("https://github.com/acme/maker")).toEqual({ repository: "acme/maker" });
    expect(parseGitHubUrl("github.com/acme/maker.git/")).toEqual({ repository: "acme/maker" });
    expect(parseGitHubUrl("https://github.com/acme/maker/tree/v1.0")).toEqual({ repository: "acme/maker", ref: "v1.0" });
    expect(parseGitHubUrl("https://github.com/acme/maker/tree/release/1.0/")).toEqual({ repository: "acme/maker", ref: "release/1.0" });
    for (const bad of ["acme/maker", "http://github.com/acme/maker", "https://evil.example/acme/maker", "https://github.com.evil.example/acme/maker", "https://github.com/acme/..", "https://github.com/acme/maker?x=1", "https://github.com/acme/maker/tree/a..b", "https://github.com/acme/maker/tree/a/../../b", "https://github.com/acme/maker/tree/a/./b", "https://github.com/acme/maker/blob/main/x", `https://github.com/acme/maker/commit/${"a".repeat(40)}`])
      expect(() => parseGitHubUrl(bad), bad).toThrow(PluginSourceError);
  });
});

describe("PluginSources", () => {
  type Market = NonNullable<ConstructorParameters<typeof PluginSources>[3]>;
  async function setup(routes: Record<string, () => Response> = {}, files: Record<string, Buffer> = {}, market?: Market) {
    const directory = await temporary();
    const services = new PluginServices({ directory: path.join(directory, "plugin-store") });
    const requested: string[] = [];
    const network: PluginSourceNetwork = {
      fetch: vi.fn(async (input: string | URL | Request) => {
        const url = String(input);
        requested.push(url);
        return routes[url]?.() ?? new Response("missing", { status: 404 });
      }) as typeof fetch,
      download: async (url, file) => {
        requested.push(url);
        const bytes = files[url];
        if (!bytes) throw new Error(`Nothing at ${url}`);
        await writeFile(file, bytes, { flag: "wx" });
      },
    };
    const sources = new PluginSources(services, path.join(directory, "plugin-store", "origins.json"), network, market);
    return { services, sources, requested, directory, close: () => services.close() };
  }
  const sha256 = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");
  /** A plugin package as a release attaches it: its folder, zipped. */
  async function zipped(id = "acme/maker", version = "1.0.0", extra: object = {}, more: Record<string, string> = {}): Promise<Buffer> {
    const folder = await temporary();
    for (const [file, text] of Object.entries({ ".ohmygame-plugin/plugin.json": manifest(id, version, extra), "skills/make/SKILL.md": skill, ...more })) {
      await mkdir(path.dirname(path.join(folder, file)), { recursive: true });
      await writeFile(path.join(folder, file), text);
    }
    return createPluginArchive(folder);
  }
  /** What the market says of a release of `bytes`: its signed record, the mirror's copy then GitHub's, and the release it is. */
  const marketRelease = (bytes: Buffer, { id = "acme/maker", version = "1.0.0", repository = id }: { id?: string; version?: string; repository?: string } = {}): MarketRelease => {
    const mirror = `https://plugins.example.com/plugins/packages/${id}/${version}-${sha256(bytes)}.zip`;
    return {
      release: { id, version, url: mirror, size: bytes.length, sha256: sha256(bytes), key: "test", signature: "c2lnbmVk" },
      urls: [mirror, `https://github.com/${repository}/releases/download/v${version}/plugin.zip`],
      origin: { type: "github", repository, commit: createHash("sha1").update(`${id}@${version}`).digest("hex"), release: `v${version}` },
    };
  };
  /** A market that lists these releases, the newest of each plugin on its cards. */
  function marketOf(...releases: MarketRelease[]) {
    const find = async (id: string, version: string) => releases.find(({ release }) => release.id === id && release.version === version);
    const listing = async (): Promise<PluginMarketListing> => {
      const newest = new Map<string, MarketPlugin>();
      for (const { release, origin } of releases) {
        const listed = newest.get(release.id);
        if (listed && listed.version.localeCompare(release.version, undefined, { numeric: true }) > 0) continue;
        newest.set(release.id, { id: release.id, version: release.version, displayName: release.id, description: "", asks: [], adds: {}, repository: `https://github.com/${origin.repository}`, sourceVerified: true, featured: false });
      }
      return { status: "ready", plugins: [...newest.values()], blocked: [] };
    };
    return { release: vi.fn(find), vouchedRelease: vi.fn(find), listing: vi.fn(listing), releases };
  }
  /** Each release's mirror copy. */
  const mirrored = (...releases: [MarketRelease, Buffer][]) => Object.fromEntries(releases.map(([found, bytes]) => [found.urls[0]!, bytes]));
  const fromMarket = (id = "acme/maker", version = "1.0.0") => ({ type: "market", id, version }) as const;
  /** A repository whose default branch, main, is at this commit. */
  const gitHubBranch = (repository: string, sha: string) => ({
    [`https://api.github.com/repos/${repository}`]: () => Response.json({ default_branch: "main" }),
    [`https://api.github.com/repos/${repository}/git/ref/heads/main`]: () => Response.json({ object: { type: "commit", sha } }),
  });

  it("reviews, then adds a release from the market, allowing what the review listed and recording where it came from", async () => {
    const bytes = await zipped("acme/maker", "1.0.0", { capabilities: { network: ["api.example.com"] }, contributes: { skills: "./skills/", mcpServers: [{ id: "api", title: "API", url: "https://api.example.com/mcp", tools: ["search"] }] } });
    const found = marketRelease(bytes);
    const { services, sources, close } = await setup({}, mirrored([found, bytes]), marketOf(found));
    const preview = await sources.inspect(fromMarket(), "en");
    expect(preview).toMatchObject({
      id: "acme/maker", version: "1.0.0", displayName: "Maker", appWide: false, asks: ["network:api.example.com"], adds: { mcpServers: ["API"], skills: 1 }, installedVersions: [],
      source: fromMarket(),
      origin: found.origin,
    });
    expect(services.index.get("acme/maker")).toBeUndefined();
    const installed = await sources.install(preview.source!, preview.digest);
    expect(installed.id).toBe("acme/maker");
    expect(services.index.get("acme/maker")?.root).toContain(path.join("plugin-store", "packages", "acme", "maker", "1.0.0"));
    expect(services.grants.plugin("acme/maker")?.allowed).toEqual(["network:api.example.com"]);
    expect(await sources.origin("acme/maker", "1.0.0")).toEqual(found.origin);
    await close();
  });

  it("says when the app is too old for a package, and when the package is too old for the app", async () => {
    const check = async (extra: object) => {
      const directory = await temporary();
      await mkdir(path.join(directory, ".ohmygame-plugin"), { recursive: true });
      await writeFile(path.join(directory, ".ohmygame-plugin/plugin.json"), JSON.stringify({ id: "acme/maker", version: "1.0.0", engines: { "ohmygame-api": "^2.0.0" }, displayName: "Maker", description: "Makes things", contributes: { skills: "./skills/" }, ...extra }));
      await mkdir(path.join(directory, "skills/make"), { recursive: true });
      await writeFile(path.join(directory, "skills/make/SKILL.md"), skill);
      const { sources, close } = await setup();
      try {
        return await sources.inspect({ type: "directory", path: directory }, "en").catch((cause: PluginSourceError) => cause);
      } finally {
        await close();
      }
    };
    expect(await check({ engines: { "ohmygame-api": "^3.0.0" } })).toMatchObject({ code: "needs-app-update", message: expect.stringContaining("Update OhMyGame") });
    const futureSlot = {
      contributes: { commands: [{ id: "play", title: "Play", run: { prompt: "Play" }, slots: [{ slot: "game.future" }] }] },
    };
    expect(await check({ ...futureSlot, engines: { "ohmygame-api": "^2.999.0" } })).toMatchObject({
      code: "needs-app-update", message: expect.stringContaining("plugin API ^2.999.0"),
    });
    expect(await check(futureSlot)).toMatchObject({
      code: undefined, message: expect.stringContaining("/contributes/commands/0/slots/0/slot"),
    });
    expect(await check({ engines: { "ohmygame-api": "^03.0.0" } })).toMatchObject({
      code: undefined, message: expect.stringContaining("/engines/ohmygame-api"),
    });
    expect(await check({ ui: { major: 999 } })).toMatchObject({ code: "needs-app-update", message: expect.stringContaining("page components 999") });
    const old = await check({ engines: { "ohmygame-api": "^1.0.0" } });
    expect(old).toMatchObject({ code: "needs-plugin-update", message: expect.stringContaining("author") });
  });

  describe("a version on the market", () => {
    it("downloads from the first place it can, falling back when the mirror fails, and keeps the release it is", async () => {
      const bytes = await zipped();
      const found = marketRelease(bytes);
      const [mirror, github] = found.urls as [string, string];
      const { sources, requested, close } = await setup({}, { [github]: bytes }, marketOf(found));
      const preview = await sources.inspect(fromMarket(), "en");
      expect(requested).toEqual([mirror, github]);
      expect(preview.origin).toEqual(found.origin);
      await close();
    });

    it("refuses a package that isn't the one the market signed, unless another place has the signed one", async () => {
      const bytes = await zipped();
      const found = marketRelease(bytes);
      const [mirror, github] = found.urls as [string, string];
      const tampered = await zipped("acme/maker", "1.0.0", { description: "Changed" });
      // Everywhere tampered with: refused, and nothing installed.
      const everywhere = await setup({}, { [mirror]: tampered, [github]: tampered }, marketOf(found));
      await expect(everywhere.sources.inspect(fromMarket(), "en")).rejects.toThrow(PluginSourceError);
      await expect(everywhere.sources.inspect(fromMarket(), "en")).rejects.toThrow(/is \d+ bytes, not the|doesn't match its digest/);
      expect(everywhere.services.index.get("acme/maker")).toBeUndefined();
      await everywhere.close();
      // Same size, other bytes: the digest is what tells, even when GitHub then can't be reached.
      const flipped = Buffer.from(bytes);
      flipped[flipped.length - 30]! ^= 1;
      const sameSize = await setup({}, { [mirror]: flipped }, marketOf(found));
      await expect(sameSize.sources.inspect(fromMarket(), "en")).rejects.toThrow("doesn't match its digest");
      await sameSize.close();
      // A mirror that lies loses to GitHub's copy, which the signature vouches for.
      const elsewhere = await setup({}, { [mirror]: tampered, [github]: bytes }, marketOf(found));
      const preview = await elsewhere.sources.inspect(fromMarket(), "en");
      await elsewhere.sources.install(preview.source!, preview.digest);
      expect(elsewhere.services.index.get("acme/maker")?.digest).toBe(preview.digest);
      await elsewhere.close();
    });

    it("refuses a signed archive that holds another plugin or version than its record names", async () => {
      for (const [id, version] of [["acme/other", "1.0.0"], ["acme/maker", "2.0.0"]] as const) {
        const bytes = await zipped(id, version);
        const found = marketRelease(bytes);
        const { sources, close } = await setup({}, mirrored([found, bytes]), marketOf(found));
        await expect(sources.inspect(fromMarket(), "en")).rejects.toThrow("not the acme/maker 1.0.0 the market signed");
        await close();
      }
    });

    it("refuses what the market refuses, without downloading it", async () => {
      const refusing = { release: async () => { throw new PluginMarketError("acme/maker 1.0.0 was blocked: steals keys"); } };
      const { sources, requested, close } = await setup({}, {}, refusing);
      await expect(sources.inspect(fromMarket(), "en")).rejects.toThrow(PluginSourceError);
      await expect(sources.inspect(fromMarket(), "en")).rejects.toThrow("was blocked: steals keys");
      expect(requested).toEqual([]);
      await close();
    });

    it("keeps a market card's review and install to a signed version, even once it's gone from the index", async () => {
      const bytes = await zipped();
      const found = marketRelease(bytes);
      const gone = await setup({}, mirrored([found, bytes]), { release: async () => undefined });
      await expect(gone.sources.inspect(fromMarket(), "en")).rejects.toThrow("isn't on the plugin market any more");
      await expect(gone.sources.install(fromMarket(), "d".repeat(64))).rejects.toThrow("isn't on the plugin market any more");
      expect(gone.requested).toEqual([]);
      await gone.close();

      const off = await setup({}, mirrored([found, bytes]));
      await expect(off.sources.inspect(fromMarket(), "en")).rejects.toThrow("isn't on the plugin market any more");
      await off.close();

      const market = marketOf(found);
      const listed = await setup({}, mirrored([found, bytes]), market);
      const preview = await listed.sources.inspect(fromMarket(), "zh-CN");
      expect(market.release).toHaveBeenCalledWith("acme/maker", "1.0.0", "zh-CN");
      market.release.mockResolvedValue(undefined);
      await expect(listed.sources.install(preview.source!, preview.digest)).rejects.toThrow("isn't on the plugin market any more");
      expect(listed.services.index.get("acme/maker")).toBeUndefined();
      await listed.close();
    });

    it("gives a released template its .gitignore back", async () => {
      const extra = { contributes: { skills: "./skills/", projectTypes: [{ id: "game", title: "Game", preview: "web", template: "./template/" }] }, capabilities: {} };
      const bytes = await zipped("acme/maker", "1.0.0", extra, { "template/gitignore": "dist/\n" });
      const found = marketRelease(bytes);
      const { sources, close } = await setup({}, mirrored([found, bytes]), marketOf(found));
      const entry = await sources.install(fromMarket(), (await sources.inspect(fromMarket(), "en")).digest);
      expect(await readFile(path.join(entry.root, "template", ".gitignore"), "utf8")).toBe("dist/\n");
      await close();
    });
  });

  it("keeps the builder's publisher for itself, and OhMyGame's for its releases on the market and folders in development", async () => {
    // personal/ comes only from the Plugin Builder.
    const personalBytes = await zipped("personal/maker");
    const personal = marketRelease(personalBytes, { id: "personal/maker" });
    const builder = await setup({}, mirrored([personal, personalBytes]), marketOf(personal));
    await expect(builder.sources.inspect(fromMarket("personal/maker"), "en")).rejects.toThrow("can't use the publisher");
    await builder.close();

    // ohmygame/ from WhiteTowerAI's releases on the market, which only it can publish there.
    const officialBytes = await zipped("ohmygame/maker");
    const official = marketRelease(officialBytes, { id: "ohmygame/maker", repository: "WhiteTowerAI/ohmygame-plugins" });
    const { sources, services, directory, close } = await setup({}, mirrored([official, officialBytes]), marketOf(official));
    const preview = await sources.inspect(fromMarket("ohmygame/maker"), "en");
    expect(preview.id).toBe("ohmygame/maker");
    expect((await sources.install(preview.source!, preview.digest)).id).toBe("ohmygame/maker");
    expect(services.index.get("ohmygame/maker")?.root).toContain(path.join("plugin-store", "packages", "ohmygame", "maker"));

    // Not from a file, a folder or a GitHub branch, where any package can claim it, nor through installAdded without an origin.
    for (const id of ["ohmygame/other", "personal/other", "project/other"]) {
      await expect(sources.inspectFile(tgz(...pluginEntries("package/", id)), "en")).rejects.toThrow("can't use the publisher");
      const folder = path.join(directory, id.replace("/", "-"));
      await mkdir(path.join(folder, ".ohmygame-plugin"), { recursive: true });
      await writeFile(path.join(folder, ".ohmygame-plugin", "plugin.json"), manifest(id, "1.0.0", { contributes: {} }));
      await expect(sources.inspect({ type: "directory", path: folder }, "en")).rejects.toThrow("can't use the publisher");
      await expect(services.installAdded(folder)).rejects.toThrow("can't use the publisher");
    }
    // A folder OhMyGame develops its own plugin in.
    const developed = path.join(directory, "developed");
    await mkdir(path.join(developed, ".ohmygame-plugin"), { recursive: true });
    await writeFile(path.join(developed, ".ohmygame-plugin", "plugin.json"), manifest("ohmygame/developed", "1.0.0", { contributes: {} }));
    expect((await sources.inspect({ type: "directory", path: developed, development: true }, "en")).id).toBe("ohmygame/developed");
    await close();

    // A release from anyone else's repository doesn't vouch for ohmygame/.
    const posing = marketRelease(officialBytes, { id: "ohmygame/maker", repository: "evil/ohmygame-plugins" });
    const other = await setup({}, mirrored([posing, officialBytes]), marketOf(posing));
    await expect(other.sources.inspect(fromMarket("ohmygame/maker"), "en")).rejects.toMatchObject({ message: expect.stringContaining("unless they come from the plugin market"), code: "official-publisher" });
    await other.close();
  });

  it("doesn't let OhMyGame's releases stand in for a plugin the app bundles", async () => {
    const bytes = await zipped("ohmygame/maker", "2.0.0", { contributes: {} });
    const official = marketRelease(bytes, { id: "ohmygame/maker", version: "2.0.0", repository: "WhiteTowerAI/ohmygame-plugins" });
    const { sources, services, directory, close } = await setup({}, mirrored([official, bytes]), marketOf(official));
    const bundled = path.join(directory, "bundled");
    await mkdir(path.join(bundled, "maker", ".ohmygame-plugin"), { recursive: true });
    await writeFile(path.join(bundled, "maker", ".ohmygame-plugin", "plugin.json"), manifest("ohmygame/maker", "1.0.0", { contributes: {} }));
    await services.addBundled(bundled);
    expect(services.index.get("ohmygame/maker")?.version).toBe("1.0.0");
    await expect(sources.inspect(fromMarket("ohmygame/maker", "2.0.0"), "en")).rejects.toThrow("is already installed from");
    await close();
  });

  it("pins a GitHub repository to a commit and doesn't take a different package at that source", async () => {
    const commit = "c".repeat(40);
    const download = `https://codeload.github.com/acme/maker/tar.gz/${commit}`;
    const files = { [download]: tgz(tarEntry("pax_global_header", `52 comment=${commit}\n`, { type: "g" }), ...pluginEntries("maker-ccc/"), tarEntry("maker-ccc/README.md", "hello")) };
    const { sources, services, requested, close } = await setup(gitHubBranch("acme/maker", commit), files);
    const preview = await sources.inspect({ type: "github", url: "https://github.com/acme/maker" }, "en");
    expect(preview.source).toEqual({ type: "github", url: "https://github.com/acme/maker", commit });
    expect(preview.origin).toEqual({ type: "github", repository: "acme/maker", commit });
    await expect(sources.install(preview.source!, "f".repeat(64))).rejects.toThrow("changed after you reviewed it");
    expect(services.index.get("acme/maker")).toBeUndefined();
    requested.length = 0;
    await sources.install(preview.source!, preview.digest);
    // Adding names the commit, so it asks GitHub for nothing newer.
    expect(requested).toEqual([download]);
    await close();
  });

  it("finds a branch with a slash in its name", async () => {
    const commit = "d".repeat(40);
    const { sources, close } = await setup({
      "https://api.github.com/repos/acme/maker/git/ref/heads/release/1.0": () => Response.json({ object: { type: "commit", sha: commit } }),
    }, { [`https://codeload.github.com/acme/maker/tar.gz/${commit}`]: tgz(...pluginEntries("maker/")) });
    expect((await sources.inspect({ type: "github", url: "https://github.com/acme/maker/tree/release/1.0" }, "en")).origin).toEqual({ type: "github", repository: "acme/maker", commit, ref: "release/1.0" });
    await close();
  });

  it("follows an annotated tag to its commit", async () => {
    const commit = "d".repeat(40);
    const tagObject = "e".repeat(40);
    const base = "https://api.github.com/repos/acme/maker";
    const { sources, close } = await setup({
      [`${base}/git/ref/tags/v1.0`]: () => Response.json({ object: { type: "tag", sha: tagObject } }),
      [`${base}/git/tags/${tagObject}`]: () => Response.json({ object: { type: "commit", sha: commit } }),
    }, { [`https://codeload.github.com/acme/maker/tar.gz/${commit}`]: tgz(...pluginEntries("maker/")) });
    const preview = await sources.inspect({ type: "github", url: "https://github.com/acme/maker/tree/v1.0" }, "en");
    expect(preview.origin).toEqual({ type: "github", repository: "acme/maker", commit, ref: "v1.0" });
    await close();
  });

  it.each(["67a541", "abc1234", "a".repeat(40), `nonexistent-0-g${"a".repeat(40)}`])("reads %s only as a branch or tag, so a fork's commit can't pose as the repository", async (ref) => {
    const { sources, requested, close } = await setup();
    await expect(sources.inspect({ type: "github", url: `https://github.com/acme/maker/tree/${ref}` }, "en")).rejects.toThrow(`has no branch or tag named ${ref}`);
    expect(requested).toEqual([
      `https://api.github.com/repos/acme/maker/git/ref/heads/${ref}`,
      `https://api.github.com/repos/acme/maker/git/ref/tags/${ref}`,
    ]);
    await close();
  });

  it("says when GitHub can't find a repository or is limiting requests", async () => {
    const limited = await setup({ "https://api.github.com/repos/acme/maker": () => new Response("", { status: 403 }) });
    await expect(limited.sources.inspect({ type: "github", url: "https://github.com/acme/maker" }, "en")).rejects.toThrow("limiting requests");
    await limited.close();
    const absent = await setup();
    await expect(absent.sources.inspect({ type: "github", url: "https://github.com/acme/maker" }, "en")).rejects.toThrow("Could not find");
    await absent.close();
  });

  async function folderPackage(directory: string, version = "1.0.0", extra = "") {
    const folder = path.join(directory, "folder");
    await mkdir(path.join(folder, ".ohmygame-plugin"), { recursive: true });
    await mkdir(path.join(folder, "skills", "make"), { recursive: true });
    await writeFile(path.join(folder, ".ohmygame-plugin", "plugin.json"), manifest("acme/maker", version));
    await writeFile(path.join(folder, "skills", "make", "SKILL.md"), skill + extra);
    return folder;
  }

  it("adds an uploaded package and a folder, with no origin", async () => {
    const bytes = tgz(...pluginEntries("package/"));
    const { sources, services, directory, close } = await setup();
    const uploaded = await sources.inspectFile(bytes, "en");
    expect(uploaded.source).toBeUndefined();
    expect(uploaded.installedVersions).toEqual([]);
    await sources.installFile(bytes, uploaded.digest);
    expect(await sources.origin("acme/maker", "1.0.0")).toBeUndefined();
    await services.uninstall("acme/maker");

    const source = { type: "directory", path: await folderPackage(directory) } as const;
    const local = await sources.inspect(source, "en");
    await sources.install(source, local.digest);
    expect(services.index.get("acme/maker")?.root).toContain(path.join("plugin-store", "packages"));
    await expect(sources.inspect({ type: "directory", path: path.join(directory, "absent") }, "en")).rejects.toThrow("no folder");
    await expect(sources.inspect({ type: "directory", path: "relative" }, "en")).rejects.toThrow("full path");
    await close();
  });

  it("adds only what npm would publish from a folder", async () => {
    const { sources, services, directory, close } = await setup();
    const folder = await folderPackage(directory);
    await writeFile(path.join(folder, "package.json"), JSON.stringify({ name: "@acme/maker", version: "1.0.0", files: [".ohmygame-plugin", "skills"] }));
    await mkdir(path.join(folder, "node_modules", ".bin"), { recursive: true });
    await writeFile(path.join(folder, "node_modules", "dependency.js"), "");
    if (process.platform !== "win32") await symlink("../dependency.js", path.join(folder, "node_modules", ".bin", "tool"));
    await mkdir(path.join(folder, ".git"));
    await writeFile(path.join(folder, ".git", "HEAD"), "ref: refs/heads/main\n");
    await writeFile(path.join(folder, "notes.md"), "Not published");
    await writeFile(path.join(folder, "skills", "make", "draft.md.orig"), "");
    const source = { type: "directory", path: folder } as const;
    await sources.install(source, (await sources.inspect(source, "en")).digest);
    const { root } = services.index.get("acme/maker")!;
    expect((await readdir(root, { recursive: true })).map((file) => file.split(path.sep).join("/")).sort()).toEqual([".ohmygame-plugin", ".ohmygame-plugin/plugin.json", "package.json", "skills", "skills/make", "skills/make/SKILL.md"]);
    await close();
  });

  it("installs the folder that was reviewed, not what it became", async () => {
    const { sources, services, directory, close } = await setup();
    const folder = await folderPackage(directory);
    const source = { type: "directory", path: folder } as const;
    const reviewed = await sources.inspect(source, "en");
    await writeFile(path.join(folder, "skills", "make", "SKILL.md"), `${skill}Something else.\n`);
    await expect(sources.install(source, reviewed.digest)).rejects.toThrow("changed after you reviewed it");
    expect(services.index.get("acme/maker")).toBeUndefined();
    await close();
  });

  it.skipIf(process.platform === "win32")("copies a linked folder's contents, so the plugin doesn't depend on the link", async () => {
    const { sources, services, directory, close } = await setup();
    const folder = await folderPackage(directory);
    const link = path.join(directory, "link");
    await symlink(folder, link);
    const source = { type: "directory", path: link } as const;
    const reviewed = await sources.inspect(source, "en");
    await sources.install(source, reviewed.digest);
    await rm(folder, { recursive: true });
    const { root } = services.index.get("acme/maker")!;
    expect((await lstat(root)).isSymbolicLink()).toBe(false);
    expect(await readFile(path.join(root, "skills", "make", "SKILL.md"), "utf8")).toBe(skill);
    await close();
  });

  describe("in development", () => {
    const develop = (folder: string) => ({ type: "directory", path: folder, development: true }) as const;

    it("adds the folder again in place, without a review, and only as the same plugin", async () => {
      const { sources, services, directory, close } = await setup();
      const folder = await folderPackage(directory);
      const preview = await sources.inspect(develop(folder), "en");
      expect(preview.origin).toEqual({ type: "development", folder: await realpath(folder) });
      await sources.install(develop(folder), preview.digest);
      expect(await sources.developmentFolders()).toEqual(new Map([["acme/maker", await realpath(folder)]]));
      expect(await sources.refreshDevelopment("acme/maker")).toBe(false);
      await writeFile(path.join(folder, "skills", "make", "SKILL.md"), `${skill}Then check it.\n`);
      expect(await sources.refreshDevelopment("acme/maker")).toBe(true);
      const entry = services.index.get("acme/maker", "1.0.0")!;
      expect(entry.digest).not.toBe(preview.digest);
      expect(await readFile(path.join(entry.root, "skills", "make", "SKILL.md"), "utf8")).toContain("Then check it.");
      // A new version keeps the old one for the projects that name it.
      await writeFile(path.join(folder, ".ohmygame-plugin", "plugin.json"), manifest("acme/maker", "1.1.0", { capabilities: { native: true }, entrypoints: { native: "./index.mjs" } }));
      await writeFile(path.join(folder, "index.mjs"), "export function activate() {}\n");
      expect(await sources.refreshDevelopment("acme/maker")).toBe(true);
      expect(services.index.versions("acme/maker").map((item) => item.version).sort()).toEqual(["1.0.0", "1.1.0"]);
      await writeFile(path.join(folder, ".ohmygame-plugin", "plugin.json"), manifest("acme/other"));
      await expect(sources.refreshDevelopment("acme/maker")).rejects.toThrow("now holds acme/other");
      await close();
    });

    it("can't develop a plugin installed from elsewhere, even with the same contents", async () => {
      const bytes = await zipped();
      const found = marketRelease(bytes);
      const { sources, directory, close } = await setup({}, mirrored([found, bytes]), marketOf(found));
      const preview = await sources.inspect(fromMarket(), "en");
      await sources.install(preview.source!, preview.digest);
      const folder = await folderPackage(directory);
      await expect(sources.inspect(develop(folder), "en")).rejects.toThrow("already installed from GitHub");
      // Nor from a second folder once one is in development.
      await close();
      const other = await setup();
      const first = await folderPackage(other.directory);
      await other.sources.install(develop(first), (await other.sources.inspect(develop(first), "en")).digest);
      const second = path.join(other.directory, "second");
      await cp(first, second, { recursive: true });
      await expect(other.sources.inspect(develop(second), "en")).rejects.toThrow("in development");
      await other.close();
    });

    it("watches the folder, restarts the plugin's hosts after a change, and says why one can't be added", async () => {
      const { sources, services, directory, close } = await setup();
      const folder = await folderPackage(directory);
      await sources.install(develop(folder), (await sources.inspect(develop(folder), "en")).digest);
      const reload = vi.spyOn(services.native, "reload");
      const development = new PluginDevelopment(services, sources, { settleMs: 20 });
      await development.sync();
      const before = services.index.get("acme/maker")!.digest;
      // macOS fs.watch can lose an edit while starting or changing its OS subscriptions.
      // Keep producing the same edit until it is observed; indexing and reload must still occur.
      await vi.waitFor(async () => {
        if (services.index.get("acme/maker")!.digest === before)
          await writeFile(path.join(folder, "skills", "make", "SKILL.md"), `${skill}Then check it.\n`);
        expect(services.index.get("acme/maker")!.digest).not.toBe(before);
      }, { timeout: 5000 });
      await development.settled();
      expect(reload).toHaveBeenCalledWith("acme/maker");
      // What npm leaves out, such as node_modules, changes nothing.
      reload.mockClear();
      await mkdir(path.join(folder, "node_modules"), { recursive: true });
      await writeFile(path.join(folder, "node_modules", "x.js"), "");
      await new Promise((resolve) => setTimeout(resolve, 200));
      await development.settled();
      expect(reload).not.toHaveBeenCalled();
      await writeFile(path.join(folder, ".ohmygame-plugin", "plugin.json"), "{");
      await vi.waitFor(() => expect(development.error("acme/maker")).toContain("isn't a valid plugin"), { timeout: 5000 });
      await writeFile(path.join(folder, ".ohmygame-plugin", "plugin.json"), manifest("acme/maker"));
      await vi.waitFor(() => expect(development.error("acme/maker")).toBeUndefined(), { timeout: 5000 });
      await services.uninstall("acme/maker");
      await development.sync();
      await writeFile(path.join(folder, "skills", "make", "SKILL.md"), `${skill}Again.\n`);
      await new Promise((resolve) => setTimeout(resolve, 200));
      expect(services.index.get("acme/maker")).toBeUndefined();
      expect((await readFile(path.join(folder, "skills", "make", "SKILL.md"), "utf8"))).toContain("Again.");
      await development.close();
      await close();
    });
  });

  it("keeps an installed plugin's approvals and settings from a package of another source", async () => {
    const commit = "c".repeat(40);
    const bytes = await zipped();
    const found = marketRelease(bytes);
    // A release of the same id from another repository is a source of its own.
    const posingBytes = await zipped("acme/maker", "1.1.0");
    const posing = marketRelease(posingBytes, { version: "1.1.0", repository: "evil/maker" });
    const { sources, services, directory, close } = await setup(gitHubBranch("evil/maker", commit), {
      ...mirrored([found, bytes], [posing, posingBytes]),
      [`https://codeload.github.com/evil/maker/tar.gz/${commit}`]: tgz(...pluginEntries("maker/", "acme/maker", "1.1.0")),
    }, marketOf(found, posing));
    const preview = await sources.inspect(fromMarket(), "en");
    await sources.install(preview.source!, preview.digest);

    const message = "already installed from GitHub (acme/maker)";
    await expect(sources.inspect({ type: "github", url: "https://github.com/evil/maker" }, "en")).rejects.toThrow(message);
    await expect(sources.inspect(fromMarket("acme/maker", "1.1.0"), "en")).rejects.toThrow(message);
    await expect(sources.inspectFile(tgz(...pluginEntries("package/", "acme/maker", "2.0.0")), "en")).rejects.toThrow(message);
    await expect(sources.inspect({ type: "directory", path: await folderPackage(directory, "2.0.0") }, "en")).rejects.toThrow(message);

    // What's kept at uninstall goes back to the same source only; a package from elsewhere that takes the id starts empty.
    const kept = path.join(services.dataFolder("acme/maker"), "token");
    await mkdir(path.dirname(kept), { recursive: true });
    await writeFile(kept, "s3cret");
    await services.uninstall("acme/maker", undefined, { keepData: true });
    const again = await sources.inspect(fromMarket(), "en");
    await sources.install(again.source!, again.digest);
    expect(await readFile(kept, "utf8")).toBe("s3cret");
    await services.uninstall("acme/maker", undefined, { keepData: true });
    const elsewhere = await sources.inspect({ type: "github", url: "https://github.com/evil/maker" }, "en");
    expect(elsewhere.installedVersions).toEqual([]);
    await sources.install(elsewhere.source!, elsewhere.digest);
    await expect(readFile(kept, "utf8")).rejects.toThrow();
    await close();
  });

  it("doesn't let a package from this computer join one installed the same way", async () => {
    const { sources, close } = await setup();
    const bytes = tgz(...pluginEntries("package/"));
    await sources.installFile(bytes, (await sources.inspectFile(bytes, "en")).digest);
    await expect(sources.inspectFile(tgz(...pluginEntries("package/", "acme/maker", "1.1.0")), "en")).rejects.toThrow("another package on this computer");
    await close();
  });

  it("takes a newer release from the same source, and refuses other contents under one version", async () => {
    const first = "1".repeat(40);
    const second = "2".repeat(40);
    const third = "3".repeat(40);
    const url = "https://github.com/acme/maker";
    const { sources, services, close } = await setup({}, {
      [`https://codeload.github.com/acme/maker/tar.gz/${first}`]: tgz(...pluginEntries("maker/")),
      [`https://codeload.github.com/acme/maker/tar.gz/${second}`]: tgz(...pluginEntries("maker/", "acme/maker", "1.1.0")),
      [`https://codeload.github.com/acme/maker/tar.gz/${third}`]: tgz(...pluginEntries("maker/"), tarEntry("maker/extra.txt", "changed")),
    });
    const add = async (commit: string) => {
      const source = { type: "github", url, commit } as const;
      return sources.install(source, (await sources.inspect(source, "en")).digest);
    };
    await add(first);
    await expect(sources.inspect({ type: "github", url, commit: third }, "en")).rejects.toThrow("different contents");
    // The same package again changes nothing, wherever it comes from.
    const identical = tgz(...pluginEntries("package/"));
    const before = services.index.get("acme/maker", "1.0.0")!;
    expect((await sources.installFile(identical, (await sources.inspectFile(identical, "en")).digest)).root).toBe(before.root);
    expect((await sources.origin("acme/maker", "1.0.0"))?.type).toBe("github");
    await add(second);
    // It only adds Skills, so the new version takes over from the old.
    expect(services.index.versions("acme/maker").map((entry) => entry.version)).toEqual(["1.1.0"]);
    await close();
  });

  it("finds newer versions on the market and new commits on GitHub, less often, and asks again only for what a new version adds", async () => {
    const extra = { capabilities: { network: ["api.example.com"] }, contributes: { skills: "./skills/", mcpServers: [{ id: "api", title: "API", url: "https://api.example.com/mcp", tools: ["search"] }] } };
    const bytes = await zipped("acme/maker", "1.0.0", extra);
    const found = marketRelease(bytes);
    const commit = "a".repeat(40);
    const newer = "b".repeat(40);
    const branch = "https://api.github.com/repos/acme/tiles/git/ref/heads/stable";
    let branchAt = commit;
    const market = marketOf(found);
    // The market blocked 1.2.0 after listing it.
    const find = market.release.getMockImplementation()!;
    market.release.mockImplementation(async (id, version) => {
      if (version === "1.2.0") throw new PluginMarketError(`${id} ${version} was blocked: steals keys`);
      return find(id, version);
    });
    const { sources, requested, close } = await setup({
      [branch]: () => Response.json({ object: { type: "commit", sha: branchAt } }),
    }, {
      ...mirrored([found, bytes]),
      [`https://codeload.github.com/acme/tiles/tar.gz/${commit}`]: tgz(...pluginEntries("tiles/", "acme/tiles")),
    }, market);
    const preview = await sources.inspect(fromMarket(), "en");
    // Nothing is installed yet, so there is nothing to compare with.
    expect(preview.newAsks).toBeUndefined();
    await sources.install(preview.source!, preview.digest);
    const tiles = { type: "github", url: "https://github.com/acme/tiles/tree/stable" } as const;
    await sources.install((await sources.inspect(tiles, "en")).source!, (await sources.inspect(tiles, "en")).digest);
    // A package from this computer has nowhere to look.
    const local = tgz(...pluginEntries("package/", "acme/local"));
    await sources.installFile(local, (await sources.inspectFile(local, "en")).digest);
    const now = vi.spyOn(Date, "now");
    try {
      expect(await sources.updates()).toEqual([]);

      market.releases.push(marketRelease(await zipped("acme/maker", "1.1.0", extra), { version: "1.1.0" }));
      branchAt = newer;
      // The market's index says at once; GitHub is asked again only hours later.
      requested.length = 0;
      expect(await sources.updates()).toEqual([{ id: "acme/maker", version: "1.1.0", source: fromMarket("acme/maker", "1.1.0") }]);
      expect(requested).toEqual([]);
      // As does another index that lists the plugin, where the person found it.
      const listed = await market.listing();
      market.listing.mockResolvedValueOnce({ ...listed, plugins: listed.plugins.map((plugin) => ({ ...plugin, source: "https://lists.example.org/index.json" })) });
      expect(await sources.updates()).toEqual([{ id: "acme/maker", version: "1.1.0", source: fromMarket("acme/maker", "1.1.0") }]);
      now.mockReturnValue(Date.now() + 6 * 60 * 60 * 1000);
      expect(await sources.updates()).toEqual([
        { id: "acme/maker", version: "1.1.0", source: fromMarket("acme/maker", "1.1.0") },
        { id: "acme/tiles", commit: newer, source: { type: "github", url: "https://github.com/acme/tiles/tree/stable", commit: newer } },
      ]);
      expect(requested).toEqual([branch]);
    } finally {
      now.mockRestore();
    }
    // A version the market blocked would only be refused, so it isn't offered.
    market.releases.push(marketRelease(await zipped("acme/maker", "1.2.0", extra), { version: "1.2.0" }));
    expect((await sources.updates()).map((update) => update.id)).toEqual(["acme/tiles"]);
    // Adding it allowed what it asks for, so reviewing it again finds nothing new.
    expect((await sources.inspect(fromMarket(), "en")).newAsks).toEqual([]);
    await close();
  });

  it("updates by itself only a market plugin whose new version a fresh index vouches for, runs no code and asks for nothing new", async () => {
    // Each package at 1.0.0, then at 1.1.0 with what that version adds.
    const network = { capabilities: { network: ["api.example.com"] }, contributes: { skills: "./skills/", mcpServers: [{ id: "api", title: "API", url: "https://api.example.com/mcp", tools: ["search"] }] } };
    const provider = (baseUrl: string) => ({ contributes: { skills: "./skills/", providers: [{ id: "chat", title: "Chat", api: "openai-completions", baseUrl, models: [{ id: "m" }] }] } });
    const plugins: Record<string, [object, object]> = {
      "acme/notes": [{}, {}],
      "acme/maker": [network, { ...network, capabilities: { network: ["api.example.com", "cdn.example.com"] } }],
      "acme/native": [{}, { entrypoints: { native: "./index.js" }, capabilities: { native: true } }],
      "acme/chat": [provider("https://api.acme.com/v1"), provider("https://elsewhere.example/v1")],
      // More models at the same address is fine.
      "acme/models": [provider("https://api.acme.com/v1"), { contributes: { skills: "./skills/", providers: [{ id: "chat", title: "Chat", api: "openai-completions", baseUrl: "https://api.acme.com/v1", models: [{ id: "m" }, { id: "n" }] }] } }],
      "acme/unlisted": [{}, {}],
      "acme/removed": [{}, {}],
    };
    const files: Record<string, Buffer> = {};
    const first: MarketRelease[] = [];
    const second: MarketRelease[] = [];
    for (const [id, [older, newer]] of Object.entries(plugins)) {
      for (const [version, extra, list] of [["1.0.0", older, first], ["1.1.0", newer, second]] as const) {
        const bytes = await zipped(id, version, extra, "entrypoints" in extra ? { "index.js": "export function activate() {}" } : {});
        const found = marketRelease(bytes, { id, version });
        files[found.urls[0]!] = bytes;
        list.push(found);
      }
    }
    // The market lists every version, but a fresh index no longer has the unlisted plugin's newer one.
    const market = marketOf(...first, ...second.filter(({ release }) => release.id === "acme/removed"));
    const find = market.release.getMockImplementation()!;
    market.vouchedRelease.mockImplementation(async (id, version) => id === "acme/unlisted" && version === "1.1.0" ? undefined : find(id, version));
    const { services, sources, close } = await setup({}, files, market);
    const add = async (id: string, version: string) => {
      const preview = await sources.inspect(fromMarket(id, version), "en");
      await sources.install(preview.source!, preview.digest);
    };
    for (const id of Object.keys(plugins)) if (id !== "acme/removed") await add(id, "1.0.0");
    // The person went back from 1.1.0 of one: removed it, its last version, and added 1.0.0 again.
    await add("acme/removed", "1.1.0");
    await sources.decline("acme/removed", "1.1.0");
    await services.uninstall("acme/removed", "1.1.0");
    await add("acme/removed", "1.0.0");
    market.releases.push(...second.filter(({ release }) => release.id !== "acme/removed"));
    const updates = await sources.updates();
    expect(updates.map((update) => update.id).sort()).toEqual(["acme/chat", "acme/maker", "acme/models", "acme/native", "acme/notes", "acme/removed", "acme/unlisted"]);
    const failed: string[] = [];
    const updated = await sources.updateQuietly(updates, (id) => failed.push(id));
    // Only the one that asks for nothing new, runs no code, sends nothing elsewhere and the market vouches for.
    expect(updated.map((entry) => `${entry.id}@${entry.version}`).sort()).toEqual(["acme/models@1.1.0", "acme/notes@1.1.0"]);
    expect(failed).toEqual([]);
    expect(services.index.versions("acme/notes").map((entry) => entry.version)).toEqual(["1.1.0"]);
    expect(await sources.origin("acme/notes", "1.1.0")).toEqual(second.find(({ release }) => release.id === "acme/notes")!.origin);
    for (const id of ["acme/maker", "acme/native", "acme/chat", "acme/unlisted", "acme/removed"]) expect(services.index.get(id)?.version, id).toBe("1.0.0");
    expect(services.grants.plugin("acme/maker")?.allowed).toEqual(["network:api.example.com"]);
    // A GitHub branch, however new, waits for the person.
    expect(await sources.updateQuietly([{ id: "acme/notes", commit: "d".repeat(40), source: { type: "github", url: "https://github.com/acme/notes", commit: "d".repeat(40) } }])).toEqual([]);
    // Adding the removed version again is the person's choice, and later ones may update by themselves again.
    await add("acme/removed", "1.1.0");
    expect(services.index.get("acme/removed")?.version).toBe("1.1.0");
    // Removals at once are all kept; a file that can't be read stops updates by itself rather than being replaced.
    const declinedFile = path.join(path.dirname(services.packagesDirectory), "declined-updates.json");
    await Promise.all([sources.decline("acme/notes", "1.1.0"), sources.decline("acme/models", "1.1.0")]);
    expect(JSON.parse(await readFile(declinedFile, "utf8"))).toEqual({ version: 1, plugins: { "acme/models": ["1.1.0"], "acme/notes": ["1.1.0"] } });
    await writeFile(declinedFile, "{ broken");
    await expect(sources.decline("acme/maker", "1.0.0")).rejects.toThrow(DeclinedUnreadableError);
    expect(await readFile(declinedFile, "utf8")).toBe("{ broken");
    const refused: string[] = [];
    expect(await sources.updateQuietly(await sources.updates(), (id) => refused.push(id))).toEqual([]);
    expect(refused.length).toBeGreaterThan(0);
    await close();
  });

  it("lets only one of two packages racing for a version in", async () => {
    const { sources, services, close } = await setup();
    const first = tgz(...pluginEntries("package/"));
    const second = tgz(...pluginEntries("package/"), tarEntry("package/extra.txt", "other"));
    const [one, two] = await Promise.all([sources.inspectFile(first, "en"), sources.inspectFile(second, "en")]);
    const results = await Promise.allSettled([sources.installFile(first, one.digest), sources.installFile(second, two.digest)]);
    // Either may get there first; the installed package is the one that was told it did.
    expect(results.map((result) => result.status).sort()).toEqual(["fulfilled", "rejected"]);
    const winner = results[0].status === "fulfilled" ? one : two;
    expect(services.index.get("acme/maker")?.digest).toBe(winner.digest);
    await close();
  });

  it("installs nothing when it can't record where a package came from", async () => {
    const bytes = await zipped();
    const found = marketRelease(bytes);
    const { sources, services, directory, close } = await setup({}, mirrored([found, bytes]), marketOf(found));
    const preview = await sources.inspect(fromMarket(), "en");
    const origins = path.join(directory, "plugin-store", "origins.json");
    await mkdir(path.join(origins, "in-the-way"), { recursive: true });
    await expect(sources.install(preview.source!, preview.digest)).rejects.toThrow();
    expect(services.index.get("acme/maker")).toBeUndefined();
    await rm(origins, { recursive: true });
    await sources.install(preview.source!, preview.digest);
    expect(await sources.origin("acme/maker", "1.0.0")).toEqual(found.origin);
    await close();
  });

  it("doesn't count an origin left from before an uninstall", async () => {
    const bytes = await zipped();
    const found = marketRelease(bytes);
    const { sources, services, close } = await setup({}, mirrored([found, bytes]), marketOf(found));
    const preview = await sources.inspect(fromMarket(), "en");
    await sources.install(preview.source!, preview.digest);
    await services.uninstall("acme/maker");
    const local = tgz(...pluginEntries("package/"), tarEntry("package/extra.txt", "local"));
    await sources.installFile(local, (await sources.inspectFile(local, "en")).digest);
    expect(await sources.origin("acme/maker", "1.0.0")).toBeUndefined();
    await expect(sources.inspect(fromMarket(), "en")).rejects.toThrow("another package on this computer");
    await close();
  });

  it("hands what a package from this computer kept to no source that had the id before it", async () => {
    const bytes = await zipped();
    const found = marketRelease(bytes);
    const { sources, services, close } = await setup({}, mirrored([found, bytes]), marketOf(found));
    const preview = await sources.inspect(fromMarket(), "en");
    await sources.install(preview.source!, preview.digest);
    await services.uninstall("acme/maker");
    const local = tgz(...pluginEntries("package/", "acme/maker", "2.0.0"));
    await sources.installFile(local, (await sources.inspectFile(local, "en")).digest);
    const kept = path.join(services.dataFolder("acme/maker"), "token");
    await mkdir(path.dirname(kept), { recursive: true });
    await writeFile(kept, "local");
    await services.uninstall("acme/maker", undefined, { keepData: true });
    const again = await sources.inspect(fromMarket(), "en");
    await sources.install(again.source!, again.digest);
    await expect(readFile(kept, "utf8")).rejects.toThrow();
    await close();
  });

  it("leaves a plugin that says where it's on to that when added, instead of every project", async () => {
    const { services, directory, close } = await setup();
    const folder = await folderPackage(directory);
    const file = path.join(folder, ".ohmygame-plugin", "plugin.json");
    await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, "utf8")), activation: { files: ["ProjectSettings/ProjectVersion.txt"] } }));
    const entry = await services.installAdded(folder);
    expect(services.grants.plugin(entry.id)?.everyProject).toBeUndefined();
    expect(services.onInEveryProject(entry.id)).toBe(false);
    await close();
  });

  it("doesn't let an uninstall delete what an install just placed", async () => {
    const { services, directory, close } = await setup();
    const folder = await folderPackage(directory);
    await services.installAdded(folder);
    // The uninstall stops between leaving the index and deleting the files.
    const { changed } = services;
    let resume!: () => void;
    const paused = new Promise<void>((resolve) => { resume = resolve; });
    let reached!: () => void;
    const atPause = new Promise<void>((resolve) => { reached = resolve; });
    vi.spyOn(services, "changed").mockImplementationOnce(async () => {
      reached();
      await paused;
      return changed.call(services);
    });
    const uninstalling = services.uninstall("acme/maker");
    await atPause;
    const installing = services.installAdded(folder);
    await new Promise((resolve) => setTimeout(resolve, 50));
    resume();
    await uninstalling;
    const entry = await installing;
    expect((await stat(path.join(entry.root, ".ohmygame-plugin", "plugin.json"))).isFile()).toBe(true);
    expect(services.index.get("acme/maker")).toBeDefined();
    await close();
  });

  it("gives a published template its .gitignore back", async () => {
    const extra = { contributes: { skills: "./skills/", projectTypes: [{ id: "game", title: "Game", preview: "web", template: "./template/" }] }, capabilities: {} };
    const bytes = tgz(...pluginEntries("package/", "acme/maker", "1.0.0", extra), tarEntry("package/template/gitignore", "dist/\n"), tarEntry("package/template/kept/gitignore", "x\n"), tarEntry("package/template/kept/.gitignore", "y\n"));
    const { sources, services, close } = await setup();
    const preview = await sources.inspectFile(bytes, "en");
    const entry = await sources.installFile(bytes, preview.digest);
    expect(await readFile(path.join(entry.root, "template", ".gitignore"), "utf8")).toBe("dist/\n");
    expect(await readFile(path.join(entry.root, "template", "kept", ".gitignore"), "utf8")).toBe("y\n");
    expect(await readFile(path.join(entry.root, "template", "kept", "gitignore"), "utf8")).toBe("x\n");
    expect(services.index.get("acme/maker")?.digest).toBe(preview.digest);
    await close();
  });

  it("removes its temporary folder and leaves the store as it was when a package is invalid", async () => {
    const { sources, services, close } = await setup();
    await expect(sources.inspectFile(tgz(tarEntry("package/readme.txt", "no plugin")), "en")).rejects.toThrow("isn't a valid plugin");
    await expect(sources.inspectFile(Buffer.from("nope"), "en")).rejects.toThrow("can't be unpacked");
    expect(services.index.entries().filter((entry) => !entry.id.startsWith("ohmygame/"))).toEqual([]);
    await close();
  });
});
