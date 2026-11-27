import { useState } from "react";
import type { ProjectAssetFilters, BrowsableAsset } from "./asset-browser.js";
import { ASSET_SORTS, type AssetPeriod, type AssetSort } from "./asset-sort.js";
import { t } from "./i18n.js";
import { Select } from "./ui/index.js";

/** The order a list was last sorted in on this device. */
export function useAssetSort(storageKey: string): readonly [AssetSort, (sort: AssetSort) => void] {
  const [sort, setSort] = useState<AssetSort>(() => {
    try {
      const stored = localStorage.getItem(storageKey) as AssetSort | null;
      return stored && ASSET_SORTS.includes(stored) ? stored : "newest";
    } catch { return "newest"; }
  });
  const choose = (next: AssetSort) => {
    setSort(next);
    try { localStorage.setItem(storageKey, next); } catch { /* Sorting still works without storage. */ }
  };
  return [sort, choose] as const;
}

export function AssetSortSelect({ value, onChange }: { value: AssetSort; onChange: (sort: AssetSort) => void }) {
  return <span className="library-filter-sort"><Select size="sm" label={t("libraryFilters.sort")} value={value} onChange={onChange} options={ASSET_SORTS.map((sort) => ({ value: sort, label: t(`libraryFilters.sortBy.${sort}`) }))} /></span>;
}

export function AssetPeriodSelect({ label, value = "all", onChange }: { label: string; value?: AssetPeriod; onChange: (period: AssetPeriod) => void }) {
  return <Select size="sm" label={label} value={value} onChange={onChange} options={[
    { value: "all", label: t("libraryFilters.anyTime") },
    { value: "today", label: t("libraryFilters.today") },
    { value: "week", label: t("libraryFilters.pastWeek") },
    { value: "month", label: t("libraryFilters.pastMonth") },
  ]} />;
}

/**
 * A project's Assets panel source, use and time filters, in the row beside the
 * kind tabs. Source and use show only when the assets
 * differ in them, or while one is set, so a filter is never a no-op.
 */
export function ProjectAssetFilterRow({ assets, filters, onChange }: {
  assets: readonly BrowsableAsset[];
  filters: ProjectAssetFilters;
  onChange: (filters: ProjectAssetFilters) => void;
}) {
  const sources = new Set(assets.map((asset) => asset.origin ?? "workspace")).size > 1 || (filters.origin ?? "all") !== "all";
  const uses = new Set(assets.map((asset) => asset.purpose ?? "asset")).size > 1 || (filters.purpose ?? "all") !== "all";
  return <>
    {sources ? <Select size="sm" label={t("libraryFilters.source")} value={filters.origin ?? "all"} onChange={(origin) => onChange({ ...filters, origin })} options={[
      { value: "all", label: t("libraryFilters.allSources") },
      { value: "generated", label: t("libraryFilters.generated") },
      { value: "uploaded", label: t("libraryFilters.uploaded") },
      { value: "workspace", label: t("libraryFilters.projectFiles") },
      ...(assets.some((asset) => asset.origin === "builtin") ? [{ value: "builtin" as const, label: t("libraryFilters.builtIn") }] : []),
    ]} /> : null}
    {uses ? <Select size="sm" label={t("libraryFilters.use")} value={filters.purpose ?? "all"} onChange={(purpose) => onChange({ ...filters, purpose })} options={[
      { value: "all", label: t("libraryFilters.allUses") },
      { value: "asset", label: t("libraryFilters.assets") },
      { value: "reference", label: t("libraryFilters.references") },
    ]} /> : null}
    <AssetPeriodSelect label={t("libraryFilters.modified")} value={filters.period} onChange={(period) => onChange({ ...filters, period })} />
  </>;
}
