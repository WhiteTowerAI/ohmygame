import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { marketScore, PluginMarket, PluginMarketError } from "../src/daemon/plugin-market.js";
import { normalizePluginFileMirror, PluginFileMirror, pluginFileUrl } from "../src/daemon/plugin-file-mirror.js";
import type { MarketPlugin } from "../src/shared/plugins.js";

const URL_INDEX = "https://plugins.example.com/plugins/index.json";
const cleanup: string[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function temporary(): Promise<string> {
  const directory = await mkdtemp(path.join(tmpdir(), "ohmygame-plugin-market-"));
  cleanup.push(directory);
  return directory;
}

const { publicKey, privateKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
const KEY = publicKey.export({ format: "der", type: "spki" }).toString("base64");
const INTEGRITY = "sha512-AAAA";
const signed = (name: string, version: string, integrity = INTEGRITY) => [{
  keyid: "test",
  sig: sign("sha256", Buffer.from(`${name}@${version}:${integrity}`), privateKey).toString("base64"),
}];

const version = (name: string, ver: string, id: string, fields: object = {}) => ({
  package: name,
  version: ver,
  tarball: `https://registry.npmjs.org/${name}/-/x-${ver}.tgz`,
  integrity: INTEGRITY,
  signatures: signed(name, ver),
  publishedAt: `2026-01-0${ver.split(".")[1] ?? "1"}T00:00:00.000Z`,
  plugin: { id, displayName: { en: `${id} name`, "zh-CN": `${id} 名字` }, description: { en: "A plugin" }, grants: ["network:api.example.com"], adds: { skills: 2, mcpServers: 1 } },
  ...fields,
});
const index = (fields: object = {}) => ({ schemaVersion: 1, versions: [], packages: {}, featured: [], ...fields });

/** Serves an index as the job writes it, and any other files beside it, counting what's read. */
function server(body: unknown) {
  const reads: string[] = [];
  const state = { body, up: true, files: {} as Record<string, Buffer>, redirects: [] as Array<RequestRedirect | undefined> };
  const fetcher = (async (input: string | URL, init?: RequestInit) => {
    const url = String(input);
    reads.push(url);
    if (!state.up) throw new Error("offline");
    const text = typeof state.body === "string" ? state.body : JSON.stringify(state.body);
    const digest = createHash("sha256").update(text).digest("hex");
    if (url === URL_INDEX) return Response.json({ schemaVersion: 1, latest: `index.${digest}.json`, sha256: digest });
    if (url.endsWith(`/index.${digest}.json`)) return new Response(text);
    const file = state.files[url];
    if (file) state.redirects.push(init?.redirect);
    return file ? new Response(new Uint8Array(file)) : new Response("", { status: 404 });
  }) as typeof fetch;
  return { fetcher, reads, state };
}

async function market(body: unknown, options: { now?: () => number; directory?: string; fetcher?: typeof fetch; mirror?: () => string } = {}) {
  const { fetcher, reads, state } = server(body);
  return {
    market: new PluginMarket({
      url: URL_INDEX, directory: options.directory ?? await temporary(), fetch: options.fetcher ?? fetcher, keys: { test: { key: KEY } },
      ...(options.now ? { now: options.now } : {}), ...(options.mirror ? { mirror: options.mirror } : {}),
    }),
    reads,
    state,
  };
}

describe("PluginMarket listing", () => {
  it("does nothing without an index, or with one not over HTTPS", async () => {
    const reads: string[] = [];
    const fetcher = (async (input: string) => { reads.push(input); return new Response(""); }) as unknown as typeof fetch;
    for (const url of [undefined, "http://plugins.example.com/index.json", "not a url"]) {
      const off = new PluginMarket({ url, directory: await temporary(), fetch: fetcher });
      expect(await off.listing("en")).toEqual({ status: "off", plugins: [], blocked: [] });
      expect(await off.release("@a/b", "1.0.0")).toBeUndefined();
    }
    expect(reads).toEqual([]);
  });

  it("lists each plugin's newest installable version with its facts, featured first, then by score", async () => {
    const { market: subject } = await market(index({
      versions: [
        version("@a/low", "1.0.0", "a/low"),
        version("@a/top", "1.1.0", "a/top"),
        version("@a/top", "1.2.0", "a/top", { unpackedSize: 2048 }),
        { ...version("@a/top", "1.3.0", "a/top", { rejected: ["no"] }), plugin: undefined },
        version("@a/picked", "1.0.0", "a/picked"),
        version("@ohmygame/studio", "1.0.0", "ohmygame/studio"),
        version("@personal/mine", "1.0.0", "personal/mine"),
      ].map((item) => JSON.parse(JSON.stringify(item))),
      packages: {
        "@a/top": { repository: "https://github.com/a/top", sourceVerified: true, stars: 9, weeklyDownloads: 500, avatar: "https://avatars.githubusercontent.com/u/42?v=4", createdAt: "2025-06-01T00:00:00.000Z" },
        // An avatar is shown only for a verified source: anyone can name any repository.
        "@a/low": { weeklyDownloads: 5, repository: "https://github.com/famous/thing", avatar: "https://avatars.githubusercontent.com/u/7?v=4" },
      },
      featured: ["a/picked", "a/gone"],
    }));
    const { status, plugins } = await subject.listing("zh-CN");
    expect(status).toBe("ready");
    expect(plugins.map((plugin) => [plugin.id, plugin.version, plugin.featured])).toEqual([
      // OhMyGame's own npm scope is listed; the Plugin Builder's publisher isn't.
      ["a/picked", "1.0.0", true], ["a/top", "1.2.0", false], ["a/low", "1.0.0", false], ["ohmygame/studio", "1.0.0", false],
    ]);
    expect(plugins[1]).toMatchObject({
      package: "@a/top", displayName: "a/top 名字", description: "A plugin", asks: ["network:api.example.com"],
      adds: { skills: 2, mcpServers: 1 }, repository: "https://github.com/a/top", sourceVerified: true, stars: 9, weeklyDownloads: 500,
      avatar: "42", createdAt: "2025-06-01T00:00:00.000Z", size: 2048,
    });
    expect(plugins[0]!.sourceVerified).toBe(false);
    expect(plugins[2]).not.toHaveProperty("avatar");
  });

  it("scores plugins by downloads most, but also by stars, how recently they were updated and their page", () => {
    const now = Date.parse("2026-11-11T00:00:00.000Z");
    const plugin = (fields: Partial<MarketPlugin>): MarketPlugin => ({
      id: "a/b", package: "@a/b", version: "1.0.0", displayName: "B", description: "", asks: [], adds: {}, featured: false, sourceVerified: false, ...fields,
    });
    const most = { downloads: 1000, stars: 100 };
    const score = (fields: Partial<MarketPlugin>) => marketScore(plugin(fields), most, now);
    expect(score({})).toBe(0);
    expect(score({ weeklyDownloads: 1000, stars: 100, publishedAt: "2026-11-01T00:00:00.000Z", sourceVerified: true, longDescription: "L", screenshots: [{ path: "a.png" }], categories: ["art"] })).toBeCloseTo(1);
    // Downloads weigh most, on a log scale: ten times as many isn't ten times the score.
    expect(score({ weeklyDownloads: 1000 })).toBeCloseTo(0.5);
    expect(score({ weeklyDownloads: 100 })).toBeGreaterThan(0.3);
    // Freshness fades from a month to a year.
    expect(score({ publishedAt: "2026-10-20T00:00:00.000Z" })).toBeCloseTo(0.15);
    expect(score({ publishedAt: "2025-10-01T00:00:00.000Z" })).toBe(0);
    expect(score({ publishedAt: "not a date" })).toBe(0);
    // A well-kept page lifts a quiet plugin over one only downloaded a little more.
    expect(score({ weeklyDownloads: 20, sourceVerified: true, longDescription: "L", categories: ["art"] })).toBeGreaterThan(score({ weeklyDownloads: 40 }));
    expect(score({ weeklyDownloads: 1000, beta: true })).toBeCloseTo(0.425);
  });

  it("shows the greatest version, whatever order they were published in", async () => {
    const list = async (...versions: string[]) => (await (await market(index({
      versions: versions.map((ver, order) => version("@a/b", ver, "a/b", { publishedAt: `2026-01-0${order + 1}T00:00:00.000Z` })),
    }))).market.listing("en")).plugins.map((plugin) => plugin.version);
    // A maintenance release after 2.0.0 doesn't hide it.
    expect(await list("2.0.0", "1.9.1")).toEqual(["2.0.0"]);
    expect(await list("1.9.1", "2.0.0")).toEqual(["2.0.0"]);
    // A prerelease shows only when there's no release.
    expect(await list("1.9.1", "3.0.0-beta.1")).toEqual(["1.9.1"]);
    expect(await list("3.0.0-beta.1", "3.0.0-beta.2")).toEqual(["3.0.0-beta.2"]);
    // A hyphen in build metadata doesn't make a prerelease.
    expect(await list("1.0.0", "2.0.0+build-1")).toEqual(["2.0.0+build-1"]);
  });

  it("leaves out a name or version installing wouldn't look up as written", async () => {
    // Add plugin trims a name and reads a version out of it. A card for one of these
    // would miss the index when installing, and so the signature check.
    const { market: subject } = await market(index({ versions: [
      version(" @a/spaced ", "1.0.0", "a/spaced", { signatures: [] }),
      version("@a/named@9.0.0", "1.0.0", "a/named", { signatures: [] }),
      version("@A/upper", "1.0.0", "a/upper", { signatures: [] }),
      version("unscoped", "1.0.0", "a/unscoped", { signatures: [] }),
      version("@a/tagged", "latest", "a/tagged", { signatures: [] }),
      version("@a/good", "1.0.0", "a/good"),
    ] }));
    expect((await subject.listing("en")).plugins.map((plugin) => plugin.package)).toEqual(["@a/good"]);
  });

  it("lists blocked versions with their reasons", async () => {
    const { market: subject } = await market(index({
      versions: [
        { package: "@a/bad", version: "1.0.0", tarball: "", integrity: INTEGRITY, signatures: [], rejected: ["blocked: steals keys"] },
        { package: "@a/odd", version: "1.0.0", tarball: "", integrity: INTEGRITY, signatures: [], rejected: ["has a postinstall script"] },
      ],
    }));
    expect((await subject.listing("en")).blocked).toEqual([{ package: "@a/bad", version: "1.0.0", reason: "steals keys" }]);
  });

  it("refuses an index that doesn't match its name, isn't well formed, or has an odd pointer", async () => {
    const wrongFile = (async (input: string) => input === URL_INDEX
      ? Response.json({ latest: `index.${"a".repeat(64)}.json` })
      : new Response(JSON.stringify(index()))) as unknown as typeof fetch;
    const oddPointer = (async () => Response.json({ latest: "../../evil.json" })) as unknown as typeof fetch;
    for (const options of [{ fetcher: wrongFile }, { fetcher: oddPointer }])
      expect((await (await market(index(), options)).market.listing("en")).status).toBe("unavailable");
    for (const body of ["{", index({ schemaVersion: 2 }), index({ versions: [{ package: "@a/b" }] }), index({ packages: { "@a/b": { repository: "https://evil.example.com/a/b" } } })])
      expect((await (await market(body)).market.listing("en")).status).toBe("unavailable");
  });

  it("doesn't let a slow read of the saved index undo a refresh", async () => {
    let now = 1_000_000;
    const directory = await temporary();
    await (await market(index(), { directory, now: () => now })).market.listing("en");
    const newer = await market(index({ versions: [version("@a/b", "1.0.0", "a/b")] }), { directory, now: () => now });
    const answers = await Promise.all([newer.market.listing("en"), newer.market.listing("en"), newer.market.listing("en")]);
    expect(answers.every(({ status }) => status === "ready")).toBe(true);
    await vi.waitFor(async () => expect((await newer.market.listing("en")).plugins).toHaveLength(1));
    expect(newer.reads.filter((url) => url === URL_INDEX)).toHaveLength(1);
  });

  it("keeps the last index when the network is down, across restarts, and says it may be old", async () => {
    let now = 1_000_000;
    const directory = await temporary();
    const first = await market(index({ versions: [version("@a/b", "1.0.0", "a/b")] }), { directory, now: () => now });
    expect((await first.market.listing("en")).plugins).toHaveLength(1);

    // A restart without network shows what was saved. The refresh runs behind the answer.
    const offline = server(index());
    offline.state.up = false;
    const restarted = await market(index(), { directory, fetcher: offline.fetcher, now: () => now });
    expect((await restarted.market.listing("en")).plugins).toHaveLength(1);
    await vi.waitFor(async () => expect(await restarted.market.listing("en")).toMatchObject({ status: "stale", plugins: [{ id: "a/b" }] }));
  });

  it("lists what an index says about a plugin's place and pictures, leaving out what this app doesn't know", async () => {
    const { market: subject } = await market(index({ versions: [version("@a/b", "1.0.0", "a/b", { plugin: {
      ...version("@a/b", "1.0.0", "a/b").plugin,
      categories: ["art", "hologram", "3d"], appliesTo: ["web-game"], beta: true,
      longDescription: { en: "Long", "zh-CN": "长" },
      // An index field from a later schema is passed over.
      rating: 5,
      icon: "./assets/icon.svg",
      screenshots: [
        { path: "./assets/one.png", caption: { en: "One", "zh-CN": "一" } },
        { path: "../elsewhere.png" }, { path: "https://evil.example/x.png" }, { path: "assets/two.webp" },
      ],
    } })] }));
    const [plugin] = (await subject.listing("zh-CN")).plugins;
    expect(plugin).toMatchObject({
      categories: ["art", "3d"], appliesTo: ["web-game"], beta: true, longDescription: "长",
      icon: "./assets/icon.svg",
      screenshots: [{ path: "./assets/one.png", caption: "一" }, { path: "assets/two.webp" }],
    });
    expect(plugin).not.toHaveProperty("rating");
  });

  it("reads only the icon and screenshots its index lists for a version, from the package file mirror, checking each", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M0 0h32v32H0z"/></svg>');
    const plugin = (icon: string, screenshots: string[]) => ({ plugin: { ...version("@a/b", "1.0.0", "a/b").plugin, icon, screenshots: screenshots.map((path) => ({ path })) } });
    const { market: subject, reads, state } = await market(index({ versions: [
      version("@a/b", "1.0.0", "a/b", plugin("./icon.svg", ["./shots/one.png", "./shots/page.png", "./shots/script.svg"])),
      version("@a/c", "1.0.0", "a/c", plugin("./bad.svg", [])),
      version("@a/d", "1.0.0", "a/d", plugin("./icon.png", [])),
    ] }));
    const cdn = "https://cdn.jsdelivr.net/npm/";
    state.files[`${cdn}@a/b@1.0.0/icon.svg`] = svg;
    state.files[`${cdn}@a/b@1.0.0/shots/one.png`] = png;
    state.files[`${cdn}@a/b@1.0.0/shots/page.png`] = Buffer.from("<html></html>");
    state.files[`${cdn}@a/b@1.0.0/shots/script.svg`] = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0Z"/></svg>');
    state.files[`${cdn}@a/b@1.0.0/other.png`] = png;
    state.files[`${cdn}@a/c@1.0.0/bad.svg`] = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(await subject.file("@a/b", "1.0.0", "./icon.svg")).toMatchObject({ mediaType: "image/svg+xml", bytes: svg });
    expect(await subject.file("@a/b", "1.0.0", "./shots/one.png")).toMatchObject({ mediaType: "image/png", bytes: png });
    // Kept once read: a version's files don't change.
    await subject.file("@a/b", "1.0.0", "./shots/one.png");
    expect(reads.filter((url) => url.endsWith("one.png"))).toHaveLength(1);
    // A screenshot is a PNG, JPEG or WebP; an icon is checked as an installed one's is.
    await expect(subject.file("@a/b", "1.0.0", "./shots/page.png")).rejects.toThrow();
    await expect(subject.file("@a/b", "1.0.0", "./shots/script.svg")).rejects.toThrow();
    await expect(subject.file("@a/c", "1.0.0", "./bad.svg")).rejects.toThrow();
    // An icon is the type its name says.
    state.files[`${cdn}@a/d@1.0.0/icon.png`] = svg;
    await expect(subject.file("@a/d", "1.0.0", "./icon.png")).rejects.toThrow();
    // Nothing the index doesn't list for that version.
    expect(await subject.file("@a/b", "1.0.0", "./other.png")).toBeUndefined();
    expect(await subject.file("@a/b", "0.9.0", "./icon.svg")).toBeUndefined();
    expect(await subject.file("@a/c", "1.0.0", "./icon.svg")).toBeUndefined();
    expect(reads.some((url) => url.endsWith("other.png") || url.includes("0.9.0"))).toBe(false);
    // A redirect could lead anywhere, so it isn't followed.
    expect(new Set(state.redirects)).toEqual(new Set(["error"]));
  });

  it("reads files from the mirror the person chose", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    let mirror = "https://unpkg.com/";
    const { market: subject, state } = await market(index({ versions: [version("@a/b", "1.0.0", "a/b", {
      plugin: { ...version("@a/b", "1.0.0", "a/b").plugin, screenshots: [{ path: "./one.png" }] },
    })] }), { mirror: () => mirror });
    state.files["https://unpkg.com/@a/b@1.0.0/one.png"] = png;
    expect(await subject.file("@a/b", "1.0.0", "./one.png")).toMatchObject({ bytes: png });
    mirror = "https://mirror.example/npm/";
    state.files["https://mirror.example/npm/@a/b@1.0.0/one.png"] = png;
    expect(await subject.file("@a/b", "1.0.0", "./one.png")).toMatchObject({ bytes: png });
  });

  it("reads a verified publisher's GitHub avatar, from GitHub's avatar host only", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const { market: subject, reads, state } = await market(index({
      versions: [version("@a/b", "1.0.0", "a/b"), version("@a/c", "1.0.0", "a/c")],
      packages: {
        "@a/b": { sourceVerified: true, avatar: "https://avatars.githubusercontent.com/u/42?v=4" },
        "@a/c": { avatar: "https://avatars.githubusercontent.com/u/7?v=4" },
      },
    }));
    state.files["https://avatars.githubusercontent.com/u/42?s=96"] = png;
    state.files["https://avatars.githubusercontent.com/u/7?s=96"] = png;
    expect(await subject.avatar("42")).toMatchObject({ mediaType: "image/png", bytes: png });
    await subject.avatar("42");
    expect(reads.filter((url) => url.includes("/u/42"))).toHaveLength(1);
    // Not for an unverified source, nor for anyone the index doesn't name.
    expect(await subject.avatar("7")).toBeUndefined();
    expect(await subject.avatar("1")).toBeUndefined();
    expect(reads.some((url) => url.includes("/u/7") || url.includes("/u/1?"))).toBe(false);
    expect(new Set(state.redirects)).toEqual(new Set(["error"]));
  });

  it("passes over an avatar that isn't on GitHub's avatar host", async () => {
    const { market: subject } = await market(index({
      versions: [version("@a/b", "1.0.0", "a/b")],
      packages: { "@a/b": { sourceVerified: true, avatar: "https://evil.example/u/42" } },
    }));
    const listing = await subject.listing("en");
    expect(listing.status).toBe("ready");
    expect(listing.plugins[0]).not.toHaveProperty("avatar");
    expect(await subject.avatar("42")).toBeUndefined();
  });

  it("keeps a package's files below the package on the mirror", () => {
    const cdn = "https://cdn.jsdelivr.net/npm/";
    expect(pluginFileUrl(cdn, "@a/b", "1.0.0-beta.1", "./assets/a b.png")).toBe(`${cdn}@a/b@1.0.0-beta.1/assets/a%20b.png`);
    expect(pluginFileUrl(cdn, "@a/b", "1.0.0", "a.png")).toBe(`${cdn}@a/b@1.0.0/a.png`);
    for (const file of ["../a.png", "./assets/../../a.png", "/a.png", "//evil.example/a.png", "https://evil.example/a.png", "a\\b.png", "", "./", "a.png?x", "a%2e%2e/b.png"]) {
      expect(pluginFileUrl(cdn, "@a/b", "1.0.0", file)).toBeUndefined();
    }
  });

  it("keeps the chosen mirror, and leaves a file it can't read as it is", async () => {
    const directory = await temporary();
    const mirror = new PluginFileMirror(directory);
    await mirror.load();
    expect(mirror.get()).toBe("https://cdn.jsdelivr.net/npm/");
    await mirror.set("https://unpkg.com");
    const again = new PluginFileMirror(directory);
    await again.load();
    expect(again.get()).toBe("https://unpkg.com/");
    const file = path.join(directory, "plugin-file-mirror.json");
    await writeFile(file, JSON.stringify({ version: 2, bases: ["https://a.example/"] }));
    const newer = new PluginFileMirror(directory);
    await newer.load();
    expect(newer.get()).toBe("https://cdn.jsdelivr.net/npm/");
    await expect(newer.set("https://unpkg.com/")).rejects.toThrow();
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ version: 2, bases: ["https://a.example/"] });
  });

  it("takes a mirror over HTTPS, or plain HTTP on this computer, as a base address", () => {
    expect(normalizePluginFileMirror(" https://cdn.example/npm ")).toBe("https://cdn.example/npm/");
    expect(normalizePluginFileMirror("http://127.0.0.1:4000/npm/")).toBe("http://127.0.0.1:4000/npm/");
    for (const value of ["http://cdn.example/npm/", "ftp://cdn.example/", "cdn.example/npm/", "https://cdn.example/npm/?a=1", "https://cdn.example/npm?", "https://cdn.example/npm#", "https://user:pass@cdn.example/", "https://cdn.example/#x"])
      expect(() => normalizePluginFileMirror(value)).toThrow();
  });

  it("stops reading an answer larger than allowed", async () => {
    const cancelled = vi.fn();
    const endless = new ReadableStream<Uint8Array>({ pull: (controller) => controller.enqueue(new Uint8Array(1024)), cancel: cancelled });
    const fetcher = (async () => new Response(endless)) as unknown as typeof fetch;
    expect((await (await market(index(), { fetcher })).market.listing("en")).status).toBe("unavailable");
    expect(cancelled).toHaveBeenCalled();
  });

  it("tries again soon after a failure, so starting offline doesn't cost half an hour", async () => {
    let now = 1_000_000;
    const { market: subject, reads, state } = await market(index({ versions: [version("@a/b", "1.0.0", "a/b")] }), { now: () => now });
    state.up = false;
    expect((await subject.listing("en")).status).toBe("unavailable");
    await subject.listing("en");
    expect(reads).toHaveLength(1);
    state.up = true;
    now += 2 * 60_000;
    expect((await subject.listing("en")).status).toBe("ready");
  });

  it("reads the pointer at most every half hour, and the file only when it changed", async () => {
    let now = 1_000_000;
    const { market: subject, reads, state } = await market(index(), { now: () => now });
    const files = () => reads.filter((url) => url !== URL_INDEX);
    await subject.listing("en");
    await subject.listing("en");
    expect(reads).toHaveLength(2);
    now += 31 * 60_000;
    await subject.listing("en");
    await vi.waitFor(() => expect(reads).toHaveLength(3));
    state.body = index({ versions: [version("@a/b", "1.0.0", "a/b")] });
    // A refresh runs behind the answer, so each try moves on to when another is due.
    await vi.waitFor(async () => {
      now += 31 * 60_000;
      expect((await subject.listing("en")).plugins).toHaveLength(1);
    });
    expect(files()).toHaveLength(2);
  });
});

