import { useEffect, useId, useRef, useState } from "react";
import type { WorkspaceFile } from "../shared/contracts.js";
import { Box, ExternalLink, Film, Image as ImageIcon, Layers3, LoaderCircle, MoreHorizontal, Music2, Play, Search, X } from "./icons.js";
import { ModelPreview } from "./model-preview.js";
import { useWorkspaceAssetUrl } from "./use-workspace-asset-url.js";
import { publishAsset } from "./api.js";
import { useAuth } from "./auth.js";

export type MediaFilter = "all" | NonNullable<WorkspaceFile["mediaType"]>;

export interface BrowsableAsset extends Omit<WorkspaceFile, "mediaType"> {
  mediaType: NonNullable<WorkspaceFile["mediaType"]>;
  projectId: string;
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

export function AssetCard({ asset, onOpen, onRename, onDelete }: {
  asset: BrowsableAsset;
  onOpen: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const card = useRef<HTMLElement>(null);

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

  return (
    <article className="library-asset-card" ref={card}>
      <button className="library-asset-card-open" type="button" onClick={onOpen} title={asset.prompt ?? asset.path}>
        <AssetThumbnail asset={asset} />
        <span className="library-asset-info">
          <strong>{asset.prompt ?? fileName(asset.path)}</strong>
          <span>{mediaTypeLabel(asset.mediaType)}{asset.projectName ? ` · ${asset.projectName}` : ""}</span>
        </span>
      </button>
      <div className="library-asset-actions">
        <button className="library-asset-menu" type="button" aria-label={`Asset actions for ${fileName(asset.path)}`} aria-expanded={menuOpen} aria-haspopup="menu" onClick={() => setMenuOpen((open) => !open)}><MoreHorizontal size={16} /></button>
        {menuOpen ? <div className="library-asset-actions-menu" role="menu">
          <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onRename(); }}>Rename</button>
          <button className="library-action-delete" type="button" role="menuitem" onClick={() => { setMenuOpen(false); onDelete(); }}>Delete</button>
        </div> : null}
      </div>
    </article>
  );
}

export function AssetDetailDialog({ asset, onClose, onOpenProject, onRename, onDelete }: {
  asset: BrowsableAsset;
  onClose: () => void;
  onOpenProject?: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const actions = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const menuOpenRef = useRef(menuOpen);
  const preview = useWorkspaceAssetUrl(asset.projectId, asset.path, asset.revision);
  const auth = useAuth();
  const [sharing, setSharing] = useState(false);
  const [shareNotice, setShareNotice] = useState<string>();
  onCloseRef.current = onClose;
  menuOpenRef.current = menuOpen;

  async function share(): Promise<void> {
    setShareNotice(undefined);
    const accessToken = await auth.requestAccessToken();
    if (!accessToken) return;
    setSharing(true);
    try {
      await publishAsset(asset.projectId, asset.path, accessToken);
      setShareNotice("Shared to Explore");
    } catch (cause) {
      setShareNotice(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSharing(false);
    }
  }

  useEffect(() => {
    if (!menuOpen) return;
    const close = (event: MouseEvent) => {
      if (!actions.current?.contains(event.target as Node)) setMenuOpen(false);
    };
    document.addEventListener("mousedown", close);
    return () => document.removeEventListener("mousedown", close);
  }, [menuOpen]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.current?.focus();
    const handleKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (menuOpenRef.current) setMenuOpen(false);
        else onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog.current) return;
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>("button:not(:disabled), [href], audio[controls], video[controls], [tabindex]:not([tabindex='-1'])")];
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (document.activeElement === dialog.current) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyboard);
    return () => {
      window.removeEventListener("keydown", handleKeyboard);
      previousFocus?.focus();
    };
  }, []);

  return (
    <div className="library-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="library-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="asset-dialog-title" tabIndex={-1}>
        <header className="library-dialog-header">
          <div className="library-dialog-title">
            <h2 id="asset-dialog-title" title={asset.prompt ?? fileName(asset.path)}>{asset.prompt ?? fileName(asset.path)}</h2>
            <p><span title={fileName(asset.path)}>{fileName(asset.path)}</span>{asset.projectName ? <span>{asset.projectName}</span> : null}</p>
          </div>
          <div className="library-dialog-header-actions" ref={actions}>
            <button type="button" aria-label={`Asset actions for ${fileName(asset.path)}`} aria-expanded={menuOpen} aria-haspopup="menu" onClick={() => setMenuOpen((open) => !open)}><MoreHorizontal size={17} /></button>
            {menuOpen ? <div className="library-dialog-actions-menu" role="menu">
              <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onRename(); }}>Rename</button>
              <button className="library-action-delete" type="button" role="menuitem" onClick={() => { setMenuOpen(false); onDelete(); }}>Delete</button>
            </div> : null}
            <button type="button" onClick={onClose} aria-label="Close asset preview"><X size={17} /></button>
          </div>
        </header>
        <div className="library-dialog-preview">
          {!preview.url && !preview.error ? <span className="library-dialog-state"><LoaderCircle className="spin" size={18} />Loading asset</span> : null}
          {preview.error ? <span className="library-dialog-state library-dialog-error" role="alert"><X size={18} />{preview.error}</span> : null}
          {preview.url && asset.mediaType === "image" ? <img src={preview.url} alt={fileName(asset.path)} /> : null}
          {preview.url && asset.mediaType === "video" ? <video src={preview.url} controls preload="metadata" /> : null}
          {preview.url && asset.mediaType === "audio" ? <audio src={preview.url} controls /> : null}
          {preview.url && asset.mediaType === "model" ? <ModelPreview source={preview.url} label={fileName(asset.path)} minHeight={420} /> : null}
        </div>
        <footer className={`library-dialog-footer${onOpenProject ? "" : " library-dialog-footer-compact"}`}>
          <dl>
            <div><dt>Type</dt><dd>{mediaTypeLabel(asset.mediaType)}</dd></div>
            <div><dt>Size</dt><dd>{fileSize(asset.size)}</dd></div>
            {asset.projectName ? <div><dt>Project</dt><dd title={asset.projectName}>{asset.projectName}</dd></div> : null}
            <div className="library-dialog-path"><dt>Path</dt><dd title={asset.path}>{asset.path}</dd></div>
          </dl>
          <div className="library-dialog-footer-actions">
            {shareNotice ? <span role="status">{shareNotice}</span> : null}
            {onOpenProject ? <button type="button" onClick={onOpenProject}><ExternalLink size={15} />Open project</button> : null}
            <button className="is-primary" type="button" disabled={sharing} onClick={() => void share()}>{sharing ? <LoaderCircle className="spin" size={15} /> : null}{sharing ? "Sharing" : "Share"}</button>
          </div>
        </footer>
      </section>
    </div>
  );
}

