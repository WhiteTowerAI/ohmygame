import type { PublishListingStatus } from "../shared/publish-v1.js";

export interface ListingState {
  status: PublishListingStatus;
  listedAt: string | null;
  updatedAt: string;
}

export const listingBodySchema = {
  type: "object",
  additionalProperties: false,
  required: ["status"],
  properties: { status: { type: "string", enum: ["listed", "unlisted"] } },
} as const;

export function nextListingState(
  current: ListingState,
  status: PublishListingStatus,
  ready: boolean,
  updatedAt: string,
): ListingState | "not_ready" {
  if (status === "listed" && !ready) return "not_ready";
  if (status === "listed") {
    return { status, listedAt: current.listedAt ?? updatedAt, updatedAt };
  }
  return { status, listedAt: null, updatedAt };
}
