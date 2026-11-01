import { createHash } from "node:crypto";
import { lstat, mkdir, mkdtemp, readFile, rm, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { gzipSync } from "node:zlib";
import { afterEach, describe, expect, it, vi } from "vitest";
import { extractTarball } from "../src/daemon/archive-extraction.js";
import { PluginServices } from "../src/daemon/plugin-services.js";
import { parseGitHubUrl, parseNpmName, PluginSourceError, PluginSources, type PluginSourceNetwork } from "../src/daemon/plugin-sources.js";

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
  it("reads scoped npm names", () => {
    expect(parseNpmName(" @acme/maker ")).toEqual({ scope: "acme", name: "maker" });
    expect(parseNpmName("@acme/ohmygame-plugin-maker@1.2.3")).toEqual({ scope: "acme", name: "ohmygame-plugin-maker", version: "1.2.3" });
    for (const bad of ["maker", "@acme", "@acme/", "@acme/maker@latest", "@acme/../x", "https://evil.example/x"])
      expect(() => parseNpmName(bad), bad).toThrow(PluginSourceError);
  });

  it("reads GitHub repositories, at a ref or not", () => {
    expect(parseGitHubUrl("https://github.com/acme/maker")).toEqual({ repository: "acme/maker" });
    expect(parseGitHubUrl("github.com/acme/maker.git/")).toEqual({ repository: "acme/maker" });
    expect(parseGitHubUrl("https://github.com/acme/maker/tree/v1.0")).toEqual({ repository: "acme/maker", ref: "v1.0" });
    expect(parseGitHubUrl(`https://github.com/acme/maker/commit/${"a".repeat(40)}`)).toEqual({ repository: "acme/maker", ref: "a".repeat(40) });
    for (const bad of ["acme/maker", "http://github.com/acme/maker", "https://evil.example/acme/maker", "https://github.com.evil.example/acme/maker", "https://github.com/acme/..", "https://github.com/acme/maker?x=1", "https://github.com/acme/maker/tree/a..b", "https://github.com/acme/maker/blob/main/x"])
      expect(() => parseGitHubUrl(bad), bad).toThrow(PluginSourceError);
  });
});

