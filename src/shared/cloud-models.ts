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
  /** Actual server-selected generation/version and quality; clients cannot override it. */
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
export const BUILTIN_CLOUD_CATALOG: CloudCatalog = {
  providers: [{ id: HYPER3D_CONNECTION_ID, upstreamProvider: "hyper3d", name: "Hyper3D", capabilities: ["3d"] }],
  models: [{ provider: HYPER3D_CONNECTION_ID, id: "rodin", name: "Rodin", capability: "3d", maxReferenceImages: 5,
    polycount: { min: 500, max: 20_000, default: 4_000, presets: [1_000, 4_000, 10_000, 20_000] }, supportsTexture: true, supportsPbr: true }],
};

/** Base Rodin pricing without add-ons, using a non-extreme Gen 2.5 texture mode. */
export function hyper3DCredits(tier: string): number | undefined {
  return tier === "Gen-2.5-Extreme-High" ? 1 : ["Sketch", "Regular", "Detail", "Smooth", "Gen-2", "Gen-2.5-Extreme-Low", "Gen-2.5-Low", "Gen-2.5-Medium", "Gen-2.5-High"].includes(tier) ? 0.5 : undefined;
}
