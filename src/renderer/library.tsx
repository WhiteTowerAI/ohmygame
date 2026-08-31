import { Box, ExternalLink, Film, Image as ImageIcon, Layers3, LoaderCircle, Music2, Play, RefreshCw, Search, X } from "./icons.js";
import { useEffect, useMemo, useRef, useState } from "react";
import type { ProjectState, WorkspaceFile } from "../shared/contracts.js";
import { listProjects, listWorkspaceFiles, waitForRuntime } from "./api.js";
import { AppSidebar } from "./app-sidebar.js";
import { ModelPreview } from "./model-preview.js";
import type { SidebarPage } from "./routes.js";
import { useWorkspaceAssetUrl } from "./use-workspace-asset-url.js";

interface LibraryPageProps {
  onNavigate: (page: SidebarPage) => void;
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

  const visibleAssets = useMemo(() => filterLibraryAssets(assets, mediaFilter, query), [assets, mediaFilter, query]);

  return (
    <main className="home-shell">
      <AppSidebar active="library" onNavigate={onNavigate} />
      <section className="library-page library-content">
          <header className="library-header window-drag-handle">
            <h1>Library</h1>
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
          </header>
          {phase === "loading" && assets.length === 0 ? <LibraryState><LoaderCircle className="spin" size={18} />Loading assets</LibraryState> : null}
          {phase === "error" ? <LibraryState error><X size={18} />{error}<button type="button" onClick={() => void load()}><RefreshCw size={14} />Retry</button></LibraryState> : null}
          {phase === "ready" && visibleAssets.length === 0 ? <LibraryState><ImageIcon size={18} />{assets.length ? "No assets match these filters" : "No media assets yet"}</LibraryState> : null}
          {visibleAssets.length ? <div className="library-grid">{visibleAssets.map((asset) => <LibraryAssetCard asset={asset} key={`${asset.projectId}:${asset.path}`} onOpen={() => setSelectedAsset(asset)} />)}</div> : null}
      </section>
      {selectedAsset ? <LibraryAssetDialog asset={selectedAsset} onClose={() => setSelectedAsset(undefined)} onOpenProject={() => onOpenProject(selectedAsset.projectId)} /> : null}
    </main>
  );
}

function LibraryAssetCard({ asset, onOpen }: { asset: LibraryAsset; onOpen: () => void }) {
  return (
    <button className="library-asset-card" type="button" onClick={onOpen} title={`${asset.prompt ?? asset.path}\n${asset.projectName}`}>
      <LibraryAssetThumbnail asset={asset} />
      <div className="library-asset-info"><strong>{asset.prompt ?? fileName(asset.path)}</strong><span>{mediaTypeLabel(asset.mediaType)} · {asset.projectName}</span></div>
    </button>
  );
}

function LibraryAssetDialog({ asset, onClose, onOpenProject }: { asset: LibraryAsset; onClose: () => void; onOpenProject: () => void }) {
  const dialog = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  const preview = useWorkspaceAssetUrl(asset.projectId, asset.path);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.current?.focus();
    const handleKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
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
          <div><h2 id="library-dialog-title">{fileName(asset.path)}</h2><p>{asset.projectName}</p></div>
          <button type="button" onClick={onClose} aria-label="Close asset preview"><X size={17} /></button>
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
          <dl><div><dt>Path</dt><dd title={asset.path}>{asset.path}</dd></div><div><dt>Size</dt><dd>{fileSize(asset.size)}</dd></div></dl>
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
