import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { indexImage, marketScore, PluginMarket, PluginMarketError } from "../src/daemon/plugin-market.js";
import { PluginMarketSettingsError, PluginMarketSettingsStore } from "../src/daemon/plugin-market-settings.js";
import { releaseMessage } from "../src/daemon/plugin-releases.js";
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

const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const KEYS = { test: { publicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"), publishers: "*" as const } };
const SHA256 = "a".repeat(64);
const MIRROR = "https://plugins.example.com/plugins";
/** The market's signed record of a release, as the index job writes it. */
const signed = (id: string, version: string, fields: object = {}) => {
  const record = { id, version, url: `${MIRROR}/packages/${id}/${version}-${SHA256}.zip`, size: 2048, sha256: SHA256, key: "test", ...fields };
  return { ...record, signature: sign(null, releaseMessage(record), privateKey).toString("base64") };
};

/** A release of `repository` (`owner/repo`) the index accepted, holding plugin `id`. */
const version = (repository: string, ver: string, id: string, fields: object = {}) => ({
  repository,
  tag: `v${ver}`,
  commit: createHash("sha1").update(`${repository}@${ver}`).digest("hex"),
  version: ver,
  publishedAt: `2026-01-0${ver.split(".")[1] ?? "1"}T00:00:00.000Z`,
  plugin: { id, displayName: { en: `${id} name`, "zh-CN": `${id} 名字` }, description: { en: "A plugin" }, grants: ["network:api.example.com"], adds: { skills: 2, mcpServers: 1 } },
  release: signed(id, ver),
  github: `https://github.com/${repository}/releases/download/v${ver}/plugin.zip`,
  ...fields,
});
/** A release the index turned away: it no longer says which plugin it holds, nor has a release. */
const rejected = (repository: string, ver: string, reasons: string[]) => ({ repository, tag: `v${ver}`, commit: "", version: ver, rejected: reasons });
const index = (fields: object = {}) => ({ schemaVersion: 2, versions: [], repositories: {}, featured: [], ...fields });

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
    if (url === URL_INDEX) return Response.json({ schemaVersion: 2, latest: `index.${digest}.json`, sha256: digest });
    if (url.endsWith(`/index.${digest}.json`)) return new Response(text);
    const file = state.files[url];
    if (file) state.redirects.push(init?.redirect);
    return file ? new Response(new Uint8Array(file)) : new Response("", { status: 404 });
  }) as typeof fetch;
  return { fetcher, reads, state };
}

