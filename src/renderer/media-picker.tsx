import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Spinner, Search, Upload, X } from "./icons.js";
import type { ProjectState } from "../shared/contracts.js";
import { mediaFileInfo } from "../shared/media-files.js";
import { listProjects, listWorkspaceFiles } from "./api.js";
import { useNearViewport } from "./asset-gallery.js";
import { AssetThumbnail, assetTypeBadge, fileName, type BrowsableAsset } from "./asset-browser.js";
import { Button, IconButton, Select } from "./ui/index.js";
import { t } from "./i18n.js";

/** A media file in a project, as the picker offers it. */
export interface ProjectMedia extends BrowsableAsset {
  projectId: string;
  contentType?: string;
}

/**
 * The media picker the canvases share: the project's media, or another
 * project's, and the upload behind it. A reference sent in a conversation is
 * offered only with `includeReferences`.
 */
export function MediaPicker({ title, projectId, accept, includeReferences = false, uploading, multiple, onUpload, onClose, onSelect }: {
  title: string;
  /** The project it opens on; the others are a choice away. */
  projectId: string;
  /** The files it offers; every media file when absent. */
  accept?: (file: ProjectMedia) => boolean;
  includeReferences?: boolean;
  /** Offers Upload beside the media, for a new file instead. */
  onUpload?: () => void;
  uploading?: boolean;
  /** Picks several: items toggle, and the footer's button hands over the picks once there are at least `min`. */
  multiple?: { min: number; max: number; action: (count: number) => string; onSubmit: (files: ProjectMedia[]) => void };
  onClose: () => void;
  onSelect?: (file: ProjectMedia) => void;
}) {
  const [query, setQuery] = useState("");
  const [shown, setShown] = useState(projectId);
  const [projects, setProjects] = useState<ProjectState[]>([]);
  const [listing, setListing] = useState<{ projectId: string; files?: ProjectMedia[]; error?: string }>();
  const [picked, setPicked] = useState<ProjectMedia[]>([]);
  const same = (left: ProjectMedia, right: ProjectMedia) => left.projectId === right.projectId && left.path === right.path;
  const toggle = (file: ProjectMedia) => setPicked((current) => current.some((item) => same(item, file))
    ? current.filter((item) => !same(item, file))
    : current.length >= (multiple?.max ?? Infinity) ? current : [...current, file]);
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

  useEffect(() => {
    let stopped = false;
    void listProjects().then((list) => {
      if (!stopped) setProjects(list.filter((project) => project.workspaceAvailable !== false).sort((left, right) => right.updatedAt.localeCompare(left.updatedAt)));
    }, () => undefined);
    return () => { stopped = true; };
  }, []);

  useEffect(() => {
    let stopped = false;
    setListing({ projectId: shown });
    void listWorkspaceFiles(shown).then((files) => {
      if (stopped) return;
      const media = files.flatMap((file): ProjectMedia[] => file.mediaType && !file.directory && (includeReferences || file.purpose !== "reference")
        ? [{ ...file, mediaType: file.mediaType, projectId: shown, contentType: mediaFileInfo(file.path)?.contentType }]
        : []);
      setListing({ projectId: shown, files: media.sort((left, right) => (right.modifiedAt ?? "").localeCompare(left.modifiedAt ?? "")) });
    }, (cause: unknown) => {
      if (!stopped) setListing({ projectId: shown, error: cause instanceof Error ? cause.message : String(cause) });
    });
    return () => { stopped = true; };
  }, [shown, includeReferences]);

  const offered = useMemo(() => (listing?.files ?? []).filter((file) => accept?.(file) ?? true), [listing, accept]);
  const visible = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized ? offered.filter((file) => `${file.path} ${file.prompt ?? ""}`.toLowerCase().includes(normalized)) : offered;
  }, [offered, query]);

  return createPortal(
    <div className="canvas-video-picker-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="canvas-video-picker" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="canvas-video-picker-title" tabIndex={-1}>
        <header>
          <h2 id="canvas-video-picker-title">{title}</h2>
          {onUpload ? <Button size="sm" className="canvas-video-picker-upload" disabled={uploading} icon={uploading ? <Spinner size="sm" /> : <Upload size="sm" />} onClick={onUpload}>{t("assetCanvas.upload")}</Button> : null}
          <IconButton size="sm" label={t("libraryPicker.closePicker")} onClick={onClose}><X size="md" /></IconButton>
        </header>
        <div className="library-picker-toolbar">
          <label><Search size="sm" /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("libraryPicker.search")} /></label>
          {projects.length > 1 ? <Select size="sm" label={t("libraryFilters.project")} value={shown} onChange={setShown}
            options={projects.map((project) => ({ value: project.id, label: project.id === projectId ? t("libraryPicker.thisProject", { name: project.name }) : project.name }))} /> : null}
        </div>
        <div className="canvas-video-picker-list">
          {!listing?.files && !listing?.error ? <p><Spinner size="sm" /></p> : null}
          {listing?.error ? <p role="alert">{listing.error}</p> : null}
          {listing?.files && visible.length === 0 ? <p>{offered.length ? t("libraryPicker.noMatch") : t("libraryPicker.empty")}</p> : null}
          {visible.map((file) => <MediaPickerItem key={file.path} file={file} {...(multiple ? { selected: picked.some((item) => same(item, file)) } : {})} onSelect={() => multiple ? toggle(file) : onSelect?.(file)} />)}
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

/** One file in the picker: its thumbnail, loaded once it scrolls near view, and its name. */
function MediaPickerItem({ file, selected, onSelect }: { file: ProjectMedia; selected?: boolean; onSelect: () => void }) {
  const [item, visible] = useNearViewport<HTMLButtonElement>(file.mediaType !== "model");
  const badge = assetTypeBadge(file.mediaType);
  const name = fileName(file.path);
  const title = file.prompt ?? name;
  return <button type="button" ref={item} onClick={onSelect} title={title} aria-pressed={selected} className={selected ? "is-selected" : undefined}>
    <span className="canvas-video-picker-thumbnail">
      <AssetThumbnail asset={file} visible={visible} large={false} />
      {badge ? <span className="canvas-video-picker-badge">{badge}</span> : null}
    </span>
    <span><strong>{title}</strong>{file.prompt ? <small>{name}</small> : null}</span>
  </button>;
}
