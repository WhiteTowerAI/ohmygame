import { useEffect, useId, useRef, useState } from "react";
import type { WorkspaceFile } from "../shared/contracts.js";
import { Box, ExternalLink, Film, Image as ImageIcon, Layers3, LoaderCircle, MoreHorizontal, Music2, Play, Search, X } from "./icons.js";
import { useWorkspaceAssetUrl } from "./use-workspace-asset-url.js";
import { AssetCardShell, AssetDialogShell, AssetMedia, useNearViewport } from "./asset-gallery.js";
import { ModelPreview } from "./model-preview.js";

export type MediaFilter = "all" | NonNullable<WorkspaceFile["mediaType"]>;

export interface BrowsableAsset extends Omit<WorkspaceFile, "mediaType"> {
  mediaType: NonNullable<WorkspaceFile["mediaType"]>;
  projectId?: string;
  assetId?: string;
  projectName?: string;
  revision?: number;
}

const MEDIA_FILTERS: readonly { id: MediaFilter; label: string; icon: typeof Layers3 }[] = [
  { id: "all", label: "All assets", icon: Layers3 },
  { id: "image", label: "Images", icon: ImageIcon },
  { id: "video", label: "Videos", icon: Film },
  { id: "audio", label: "Audio", icon: Music2 },
  { id: "model", label: "3D models", icon: Box },
];

export function AssetToolbar({ mediaFilter, query, onMediaFilterChange, onQueryChange }: {
  mediaFilter: MediaFilter;
  query: string;
  onMediaFilterChange: (filter: MediaFilter) => void;
  onQueryChange: (query: string) => void;
}) {
  const searchId = `asset-search-${useId()}`;
  return (
    <div className="library-toolbar">
      <nav className="library-filters" aria-label="Media types">
        {MEDIA_FILTERS.map(({ id, label, icon: Icon }) => (
          <button className={mediaFilter === id ? "is-active" : undefined} type="button" key={id} aria-pressed={mediaFilter === id} onClick={() => onMediaFilterChange(id)}>
            <Icon size={15} /><span>{label}</span>
          </button>
        ))}
      </nav>
      <label className="library-search" htmlFor={searchId}>
        <Search size={14} aria-hidden="true" />
        <input id={searchId} value={query} onChange={(event) => onQueryChange(event.target.value)} placeholder="Search assets" />
      </label>
    </div>
  );
}