function AssetThumbnail({ asset }: { asset: BrowsableAsset }) {
  const [visible, setVisible] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const target = useRef<HTMLDivElement>(null);
  const previewPath = asset.mediaType === "image" || asset.mediaType === "video" ? asset.path : asset.mediaType === "model" ? asset.previewPath : undefined;
  const preview = useWorkspaceAssetUrl(visible && previewPath ? asset.projectId : undefined, previewPath ?? asset.path, asset.revision);
  const showPreview = Boolean(preview.url) && !previewFailed;
  const FallbackIcon = asset.mediaType === "video" ? Film : asset.mediaType === "audio" ? Music2 : asset.mediaType === "model" ? Box : preview.error || previewFailed ? X : ImageIcon;
  const TypeIcon = asset.mediaType === "video" ? Play : asset.mediaType === "model" ? Box : undefined;
  const typeLabel = asset.mediaType === "video" ? "Video" : asset.mediaType === "model" ? "3D" : undefined;

  useEffect(() => {
    const node = target.current;
    if (!node || typeof IntersectionObserver === "undefined") {
      setVisible(true);
      return;
    }
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry?.isIntersecting) return;
      setVisible(true);
      observer.disconnect();
    }, { rootMargin: "160px" });
    observer.observe(node);
    return () => observer.disconnect();
  }, []);

  return (
    <div className="library-asset-thumbnail" ref={target}>
      {showPreview && asset.mediaType === "video" ? <video src={preview.url} muted playsInline preload="metadata" onError={() => setPreviewFailed(true)} onLoadedMetadata={(event) => { event.currentTarget.currentTime = 0.01; }} /> : null}
      {showPreview && asset.mediaType !== "video" ? <img src={preview.url} alt="" onError={() => setPreviewFailed(true)} /> : null}
      {!showPreview ? <FallbackIcon size={FallbackIcon === X ? 22 : 28} /> : null}
      {TypeIcon && typeLabel ? <span className="library-asset-type" aria-hidden="true"><TypeIcon size={11} />{typeLabel}</span> : null}
    </div>
  );
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
