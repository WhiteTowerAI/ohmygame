import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Box, ChevronRight, Film, Image as ImageIcon, LoaderCircle, Music2, Search, Upload, X } from "./icons.js";
import type { LibraryUploadMediaType } from "../shared/contracts.js";
import type { LibraryAsset } from "./library-assets.js";
import { uploadLibraryAsset } from "./api.js";
import { readMediaFileDuration } from "./video-reference-files.js";

/**
 * Workbench pieces for the Playable Nodes editor: a breadcrumb back to the
 * canvas, a scaled preview frame, and the Library picker.
 */
export function WorkbenchBreadcrumb({ label, onClose, onRename }: {
  label: string;
  onClose: () => void;
  /** Makes the label an editable title. */
  onRename?: (label: string) => void;
}) {
  return <nav className="story-node-editor-breadcrumb" aria-label="Breadcrumb">
    <button type="button" onClick={onClose}>Canvas</button>
    <ChevronRight size={12} aria-hidden="true" />
    {onRename ? <BreadcrumbTitle value={label} onCommit={onRename} /> : <strong>{label}</strong>}
  </nav>;
}

function BreadcrumbTitle({ value, onCommit }: { value: string; onCommit: (value: string) => void }) {
  const [draft, setDraft] = useState(value);
  // Esc blurs too; the blur that follows must not save the discarded draft.
  const cancelled = useRef(false);
  useEffect(() => setDraft(value), [value]);
  const commit = () => {
    const next = draft.trim();
    if (!cancelled.current && next && next !== value) onCommit(next);
    else setDraft(value);
    cancelled.current = false;
  };
  return <input
    className="story-node-editor-breadcrumb-title"
    aria-label="Title"
    title="Rename"
    value={draft}
    maxLength={120}
    spellCheck={false}
    onChange={(event) => setDraft(event.target.value)}
    onBlur={commit}
    onKeyDown={(event) => {
      if (event.key === "Enter") event.currentTarget.blur();
      if (event.key === "Escape") {
        cancelled.current = true;
        event.currentTarget.blur();
      }
    }}
  />;
}

/** Scales a fixed-size stage to fit its frame while keeping the viewport ratio. */
export function WorkbenchPreview({ ariaLabel, viewport, stageClassName, actions, overlay, children }: {
  ariaLabel: string;
  viewport: { width: number; height: number };
  stageClassName?: string;
  /** Controls shown in the preview header, after the label. */
  actions?: ReactNode;
  /** Floats over the preview frame, such as a tool bar. */
  overlay?: ReactNode;
  children: ReactNode;
}) {
  const frame = useRef<HTMLDivElement>(null);
  const [stageSize, setStageSize] = useState<{ width: number; height: number }>();

  useLayoutEffect(() => {
    const container = frame.current;
    if (!container) return;
    const update = () => {
      const scale = Math.min(container.clientWidth / viewport.width, container.clientHeight / viewport.height);
      setStageSize({ width: Math.max(1, viewport.width * scale), height: Math.max(1, viewport.height * scale) });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, [viewport.height, viewport.width]);

  return <section className="story-workbench-preview" aria-label={ariaLabel}>
    <header><strong>Live Preview</strong>{actions ? <div className="story-workbench-preview-actions">{actions}</div> : null}</header>
    <div ref={frame} className="story-workbench-preview-frame">
      <div className={`story-workbench-preview-stage${stageClassName ? ` ${stageClassName}` : ""}`} style={stageSize}>
        {children}
      </div>
    </div>
    {/* Outside the frame, which clips the scaled stage, so shadows and popovers are not cut off. */}
    {overlay}
  </section>;
}

export function LibraryAssetPicker({ title, assets, uploading, onUpload, onClose, onSelect }: {
  title: string;
  assets: readonly LibraryAsset[];
  /** Offers Upload next to the Library, for a new file instead. */
  onUpload?: () => void;
  uploading?: boolean;
  onClose: () => void;
  onSelect: (asset: LibraryAsset) => void;
}) {
  const [query, setQuery] = useState("");
  const dialog = useRef<HTMLElement>(null);

  useEffect(() => {
    dialog.current?.focus();
    const closeOnEscape = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    window.addEventListener("keydown", closeOnEscape);
    return () => window.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);

  const visibleAssets = useMemo(() => {
    const normalized = query.trim().toLowerCase();
    return normalized
      ? assets.filter((asset) => `${asset.name} ${asset.prompt ?? ""}`.toLowerCase().includes(normalized))
      : assets;
  }, [query, assets]);

  return createPortal(
    <div className="story-video-picker-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="story-video-picker" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="story-video-picker-title" tabIndex={-1}>
        <header>
          <h2 id="story-video-picker-title">{title}</h2>
          {onUpload ? <button type="button" className="story-video-picker-upload" disabled={uploading} onClick={onUpload}>{uploading ? <LoaderCircle className="spin" size={14} /> : <Upload size={14} />}<span>Upload</span></button> : null}
          <button type="button" aria-label="Close Library picker" onClick={onClose}><X size={16} /></button>
        </header>
        <label><Search size={14} /><input value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search Library" /></label>
        <div className="story-video-picker-list">
          {visibleAssets.length === 0 ? <p>{assets.length ? "No assets match your search" : "No assets in Library"}</p> : null}
          {visibleAssets.map((asset) => {
            const Icon = asset.mediaType === "video" ? Film : asset.mediaType === "audio" ? Music2 : asset.mediaType === "model" ? Box : ImageIcon;
            return <button type="button" key={asset.id} onClick={() => onSelect(asset)}>
              <span><Icon size={17} /></span>
              <span><strong>{asset.prompt ?? asset.name}</strong><small>{asset.name}</small></span>
            </button>;
          })}
        </div>
      </section>
    </div>,
    document.body,
  );
}

/** Uploads a media file to the Library, with the limits every editor shares. */
export async function uploadLibraryFile(file: File): Promise<LibraryAsset> {
  const mediaType = libraryUploadMediaType(file);
  if (!mediaType) throw new Error("Upload a PNG, JPEG, WebP, MP4, MOV, WebM, MP3, or WAV file.");
  if (file.size > 200 * 1024 * 1024) throw new Error("The upload must be no larger than 200 MB.");
  const kind = mediaType.startsWith("video/") ? "video" : mediaType.startsWith("audio/") ? "audio" : undefined;
  const duration = kind ? await readMediaFileDuration(file, kind) : undefined;
  const uploaded = await uploadLibraryAsset(file, mediaType, duration);
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
