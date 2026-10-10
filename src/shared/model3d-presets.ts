import type { CustomProviderPreset, Model3DDefinition } from "./contracts.js";
import { defaultModel3DSettings, normalizeModelUsages } from "./custom-models.js";

export type Native3DProviderId = "meshy" | "tripo" | "hyper3d";
export const NATIVE_3D_PROVIDER_NAMES: Record<Native3DProviderId, string> = { meshy: "Meshy", tripo: "Tripo", hyper3d: "Hyper3D" };
export function isNative3DProvider(id: string): id is Native3DProviderId { return Object.hasOwn(NATIVE_3D_PROVIDER_NAMES, id); }

export const MODEL_3D_CATALOG_DOCS: Record<Native3DProviderId, string> = {
  meshy: "https://docs.meshy.ai/en/api/image-to-3d",
  tripo: "https://developers.tripo3d.ai/en/docs/models-and-versions",
  hyper3d: "https://docs.hyper3d.ai/en/api-specification/rodin-gen2-5",
};
export const MODEL_3D_CATALOG_REVIEWED = "2026-10-10";

/** Documented image-generation versions. Saved defaults override these definitions. */
export const MODEL_3D_PRESETS: Record<Native3DProviderId, readonly Model3DDefinition[]> = {
  meshy: [
    { id: "meshy-t2", name: "Meshy T2", settings: defaultModel3DSettings("smart-topology") },
    { id: "meshy-7.1", name: "Meshy 7.1", settings: { ...defaultModel3DSettings(), operation: "multi-image-to-3d", maxReferenceImages: 4 } },
    ...["meshy-7", "meshy-6", "meshy-6-lite", "latest"].map((id) => ({ id,
      name: id === "latest" ? "Meshy Latest" : id === "meshy-7" ? "Meshy 7 (deprecated)" : id.replace("meshy-", "Meshy ").replace("-lite", " Lite"),
      settings: { ...defaultModel3DSettings(), operation: "multi-image-to-3d" as const, maxReferenceImages: 4 } })),
  ],
  tripo: [
    { id: "P1-20260311", name: "Tripo P1", settings: defaultModel3DSettings("standard", "tripo") },
    { id: "v3.1-20260211", name: "Tripo V3.1", settings: { ...defaultModel3DSettings("standard", "tripo"),
      polycount: { min: 100, max: 1_500_000, default: 30_000, presets: [10_000, 30_000, 100_000, 300_000] } } },
    { id: "P2-20260801", name: "Tripo P2 (preview)", settings: { ...defaultModel3DSettings("standard", "tripo"),
      polycount: { min: 100, max: 50_000, default: 4_000, presets: [1_000, 4_000, 10_000, 20_000, 50_000] } } },
    ...[{ id: "v3.0-20250812", name: "Tripo V3.0", max: 1_000_000 }, { id: "v2.5-20250123", name: "Tripo V2.5", max: 500_000 }].map(({ id, name, max }) => ({ id, name,
      settings: { ...defaultModel3DSettings("standard", "tripo"), polycount: { min: 100, max, default: 30_000, presets: [10_000, 30_000, 100_000, 300_000] } } })),
  ],
  hyper3d: ["Gen-2.5-Medium", "Gen-2.5-Low", "Gen-2.5-High", "Gen-2.5-Extreme-Low", "Gen-2.5-Extreme-High", "Gen-2", "Sketch", "Regular", "Detail", "Smooth"].map((tier) => {
    const settings = defaultModel3DSettings("standard", "hyper3d");
    const max = tier === "Gen-2" ? 20_000 : !tier.startsWith("Gen-") ? 200_000 : ["Gen-2.5-High", "Gen-2.5-Extreme-High"].includes(tier) ? 2_000_000 : 1_000_000;
    return { id: tier, name: tier.startsWith("Gen-") ? tier.replace("Gen-", "Rodin Gen ").replaceAll("-", " ") : `Rodin Gen 1/1.5 ${tier}`, settings: { ...settings,
      polycount: { ...settings.polycount, max, presets: settings.polycount.presets.filter((count) => count <= max) } } };
  }),
};

export function model3DPreset(provider: string, id: string): Model3DDefinition | undefined {
  return isNative3DProvider(provider) ? MODEL_3D_PRESETS[provider].find((model) => model.id === id) : undefined;
}

/** Official endpoints have no compatible /models discovery in our supported protocols. */
export function usesModel3DPresets(baseUrl: string, preset?: CustomProviderPreset): boolean {
  if (!preset || !isNative3DProvider(preset)) return false;
  try { return new URL(baseUrl).origin === { meshy: "https://api.meshy.ai", tripo: "https://openapi.tripo3d.ai", hyper3d: "https://api.hyper3d.com" }[preset]; }
  catch { return false; }
}

export function normalizeNativeModel3D(provider: Native3DProviderId, value: unknown, mode: "edit" | "restore" = "edit"): Model3DDefinition {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid 3D model");
  const input = value as Record<string, unknown>;
  const id = typeof input.id === "string" ? input.id.trim() : "";
  const name = typeof input.name === "string" ? input.name.trim() || id : id;
  if (!id || id.length > 200 || /[\s\x00-\x1f]/.test(id) || name.length > 200 || /[\x00-\x1f]/.test(name)) throw new Error("Enter a model ID and name (up to 200 characters)");
  const settings = normalizeModelUsages({ "3d": input.settings })?.["3d"];
  if (!settings || settings.protocol !== provider || settings.baseUrl) throw new Error("Use this provider's 3D protocol and connection");
  const preset = model3DPreset(provider, id);
  if (preset && mode === "restore") {
    // A manually added version can become an official preset after an app update.
    // Adopt documented capabilities without losing its name or valid generation defaults.
    const polycount = preset.settings.polycount;
    const presets = settings.polycount.presets.filter((count) => count >= polycount.min && count <= polycount.max);
    return { id, name, settings: { ...preset.settings, defaults: settings.defaults,
      polycount: { ...polycount, default: Math.max(polycount.min, Math.min(polycount.max, settings.polycount.default)),
        presets: presets.length ? presets : polycount.presets } } };
  }
  if (preset) {
    for (const key of ["protocol", "operation", "modelType", "maxReferenceImages", "supportsTexture", "supportsPbr"] as const) {
      if (settings[key] !== preset.settings[key]) throw new Error("Official model capabilities cannot be changed. Add a custom version instead.");
    }
    if (settings.polycount.min !== preset.settings.polycount.min || settings.polycount.max !== preset.settings.polycount.max) throw new Error("Keep the official model's face-count range");
  }
  return { id, name, settings };
}
