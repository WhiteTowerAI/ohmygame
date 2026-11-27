import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Spinner, Search, Upload, X } from "./icons.js";
import type { LibraryAssetProject, LibraryUploadMediaType } from "../shared/contracts.js";
import { filterLibraryAssets, type LibraryAsset, type LibraryAssetFilters } from "./library-assets.js";
import { LibraryCollectionFilters } from "./library-filters.js";
import { uploadLibraryAsset } from "./api.js";
import { readMediaFileDuration } from "./video-reference-files.js";
import { useNearViewport } from "./asset-gallery.js";
import { AssetThumbnail, assetTypeBadge } from "./asset-browser.js";
import { Button, IconButton } from "./ui/index.js";
import { t } from "./i18n.js";

/** The media picker the canvases share: the project's media and other projects', and the upload behind it. */
export function LibraryAssetPicker({ title, assets, projectId, project, uploading, includeReferences = false, multiple, onUpload, onClose, onSelect }: {
  title: string;
  assets: readonly LibraryAsset[];
  /** Limits the initial view to assets associated with the current project. */
  projectId?: string;
  /** Keeps the current project available in the filter even before it has assets. */
  project?: LibraryAssetProject;
  /** Offers Upload beside the media, for a new file instead. */
  onUpload?: () => void;
  uploading?: boolean;
  includeReferences?: boolean;
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

  const visibleAssets = useMemo(() => filterLibraryAssets(assets, "all", query, filters), [query, assets, filters]);

  return createPortal(
    <div className="canvas-video-picker-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="canvas-video-picker" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="canvas-video-picker-title" tabIndex={-1}>
        <header>
          <h2 id="canvas-video-picker-title">{title}</h2>
          {onUpload ? <Button size="sm" className="canvas-video-picker-upload" disabled={uploading} icon={uploading ? <Spinner size="sm" /> : <Upload size="sm" />} onClick={onUpload}>{t("assetCanvas.upload")}</Button> : null}
          <IconButton size="sm" label={t("libraryPicker.closePicker")} onClick={onClose}><X size="md" /></IconButton>
        </header>
        <div className="library-picker-toolbar"><label><Search size="sm" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("libraryPicker.search")} /></label>
          <LibraryCollectionFilters assets={assets} filters={filters} onChange={setFilters} defaultIncludeReferences={includeReferences} defaultProjectId={projectId} defaultProject={project} />
        </div>
        <div className="canvas-video-picker-list">
          {visibleAssets.length === 0 ? <p>{assets.length ? t("libraryPicker.noMatch") : t("libraryPicker.empty")}</p> : null}
          {visibleAssets.map((asset) => <LibraryPickerItem key={asset.id} asset={asset} {...(multiple ? { selected: picked.some((item) => item.id === asset.id) } : {})} onSelect={() => multiple ? toggle(asset) : onSelect?.(asset)} />)}
        </div>
        {multiple ? <footer className="library-picker-footer">
          <span>{t("libraryPicker.pickedCount", { count: picked.length, max: multiple.max })}</span>
          <Button variant="primary" disabled={picked.length < multiple.min} onClick={() => multiple.onSubmit(picked)}>{multiple.action(picked.length)}</Button>
        </footer> : null}
      </section>
    </div>,
    document.body,
  );
}

/** One asset in the picker: its thumbnail, loaded once it scrolls near view, and its name. */
function LibraryPickerItem({ asset, selected, onSelect }: { asset: LibraryAsset; selected?: boolean; onSelect: () => void }) {
  const [item, visible] = useNearViewport<HTMLButtonElement>(asset.mediaType !== "model");
  const badge = assetTypeBadge(asset.mediaType);
  const title = asset.prompt ?? asset.name;
  return <button type="button" ref={item} onClick={onSelect} title={title} aria-pressed={selected} className={selected ? "is-selected" : undefined}>
    <span className="canvas-video-picker-thumbnail">
      <AssetThumbnail asset={asset} visible={visible} large={false} />
      {badge ? <span className="canvas-video-picker-badge">{badge}</span> : null}
    </span>
    <span><strong>{title}</strong>{asset.prompt ? <small>{asset.name}</small> : null}{asset.referenceOnly || asset.projects?.length ? <small>{asset.referenceOnly ? t("assets.reference") : ""}{asset.projects?.length === 1 ? `${asset.referenceOnly ? " · " : ""}${asset.projects[0]!.name}` : asset.projects?.length ? `${asset.referenceOnly ? " · " : ""}${t("libraryPicker.projectCount", { count: asset.projects.length })}` : ""}</small> : null}</span>
  </button>;
}

/** Uploads a media file to the store projects share, with the limits every editor shares. */
export async function uploadLibraryFile(file: File): Promise<LibraryAsset> {
  const mediaType = libraryUploadMediaType(file);
  if (!mediaType) throw new Error(t("libraryPicker.uploadTypes"));
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
