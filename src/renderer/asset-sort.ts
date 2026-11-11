import { language } from "./i18n.js";

export const ASSET_SORTS = ["newest", "oldest", "largest", "smallest", "name"] as const;
export type AssetSort = (typeof ASSET_SORTS)[number];
export type AssetPeriod = "all" | "today" | "week" | "month";

/** What sorting and the time filter read: a Library asset's `createdAt` or a project file's `modifiedAt`. */
interface DatedAsset {
  path: string;
  size: number;
  assetId?: string;
  createdAt?: string;
  modifiedAt?: string;
}

const DAY = 24 * 60 * 60 * 1000;
const names = new Intl.Collator(language, { numeric: true, sensitivity: "base" });

function assetTime(asset: DatedAsset): number | undefined {
  const time = Date.parse(asset.createdAt ?? asset.modifiedAt ?? "");
  return Number.isFinite(time) ? time : undefined;
}

function compareAssets(left: DatedAsset, right: DatedAsset, sort: AssetSort): number {
  if (sort === "largest") return right.size - left.size;
  if (sort === "smallest") return left.size - right.size;
  if (sort === "name") return names.compare(left.path.split("/").at(-1)!, right.path.split("/").at(-1)!);
  const leftTime = assetTime(left);
  const rightTime = assetTime(right);
  // Assets with no known date stay at the end in either direction.
  if (leftTime === undefined || rightTime === undefined) return Number(leftTime === undefined) - Number(rightTime === undefined);
  return sort === "newest" ? rightTime - leftTime : leftTime - rightTime;
}

/** A sorted copy. Equal assets keep one order, so tiles don't swap when the list reloads. */
export function sortAssets<T extends DatedAsset>(assets: readonly T[], sort: AssetSort): T[] {
  return [...assets].sort((left, right) => compareAssets(left, right, sort) || (left.assetId ?? left.path).localeCompare(right.assetId ?? right.path));
}

/** An asset with no known date is outside every period but "all". */
export function inAssetPeriod(asset: DatedAsset, period: AssetPeriod = "all", now = Date.now()): boolean {
  if (period === "all") return true;
  const time = assetTime(asset);
  if (time === undefined) return false;
  return time >= (period === "today" ? new Date(now).setHours(0, 0, 0, 0) : now - (period === "week" ? 7 : 30) * DAY);
}

/** The month and day for a tile, with the year when it isn't this one. */
export function assetShortDate(asset: DatedAsset, now = Date.now()): string | undefined {
  const time = assetTime(asset);
  if (time === undefined) return undefined;
  const year = new Date(time).getFullYear() === new Date(now).getFullYear() ? undefined : "numeric";
  return new Intl.DateTimeFormat(language, { year, month: "short", day: "numeric" }).format(time);
}

/** The date and time for an asset's details. */
export function assetDateTime(asset: DatedAsset): string | undefined {
  const time = assetTime(asset);
  return time === undefined ? undefined : new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(time);
}
