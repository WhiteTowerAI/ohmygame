/** Consumer copy of ohmygame-cloud/packages/contracts/src/cloud-models.ts. */
export type CloudCapability = "language" | "image" | "video" | "3d";
export type QuotaUnit = "requests" | "tokens" | "images" | "models" | "credits";
export type CloudAvailability = "ready" | "sign_in_required" | "unavailable" | "personal_exhausted" | "pool_exhausted";

export interface CloudProvider {
  /** Connection ID is distinct from a user's own-key provider. */
  id: string;
  upstreamProvider: string;
  name: string;
  capabilities: CloudCapability[];
}

export interface CloudModel {
  provider: string;
  id: string;
  name: string;
  capability: CloudCapability;
  maxReferenceImages?: number;
  polycount?: { min: number; max: number; default: number; presets: number[] };
  supportsTexture?: boolean;
  supportsPbr?: boolean;
  /** Generation/version and detail level for this catalog model. */
  generationLabel?: string;
  estimatedCredits?: number;
}

export interface CloudCatalog { providers: CloudProvider[]; models: CloudModel[] }
export interface QuotaBalance {
  /** Overrides the quota's unit when personal and shared limits use different meters. */
  unit?: QuotaUnit;
  limit: number | null;
  used: number;
  reserved: number;
  remaining: number | null;
  resetsAt: string;
}
export interface CloudQuota {
  key: string;
  provider: string;
  capability: CloudCapability;
  unit: QuotaUnit;
  availability: CloudAvailability;
  message?: string;
  personal: QuotaBalance;
  /** Our configured allocation pool, not a claim about upstream free balance. */
  pool: QuotaBalance;
}
export interface CloudQuotaSnapshot { userId: string; quotas: CloudQuota[]; fetchedAt: string }
export interface CloudConnectionState { availability: CloudAvailability; userId?: string; quota?: CloudQuota; message?: string }
export type CloudJobStatus = "queued" | "running" | "succeeded" | "failed" | "submission_unknown";
export interface CloudGenerationJob {
  id: string;
  provider: string;
  modelId: string;
  status: CloudJobStatus;
  pollAfterMs: number;
  message?: string;
}
export interface Cloud3DRequest {
  provider: string;
  modelId: string;
  images: Array<{ mediaType: "image/png" | "image/jpeg"; data: string }>;
  targetPolycount?: number;
  texture?: boolean;
  pbr?: boolean;
}

export const HYPER3D_CONNECTION_ID = "cloud-hyper3d";
export const HYPER3D_DEFAULT_TIER = "Gen-2.5-Medium";

/** Documented Rodin tiers, using Raw mesh and no paid add-ons. */
export const HYPER3D_MODELS: CloudModel[] = [HYPER3D_DEFAULT_TIER, "Gen-2.5-Low", "Gen-2.5-High", "Gen-2.5-Extreme-Low", "Gen-2.5-Extreme-High", "Gen-2", "Sketch", "Regular", "Detail", "Smooth"].map((tier) => {
  const generationLabel = tier.startsWith("Gen-") ? tier.replace("Gen-", "Gen ").replaceAll("-", " ") : `Gen 1/1.5 ${tier}`;
  const max = !tier.startsWith("Gen-") ? 200_000 : ["Gen-2.5-High", "Gen-2.5-Extreme-High"].includes(tier) ? 2_000_000 : 1_000_000;
  return { provider: HYPER3D_CONNECTION_ID, id: tier, name: `Rodin ${generationLabel}`, capability: "3d", generationLabel,
    estimatedCredits: tier === "Gen-2.5-Extreme-High" ? 1 : 0.5, maxReferenceImages: 5,
    polycount: { min: 500, max, default: 4_000, presets: [1_000, 4_000, 10_000, 20_000, 100_000] }, supportsTexture: true, supportsPbr: true };
});
export const BUILTIN_CLOUD_CATALOG: CloudCatalog = {
  providers: [{ id: HYPER3D_CONNECTION_ID, upstreamProvider: "hyper3d", name: "Hyper3D", capabilities: ["3d"] }],
  models: HYPER3D_MODELS,
};

/** Compatibility for saved canvases and requests from the original single-model catalog. */
export function cloudModelId(provider: string, id: string): string {
  return provider === HYPER3D_CONNECTION_ID && id === "rodin" ? HYPER3D_DEFAULT_TIER : id;
}

/** Base Rodin pricing without add-ons, using a non-extreme Gen 2.5 texture mode. */
export function hyper3DCredits(tier: string): number | undefined {
  return HYPER3D_MODELS.find((model) => model.id === tier)?.estimatedCredits;
}
