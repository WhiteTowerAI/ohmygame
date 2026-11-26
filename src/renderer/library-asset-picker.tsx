import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { LoaderCircle, Search, Upload, X } from "./icons.js";
import type { LibraryAssetProject, LibraryUploadMediaType } from "../shared/contracts.js";
import { filterLibraryAssets, type LibraryAsset, type LibraryAssetFilters } from "./library-assets.js";
import { LibraryCollectionFilters } from "./library-filters.js";
import { uploadLibraryAsset } from "./api.js";
import { readMediaFileDuration } from "./video-reference-files.js";
import { useNearViewport } from "./asset-gallery.js";
import { AssetThumbnail, assetTypeBadge } from "./asset-browser.js";
import { Tabs } from "./ui/index.js";
import { t } from "./i18n.js";

/** The Library picker the canvases share, and the Library upload behind it. */
export function LibraryAssetPicker({ title, assets, projectId, project, uploading, includeReferences = false, libraryTab = false, multiple, onUpload, onClose, onSelect }: {
  title: string;
  assets: readonly LibraryAsset[];
  /** Limits the initial view to assets associated with the current project. */
  projectId?: string;
  /** Keeps the current project available in the filter even before it has assets. */
  project?: LibraryAssetProject;
  /** Offers Upload next to the Library, for a new file instead. */
  onUpload?: () => void;
  uploading?: boolean;
  includeReferences?: boolean;
  /**
   * Opens on what the Library page shows, the assets saved to it from any
   * project, with a second tab for the project's own media as filtered here.
   */
  libraryTab?: boolean;
  /** Picks several: items toggle, and the footer's button hands over the picks once there are at least `min`. */
  multiple?: { min: number; max: number; action: (count: number) => string; onSubmit: (assets: LibraryAsset[]) => void };
  onClose: () => void;
  onSelect?: (asset: LibraryAsset) => void;
}) {
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<LibraryAsset[]>([]);
  const toggle = (asset: LibraryAsset) => setPicked((current) => current.some((item) => item.id === asset.id)
    ? current.filter((item) => item.id !== asset.id)
    : current.length >= (multiple?.max ?? Infinity) ? current : [...current, asset]);
  const [filters, setFilters] = useState<LibraryAssetFilters>({ includeReferences, ...(projectId ? { projectId } : {}) });
  const [scope, setScope] = useState<"library" | "project">(libraryTab ? "library" : "project");
  const inLibrary = scope === "library";
  const saved = useMemo(() => assets.filter((asset) => asset.saved), [assets]);
  const dialog = useRef<HTMLElement>(null);
  // Parents may pass a fresh onClose each render; depending on it would re-run this effect and steal focus from search.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    dialog.current?.focus();
    // Captured first, like ui/ overlays, so a dialog this opens over keeps its Escape.
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onCloseRef.current(); } };
    document.addEventListener("keydown", closeOnEscape, true);
    return () => document.removeEventListener("keydown", closeOnEscape, true);
  }, []);

  const visibleAssets = useMemo(() => inLibrary
    // As the Library page lists them: every saved asset, references too.
    ? filterLibraryAssets(saved, "all", query, { origin: "all", includeReferences: true })
    : filterLibraryAssets(assets, "all", query, filters), [inLibrary, query, saved, assets, filters]);

  return createPortal(
    <div className="canvas-video-picker-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className={libraryTab ? "canvas-video-picker has-scopes" : "canvas-video-picker"} ref={dialog} role="dialog" aria-modal="true" aria-labelledby="canvas-video-picker-title" tabIndex={-1}>
        <header>
          <h2 id="canvas-video-picker-title">{title}</h2>
          {onUpload ? <button type="button" className="canvas-video-picker-upload" disabled={uploading} onClick={onUpload}>{uploading ? <LoaderCircle className="spin" size={14} /> : <Upload size={14} />}<span>{t("assetCanvas.upload")}</span></button> : null}
          <button type="button" aria-label={t("nodeWorkbench.closePicker")} onClick={onClose}><X size={16} /></button>
        </header>
        {libraryTab ? <div className="library-picker-scopes"><Tabs variant="pills" label={t("nodeWorkbench.scopes")} value={scope} onChange={setScope} tabs={[
          { value: "library", label: t("nodeWorkbench.libraryTab") },
          { value: "project", label: t("nodeWorkbench.projectTab") },
        ]} /></div> : null}
        <div className="library-picker-toolbar"><label><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("nodeWorkbench.searchLibrary")} /></label>
          {inLibrary ? null : <LibraryCollectionFilters assets={assets} filters={filters} onChange={setFilters} defaultIncludeReferences={includeReferences} defaultProjectId={projectId} defaultProject={project} />}
        </div>
        <div className="canvas-video-picker-list">
          {visibleAssets.length === 0 ? <p>{(inLibrary ? saved : assets).length ? t("nodeWorkbench.noMatch") : inLibrary ? t("nodeWorkbench.libraryEmpty") : t("nodeWorkbench.empty")}</p> : null}
          {visibleAssets.map((asset) => <LibraryPickerItem key={asset.id} asset={asset} {...(multiple ? { selected: picked.some((item) => item.id === asset.id) } : {})} onSelect={() => multiple ? toggle(asset) : onSelect?.(asset)} />)}
        </div>
        {multiple ? <footer className="library-picker-footer">
          <span>{t("nodeWorkbench.pickedCount", { count: picked.length, max: multiple.max })}</span>
          <button type="button" disabled={picked.length < multiple.min} onClick={() => multiple.onSubmit(picked)}>{multiple.action(picked.length)}</button>
        </footer> : null}
      </section>
    </div>,
    document.body,
  );
}

