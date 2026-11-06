import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DoubaoVoiceSettingsStore } from "../src/daemon/doubao-voice-settings.js";
import { MediaProviderKeyStore } from "../src/daemon/media-provider-settings.js";
import { MinimaxSettingsStore } from "../src/daemon/minimax-settings.js";
import { builtInMediaProviders } from "../src/daemon/providers/built-in.js";
import { MediaProviderRegistry } from "../src/daemon/providers/registry.js";
import { SeedanceSettingsStore } from "../src/daemon/seedance-settings.js";

const BUILT_IN_IDS = [
  "meshy",
  "tripo",
  "hyper3d",
  "volcengine-ark",
  "byteplus-modelark",
  "minimax-video-cn",
  "minimax-video-global",
  "volcengine-tts",
  "volcengine-seed-audio",
];

/** The stores and adapters app.ts builds, on one data directory, listed through the registry. */
async function registry(
  directory: string,
  enabled: (id: string) => boolean = () => true,
) {
  const native3D = [
    ["meshy", "Meshy", new MediaProviderKeyStore(directory, "meshy", "Meshy")],
    ["tripo", "Tripo", new MediaProviderKeyStore(directory, "tripo", "Tripo")],
    [
      "hyper3d",
      "Hyper3D",
      new MediaProviderKeyStore(directory, "hyper3d", "Hyper3D"),
    ],
  ] as const;
  const seedance = new SeedanceSettingsStore(directory);
  const minimax = new MinimaxSettingsStore(directory);
  const doubaoVoice = new DoubaoVoiceSettingsStore(directory);
  await Promise.all([
    ...native3D.map(([, , store]) => store.load()),
    seedance.load(),
    minimax.load(),
    doubaoVoice.load(),
  ]);
  const providers = new MediaProviderRegistry(
    builtInMediaProviders({
      native3D,
      seedance,
      minimax,
      doubaoVoice,
      audioFetch: fetch,
      enabled,
    }),
    enabled,
  );
  return { providers, seedance, minimax, doubaoVoice };
}

