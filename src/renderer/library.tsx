import { Box, ExternalLink, Film, Image as ImageIcon, Layers3, LoaderCircle, MoreHorizontal, Music2, Play, RefreshCw, Search, X } from "./icons.js";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectState, WorkspaceFile } from "../shared/contracts.js";
import { deleteAsset, listProjects, listWorkspaceFiles, renameAsset, waitForRuntime } from "./api.js";
import { ModelPreview } from "./model-preview.js";
import type { AppNavigationTarget, SidebarPage } from "./routes.js";
import { SidebarPageHeader, SidebarPageLayout } from "./sidebar-page.js";
import { useWorkspaceAssetUrl } from "./use-workspace-asset-url.js";

interface LibraryPageProps {
  onNavigate: (page: AppNavigationTarget) => void;
  onOpenProject: (projectId: string) => void;
}

type MediaFilter = "all" | NonNullable<WorkspaceFile["mediaType"]>;

export interface LibraryAsset extends Omit<WorkspaceFile, "mediaType"> {
  mediaType: NonNullable<WorkspaceFile["mediaType"]>;
  projectId: string;
  projectName: string;
  projectUpdatedAt: string;
}

const MEDIA_FILTERS: readonly { id: MediaFilter; label: string; icon: typeof Layers3 }[] = [
  { id: "all", label: "All assets", icon: Layers3 },
  { id: "image", label: "Images", icon: ImageIcon },
  { id: "video", label: "Videos", icon: Film },
  { id: "audio", label: "Audio", icon: Music2 },
  { id: "model", label: "3D models", icon: Box },
];

export function LibraryPage({ onNavigate, onOpenProject }: LibraryPageProps) {
  const [assets, setAssets] = useState<LibraryAsset[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedAsset, setSelectedAsset] = useState<LibraryAsset>();

  async function load(): Promise<void> {
    setPhase("loading");
    setError(undefined);
    try {
      await waitForRuntime();
      const loadedProjects = await listProjects();
      const results = await Promise.allSettled(loadedProjects.map(async (project) => ({
        project,
        files: (await listWorkspaceFiles(project.id)).filter(hasMediaType),
      })));
      const loaded = results.flatMap((result) => result.status === "fulfilled"
        ? result.value.files.map((file) => toLibraryAsset(result.value.project, file))
        : []);
      if (loadedProjects.length > 0 && results.every((result) => result.status === "rejected")) {
        throw results[0]?.status === "rejected" ? results[0].reason : new Error("Could not load project assets");
      }
      setAssets(loaded.sort(compareAssets));
      setPhase("ready");
    } catch (cause) {
      setError(errorMessage(cause));
      setPhase("error");
    }
  }

  useEffect(() => { void load(); }, []);

  async function runAssetAction(action: () => Promise<unknown>): Promise<void> {
    setActionError(undefined);
    try {
      await action();
      await load();
    } catch (cause) {
      setActionError(errorMessage(cause));
    }
  }

  function rename(asset: LibraryAsset): boolean {
    const extension = fileExtension(asset.path);
    const name = window.prompt(`Rename asset (${extension} is preserved)`, fileStem(asset.path))?.trim();
    if (!name || name === fileStem(asset.path)) return false;
    void runAssetAction(() => renameAsset(asset.projectId, asset.path, name));
    return true;
  }

  function remove(asset: LibraryAsset): boolean {
    if (!window.confirm(`Delete “${fileName(asset.path)}” from ${asset.projectName}? This may break references in the project and cannot be undone.`)) return false;
    void runAssetAction(() => deleteAsset(asset.projectId, asset.path));
    return true;
  }

  const visibleAssets = useMemo(() => filterLibraryAssets(assets, mediaFilter, query), [assets, mediaFilter, query]);

  return (
    <SidebarPageLayout active="library" onNavigate={onNavigate}>
      <SidebarPageHeader title="Library">
        <div className="library-toolbar">
          <nav className="library-filters" aria-label="Media types">
            {MEDIA_FILTERS.map(({ id, label, icon: Icon }) => (
              <button className={mediaFilter === id ? "is-active" : undefined} type="button" key={id} aria-pressed={mediaFilter === id} onClick={() => setMediaFilter(id)}>
                <Icon size={15} /><span>{label}</span>
              </button>
            ))}
          </nav>
          <label className="library-search" htmlFor="library-search-input">
            <Search size={14} aria-hidden="true" />
            <input id="library-search-input" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="Search assets" />
          </label>
        </div>
      </SidebarPageHeader>
      {actionError ? <p className="library-action-error" role="alert">{actionError}</p> : null}
      {phase === "loading" && assets.length === 0 ? <LibraryState><LoaderCircle className="spin" size={18} />Loading assets</LibraryState> : null}
      {phase === "error" ? <LibraryState error><X size={18} />{error}<button type="button" onClick={() => void load()}><RefreshCw size={14} />Retry</button></LibraryState> : null}
      {phase === "ready" && visibleAssets.length === 0 ? <LibraryState><ImageIcon size={18} />{assets.length ? "No assets match these filters" : "No media assets yet"}</LibraryState> : null}
      {visibleAssets.length ? <div className="library-grid">{visibleAssets.map((asset) => <LibraryAssetCard asset={asset} key={`${asset.projectId}:${asset.path}`} onOpen={() => setSelectedAsset(asset)} onRename={() => rename(asset)} onDelete={() => remove(asset)} />)}</div> : null}
      {selectedAsset ? <LibraryAssetDialog
        asset={selectedAsset}
        onClose={() => setSelectedAsset(undefined)}
        onOpenProject={() => onOpenProject(selectedAsset.projectId)}
        onRename={() => { if (rename(selectedAsset)) setSelectedAsset(undefined); }}
        onDelete={() => { if (remove(selectedAsset)) setSelectedAsset(undefined); }}
      /> : null}
    </SidebarPageLayout>
  );
}

