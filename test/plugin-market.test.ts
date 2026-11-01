import { createHash, generateKeyPairSync, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PluginMarket, PluginMarketError } from "../src/daemon/plugin-market.js";

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

/** Serves an index as the job writes it, counting what's read. */
function server(body: unknown) {
  const reads: string[] = [];
  const state = { body, up: true };
  const fetcher = (async (input: string | URL) => {
    const url = String(input);
    reads.push(url);
    if (!state.up) throw new Error("offline");
    const text = typeof state.body === "string" ? state.body : JSON.stringify(state.body);
    const digest = createHash("sha256").update(text).digest("hex");
    if (url === URL_INDEX) return Response.json({ schemaVersion: 1, latest: `index.${digest}.json`, sha256: digest });
    if (url.endsWith(`/index.${digest}.json`)) return new Response(text);
    return new Response("", { status: 404 });
  }) as typeof fetch;
  return { fetcher, reads, state };
}

async function market(body: unknown, options: { now?: () => number; directory?: string; fetcher?: typeof fetch } = {}) {
  const { fetcher, reads, state } = server(body);
  return {
    market: new PluginMarket({ url: URL_INDEX, directory: options.directory ?? await temporary(), fetch: options.fetcher ?? fetcher, keys: { test: { key: KEY } }, ...(options.now ? { now: options.now } : {}) }),
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

  it("lists each plugin's newest installable version with its facts, featured first, then by downloads", async () => {
    const { market: subject } = await market(index({
      versions: [
        version("@a/low", "1.0.0", "a/low"),
        version("@a/top", "1.1.0", "a/top"),
        version("@a/top", "1.2.0", "a/top"),
        { ...version("@a/top", "1.3.0", "a/top", { rejected: ["no"] }), plugin: undefined },
        version("@a/picked", "1.0.0", "a/picked"),
        version("@ohmygame/studio", "1.0.0", "ohmygame/studio"),
        version("@personal/mine", "1.0.0", "personal/mine"),
      ].map((item) => JSON.parse(JSON.stringify(item))),
      packages: {
        "@a/top": { repository: "https://github.com/a/top", sourceVerified: true, stars: 9, weeklyDownloads: 500 },
        "@a/low": { weeklyDownloads: 5 },
      },
      featured: ["a/picked", "a/gone"],
    }));
    const { status, plugins } = await subject.listing("zh-CN");
    expect(status).toBe("ready");
    expect(plugins.map((plugin) => [plugin.id, plugin.version, plugin.featured])).toEqual([
      ["a/picked", "1.0.0", true], ["a/top", "1.2.0", false], ["a/low", "1.0.0", false],
    ]);
    expect(plugins[1]).toMatchObject({
      package: "@a/top", displayName: "a/top 名字", description: "A plugin", asks: ["network:api.example.com"],
      adds: { skills: 2, mcpServers: 1 }, repository: "https://github.com/a/top", sourceVerified: true, stars: 9, weeklyDownloads: 500,
    });
    expect(plugins[0]!.sourceVerified).toBe(false);
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
