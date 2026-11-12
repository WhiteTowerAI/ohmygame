import { access, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { DoubaoVoiceSettingsStore } from "../src/daemon/doubao-voice-settings.js";
import { ElevenLabsSettingsStore } from "../src/daemon/elevenlabs-settings.js";
import { MediaProviderKeyStore } from "../src/daemon/media-provider-settings.js";
import { MinimaxSettingsStore } from "../src/daemon/minimax-settings.js";
import { builtInMediaProviders } from "../src/daemon/providers/built-in.js";
import { MediaProviderRegistry } from "../src/daemon/providers/registry.js";
import { SeedanceSettingsStore } from "../src/daemon/seedance-settings.js";

const BUILT_IN = [
  ["meshy", "Meshy", ["3d"]],
  ["tripo", "Tripo", ["3d"]],
  ["hyper3d", "Hyper3D", ["3d"]],
  ["volcengine-ark", "Volcengine Ark", ["image", "video"]],
  ["byteplus-modelark", "BytePlus ModelArk", ["video"]],
  ["minimax-video-cn", "MiniMax China", ["video"]],
  ["minimax-video-global", "MiniMax Global", ["video"]],
  ["volcengine-tts", "Doubao Speech", ["audio"]],
  ["elevenlabs", "ElevenLabs", ["audio"]],
] as const;

/** The stores app.ts builds, on one data directory, listed through the registry. */
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
  const elevenLabs = new ElevenLabsSettingsStore(directory);
  await Promise.all([
    ...native3D.map(([, , store]) => store.load()),
    seedance.load(),
    minimax.load(),
    doubaoVoice.load(),
    elevenLabs.load(),
  ]);
  const sources = {
    native3D,
    seedance,
    minimax,
    doubaoVoice,
    elevenLabs,
    audioFetch: fetch,
    enabled,
  };
  return {
    providers: new MediaProviderRegistry(
      builtInMediaProviders(sources),
      enabled,
    ),
    sources,
    seedance,
    doubaoVoice,
    elevenLabs,
  };
}

describe("media provider registry", () => {
  it("lists every built-in provider once with the summary shape the settings page expects", async () => {
    const { providers, sources } = await registry(
      await mkdtemp(path.join(tmpdir(), "ohmygame-providers-list-")),
    );
    expect(providers.summaries()).toEqual(
      BUILT_IN.map(([id, name, capabilities]) => ({
        id,
        name,
        capabilities: [...capabilities],
        configured: false,
        enabled: true,
        custom: false,
        status: "not_configured",
        credentialType: "api_key",
        methods: [{ type: "api_key", label: `${name} API key` }],
      })),
    );
    expect(providers.has("openai")).toBe(false);
    expect(() => providers.configured("openai")).toThrow("not a built-in");
    const again = {
      id: "meshy",
      name: "Again",
      capabilities: ["3d"] as const,
      configured: () => false,
    };
    expect(
      () =>
        new MediaProviderRegistry(
          [...builtInMediaProviders(sources), again],
          () => true,
        ),
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
      path.join(directory, "elevenlabs.json"),
      JSON.stringify({ version: 1, apiKey: "eleven-key" }),
    );
    const disabled = new Set(["tripo"]);
    const { providers, seedance, doubaoVoice, elevenLabs } = await registry(
      directory,
      (id) => !disabled.has(id),
    );
    await doubaoVoice.update("doubao-key");

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
      "elevenlabs",
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
    await providers.clear("meshy");
    await expect(
      access(path.join(directory, "meshy.json")),
    ).rejects.toMatchObject({ code: "ENOENT" });

    // ElevenLabs is disconnected through its own credential route, not through removal.
    expect(providers.removable("meshy")).toBe(true);
    expect(providers.removable("elevenlabs")).toBe(false);
    await providers.clear("elevenlabs");
    expect(elevenLabs.key()).toBe("eleven-key");
  });

  it("hands the audio adapters to the catalog in listing order, reading keys and the enable state live", async () => {
    const disabled = new Set<string>();
    const { providers, doubaoVoice, elevenLabs } = await registry(
      await mkdtemp(path.join(tmpdir(), "ohmygame-providers-audio-")),
      (id) => !disabled.has(id),
    );
    const [doubao, eleven, ...rest] = providers.audioAdapters();
    expect(rest).toEqual([]);
    expect([doubao!.id, eleven!.id]).toEqual(["volcengine-tts", "elevenlabs"]);
    expect([doubao!.configured(), eleven!.configured()]).toEqual([
      false,
      false,
    ]);
    await doubaoVoice.update("doubao-key");
    await doubaoVoice.setDefaultVoice("zh_female_vv_uranus_bigtts");
    await elevenLabs.update({ apiKey: "eleven-key" });
    expect([doubao!.configured(), eleven!.configured()]).toEqual([true, true]);
    expect(doubao!.defaultVoiceId?.()).toBe("zh_female_vv_uranus_bigtts");
    disabled.add("volcengine-tts");
    expect([doubao!.enabled(), eleven!.enabled()]).toEqual([false, true]);
    expect(providers.get("volcengine-tts")!.audio).toBe(doubao);
  });
});
