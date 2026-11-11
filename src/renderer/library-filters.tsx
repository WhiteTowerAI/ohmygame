import { useEffect, useId, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { SlidersHorizontal, X } from "./icons.js";
import { libraryAssetProjects, type LibraryAsset, type LibraryAssetFilters } from "./library-assets.js";
import type { LibraryAssetProject } from "../shared/contracts.js";
import { menuPlacement } from "./popover-placement.js";
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

export function LibraryCollectionFilters({ assets, filters, onChange, defaultIncludeReferences = false, defaultProjectId, defaultProject }: {
  assets: readonly LibraryAsset[];
  filters: LibraryAssetFilters;
  onChange: (filters: LibraryAssetFilters) => void;
  defaultIncludeReferences?: boolean;
  defaultProjectId?: string;
  defaultProject?: LibraryAssetProject;
}) {
  const projects = libraryAssetProjects(assets);
  if (defaultProject && !projects.some((project) => project.id === defaultProject.id)) projects.push(defaultProject);
  projects.sort((left, right) => left.name.localeCompare(right.name));
  const active = (filters.origin ?? "saved") !== "saved" || (filters.projectId ?? "") !== (defaultProjectId ?? "") || (filters.includeReferences ?? false) !== defaultIncludeReferences;
  return <AssetFilterPopover active={active} onReset={() => onChange({ includeReferences: defaultIncludeReferences, ...(defaultProjectId ? { projectId: defaultProjectId } : {}) })}>
    <label>{t("libraryFilters.source")}<select value={filters.origin ?? "saved"} onChange={(event) => onChange({ ...filters, origin: event.target.value as LibraryAssetFilters["origin"] })}>
      {librarySourceOptions().map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select></label>
    <label>{t("libraryFilters.project")}<select value={filters.projectId ?? ""} onChange={(event) => onChange({ ...filters, projectId: event.target.value })}>
      {libraryProjectOptions(projects).map((option) => <option key={option.value} value={option.value}>{option.label}</option>)}
    </select></label>
    <label className="library-reference-toggle"><input type="checkbox" checked={filters.includeReferences ?? false} onChange={(event) => onChange({ ...filters, includeReferences: event.target.checked })} /><span>{t("libraryFilters.includeReferences")}</span></label>
  </AssetFilterPopover>;
}

/** A project's Assets panel source, use and time filters, in the row beside the kind tabs, as on the Library page. */
export function ProjectAssetFilterRow({ assets, filters, onChange }: {
  assets: readonly BrowsableAsset[];
  filters: ProjectAssetFilters;
  onChange: (filters: ProjectAssetFilters) => void;
}) {
  return <>
    <Select size="sm" label={t("libraryFilters.source")} value={filters.origin ?? "all"} onChange={(origin) => onChange({ ...filters, origin })} options={[
      { value: "all", label: t("libraryFilters.allSources") },
      { value: "generated", label: t("libraryFilters.generated") },
      { value: "uploaded", label: t("libraryFilters.uploaded") },
      { value: "workspace", label: t("libraryFilters.projectFiles") },
      ...(assets.some((asset) => asset.origin === "builtin") ? [{ value: "builtin" as const, label: t("libraryFilters.builtIn") }] : []),
    ]} />
    <Select size="sm" label={t("libraryFilters.use")} value={filters.purpose ?? "all"} onChange={(purpose) => onChange({ ...filters, purpose })} options={[
      { value: "all", label: t("libraryFilters.allUses") },
      { value: "asset", label: t("libraryFilters.assets") },
      { value: "reference", label: t("libraryFilters.references") },
    ]} />
    <AssetPeriodSelect label={t("libraryFilters.modified")} value={filters.period} onChange={(period) => onChange({ ...filters, period })} />
  </>;
}

function librarySourceOptions(): { value: NonNullable<LibraryAssetFilters["origin"]>; label: string }[] {
  return [
    { value: "saved", label: t("libraryFilters.saved") },
    { value: "generated", label: t("libraryFilters.generated") },
    { value: "uploaded", label: t("libraryFilters.uploaded") },
    { value: "workspace", label: t("libraryFilters.fromProjects") },
    { value: "all", label: t("libraryFilters.allSources") },
  ];
}

function libraryProjectOptions(projects: readonly LibraryAssetProject[]): { value: string; label: string }[] {
  return [
    { value: "", label: t("libraryFilters.allProjects") },
    { value: "unassigned", label: t("libraryFilters.noProject") },
    ...projects.map((project) => ({ value: project.id, label: project.name })),
  ];
}

function AssetFilterPopover({ active, onReset, children }: { active: boolean; onReset: () => void; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number }>();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const titleId = `library-filters-${useId()}`;

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  useLayoutEffect(() => {
    if (!open) { setPosition(undefined); return; }
    const anchor = trigger.current?.getBoundingClientRect();
    const bounds = popup.current?.getBoundingClientRect();
    if (anchor && bounds) setPosition(menuPlacement(anchor, bounds, { width: window.innerWidth, height: window.innerHeight }, "end"));
  }, [open, active]);

  useLayoutEffect(() => {
    if (open && position && document.activeElement === trigger.current) popup.current?.querySelector("select")?.focus();
  }, [open, position]);

  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => {
      if (!popup.current?.contains(event.target as Node) && !trigger.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      event.stopImmediatePropagation();
      close();
    };
    const resize = () => setOpen(false);
    document.addEventListener("pointerdown", outside, true);
    window.addEventListener("keydown", escape, true);
    window.addEventListener("resize", resize);
    return () => {
      document.removeEventListener("pointerdown", outside, true);
      window.removeEventListener("keydown", escape, true);
      window.removeEventListener("resize", resize);
    };
  }, [open]);

  return <>
    <button ref={trigger} className={`library-filter-trigger${active ? " is-active" : ""}`} type="button" title={t("libraryFilters.filter")} aria-label={t("libraryFilters.filter")} aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((value) => !value)}>
      <SlidersHorizontal size={16} />{active ? <span className="library-filter-dot" /> : null}
    </button>
    {open ? createPortal(<div ref={popup} className="library-filter-popover" role="dialog" aria-labelledby={titleId} style={position ?? { top: 0, left: 0, visibility: "hidden" }}>
      <header><strong id={titleId}>{t("libraryFilters.filters")}</strong><button type="button" title={t("libraryFilters.close")} aria-label={t("libraryFilters.close")} onClick={close}><X size={14} /></button></header>
      {children}
      {active ? <button className="library-filter-reset" type="button" onClick={onReset}>{t("libraryFilters.reset")}</button> : null}
    </div>, document.body) : null}
  </>;
}