async function market(body: unknown, options: { now?: () => number; directory?: string; fetcher?: typeof fetch; timeZone?: string } = {}) {
  const { fetcher, reads, state } = server(body);
  return {
    market: new PluginMarket({
      url: URL_INDEX, directory: options.directory ?? await temporary(), fetch: options.fetcher ?? fetcher, keys: KEYS, timeZone: options.timeZone ?? "Europe/Berlin",
      ...(options.now ? { now: options.now } : {}),
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
      expect(await off.release("a/b", "1.0.0")).toBeUndefined();
    }
    expect(reads).toEqual([]);
  });

  it("lists each plugin's newest installable version with its facts, featured first, then by score", async () => {
    const { market: subject } = await market(index({
      versions: [
        version("a/low", "1.0.0", "a/low"),
        version("a/top", "1.1.0", "a/top"),
        version("a/top", "1.2.0", "a/top", { release: signed("a/top", "1.2.0", { size: 4096 }) }),
        rejected("a/top", "1.3.0", ["no"]),
        version("a/picked", "1.0.0", "a/picked"),
        version("WhiteTowerAI/ohmygame-plugins", "1.0.0", "ohmygame/studio"),
        version("evil/studio", "1.0.0", "ohmygame/posing"),
        version("personal/mine", "1.0.0", "personal/mine"),
        version("project/mine", "1.0.0", "project/mine"),
      ],
      repositories: {
        "a/top": { stars: 9, avatar: "https://avatars.githubusercontent.com/u/42?v=4", createdAt: "2025-06-01T00:00:00.000Z" },
        "a/low": { stars: 1 },
      },
      featured: ["a/picked", "a/gone"],
    }));
    const { status, plugins } = await subject.listing("zh-CN");
    expect(status).toBe("ready");
    expect(plugins.map((plugin) => [plugin.id, plugin.version, plugin.featured])).toEqual([
      // OhMyGame's own publisher is listed from its own repositories; the Plugin Builder's and projects' aren't.
      ["a/picked", "1.0.0", true], ["a/top", "1.2.0", false], ["a/low", "1.0.0", false], ["ohmygame/studio", "1.0.0", false],
    ]);
    expect(plugins[1]).toMatchObject({
      displayName: "a/top 名字", description: "A plugin", asks: ["network:api.example.com"],
      adds: { skills: 2, mcpServers: 1 }, repository: "https://github.com/a/top", sourceVerified: true, stars: 9,
      avatar: "42", createdAt: "2025-06-01T00:00:00.000Z", size: 4096,
    });
    expect(plugins[1]).not.toHaveProperty("weeklyDownloads");
    expect(plugins[2]).not.toHaveProperty("avatar");
  });

  it("scores plugins by downloads most, but also by stars, how recently they were updated and their page", () => {
    const now = Date.parse("2026-11-11T00:00:00.000Z");
    const plugin = (fields: Partial<MarketPlugin>): MarketPlugin => ({
      id: "a/b", version: "1.0.0", displayName: "B", description: "", asks: [], adds: {}, featured: false, sourceVerified: false, ...fields,
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
      versions: versions.map((ver, order) => version("a/b", ver, "a/b", { publishedAt: `2026-01-0${order + 1}T00:00:00.000Z` })),
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

  it("leaves out a version installing wouldn't find signed as listed", async () => {
    // Installing looks for exactly the plugin and version on the card. A card for one of
    // these would miss the index when installing, and so the signature check.
    const { market: subject } = await market(index({ versions: [
      version("a/unsigned", "1.0.0", "a/unsigned", { release: undefined }),
      version("a/other", "1.0.0", "a/other", { release: signed("a/elsewhere", "1.0.0") }),
      version("a/older", "1.1.0", "a/older", { release: signed("a/older", "1.0.0") }),
      version("a/tagged", "latest", "a/tagged", { release: signed("a/tagged", "latest") }),
      version("a/nocommit", "1.0.0", "a/nocommit", { commit: "" }),
      version("a/good", "1.0.0", "a/good"),
    ] }));
    expect((await subject.listing("en")).plugins.map((plugin) => plugin.id)).toEqual(["a/good"]);
  });

  it("lists blocked versions with their reasons", async () => {
    const { market: subject } = await market(index({
      versions: [rejected("a/bad", "1.0.0", ["blocked: steals keys"]), rejected("a/odd", "1.0.0", ["has a postinstall script"])],
    }));
    expect((await subject.listing("en")).blocked).toEqual([{ repository: "a/bad", version: "1.0.0", reason: "steals keys" }]);
  });

  it("refuses an index that doesn't match its name, isn't well formed, or has an odd pointer", async () => {
    const wrongFile = (async (input: string) => input === URL_INDEX
      ? Response.json({ latest: `index.${"a".repeat(64)}.json` })
      : new Response(JSON.stringify(index()))) as unknown as typeof fetch;
    const oddPointer = (async () => Response.json({ latest: "../../evil.json" })) as unknown as typeof fetch;
    for (const options of [{ fetcher: wrongFile }, { fetcher: oddPointer }])
      expect((await (await market(index(), options)).market.listing("en")).status).toBe("unavailable");
    // The npm index, schema 1, is for older apps.
    for (const body of ["{", index({ schemaVersion: 1 }), index({ versions: [{ repository: "a/b" }] }), index({ versions: [version("https://evil.example.com/a/b", "1.0.0", "a/b")] })])
      expect((await (await market(body)).market.listing("en")).status).toBe("unavailable");
  });

  it("doesn't let a slow read of the saved index undo a refresh", async () => {
    let now = 1_000_000;
    const directory = await temporary();
    await (await market(index(), { directory, now: () => now })).market.listing("en");
    const newer = await market(index({ versions: [version("a/b", "1.0.0", "a/b")] }), { directory, now: () => now });
    const answers = await Promise.all([newer.market.listing("en"), newer.market.listing("en"), newer.market.listing("en")]);
    expect(answers.every(({ status }) => status === "ready")).toBe(true);
    await vi.waitFor(async () => expect((await newer.market.listing("en")).plugins).toHaveLength(1));
    expect(newer.reads.filter((url) => url === URL_INDEX)).toHaveLength(1);
  });

  it("keeps the last index when the network is down, across restarts, and says it may be old", async () => {
    let now = 1_000_000;
    const directory = await temporary();
    const first = await market(index({ versions: [version("a/b", "1.0.0", "a/b")] }), { directory, now: () => now });
    expect((await first.market.listing("en")).plugins).toHaveLength(1);

    // A restart without network shows what was saved. The refresh runs behind the answer.
    const offline = server(index());
    offline.state.up = false;
    const restarted = await market(index(), { directory, fetcher: offline.fetcher, now: () => now });
    expect((await restarted.market.listing("en")).plugins).toHaveLength(1);
    await vi.waitFor(async () => expect(await restarted.market.listing("en")).toMatchObject({ status: "stale", plugins: [{ id: "a/b" }] }));
  });

  it("lists what an index says about a plugin's place and pictures, leaving out what this app doesn't know", async () => {
    const { market: subject } = await market(index({ versions: [version("a/b", "1.0.0", "a/b", { plugin: {
      ...version("a/b", "1.0.0", "a/b").plugin,
      categories: ["art", "hologram", "3d"], appliesTo: ["web-game"], beta: true,
      longDescription: { en: "Long", "zh-CN": "长" },
      // Each in the person's language, or English, once.
      keywords: [{ en: "image", "zh-CN": "图片" }, { en: "pixel" }, { en: "art", "zh-CN": "图片" }],
      names: [{ en: "SiliconFlow", "zh-CN": "硅基流动" }],
      // In the app's order, without a kind it doesn't know.
      providerKinds: ["video", "hologram", "language"],
      // An index field from a later schema is passed over.
      rating: 5,
      icon: "assets/icon.svg",
      screenshots: [
        { path: "assets/one.png", caption: { en: "One", "zh-CN": "一" } },
        { path: "../elsewhere.png" }, { path: "https://evil.example/x.png" }, { path: "./assets/x.png" }, { path: "assets/two.webp" },
      ],
    } })] }));
    const [plugin] = (await subject.listing("zh-CN")).plugins;
    expect(plugin).toMatchObject({
      categories: ["art", "3d"], appliesTo: ["web-game"], beta: true, longDescription: "长",
      keywords: ["图片", "pixel"], names: ["硅基流动"], providerKinds: ["language", "video"],
      icon: "assets/icon.svg",
      screenshots: [{ path: "assets/one.png", caption: "一" }, { path: "assets/two.webp" }],
    });
    expect(plugin).not.toHaveProperty("rating");
  });

  it("reads only the icon and screenshots its index lists, from beside the index, checking each", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const svg = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><path d="M0 0h32v32H0z"/></svg>');
    const plugin = (icon: string, screenshots: string[]) => ({ plugin: { ...version("a/b", "1.0.0", "a/b").plugin, icon, screenshots: screenshots.map((path) => ({ path })) } });
    const { market: subject, reads, state } = await market(index({ versions: [
      version("a/b", "1.0.0", "a/b", plugin("assets/icon.svg", ["assets/one.png", "assets/page.png", "assets/script.svg"])),
      version("a/c", "1.0.0", "a/c", plugin("assets/bad.svg", [])),
      version("a/d", "1.0.0", "a/d", plugin("assets/icon.png", [])),
    ] }));
    const at = (file: string) => new URL(file, URL_INDEX).href;
    state.files[at("assets/icon.svg")] = svg;
    state.files[at("assets/one.png")] = png;
    state.files[at("assets/page.png")] = Buffer.from("<html></html>");
    state.files[at("assets/script.svg")] = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0Z"/></svg>');
    state.files[at("assets/other.png")] = png;
    state.files[at("assets/bad.svg")] = Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    expect(await subject.image("assets/icon.svg", "icon")).toMatchObject({ mediaType: "image/svg+xml", bytes: svg });
    expect(await subject.image("assets/one.png", "screenshot")).toMatchObject({ mediaType: "image/png", bytes: png });
    // Kept once read: they're named by their contents.
    await subject.image("assets/one.png", "screenshot");
    expect(reads.filter((url) => url.endsWith("one.png"))).toHaveLength(1);
    // A screenshot is a PNG, JPEG or WebP; an icon is checked as an installed one's is.
    await expect(subject.image("assets/page.png", "screenshot")).rejects.toThrow();
    await expect(subject.image("assets/script.svg", "screenshot")).rejects.toThrow();
    await expect(subject.image("assets/bad.svg", "icon")).rejects.toThrow();
    // An icon is the type its name says.
    state.files[at("assets/icon.png")] = svg;
    await expect(subject.image("assets/icon.png", "icon")).rejects.toThrow();
    // Each as the role it's asked for: one screenshot isn't read as an icon.
    expect(await subject.image("assets/one.png", "icon")).toBeUndefined();
    // Nothing the index doesn't list.
    expect(await subject.image("assets/other.png", "screenshot")).toBeUndefined();
    expect(reads.some((url) => url.endsWith("other.png"))).toBe(false);
    // A redirect could lead anywhere, so it isn't followed.
    expect(new Set(state.redirects)).toEqual(new Set(["error"]));
  });

  it("reads a publisher's GitHub avatar the main index gives, from GitHub's avatar host only", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const { market: subject, reads, state } = await market(index({
      versions: [version("a/b", "1.0.0", "a/b"), version("a/c", "1.0.0", "a/c")],
      repositories: {
        "a/b": { avatar: "https://avatars.githubusercontent.com/u/42?v=4" },
        "a/c": {},
      },
    }));
    state.files["https://avatars.githubusercontent.com/u/42?s=96"] = png;
    state.files["https://avatars.githubusercontent.com/u/7?s=96"] = png;
    expect(await subject.avatar("42")).toMatchObject({ mediaType: "image/png", bytes: png });
    await subject.avatar("42");
    expect(reads.filter((url) => url.includes("/u/42"))).toHaveLength(1);
    // Not for anyone the index doesn't name.
    expect(await subject.avatar("7")).toBeUndefined();
    expect(await subject.avatar("1")).toBeUndefined();
    expect(reads.some((url) => url.includes("/u/7") || url.includes("/u/1?"))).toBe(false);
    expect(new Set(state.redirects)).toEqual(new Set(["error"]));
  });

  it("passes over an avatar that isn't on GitHub's avatar host", async () => {
    const { market: subject } = await market(index({
      versions: [version("a/b", "1.0.0", "a/b")],
      repositories: { "a/b": { avatar: "https://evil.example/u/42" } },
    }));
    const listing = await subject.listing("en");
    expect(listing.status).toBe("ready");
    expect(listing.plugins[0]).not.toHaveProperty("avatar");
    expect(await subject.avatar("42")).toBeUndefined();
  });

  it("keeps an image below the index's folder, on its host", () => {
    expect(indexImage(URL_INDEX, "assets/ab12.png")).toBe("https://plugins.example.com/plugins/assets/ab12.png");
    for (const file of ["../a.png", "assets/../../a.png", "./a.png", "/a.png", "//evil.example/a.png", "https://evil.example/a.png", "a\\b.png", "", "a.png?x", "a%2e%2e/b.png", "a b.png"]) {
      expect(indexImage(URL_INDEX, file)).toBeUndefined();
    }
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
    const { market: subject, reads, state } = await market(index({ versions: [version("a/b", "1.0.0", "a/b")] }), { now: () => now });
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
    state.body = index({ versions: [version("a/b", "1.0.0", "a/b")] });
    // A refresh runs behind the answer, so each try moves on to when another is due.
    await vi.waitFor(async () => {
      now += 31 * 60_000;
      expect((await subject.listing("en")).plugins).toHaveLength(1);
    });
    expect(files()).toHaveLength(2);
  });
});

describe("PluginMarket release", () => {
  const entry = (ver: string, fields: object = {}) => version("a/b", ver, "a/b", fields);
  const origin = (ver: string) => ({ type: "github", repository: "a/b", commit: entry(ver).commit, release: `v${ver}` });

  it("pins a version once the market's signature over its digest holds, with where to download it", async () => {
    const { market: subject } = await market(index({ versions: [entry("1.0.0")] }));
    expect(await subject.release("a/b", "1.0.0")).toEqual({
      release: signed("a/b", "1.0.0"),
      urls: [entry("1.0.0").github, signed("a/b", "1.0.0").url],
      origin: origin("1.0.0"),
    });
    expect(await subject.release("a/b", "9.0.0")).toBeUndefined();
    expect(await subject.release("a/c", "1.0.0")).toBeUndefined();
  });

  it("downloads from the mirror first in Chinese or in mainland China, as set, and from the mirror alone without a GitHub copy", async () => {
    const body = index({ versions: [entry("1.0.0"), entry("1.1.0", { github: undefined })] });
    const github = entry("1.0.0").github;
    const mirror = signed("a/b", "1.0.0").url;
    const abroad = (await market(body)).market;
    expect((await abroad.release("a/b", "1.0.0", "en"))?.urls).toEqual([github, mirror]);
    expect((await abroad.release("a/b", "1.0.0", "zh-CN"))?.urls).toEqual([mirror, github]);
    const shanghai = (await market(body, { timeZone: "Asia/Shanghai" })).market;
    expect((await shanghai.release("a/b", "1.0.0", "en"))?.urls).toEqual([mirror, github]);
    // Hong Kong reaches GitHub as well as anywhere.
    expect((await (await market(body, { timeZone: "Asia/Hong_Kong" })).market.release("a/b", "1.0.0", "en"))?.urls).toEqual([github, mirror]);
    shanghai.setDownload({ download: "github", proxy: "" });
    expect((await shanghai.release("a/b", "1.0.0"))?.urls).toEqual([github]);
    shanghai.setDownload({ download: "mirror", proxy: "" });
    expect((await shanghai.release("a/b", "1.0.0"))?.urls).toEqual([mirror]);
    shanghai.setDownload({ download: "proxy", proxy: "https://proxy.example.cn/" });
    expect((await shanghai.release("a/b", "1.0.0"))?.urls).toEqual([`https://proxy.example.cn/${github}`]);
    // A tag's source isn't on GitHub byte for byte, so it comes from the mirror whatever is set.
    expect((await shanghai.release("a/b", "1.1.0"))?.urls).toEqual([signed("a/b", "1.1.0").url]);
  });

  it("vouches for an update nobody reviews only by an index read just now", async () => {
    const directory = await temporary();
    const first = await market(index({ versions: [entry("1.1.0")] }), { directory });
    expect(await first.market.vouchedRelease("a/b", "1.1.0")).toMatchObject({ release: signed("a/b", "1.1.0") });
    // Blocked since: a saved copy that still lists it isn't enough.
    const blocked = server(index({ versions: [entry("1.0.0"), rejected("a/b", "1.1.0", ["blocked: steals keys"])] }));
    const restarted = await market(index(), { directory, fetcher: blocked.fetcher });
    await expect(restarted.market.vouchedRelease("a/b", "1.1.0")).rejects.toThrow("blocked");
    // Offline, the saved copy vouches for nothing.
    const offline = server(index());
    offline.state.up = false;
    const away = await market(index(), { directory, fetcher: offline.fetcher });
    expect(await away.market.vouchedRelease("a/b", "1.1.0")).toBeUndefined();
  });

  it("refuses what the index rejected, saying why, by the repository the plugin comes from", async () => {
    const { market: subject } = await market(index({
      versions: [
        entry("1.0.0"),
        rejected("a/b", "1.1.0", ["blocked: steals keys"]),
        rejected("a/b", "1.2.0", ["has a postinstall script"]),
        // Another repository's rejected version says nothing about a/b.
        rejected("evil/b", "1.3.0", ["blocked: not this one"]),
        // A second release of a listed version is turned away, not the version.
        version("a/b", "1.0.0", "a/b", { tag: "b-v1.0.0", plugin: undefined, release: undefined, rejected: ["a/b 1.0.0 is already released as a/b v1.0.0"] }),
      ],
    }));
    await expect(subject.release("a/b", "1.1.0")).rejects.toThrow("was blocked: steals keys");
    await expect(subject.release("a/b", "1.2.0")).rejects.toThrow("can't be added: has a postinstall script");
    await expect(subject.release("a/b", "1.2.0")).rejects.toBeInstanceOf(PluginMarketError);
    expect(await subject.release("a/b", "1.3.0")).toBeUndefined();
    expect(await subject.release("a/b", "1.0.0")).toBeDefined();
  });

  it("refuses a digest, plugin or version the signature doesn't cover, and a key it doesn't know", async () => {
    const { market: subject } = await market(index({ versions: [
      version("a/swapped", "1.0.0", "a/swapped", { release: { ...signed("a/swapped", "1.0.0"), sha256: "b".repeat(64) } }),
      version("a/garbled", "1.0.0", "a/garbled", { release: { ...signed("a/garbled", "1.0.0"), signature: "bm90IGEgc2lnbmF0dXJl" } }),
      version("a/unknown", "1.0.0", "a/unknown", { release: signed("a/unknown", "1.0.0", { key: "other" }) }),
    ] }));
    await expect(subject.release("a/swapped", "1.0.0")).rejects.toThrow("invalid signature");
    await expect(subject.release("a/garbled", "1.0.0")).rejects.toThrow("invalid signature");
    await expect(subject.release("a/unknown", "1.0.0")).rejects.toThrow("a key this app doesn't know");
    // Another key than the market's, which never signed this.
    const { publicKey: otherKey } = generateKeyPairSync("ed25519");
    const other = new PluginMarket({ url: URL_INDEX, directory: await temporary(), fetch: server(index({ versions: [entry("1.0.0")] })).fetcher,
      keys: { test: { publicKey: otherKey.export({ format: "der", type: "spki" }).toString("base64"), publishers: "*" } } });
    await expect(other.release("a/b", "1.0.0")).rejects.toThrow("invalid signature");
  });
});

describe("PluginMarket sources", () => {
  const EXTRA = "https://lists.example.org/ohmygame/index.json";
  /** Serves an index at each address, as the job writes it. */
  function servers(bodies: Record<string, unknown>) {
    const files: Record<string, Buffer> = {};
    const fetcher = (async (input: string | URL) => {
      const url = String(input);
      for (const [pointer, body] of Object.entries(bodies)) {
        const text = JSON.stringify(body);
        const digest = createHash("sha256").update(text).digest("hex");
        if (url === pointer) return Response.json({ schemaVersion: 2, latest: `index.${digest}.json`, sha256: digest });
        if (url === new URL(`index.${digest}.json`, pointer).href) return new Response(text);
      }
      return files[url] ? new Response(new Uint8Array(files[url])) : new Response("", { status: 404 });
    }) as typeof fetch;
    return { fetcher, files };
  }

  it("adds what another index lists and the main one doesn't, without the marks only the main one gives", async () => {
    const facts = { stars: 900, avatar: "https://avatars.githubusercontent.com/u/42?v=4" };
    const { fetcher } = servers({
      [URL_INDEX]: index({ versions: [version("acme/a", "1.0.0", "acme/a")], featured: ["acme/a"] }),
      [EXTRA]: index({
        versions: [
          version("acme/a", "2.0.0", "acme/a", { plugin: { ...version("acme/a", "2.0.0", "acme/a").plugin, displayName: { en: "Not the main one's" } } }),
          version("acme/b", "1.0.0", "acme/b"),
          // OhMyGame's seal comes only from the main index.
          version("acme/fake", "1.0.0", "ohmygame/fake"),
        ],
        repositories: { "acme/b": facts },
        featured: ["acme/b"],
      }),
    });
    const subject = new PluginMarket({ url: URL_INDEX, extra: [EXTRA, "http://lists.example.org/index.json"], directory: await temporary(), fetch: fetcher, keys: KEYS });
    const listing = await subject.listing("en");
    expect(listing.status).toBe("ready");
    // The address that isn't HTTPS is passed over.
    expect(listing.sources).toEqual([{ url: URL_INDEX, status: "ready" }, { url: EXTRA, status: "ready" }]);
    expect(listing.plugins.map((plugin) => [plugin.id, plugin.version, plugin.displayName, plugin.featured])).toEqual([
      ["acme/a", "1.0.0", "acme/a name", true],
      ["acme/b", "1.0.0", "acme/b name", false],
    ]);
    const added = listing.plugins[1]!;
    expect(added).toMatchObject({ source: EXTRA, sourceVerified: false, repository: "https://github.com/acme/b" });
    expect(added).not.toHaveProperty("stars");
    expect(added).not.toHaveProperty("avatar");
    expect(listing.plugins[0]).not.toHaveProperty("source");
    expect(await subject.avatar("42")).toBeUndefined();
  });

  it("reads another index's pictures from beside it, only when asked for that index", async () => {
    const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
    const { fetcher, files } = servers({
      [URL_INDEX]: index(),
      [EXTRA]: index({ versions: [version("acme/b", "1.0.0", "acme/b", { plugin: { ...version("acme/b", "1.0.0", "acme/b").plugin, screenshots: [{ path: "assets/shot.png" }] } })] }),
    });
    files[new URL("assets/shot.png", EXTRA).href] = png;
    const subject = new PluginMarket({ url: URL_INDEX, extra: [EXTRA], directory: await temporary(), fetch: fetcher, keys: KEYS });
    expect(await subject.image("assets/shot.png", "screenshot", EXTRA)).toMatchObject({ bytes: png });
    expect(await subject.image("assets/shot.png", "screenshot")).toBeUndefined();
    expect(await subject.image("assets/shot.png", "screenshot", "https://elsewhere.example/index.json")).toBeUndefined();
  });

  it("lets the first index that lists a version decide about it, the main one first", async () => {
    const { fetcher } = servers({
      [URL_INDEX]: index({ versions: [version("acme/a", "0.9.0", "acme/a"), rejected("acme/a", "1.0.0", ["blocked: steals keys"])] }),
      [EXTRA]: index({ versions: [version("acme/a", "1.0.0", "acme/a"), version("acme/b", "1.0.0", "acme/b")] }),
    });
    const subject = new PluginMarket({ url: URL_INDEX, extra: [EXTRA], directory: await temporary(), fetch: fetcher, keys: KEYS });
    await expect(subject.release("acme/a", "1.0.0")).rejects.toThrow("was blocked: steals keys");
    expect(await subject.release("acme/b", "1.0.0")).toMatchObject({ release: signed("acme/b", "1.0.0") });
    expect((await subject.listing("en")).blocked).toEqual([{ repository: "acme/a", version: "1.0.0", reason: "steals keys" }]);
  });

  it("takes no other index's word for a version while the main one can't be read", async () => {
    const { fetcher } = servers({ [EXTRA]: index({ versions: [version("acme/b", "1.0.0", "acme/b")] }) });
    const subject = new PluginMarket({ url: URL_INDEX, extra: [EXTRA], directory: await temporary(), fetch: fetcher, keys: KEYS });
    expect(await subject.release("acme/b", "1.0.0")).toBeUndefined();
  });

  it("starts from the copy saved before each index had its own file, and drops it once it has its own", async () => {
    const directory = await temporary();
    const old = index({ versions: [version("acme/a", "1.0.0", "acme/a")] });
    await writeFile(path.join(directory, "market-index.json"), JSON.stringify(old));
    const { fetcher } = servers({ [URL_INDEX]: index({ versions: [version("acme/a", "1.1.0", "acme/a")] }) });
    const offline = new PluginMarket({ url: URL_INDEX, directory, fetch: (async () => { throw new Error("offline"); }) as unknown as typeof fetch, keys: KEYS });
    expect(await offline.listing("en")).toMatchObject({ status: "stale", plugins: [{ id: "acme/a", version: "1.0.0" }] });
    const online = new PluginMarket({ url: URL_INDEX, directory, fetch: fetcher, keys: KEYS });
    // It shows what it has while it reads the new one.
    await vi.waitFor(async () => expect(await online.listing("en")).toMatchObject({ status: "ready", plugins: [{ id: "acme/a", version: "1.1.0" }] }));
    await vi.waitFor(() => expect(readFile(path.join(directory, "market-index.json"))).rejects.toThrow());
  });

  it("lets any index's block stop an update nobody reviews, and only the main index vouch for one", async () => {
    const { fetcher } = servers({
      [URL_INDEX]: index({ versions: [version("acme/a", "1.1.0", "acme/a")] }),
      [EXTRA]: index({ versions: [version("acme/a", "1.0.0", "acme/a"), rejected("acme/a", "1.1.0", ["blocked: steals keys"]), version("acme/b", "1.0.0", "acme/b")] }),
    });
    const subject = new PluginMarket({ url: URL_INDEX, extra: [EXTRA], directory: await temporary(), fetch: fetcher, keys: KEYS });
    await expect(subject.vouchedRelease("acme/a", "1.1.0")).rejects.toThrow("steals keys");
    expect(await subject.vouchedRelease("acme/b", "1.0.0")).toBeUndefined();
  });

  it("says which index can't be read, and changes where it reads without losing what it read", async () => {
    const { fetcher } = servers({ [URL_INDEX]: index({ versions: [version("acme/a", "1.0.0", "acme/a")] }) });
    const reads = vi.fn(fetcher);
    const subject = new PluginMarket({ url: URL_INDEX, extra: [EXTRA], directory: await temporary(), fetch: reads as typeof fetch, keys: KEYS });
    expect((await subject.listing("en")).sources).toEqual([{ url: URL_INDEX, status: "ready" }, { url: EXTRA, status: "unavailable" }]);
    const before = reads.mock.calls.length;
    subject.setSources({ url: URL_INDEX, extra: [] });
    expect((await subject.listing("en")).plugins.map((plugin) => plugin.id)).toEqual(["acme/a"]);
    expect(reads.mock.calls.length).toBe(before);
    subject.setSources({ url: undefined, extra: [EXTRA] });
    expect(await subject.listing("en")).toEqual({ status: "off", plugins: [], blocked: [] });
  });
});

describe("PluginMarketSettingsStore", () => {
  it("keeps another main index and more indexes, going back to the default when asked", async () => {
    const directory = await temporary();
    const store = new PluginMarketSettingsStore(directory, URL_INDEX);
    await store.load();
    expect(store.settings()).toEqual({ index: URL_INDEX, defaultIndex: URL_INDEX, extra: [], download: "auto", proxy: "" });
    const mirror = "https://mirror.example.cn/plugins/index.json";
    expect(await store.set({ index: ` ${mirror} `, extra: ["https://lists.example.org/a/index.json", "https://lists.example.org/a/index.json", "", mirror], download: "auto", proxy: "" }))
      .toEqual({ index: mirror, defaultIndex: URL_INDEX, extra: ["https://lists.example.org/a/index.json"], download: "auto", proxy: "" });
    const reloaded = new PluginMarketSettingsStore(directory, URL_INDEX);
    await reloaded.load();
    expect(reloaded.sources()).toEqual({ url: mirror, extra: ["https://lists.example.org/a/index.json"] });
    expect((await reloaded.set({ index: "", extra: [], download: "auto", proxy: "" })).index).toBe(URL_INDEX);
    expect(JSON.parse(await readFile(path.join(directory, "plugin-market-sources.json"), "utf8"))).toEqual({ version: 1, extra: [] });
  });

  it("keeps where plugins download from, a proxy as a prefix ending in a slash, in a file an older app still reads", async () => {
    const directory = await temporary();
    const file = path.join(directory, "plugin-market-sources.json");
    // A file an older app wrote, without them, downloads by where the person is.
    await writeFile(file, JSON.stringify({ version: 1, extra: [] }));
    const store = new PluginMarketSettingsStore(directory, URL_INDEX);
    await store.load();
    expect(store.downloads()).toEqual({ download: "auto", proxy: "" });
    await expect(store.set({ index: "", extra: [], download: "proxy", proxy: "" })).rejects.toThrow("proxy's address");
    await expect(store.set({ index: "", extra: [], download: "proxy", proxy: "http://proxy.example.cn" })).rejects.toBeInstanceOf(PluginMarketSettingsError);
    await expect(store.set({ index: "", extra: [], download: "proxy", proxy: "https://proxy.example.cn/?to=" })).rejects.toBeInstanceOf(PluginMarketSettingsError);
    expect(await store.set({ index: "", extra: [], download: "proxy", proxy: " https://proxy.example.cn/gh " })).toMatchObject({ download: "proxy", proxy: "https://proxy.example.cn/gh/" });
    expect(JSON.parse(await readFile(file, "utf8"))).toEqual({ version: 1, extra: [], download: "proxy", proxy: "https://proxy.example.cn/gh/" });
    const reloaded = new PluginMarketSettingsStore(directory, URL_INDEX);
    await reloaded.load();
    expect(reloaded.downloads()).toEqual({ download: "proxy", proxy: "https://proxy.example.cn/gh/" });
    // The proxy is kept while another source is chosen.
    expect(await reloaded.set({ index: "", extra: [], download: "mirror", proxy: "https://proxy.example.cn/gh/" })).toMatchObject({ download: "mirror", proxy: "https://proxy.example.cn/gh/" });
    // A source this app doesn't know is a file it can't read.
    await writeFile(file, JSON.stringify({ version: 1, extra: [], download: "carrier-pigeon" }));
    await expect(new PluginMarketSettingsStore(directory, URL_INDEX).load()).rejects.toThrow("can read");
  });

  it("refuses an address that isn't HTTPS, too many indexes, and a file it can't read", async () => {
    const directory = await temporary();
    const store = new PluginMarketSettingsStore(directory, URL_INDEX);
    await expect(store.set({ index: "http://mirror.example.cn/index.json", extra: [], download: "auto", proxy: "" })).rejects.toBeInstanceOf(PluginMarketSettingsError);
    await expect(store.set({ index: "", extra: Array.from({ length: 6 }, (_, at) => `https://lists.example.org/${at}/index.json`), download: "auto", proxy: "" })).rejects.toThrow("At most 5");
    await expect(store.set({ index: "", extra: [`https://lists.example.org/${"插".repeat(60)}/index.json`], download: "auto", proxy: "" })).rejects.toThrow("at most 500");
    await writeFile(path.join(directory, "plugin-market-sources.json"), '{"version": 1, "extra": ["https://lists.exa');
    const cut = new PluginMarketSettingsStore(directory, URL_INDEX);
    await expect(cut.load()).rejects.toThrow();
    await expect(cut.set({ index: "", extra: [], download: "auto", proxy: "" })).rejects.toThrow("isn't replaced");
    await writeFile(path.join(directory, "plugin-market-sources.json"), JSON.stringify({ version: 2, extra: [] }));
    const newer = new PluginMarketSettingsStore(directory, URL_INDEX);
    await expect(newer.load()).rejects.toThrow("can read");
    expect(newer.sources()).toEqual({ url: URL_INDEX, extra: [] });
    await expect(newer.set({ index: "", extra: [], download: "auto", proxy: "" })).rejects.toThrow("isn't replaced");
    expect(JSON.parse(await readFile(path.join(directory, "plugin-market-sources.json"), "utf8")).version).toBe(2);
  });
});