describe("PluginMarket release", () => {
  const entry = (name: string, ver: string, fields: object = {}) => version(name, ver, "a/b", fields);

  it("pins a version once npm's signature over its checksum holds", async () => {
    const { market: subject } = await market(index({ versions: [entry("@a/b", "1.0.0")] }));
    expect(await subject.release("@a/b", "1.0.0")).toEqual({ package: "@a/b", version: "1.0.0", integrity: INTEGRITY });
    expect(await subject.release("@a/b", "9.0.0")).toBeUndefined();
    expect(await subject.release("@a/c", "1.0.0")).toBeUndefined();
  });

  it("refuses what the index rejected, saying why", async () => {
    const { market: subject } = await market(index({
      versions: [
        entry("@a/bad", "1.0.0", { plugin: undefined, rejected: ["blocked: steals keys"] }),
        entry("@a/odd", "1.0.0", { plugin: undefined, rejected: ["has a postinstall script"] }),
      ].map((item) => JSON.parse(JSON.stringify(item))),
    }));
    await expect(subject.release("@a/bad", "1.0.0")).rejects.toThrow("was blocked: steals keys");
    await expect(subject.release("@a/odd", "1.0.0")).rejects.toThrow("can't be added: has a postinstall script");
    await expect(subject.release("@a/odd", "1.0.0")).rejects.toBeInstanceOf(PluginMarketError);
  });

  it("refuses a checksum, package or version the signature doesn't cover", async () => {
    const { market: subject } = await market(index({ versions: [
      entry("@a/swapped", "1.0.0", { integrity: "sha512-BBBB" }),
      entry("@a/other", "1.0.0", { signatures: signed("@a/elsewhere", "1.0.0") }),
      entry("@a/newer", "2.0.0", { signatures: signed("@a/newer", "1.0.0") }),
      entry("@a/none", "1.0.0", { signatures: [] }),
      entry("@a/garbled", "1.0.0", { signatures: [{ keyid: "test", sig: "bm90IGEgc2lnbmF0dXJl" }] }),
    ] }));
    for (const [name, ver] of [["@a/swapped", "1.0.0"], ["@a/other", "1.0.0"], ["@a/newer", "2.0.0"], ["@a/none", "1.0.0"], ["@a/garbled", "1.0.0"]])
      await expect(subject.release(name!, ver!)).rejects.toThrow("no valid npm signature");
  });

  it("takes no signature from an expired key, whatever the index says about when it was published", async () => {
    const { fetcher } = server(index({ versions: [entry("@a/b", "1.0.0", { publishedAt: "2020-01-01T00:00:00.000Z" })] }));
    const subject = async (now: number) => {
      const directory = await temporary();
      return new PluginMarket({ url: URL_INDEX, directory, fetch: fetcher, now: () => now, keys: { test: { key: KEY, expires: "2025-01-29T00:00:00.000Z" } } });
    };
    await expect((await subject(Date.parse("2025-01-28T00:00:00.000Z"))).release("@a/b", "1.0.0")).resolves.toBeDefined();
    await expect((await subject(Date.parse("2025-01-29T00:00:00.000Z"))).release("@a/b", "1.0.0")).rejects.toThrow("no valid npm signature");
  });

  it("asks npm for a key it doesn't know, and refuses when npm doesn't know it either", async () => {
    const body = index({ versions: [entry("@a/b", "1.0.0"), entry("@a/c", "1.0.0", { signatures: [{ keyid: "other", sig: "AAAA" }] })] });
    const { fetcher, reads } = server(body);
    const withKeys = (async (input: string) => input.endsWith("/-/npm/v1/keys")
      ? Response.json({ keys: [{ keyid: "test", key: KEY, expires: null }] })
      : fetcher(input)) as unknown as typeof fetch;
    const subject = new PluginMarket({ url: URL_INDEX, directory: await temporary(), fetch: withKeys, keys: {} });
    await expect(subject.release("@a/b", "1.0.0")).resolves.toBeDefined();
    await expect(subject.release("@a/c", "1.0.0")).rejects.toThrow("no valid npm signature");
    expect(reads.every((url) => !url.includes("keys"))).toBe(true);
  });

  it("checks a real npm signature with the keys it ships with", async () => {
    const real = {
      package: "@sigstore/core", version: "4.0.1", tarball: "", publishedAt: "2026-06-25T22:33:24.869Z",
      integrity: "sha512-9v5hRjujn5NXq8o7XFEUgLyAtdr5Iisb4pzM05u3K61IS5q3hP3luWAndk0RkPPLTUFoTbg7Vb84UQ1ZQeajWQ==",
      signatures: [{ keyid: "SHA256:DhQ8wR5APBvFHLF/+Tc+AYvPOdTpcIDqOhxsBHRwC7U", sig: "MEYCIQCD+g9SHEyZwSovTHY2fX+lUQ9UlJpjCpgtqWO/4HlshwIhAMWhgS+3m+vDni6pf//SEKOYpbq31bK2119OZgqFcR8X" }],
    };
    const { fetcher } = server(index({ versions: [real, { ...real, version: "4.0.2" }] }));
    const subject = new PluginMarket({ url: URL_INDEX, directory: await temporary(), fetch: fetcher });
    await expect(subject.release("@sigstore/core", "4.0.1")).resolves.toMatchObject({ integrity: real.integrity });
    await expect(subject.release("@sigstore/core", "4.0.2")).rejects.toThrow("no valid npm signature");
  });
});
