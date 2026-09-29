import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Box, ChevronRight, Film, Image as ImageIcon, Music2, PanelToggle, Search, X } from "./icons.js";
import type { LibraryUploadMediaType } from "../shared/contracts.js";
import type { LibraryAsset } from "./library-assets.js";
import { uploadLibraryAsset } from "./api.js";
import { readMediaFileDuration } from "./video-reference-files.js";

/**
 * Workbench pieces shared by the story editor and the Playable Nodes editor: a
 * breadcrumb back to the canvas, a large preview with a resizable, collapsible
 * inspector, a scaled preview frame, and the Library picker.
 */
export function WorkbenchBreadcrumb({ label, onClose }: { label: string; onClose: () => void }) {
  return <nav className="story-node-editor-breadcrumb" aria-label="Breadcrumb"><button type="button" onClick={onClose}>Canvas</button><ChevronRight size={12} aria-hidden="true" /><strong>{label}</strong></nav>;
}

export function NodeWorkbenchLayout({ className, preview, inspector, timeline }: {
  className: string;
  preview: ReactNode;
  inspector: ReactNode;
  timeline: ReactNode;
}) {
  const [inspectorOpen, setInspectorOpen] = useState(true);
  const [inspectorWidth, setInspectorWidth] = useState(340);
  const workbench = useRef<HTMLDivElement>(null);
  const resize = useRef<{ pointerId: number } | undefined>(undefined);

  function constrainedInspectorWidth(clientX: number): number {
    const bounds = workbench.current?.getBoundingClientRect();
    if (!bounds) return inspectorWidth;
    const maximum = Math.max(280, Math.min(480, bounds.width - 420));
    return Math.round(Math.max(280, Math.min(maximum, bounds.right - clientX - 5)));
  }

  function finishResize(target: HTMLDivElement, pointerId: number, clientX: number): void {
    if (resize.current?.pointerId !== pointerId) return;
    if (target.hasPointerCapture(pointerId)) target.releasePointerCapture(pointerId);
    const width = constrainedInspectorWidth(clientX);
    workbench.current?.style.setProperty("--story-workbench-inspector-width", `${width}px`);
    workbench.current?.classList.remove("is-resizing-inspector");
    resize.current = undefined;
    setInspectorWidth(width);
  }

  return <div
    ref={workbench}
    className={`story-node-workbench ${className}${inspectorOpen ? " has-inspector" : " is-inspector-collapsed"}${timeline ? " has-timeline" : ""}`}
    style={{ "--story-workbench-inspector-width": `${inspectorWidth}px` } as CSSProperties}
  >
    <div className="story-node-workbench-stage">
      <div className="story-node-workbench-preview">{preview}</div>
      {inspectorOpen ? <div
        className="story-node-workbench-resizer"
        role="separator"
        aria-label="Resize inspector"
        aria-orientation="vertical"
        tabIndex={0}
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          event.preventDefault();
          const next = Math.max(280, Math.min(480, inspectorWidth + (event.key === "ArrowLeft" ? 16 : -16)));
          setInspectorWidth(next);
        }}
        onPointerDown={(event) => {
          if (event.button !== 0) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          resize.current = { pointerId: event.pointerId };
          workbench.current?.classList.add("is-resizing-inspector");
        }}
        onPointerMove={(event) => {
          if (resize.current?.pointerId !== event.pointerId) return;
          workbench.current?.style.setProperty("--story-workbench-inspector-width", `${constrainedInspectorWidth(event.clientX)}px`);
        }}
        onPointerUp={(event) => finishResize(event.currentTarget, event.pointerId, event.clientX)}
        onPointerCancel={(event) => finishResize(event.currentTarget, event.pointerId, event.clientX)}
        onLostPointerCapture={() => {
          workbench.current?.classList.remove("is-resizing-inspector");
          resize.current = undefined;
        }}
      /> : null}
      {inspectorOpen ? <div className="story-node-workbench-inspector">{inspector}</div> : null}
      <button
        className="story-node-workbench-inspector-toggle"
        type="button"
        title={inspectorOpen ? "Hide inspector" : "Show inspector"}
        aria-label={inspectorOpen ? "Hide inspector" : "Show inspector"}
        aria-expanded={inspectorOpen}
        onClick={() => setInspectorOpen((open) => !open)}
      ><PanelToggle size={15} /></button>
    </div>
    {timeline ? <div className="story-node-workbench-timeline">{timeline}</div> : null}
  </div>;
}

/** Scales a fixed-size stage to fit its frame while keeping the viewport ratio. */
export function WorkbenchPreview({ label = "Live Preview", ariaLabel, viewport, stageClassName, actions, footer, children }: {
  label?: string;
  ariaLabel: string;
  viewport: { width: number; height: number };
  stageClassName?: string;
  /** Controls shown in the preview header, after the label. */
  actions?: ReactNode;
  /** Content below the preview frame, such as recent Signals and errors. */
  footer?: ReactNode;
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

  return <section className={`story-workbench-preview${footer ? " has-footer" : ""}`} aria-label={ariaLabel}>
    <header><strong>{label}</strong>{actions ? <div className="story-workbench-preview-actions">{actions}</div> : null}<span>{viewport.width} x {viewport.height}</span></header>
    <div ref={frame} className="story-workbench-preview-frame">
      <div className={`story-workbench-preview-stage${stageClassName ? ` ${stageClassName}` : ""}`} style={stageSize}>
        {children}
      </div>
    </div>
    {footer ? <div className="story-workbench-preview-footer">{footer}</div> : null}
  </section>;
}

export function LibraryAssetPicker({ title, assets, onClose, onSelect }: {
  title: string;
  assets: readonly LibraryAsset[];
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
        <header><h2 id="story-video-picker-title">{title}</h2><button type="button" aria-label="Close Library picker" onClick={onClose}><X size={16} /></button></header>
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

export function libraryUploadMediaType(file: File): LibraryUploadMediaType | undefined {
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