describe("media provider registry", () => {
  it("lists every built-in provider once with the summary shape the settings page expects", async () => {
    const { providers } = await registry(
      await mkdtemp(path.join(tmpdir(), "ohmygame-providers-list-")),
    );
    expect(providers.summaries()).toEqual(
      BUILT_IN_IDS.map((id) =>
        expect.objectContaining({
          id,
          configured: false,
          enabled: true,
          custom: false,
          status: "not_configured",
          credentialType: "api_key",
          methods: [
            { type: "api_key", label: `${providers.get(id)!.name} API key` },
          ],
        }),
      ),
    );
    expect(
      providers
        .summaries()
        .map((provider) => [provider.id, provider.name, provider.capabilities]),
    ).toEqual([
      ["meshy", "Meshy", ["3d"]],
      ["tripo", "Tripo", ["3d"]],
      ["hyper3d", "Hyper3D", ["3d"]],
      ["volcengine-ark", "Volcengine Ark", ["image", "video"]],
      ["byteplus-modelark", "BytePlus ModelArk", ["video"]],
      ["minimax-video-cn", "MiniMax China", ["video"]],
      ["minimax-video-global", "MiniMax Global", ["video"]],
      ["volcengine-tts", "Doubao Speech", ["audio"]],
      ["volcengine-seed-audio", "Doubao Seed Audio", ["audio"]],
    ]);
    expect(providers.has("openai")).toBe(false);
    expect(() => providers.configured("openai")).toThrow("not a built-in");
    const listed = builtInMediaProviders(await sources());
    const again = {
      id: "meshy",
      name: "Again",
      capabilities: ["3d"] as const,
      configured: () => false,
      clear: async () => {},
    };
    expect(
      () => new MediaProviderRegistry([...listed, again], () => true),
    ).toThrow("listed twice");
  });

  it("reads the stores' existing files and clears one connection without touching its neighbours", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "ohmygame-providers-files-"),
    );
    await writeFile(
      path.join(directory, "meshy.json"),
      JSON.stringify({ version: 1, apiKey: "meshy-key" }),
    );
    await writeFile(
      path.join(directory, "seedance.json"),
      JSON.stringify({
        version: 1,
        volcengineApiKey: "volc-key",
        byteplusApiKey: "byteplus-key",
      }),
    );
    await writeFile(
      path.join(directory, "minimax.json"),
      JSON.stringify({ version: 1, cnApiKey: "cn-key" }),
    );
    await writeFile(
      path.join(directory, "doubao-voice.json"),
      JSON.stringify({
        version: 1,
        apiKey: "doubao-key",
        services: {},
        defaultVoiceId: "zh_female_vv_uranus_bigtts",
      }),
    );
    const disabled = new Set(["tripo"]);
    const { providers, seedance, doubaoVoice } = await registry(
      directory,
      (id) => !disabled.has(id),
    );

    const configured = providers
      .summaries()
      .filter((provider) => provider.configured)
      .map((provider) => provider.id);
    expect(configured).toEqual([
      "meshy",
      "volcengine-ark",
      "byteplus-modelark",
      "minimax-video-cn",
      "volcengine-tts",
      "volcengine-seed-audio",
    ]);
    expect(
      providers.summaries().find((provider) => provider.id === "tripo"),
    ).toMatchObject({ enabled: false, status: "not_configured" });
    expect(JSON.stringify(providers.summaries())).not.toContain("-key");

    await providers.clear("volcengine-ark");
    expect(providers.configured("volcengine-ark")).toBe(false);
    expect(seedance.key("byteplus-modelark")).toBe("byteplus-key");
    expect(
      JSON.parse(await readFile(path.join(directory, "seedance.json"), "utf8")),
    ).toEqual({ version: 1, byteplusApiKey: "byteplus-key" });

    await providers.clear("volcengine-tts");
    expect(providers.configured("volcengine-tts")).toBe(false);
    expect(providers.configured("volcengine-seed-audio")).toBe(true);
    // The voice outlives the disconnection, so reconnecting with a new key keeps it.
    expect(doubaoVoice.defaultVoiceId()).toBe("zh_female_vv_uranus_bigtts");

    await providers.clear("meshy");
    await expect(
      access(path.join(directory, "meshy.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("hands the audio adapters to the catalog in listing order, reading keys and the enable state live", async () => {
    const directory = await mkdtemp(
      path.join(tmpdir(), "ohmygame-providers-audio-"),
    );
    const disabled = new Set<string>();
    const { providers, doubaoVoice } = await registry(
      directory,
      (id) => !disabled.has(id),
    );
    const [speech, seed, ...rest] = providers.audioAdapters();
    expect(rest).toEqual([]);
    expect([speech!.id, seed!.id]).toEqual([
      "volcengine-tts",
      "volcengine-seed-audio",
    ]);
    expect(speech!.configured()).toBe(false);
    await doubaoVoice.setService("volcengine-tts", "doubao-key");
    await doubaoVoice.setDefaultVoice("zh_female_vv_uranus_bigtts");
    expect(speech!.configured()).toBe(true);
    expect(speech!.defaultVoiceId?.()).toBe("zh_female_vv_uranus_bigtts");
    expect(seed!.configured()).toBe(false);
    disabled.add("volcengine-tts");
    expect(speech!.enabled()).toBe(false);
    expect(seed!.enabled()).toBe(true);
  });
});

async function sources() {
  const directory = await mkdtemp(
    path.join(tmpdir(), "ohmygame-providers-sources-"),
  );
  const doubaoVoice = new DoubaoVoiceSettingsStore(directory);
  return {
    native3D: [
      [
        "meshy",
        "Meshy",
        new MediaProviderKeyStore(directory, "meshy", "Meshy"),
      ],
    ] as const,
    seedance: new SeedanceSettingsStore(directory),
    minimax: new MinimaxSettingsStore(directory),
    doubaoVoice,
    audioFetch: fetch,
    enabled: () => true,
  };
}