/** One Library asset in the picker: the Library's own thumbnail, loaded once it scrolls near view, and its name. */
function LibraryPickerItem({ asset, selected, onSelect }: { asset: LibraryAsset; selected?: boolean; onSelect: () => void }) {
  const [item, visible] = useNearViewport<HTMLButtonElement>();
  const badge = assetTypeBadge(asset.mediaType);
  const title = asset.prompt ?? asset.name;
  return <button type="button" ref={item} onClick={onSelect} title={title} aria-pressed={selected} className={selected ? "is-selected" : undefined}>
    <span className="canvas-video-picker-thumbnail">
      <AssetThumbnail asset={asset} visible={visible} />
      {badge ? <span className="canvas-video-picker-badge">{badge}</span> : null}
    </span>
    <span><strong>{title}</strong>{asset.prompt ? <small>{asset.name}</small> : null}{asset.referenceOnly || asset.projects?.length ? <small>{asset.referenceOnly ? t("assets.reference") : ""}{asset.projects?.length === 1 ? `${asset.referenceOnly ? " · " : ""}${asset.projects[0]!.name}` : asset.projects?.length ? `${asset.referenceOnly ? " · " : ""}${t("nodeWorkbench.projectCount", { count: asset.projects.length })}` : ""}</small> : null}</span>
  </button>;
}

/** Uploads a media file to the Library, with the limits every editor shares. */
export async function uploadLibraryFile(file: File): Promise<LibraryAsset> {
  const mediaType = libraryUploadMediaType(file);
  if (!mediaType) throw new Error(t("nodeWorkbench.uploadTypes"));
  if (file.size > 200 * 1024 * 1024) throw new Error(t("assetCanvas.uploadSize"));
  const kind = mediaType.startsWith("video/") ? "video" : mediaType.startsWith("audio/") ? "audio" : undefined;
  const duration = kind ? await readMediaFileDuration(file, kind) : undefined;
  const uploaded = await uploadLibraryAsset(file, mediaType, { duration });
  return { ...uploaded, assetId: uploaded.id, path: uploaded.name };
}

function libraryUploadMediaType(file: File): LibraryUploadMediaType | undefined {
  const extension = file.name.split(".").pop()?.toLowerCase();
  if (extension === "png") return "image/png";
  if (extension === "jpg" || extension === "jpeg") return "image/jpeg";
  if (extension === "webp") return "image/webp";
  if (extension === "mp4") return "video/mp4";
  if (extension === "mov") return "video/quicktime";
  if (extension === "webm") return "video/webm";
  if (extension === "mp3") return "audio/mpeg";
  if (extension === "wav") return "audio/wav";
  return undefined;
}