function LibraryAssetCard({ asset, onOpen, onRename, onDelete }: { asset: LibraryAsset; onOpen: () => void; onRename: () => void; onDelete: () => void }) {
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
      <button className="library-asset-card-open" type="button" onClick={onOpen} title={`${asset.prompt ?? asset.path}\n${asset.projectName}`}>
        <LibraryAssetThumbnail asset={asset} />
        <span className="library-asset-info"><strong>{asset.prompt ?? fileName(asset.path)}</strong><span>{mediaTypeLabel(asset.mediaType)} · {asset.projectName}</span></span>
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

function LibraryAssetDialog({ asset, onClose, onOpenProject, onRename, onDelete }: {
  asset: LibraryAsset;
  onClose: () => void;
  onOpenProject: () => void;
  onRename: () => void;
  onDelete: () => void;
}) {
  const [menuOpen, setMenuOpen] = useState(false);
  const dialog = useRef<HTMLElement>(null);
  const actions = useRef<HTMLDivElement>(null);
  const onCloseRef = useRef(onClose);
  const menuOpenRef = useRef(menuOpen);
  const preview = useWorkspaceAssetUrl(asset.projectId, asset.path);
  onCloseRef.current = onClose;
  menuOpenRef.current = menuOpen;

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
        if (menuOpenRef.current) {
          setMenuOpen(false);
          return;
        }
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog.current) return;
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>(
        "button:not(:disabled), [href], audio[controls], video[controls], [tabindex]:not([tabindex='-1'])",
      )];
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
      <section className="library-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="library-dialog-title" tabIndex={-1}>
        <header className="library-dialog-header">
          <div className="library-dialog-title">
            <h2 id="library-dialog-title" title={asset.prompt ?? fileName(asset.path)}>{asset.prompt ?? fileName(asset.path)}</h2>
            <p><span title={fileName(asset.path)}>{fileName(asset.path)}</span><span>{asset.projectName}</span></p>
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
        <div className={`library-dialog-preview library-dialog-${asset.mediaType}`}>
          {!preview.url && !preview.error ? <span className="library-dialog-state"><LoaderCircle className="spin" size={18} />Loading asset</span> : null}
          {preview.error ? <span className="library-dialog-state library-dialog-error" role="alert"><X size={18} />{preview.error}</span> : null}
          {preview.url && asset.mediaType === "image" ? <img src={preview.url} alt={fileName(asset.path)} /> : null}
          {preview.url && asset.mediaType === "video" ? <video src={preview.url} controls preload="metadata" /> : null}
          {preview.url && asset.mediaType === "audio" ? <audio src={preview.url} controls /> : null}
          {preview.url && asset.mediaType === "model" ? <ModelPreview source={preview.url} label={fileName(asset.path)} minHeight={420} /> : null}
        </div>
        <footer className="library-dialog-footer">
          <dl>
            <div><dt>Type</dt><dd>{mediaTypeLabel(asset.mediaType)}</dd></div>
            <div><dt>Size</dt><dd>{fileSize(asset.size)}</dd></div>
            <div><dt>Project</dt><dd title={asset.projectName}>{asset.projectName}</dd></div>
            <div className="library-dialog-path"><dt>Path</dt><dd title={asset.path}>{asset.path}</dd></div>
          </dl>
          <button type="button" onClick={onOpenProject}><ExternalLink size={15} />Open project</button>
        </footer>
      </section>
    </div>
  );
}

