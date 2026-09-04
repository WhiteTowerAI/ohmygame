import { useEffect, useMemo, useRef, useState } from "react";
import type { ExploreAsset, ProjectState } from "../shared/contracts.js";
import { addExploreAssetToProject, listExploreAssets, listProjects, waitForRuntime } from "./api.js";
import { AssetToolbar, fileName, fileSize, mediaTypeLabel, type MediaFilter } from "./asset-browser.js";
import { Box, Check, Film, Image as ImageIcon, LoaderCircle, Music2, Plus, RefreshCw, Search, X } from "./icons.js";
import { ModelPreview } from "./model-preview.js";
import { ProjectTypeIcon, projectTypeLabel } from "./project-types.js";
import type { AppNavigationTarget } from "./routes.js";
import { SidebarPageHeader, SidebarPageLayout } from "./sidebar-page.js";
import { useExploreAssetUrl } from "./use-explore-asset-url.js";
import { CommunityMeta, useCommunityUseRecorder } from "./community-meta.js";

export function ExploreAssetsPage({ onNavigate, onOpenProject }: {
  onNavigate: (page: AppNavigationTarget) => void;
  onOpenProject: (projectId: string) => void;
}) {
  const [assets, setAssets] = useState<ExploreAsset[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>("all");
  const [query, setQuery] = useState("");
  const [selected, setSelected] = useState<ExploreAsset>();

  async function load(): Promise<void> {
    setPhase("loading");
    setError(undefined);
    try {
      await waitForRuntime();
      setAssets(await listExploreAssets());
      setPhase("ready");
    } catch (cause) {
      setError(errorMessage(cause));
      setPhase("error");
    }
  }

  useEffect(() => { void load(); }, []);
  const normalized = query.trim().toLowerCase();
  const visible = useMemo(() => assets.filter((asset) => (
    (mediaFilter === "all" || asset.mediaType === mediaFilter) &&
    (!normalized || `${asset.title} ${asset.description} ${asset.fileName}`.toLowerCase().includes(normalized))
  )), [assets, mediaFilter, normalized]);

  return (
    <SidebarPageLayout active="assets" onNavigate={onNavigate}>
      <SidebarPageHeader title="Assets">
        <AssetToolbar mediaFilter={mediaFilter} query={query} onMediaFilterChange={setMediaFilter} onQueryChange={setQuery} />
      </SidebarPageHeader>
      {phase === "loading" && !assets.length ? <ExploreState><LoaderCircle className="spin" size={18} />Loading assets</ExploreState> : null}
      {phase === "error" ? <ExploreState><X size={18} />{error}<button type="button" onClick={() => void load()}><RefreshCw size={14} />Retry</button></ExploreState> : null}
      {phase === "ready" && !visible.length ? <ExploreState><ImageIcon size={18} />{assets.length ? "No assets match these filters" : "No shared assets yet"}</ExploreState> : null}
      {visible.length ? <div className="library-grid">{visible.map((asset) => <ExploreAssetCard asset={asset} key={asset.id} onOpen={() => setSelected(asset)} />)}</div> : null}
      {selected ? <ExploreAssetDialog asset={selected} onClose={() => setSelected(undefined)} onOpenProject={onOpenProject} /> : null}
    </SidebarPageLayout>
  );
}

function ExploreAssetCard({ asset, onOpen }: { asset: ExploreAsset; onOpen: () => void }) {
  const [visible, setVisible] = useState(false);
  const [previewFailed, setPreviewFailed] = useState(false);
  const target = useRef<HTMLElement>(null);
  const preview = useExploreAssetUrl(visible && asset.mediaType === "image" ? asset.id : undefined);
  const Icon = asset.mediaType === "video" ? Film : asset.mediaType === "audio" ? Music2 : asset.mediaType === "model" ? Box : ImageIcon;
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
  return <article className="library-asset-card" ref={target}>
    <button className="library-asset-card-open" type="button" onClick={onOpen} title={asset.title}>
      <div className="library-asset-thumbnail">
        {preview.url && asset.mediaType === "image" && !previewFailed ? <img src={preview.url} alt="" onError={() => setPreviewFailed(true)} /> : null}
        {asset.mediaType !== "image" || !preview.url || previewFailed ? <Icon size={28} /> : null}
        {asset.mediaType === "video" || asset.mediaType === "model" ? <span className="library-asset-type"><Icon size={11} />{mediaTypeLabel(asset.mediaType)}</span> : null}
      </div>
      <span className="library-asset-info"><strong>{asset.title}</strong><span>{mediaTypeLabel(asset.mediaType)}</span></span>
    </button>
  </article>;
}

function ExploreAssetDialog({ asset, onClose, onOpenProject }: {
  asset: ExploreAsset;
  onClose: () => void;
  onOpenProject: (projectId: string) => void;
}) {
  const preview = useExploreAssetUrl(asset.id);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectState[]>([]);
  const [query, setQuery] = useState("");
  const [phase, setPhase] = useState<"idle" | "loading" | "ready" | "adding" | "error">("idle");
  const [notice, setNotice] = useState<string>();
  const [addedProject, setAddedProject] = useState<ProjectState>();
  const dialog = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  const recordUse = useCommunityUseRecorder();
  onCloseRef.current = onClose;

  useEffect(() => {
    dialog.current?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (pickerOpen) setPickerOpen(false);
      else onCloseRef.current();
    };
    window.addEventListener("keydown", keyboard);
    return () => window.removeEventListener("keydown", keyboard);
  }, [pickerOpen]);

  async function openPicker(): Promise<void> {
    setPickerOpen(true);
    setPhase("loading");
    setNotice(undefined);
    try {
      setProjects(await listProjects());
      setPhase("ready");
    } catch (cause) {
      setNotice(errorMessage(cause));
      setPhase("error");
    }
  }

  async function add(project: ProjectState): Promise<void> {
    setPhase("adding");
    setNotice(undefined);
    try {
      await addExploreAssetToProject(project.id, asset.id);
      void recordUse("asset", asset.id).catch(() => undefined);
      setAddedProject(project);
      setPickerOpen(false);
      setNotice(`Added to ${project.name}`);
      setPhase("ready");
    } catch (cause) {
      setNotice(errorMessage(cause));
      setPhase("error");
    }
  }

  const normalized = query.trim().toLowerCase();
  const visibleProjects = projects.filter((project) => !normalized || project.name.toLowerCase().includes(normalized));
  return <div className="library-dialog-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
    <section className="library-dialog" ref={dialog} role="dialog" aria-modal="true" aria-labelledby="explore-asset-title" tabIndex={-1}>
      <header className="library-dialog-header">
        <div className="library-dialog-title"><h2 id="explore-asset-title">{asset.title}</h2><p><span>{asset.fileName}</span></p></div>
        <div className="library-dialog-header-actions"><button type="button" onClick={onClose} aria-label="Close asset preview"><X size={17} /></button></div>
      </header>
      <div className="library-dialog-preview">
        {!preview.url && !preview.error ? <span className="library-dialog-state"><LoaderCircle className="spin" size={18} />Loading asset</span> : null}
        {preview.error ? <span className="library-dialog-state library-dialog-error"><X size={18} />{preview.error}</span> : null}
        {preview.url && asset.mediaType === "image" ? <img src={preview.url} alt={asset.title} /> : null}
        {preview.url && asset.mediaType === "video" ? <video src={preview.url} controls preload="metadata" /> : null}
        {preview.url && asset.mediaType === "audio" ? <audio src={preview.url} controls /> : null}
        {preview.url && asset.mediaType === "model" ? <ModelPreview source={preview.url} label={asset.title} minHeight={420} /> : null}
      </div>
      <footer className="library-dialog-footer">
        <div><CommunityMeta type="asset" id={asset.id} author={asset.author} stats={asset.stats} useLabel="adds" /><dl><div><dt>Type</dt><dd>{mediaTypeLabel(asset.mediaType)}</dd></div><div><dt>Size</dt><dd>{fileSize(asset.artifactBytes)}</dd></div><div className="library-dialog-path"><dt>File</dt><dd>{fileName(asset.fileName)}</dd></div></dl></div>
        <div className="library-dialog-footer-actions">
          {notice ? <span role="status">{notice}</span> : null}
          {addedProject ? <button type="button" onClick={() => onOpenProject(addedProject.id)}><Check size={15} />Open project</button> : null}
          <button className="is-primary" type="button" onClick={() => void openPicker()}><Plus size={15} />Add to project</button>
          {pickerOpen ? <div className="asset-project-picker project-switcher-popover" role="dialog" aria-label="Add asset to project">
            <label className="project-switcher-search"><Search size={13} /><input value={query} placeholder="Search projects" onChange={(event) => setQuery(event.target.value)} /></label>
            <div className="project-switcher-list">
              {phase === "loading" ? <div className="project-switcher-state"><LoaderCircle className="spin" size={14} />Loading projects</div> : null}
              {phase === "adding" ? <div className="project-switcher-state"><LoaderCircle className="spin" size={14} />Adding asset</div> : null}
              {phase === "error" ? <div className="project-switcher-state is-error">{notice}</div> : null}
              {phase === "ready" ? visibleProjects.map((project) => <button className="project-switcher-item" type="button" key={project.id} onClick={() => void add(project)}><ProjectTypeIcon type={project.type} /><span><strong>{project.name}</strong><small>{projectTypeLabel(project.type)}</small></span></button>) : null}
              {phase === "ready" && !visibleProjects.length ? <div className="project-switcher-state">No matching projects</div> : null}
            </div>
          </div> : null}
        </div>
      </footer>
    </section>
  </div>;
}

function ExploreState({ children }: { children: React.ReactNode }) {
  return <div className="library-state">{children}</div>;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