describe("PluginSources", () => {
  async function setup(routes: Record<string, () => Response> = {}, files: Record<string, Buffer> = {}) {
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
    const sources = new PluginSources(services, path.join(directory, "plugin-store", "origins.json"), network);
    return { services, sources, requested, directory, close: () => services.close() };
  }
  const integrity = (bytes: Buffer) => `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  function npmPackage(name: string, bytes: Buffer, { version = "1.0.0", host = "https://registry.npmjs.org", checksum = integrity(bytes) }: { version?: string; host?: string; checksum?: string } = {}) {
    const [scope, short] = name.slice(1).split("/") as [string, string];
    const tarball = `${host}/@${scope}/${short}/-/${short}-${version}.tgz`;
    return {
      routes: { [`https://registry.npmjs.org/@${scope}%2F${short}`]: () => Response.json({ "dist-tags": { latest: version }, versions: { [version]: { dist: { tarball, integrity: checksum } } } }) },
      files: { [tarball]: bytes },
    };
  }
  const npm = { type: "npm", name: "@acme/maker", registry: "npmjs" } as const;

  it("reviews, then adds an npm package, allowing nothing and recording where it came from", async () => {
    const bytes = tgz(...pluginEntries("package/", "acme/maker", "1.0.0", { capabilities: { network: ["api.example.com"] }, contributes: { skills: "./skills/", mcpServers: [{ id: "api", title: "API", url: "https://api.example.com/mcp", tools: ["search"] }] } }));
    const { routes, files } = npmPackage("@acme/maker", bytes);
    const { services, sources, close } = await setup(routes, files);
    const preview = await sources.inspect(npm, "en");
    expect(preview).toMatchObject({
      id: "acme/maker", version: "1.0.0", displayName: "Maker", appWide: false, asks: ["network:api.example.com"], skills: 1, mcpServers: ["API"], installedVersions: [],
      source: { type: "npm", name: "@acme/maker", registry: "npmjs", version: "1.0.0" },
      origin: { type: "npm", package: "@acme/maker", version: "1.0.0", registry: "npmjs" },
    });
    expect(services.index.get("acme/maker")).toBeUndefined();
    const installed = await sources.install(preview.source!, preview.digest);
    expect(installed.id).toBe("acme/maker");
    expect(services.index.get("acme/maker")?.root).toContain(path.join("plugin-store", "packages", "acme", "maker", "1.0.0"));
    expect(services.grants.plugin("acme/maker")?.allowed ?? []).toEqual([]);
    expect(await sources.origin("acme/maker", "1.0.0")).toEqual({ type: "npm", package: "@acme/maker", version: "1.0.0", registry: "npmjs" });
    await close();
  });

  it("accepts the ohmygame-plugin- name form, and only the plugin the scope vouches for", async () => {
    const good = npmPackage("@acme/ohmygame-plugin-maker", tgz(...pluginEntries("package/")));
    const other = npmPackage("@acme/other", tgz(...pluginEntries("package/")));
    const elsewhere = npmPackage("@evil/maker", tgz(...pluginEntries("package/")));
    const { sources, close } = await setup({ ...good.routes, ...other.routes, ...elsewhere.routes }, { ...good.files, ...other.files, ...elsewhere.files });
    expect((await sources.inspect({ type: "npm", name: "@acme/ohmygame-plugin-maker", registry: "npmjs" }, "en")).id).toBe("acme/maker");
    await expect(sources.inspect({ type: "npm", name: "@acme/other", registry: "npmjs" }, "en")).rejects.toThrow("holds the plugin acme/maker");
    await expect(sources.inspect({ type: "npm", name: "@evil/maker", registry: "npmjs" }, "en")).rejects.toThrow("holds the plugin acme/maker");
    await close();
  });

  it("refuses a package whose bytes, host, checksum or version don't line up", async () => {
    const bytes = tgz(...pluginEntries("package/"));
    const tampered = npmPackage("@acme/maker", bytes, { checksum: integrity(Buffer.from("other")) });
    const bad = await setup(tampered.routes, tampered.files);
    await expect(bad.sources.inspect(npm, "en")).rejects.toThrow("doesn't match its checksum");
    await bad.close();
    const offHost = npmPackage("@acme/maker", bytes, { host: "https://evil.example" });
    const hosted = await setup(offHost.routes, offHost.files);
    await expect(hosted.sources.inspect(npm, "en")).rejects.toThrow("doesn't download from npmjs");
    expect(hosted.requested.some((url) => url.includes("evil.example"))).toBe(false);
    await hosted.close();
    const unchecked = npmPackage("@acme/maker", bytes, { checksum: "" });
    const noSum = await setup(unchecked.routes, unchecked.files);
    await expect(noSum.sources.inspect(npm, "en")).rejects.toThrow("no SHA-512");
    await noSum.close();
    const versioned = npmPackage("@acme/maker", tgz(...pluginEntries("package/", "acme/maker", "2.0.0")));
    const mismatch = await setup(versioned.routes, versioned.files);
    await expect(mismatch.sources.inspect(npm, "en")).rejects.toThrow("holds version 2.0.0");
    await mismatch.close();
    const missing = await setup();
    await expect(missing.sources.inspect(npm, "en")).rejects.toThrow("isn't on npmjs");
    await missing.close();
  });

  it("keeps the app's and the builder's publishers for themselves", async () => {
    for (const id of ["ohmygame/maker", "personal/maker"]) {
      const publisher = id.split("/")[0]!;
      const pack = npmPackage(`@${publisher}/maker`, tgz(...pluginEntries("package/", id)));
      const { sources, services, directory, close } = await setup(pack.routes, pack.files);
      await expect(sources.inspect({ type: "npm", name: `@${publisher}/maker`, registry: "npmjs" }, "en")).rejects.toThrow("can't use the publisher");
      await expect(sources.inspectFile(tgz(...pluginEntries("package/", id)), "en")).rejects.toThrow("can't use the publisher");
      const folder = path.join(directory, "folder");
      await mkdir(path.join(folder, ".ohmygame-plugin"), { recursive: true });
      await writeFile(path.join(folder, ".ohmygame-plugin", "plugin.json"), manifest(id, "1.0.0", { contributes: {} }));
      await expect(sources.inspect({ type: "directory", path: folder }, "en")).rejects.toThrow("can't use the publisher");
      await expect(services.installAdded(folder)).rejects.toThrow("can't use the publisher");
      await close();
    }
  });

  it("pins a GitHub repository to a commit and doesn't take a different package at that source", async () => {
    const commit = "c".repeat(40);
    const api = "https://api.github.com/repos/acme/maker/commits/HEAD";
    const download = `https://codeload.github.com/acme/maker/tar.gz/${commit}`;
    const files = { [download]: tgz(tarEntry("pax_global_header", `52 comment=${commit}\n`, { type: "g" }), ...pluginEntries("maker-ccc/"), tarEntry("maker-ccc/README.md", "hello")) };
    const { sources, services, requested, close } = await setup({ [api]: () => new Response(`${commit}\n`) }, files);
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

  it("says when GitHub can't find a repository or is limiting requests", async () => {
    const limited = await setup({ "https://api.github.com/repos/acme/maker/commits/HEAD": () => new Response("", { status: 403 }) });
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

  it("keeps an installed plugin's approvals and settings from a package of another source", async () => {
    const commit = "c".repeat(40);
    const github = {
      "https://api.github.com/repos/evil/maker/commits/HEAD": () => new Response(commit),
    };
    const pack = npmPackage("@acme/maker", tgz(...pluginEntries("package/")));
    const { sources, services, directory, close } = await setup({ ...pack.routes, ...github }, {
      ...pack.files,
      [`https://codeload.github.com/evil/maker/tar.gz/${commit}`]: tgz(...pluginEntries("maker/", "acme/maker", "1.1.0")),
    });
    const preview = await sources.inspect(npm, "en");
    await sources.install(preview.source!, preview.digest);

    const message = "already installed from npm (@acme/maker)";
    await expect(sources.inspect({ type: "github", url: "https://github.com/evil/maker" }, "en")).rejects.toThrow(message);
    await expect(sources.inspectFile(tgz(...pluginEntries("package/", "acme/maker", "2.0.0")), "en")).rejects.toThrow(message);
    await expect(sources.inspect({ type: "directory", path: await folderPackage(directory, "2.0.0") }, "en")).rejects.toThrow(message);

    // Uninstalling clears what it held, so the plugin can then come from anywhere.
    await services.uninstall("acme/maker");
    const elsewhere = await sources.inspect({ type: "github", url: "https://github.com/evil/maker" }, "en");
    expect(elsewhere.installedVersions).toEqual([]);
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
    const pack = npmPackage("@acme/maker", tgz(...pluginEntries("package/")));
    const { sources, services, directory, close } = await setup(pack.routes, pack.files);
    const preview = await sources.inspect(npm, "en");
    const origins = path.join(directory, "plugin-store", "origins.json");
    await mkdir(path.join(origins, "in-the-way"), { recursive: true });
    await expect(sources.install(preview.source!, preview.digest)).rejects.toThrow();
    expect(services.index.get("acme/maker")).toBeUndefined();
    await rm(origins, { recursive: true });
    await sources.install(preview.source!, preview.digest);
    expect(await sources.origin("acme/maker", "1.0.0")).toMatchObject({ type: "npm" });
    await close();
  });

  it("doesn't count an origin left from before an uninstall", async () => {
    const pack = npmPackage("@acme/maker", tgz(...pluginEntries("package/")));
    const { sources, services, close } = await setup(pack.routes, pack.files);
    const preview = await sources.inspect(npm, "en");
    await sources.install(preview.source!, preview.digest);
    await services.uninstall("acme/maker");
    const local = tgz(...pluginEntries("package/"), tarEntry("package/extra.txt", "local"));
    await sources.installFile(local, (await sources.inspectFile(local, "en")).digest);
    expect(await sources.origin("acme/maker", "1.0.0")).toBeUndefined();
    await expect(sources.inspect(npm, "en")).rejects.toThrow("another package on this computer");
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