function LibraryAssetThumbnail({ asset }: { asset: LibraryAsset }) {
  const [visible, setVisible] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const target = useRef<HTMLDivElement>(null);
  const previewPath = asset.mediaType === "image" || asset.mediaType === "video"
    ? asset.path
    : asset.mediaType === "model"
    ? asset.previewPath
    : undefined;
  const preview = useWorkspaceAssetUrl(visible && previewPath ? asset.projectId : undefined, previewPath ?? asset.path);
  const showPreview = Boolean(preview.url) && !previewFailed;
  const FallbackIcon = asset.mediaType === "video"
    ? Film
    : asset.mediaType === "audio"
    ? Music2
    : asset.mediaType === "model"
    ? Box
    : preview.error || previewFailed
    ? X
    : ImageIcon;
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
    <div className={`library-asset-thumbnail library-asset-${asset.mediaType}`} ref={target}>
      {showPreview && asset.mediaType === "video" ? <video src={preview.url} muted playsInline preload="metadata" onError={() => setPreviewFailed(true)} onLoadedMetadata={(event) => { event.currentTarget.currentTime = 0.01; }} /> : null}
      {showPreview && asset.mediaType !== "video" ? <img src={preview.url} alt="" onError={() => setPreviewFailed(true)} /> : null}
      {!showPreview ? <FallbackIcon size={FallbackIcon === X ? 22 : 28} /> : null}
      {TypeIcon && typeLabel ? <span className="library-asset-type" aria-hidden="true"><TypeIcon size={11} />{typeLabel}</span> : null}
    </div>
  );
}

export function filterLibraryAssets(assets: LibraryAsset[], media: MediaFilter, query: string): LibraryAsset[] {
  const normalizedQuery = query.trim().toLowerCase();
  return assets.filter((asset) => (
    (media === "all" || asset.mediaType === media) &&
    (!normalizedQuery || `${asset.path} ${asset.prompt ?? ""} ${asset.projectName}`.toLowerCase().includes(normalizedQuery))
  ));
}

function LibraryState({ children, error = false }: { children: React.ReactNode; error?: boolean }) {
  return <div className={`library-state${error ? " library-state-error" : ""}`} role={error ? "alert" : undefined}>{children}</div>;
}

function hasMediaType(file: WorkspaceFile): file is WorkspaceFile & { mediaType: NonNullable<WorkspaceFile["mediaType"]> } {
  return file.mediaType !== undefined;
}

function toLibraryAsset(project: ProjectState, file: WorkspaceFile & { mediaType: NonNullable<WorkspaceFile["mediaType"]> }): LibraryAsset {
  return { ...file, projectId: project.id, projectName: project.name, projectUpdatedAt: project.updatedAt };
}

function compareAssets(left: LibraryAsset, right: LibraryAsset): number {
  return right.projectUpdatedAt.localeCompare(left.projectUpdatedAt) || left.projectName.localeCompare(right.projectName) || left.path.localeCompare(right.path);
}

function fileName(filePath: string): string {
  return filePath.split("/").at(-1) ?? filePath;
}

function fileExtension(filePath: string): string {
  const name = fileName(filePath);
  const index = name.lastIndexOf(".");
  return index > 0 ? name.slice(index) : "";
}

function fileStem(filePath: string): string {
  const name = fileName(filePath);
  const extension = fileExtension(filePath);
  return extension ? name.slice(0, -extension.length) : name;
}

function mediaTypeLabel(mediaType: LibraryAsset["mediaType"]): string {
  if (mediaType === "model") return "3D model";
  return mediaType[0]?.toUpperCase() + mediaType.slice(1);
}

function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