export function WorkspaceAssetCard({ asset, onOpen, onRename, onDelete }: {
  asset: BrowsableAsset;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const [card, visible] = useNearViewport<HTMLElement>();
  const preview = useWorkspaceAssetUrl(visible && asset.mediaType !== "audio" ? asset.projectId : undefined, asset.path, asset.revision, visible ? asset.assetId : undefined);
  const showPreview = Boolean(preview.url) && !previewFailed;
  const FallbackIcon = asset.mediaType === "video" ? Film : asset.mediaType === "audio" ? Music2 : asset.mediaType === "model" ? Box : preview.error || previewFailed ? X : ImageIcon;
  const TypeIcon = asset.mediaType === "video" ? Play : asset.mediaType === "model" ? Box : undefined;
  const typeLabel = asset.mediaType === "video" ? "Video" : asset.mediaType === "model" ? "3D" : undefined;

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (!card.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [menuOpen]);

  return <AssetCardShell
    title={asset.prompt ?? fileName(asset.path)}
    subtitle={<>{mediaTypeLabel(asset.mediaType)}{asset.projectName ? ` · ${asset.projectName}` : ""}</>}
    preview={<>
      {showPreview && asset.mediaType === "video" ? <video src={preview.url} muted playsInline preload="metadata" onError={() => setPreviewFailed(true)} onLoadedMetadata={(event) => { event.currentTarget.currentTime = 0.01; }} /> : null}
      {showPreview && asset.mediaType === "image" ? <img src={preview.url} alt="" onError={() => setPreviewFailed(true)} /> : null}
      {preview.url && !previewFailed && asset.mediaType === "model" ? <ModelPreview source={preview.url} label={fileName(asset.path)} interactive={false} /> : null}
      {!showPreview && visible && asset.mediaType === "model" && !preview.error ? <LoaderCircle className="spin" size={18} /> : null}
      {!showPreview && (!visible || asset.mediaType !== "model" || preview.error) ? <FallbackIcon size={FallbackIcon === X ? 22 : 28} /> : null}
    </>}
    badge={TypeIcon && typeLabel ? <><TypeIcon size={11} />{typeLabel}</> : undefined}
    actions={<div className="library-asset-actions">
        <button className="library-asset-menu" type="button" aria-label={`Asset actions for ${fileName(asset.path)}`} aria-expanded={menuOpen} aria-haspopup="menu" onClick={() => setMenuOpen((open) => !open)}><MoreHorizontal size={16} /></button>
        {menuOpen ? <div className="library-asset-actions-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onRename(); }}>Rename</button>
          <button className="library-action-delete" type="button" role="menuitem" onClick={() => { setMenuOpen(false); onDelete(); }}>Delete</button>
        </div> : null}
      </div>}
    articleRef={card}
    onOpen={onOpen}
  />;
}

export function WorkspaceAssetDialog({ asset, onClose, onOpenProject, onRename, onDelete }: {
  asset: BrowsableAsset;
  onClose: () => void;
  onOpenProject?: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const actions = useRef<HTMLDivElement>(null);
  const preview = useWorkspaceAssetUrl(asset.projectId, asset.path, asset.revision, asset.assetId);
  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (!actions.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  return <AssetDialogShell
    title={asset.prompt ?? fileName(asset.path)}
    subtitle={<><span title={fileName(asset.path)}>{fileName(asset.path)}</span>{asset.projectName ? <span>{asset.projectName}</span> : null}</>}
    labelledBy="asset-dialog-title"
    onClose={onClose}
    onEscape={() => { if (menuOpen) setMenuOpen(false); else onClose(); }}
    headerActionsRef={actions}
    headerActions={<>
      <button type="button" aria-label={`Asset actions for ${fileName(asset.path)}`} aria-expanded={menuOpen} aria-haspopup="menu" onClick={() => setMenuOpen((open) => !open)}><MoreHorizontal size={17} /></button>
      {menuOpen ? <div className="library-dialog-actions-menu" role="menu">
        <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onRename(); }}>Rename</button>
        <button className="library-action-delete" type="button" role="menuitem" onClick={() => { setMenuOpen(false); onDelete(); }}>Delete</button>
      </div> : null}
    </>}
    preview={<>
          {!preview.url && !preview.error ? <span className="library-dialog-state"><LoaderCircle className="spin" size={18} />Loading asset</span> : null}
          {preview.error ? <span className="library-dialog-state library-dialog-error" role="alert"><X size={18} />{preview.error}</span> : null}
          {preview.url ? <AssetMedia type={asset.mediaType} url={preview.url} label={fileName(asset.path)} /> : null}
        </>}
    footer={<footer className={`library-dialog-footer${onOpenProject ? "" : " library-dialog-footer-compact"}`}>
          <dl>
            <div><dt>Type</dt><dd>{mediaTypeLabel(asset.mediaType)}</dd></div>
            <div><dt>Size</dt><dd>{fileSize(asset.size)}</dd></div>
            {asset.projectName ? <div><dt>Project</dt><dd title={asset.projectName}>{asset.projectName}</dd></div> : null}
            <div className="library-dialog-path"><dt>Path</dt><dd title={asset.path}>{asset.path}</dd></div>
          </dl>
          <div className="library-dialog-footer-actions">
            {onOpenProject ? <button type="button" onClick={onOpenProject}><ExternalLink size={15} />Open project</button> : null}
          </div>
        </footer>}
  />;
}

export function filterAssets<T extends BrowsableAsset>(assets: T[], media: MediaFilter, query: string): T[] {
  const normalizedQuery = query.trim().toLowerCase();
  return assets.filter((asset) => (
    (media === "all" || asset.mediaType === media) &&
    (!normalizedQuery || `${asset.path} ${asset.prompt ?? ""} ${asset.projectName ?? ""}`.toLowerCase().includes(normalizedQuery))
  ));
}

export function hasMediaType(file: WorkspaceFile): file is WorkspaceFile & { mediaType: NonNullable<WorkspaceFile["mediaType"]> } {
  return file.mediaType !== undefined;
}

export function fileName(filePath: string): string {
  return filePath.split("/").at(-1) ?? filePath;
}

export function fileExtension(filePath: string): string {
  const name = fileName(filePath);
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index) : "";
}

export function fileStem(filePath: string): string {
  const name = fileName(filePath);
  const extension = fileExtension(filePath);
  return extension ? name.slice(0, -extension.length) : name;
}

export function mediaTypeLabel(mediaType: BrowsableAsset["mediaType"]): string {
  if (mediaType === "model") return "3D model";
  return mediaType[0]?.toUpperCase() + mediaType.slice(1);
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
