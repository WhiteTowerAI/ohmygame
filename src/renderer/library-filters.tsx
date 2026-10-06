import { useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { SlidersHorizontal, X } from "./icons.js";
import { libraryAssetProjects, type LibraryAsset, type LibraryAssetFilters } from "./library-assets.js";
import { menuPlacement } from "./popover-placement.js";

export function LibraryCollectionFilters({ assets, filters, onChange, defaultIncludeReferences = false }: {
  assets: readonly LibraryAsset[];
  filters: LibraryAssetFilters;
  onChange: (filters: LibraryAssetFilters) => void;
  defaultIncludeReferences?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [position, setPosition] = useState<{ top: number; left: number }>();
  const trigger = useRef<HTMLButtonElement>(null);
  const popup = useRef<HTMLDivElement>(null);
  const titleId = `library-filters-${useId()}`;
  const projects = libraryAssetProjects(assets);
  const active = (filters.origin ?? "saved") !== "saved" || Boolean(filters.projectId) || (filters.includeReferences ?? false) !== defaultIncludeReferences;

  function close() {
    setOpen(false);
    trigger.current?.focus();
  }

  useLayoutEffect(() => {
    if (!open) { setPosition(undefined); return; }
    const anchor = trigger.current?.getBoundingClientRect();
    const bounds = popup.current?.getBoundingClientRect();
    if (anchor && bounds) setPosition(menuPlacement(anchor, bounds, { width: window.innerWidth, height: window.innerHeight }, "end"));
    if (!position) popup.current?.querySelector("select")?.focus();
  }, [open, active, projects.length]);

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
    <button ref={trigger} className={`library-filter-trigger${active ? " is-active" : ""}`} type="button" title="Filter assets" aria-label="Filter assets" aria-expanded={open} aria-haspopup="dialog" onClick={() => setOpen((value) => !value)}>
      <SlidersHorizontal size={16} />{active ? <span className="library-filter-dot" /> : null}
    </button>
    {open ? createPortal(<div ref={popup} className="library-filter-popover" role="dialog" aria-labelledby={titleId} style={position ?? { top: 0, left: 0, visibility: "hidden" }}>
      <header><strong id={titleId}>Filters</strong><button type="button" title="Close filters" aria-label="Close filters" onClick={close}><X size={14} /></button></header>
      <label>Source<select value={filters.origin ?? "saved"} onChange={(event) => onChange({ ...filters, origin: event.target.value as LibraryAssetFilters["origin"] })}>
        <option value="saved">Library</option>
        <option value="generated">Generated</option>
        <option value="uploaded">Uploaded</option>
        <option value="workspace">From projects</option>
        <option value="all">All sources</option>
      </select></label>
      <label>Project<select value={filters.projectId ?? ""} onChange={(event) => onChange({ ...filters, projectId: event.target.value })}>
        <option value="">All projects</option>
        <option value="unassigned">No project</option>
        {projects.map((project) => <option key={project.id} value={project.id}>{project.name}</option>)}
      </select></label>
      <label className="library-reference-toggle"><input type="checkbox" checked={filters.includeReferences ?? false} onChange={(event) => onChange({ ...filters, includeReferences: event.target.checked })} /><span>Include references</span></label>
      {active ? <button className="library-filter-reset" type="button" onClick={() => onChange({ includeReferences: defaultIncludeReferences })}>Reset filters</button> : null}
    </div>, document.body) : null}
  </>;
}
