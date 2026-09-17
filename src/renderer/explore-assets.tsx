import { useEffect, useMemo, useState } from "react";
import type { ExploreAsset, ProjectState } from "../shared/contracts.js";
import type { CommunityStats } from "../shared/publish-v1.js";
import { addExploreAssetToProject, listExploreAssets, listProjects, waitForRuntime } from "./api.js";
import { AssetToolbar, fileName, fileSize, mediaTypeLabel, type MediaFilter } from "./asset-browser.js";
import { Box, Check, Film, Image as ImageIcon, LoaderCircle, Music2, Plus, RefreshCw, Search, X } from "./icons.js";
import { ProjectTypeIcon, projectTypeLabel } from "./project-types.js";
import type { AppNavigationTarget } from "./routes.js";
import { SidebarPageHeader, SidebarPageLayout } from "./sidebar-page.js";
import { useExploreAssetUrl } from "./use-explore-asset-url.js";
import { CommunityAuthorView, CommunityLikeButton, CommunityMeta, useCommunityLike, useCommunityUseRecorder } from "./community-meta.js";
import { AssetCardShell, AssetDialogShell, AssetMedia, useNearViewport } from "./asset-gallery.js";

export function ExploreAssetsPage({ onNavigate, onOpenProject }: {
  onNavigate: (page: AppNavigationTarget) => void;
  onOpenProject: (projectId: string) => void;
}) {
  const [assets, setAssets] = useState<ExploreAsset[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedId, setSelectedId] = useState<string>();

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
  const selected = assets.find((asset) => asset.id === selectedId);

  function updateStats(id: string, stats: CommunityStats): void {
    setAssets((assets) => assets.map((asset) => asset.id === id ? { ...asset, stats } : asset));
  }

  return (
    <SidebarPageLayout active="assets" onNavigate={onNavigate}>
      <SidebarPageHeader title="Assets">
        <AssetToolbar mediaFilter={mediaFilter} query={query} onMediaFilterChange={setMediaFilter} onQueryChange={setQuery} />
      </SidebarPageHeader>
      {phase === "loading" && !assets.length ? <ExploreState><LoaderCircle className="spin" size={18} />Loading assets</ExploreState> : null}
      {phase === "error" ? <ExploreState><X size={18} />{error}<button type="button" onClick={() => void load()}><RefreshCw size={14} />Retry</button></ExploreState> : null}
      {phase === "ready" && !visible.length ? <ExploreState><ImageIcon size={18} />{assets.length ? "No assets match these filters" : "No shared assets yet"}</ExploreState> : null}
      {visible.length ? <div className="library-grid">{visible.map((asset) => <ExploreAssetCard asset={asset} key={asset.id} onOpen={() => setSelectedId(asset.id)} onStatsChange={(stats) => updateStats(asset.id, stats)} />)}</div> : null}
      {selected ? <ExploreAssetDialog asset={selected} onClose={() => setSelectedId(undefined)} onOpenProject={onOpenProject} onStatsChange={(stats) => updateStats(selected.id, stats)} /> : null}
    </SidebarPageLayout>
  );
}

function ExploreAssetCard({ asset, onOpen, onStatsChange }: { asset: ExploreAsset; onOpen: () => void; onStatsChange: (stats: CommunityStats) => void }) {
  const [previewFailed, setPreviewFailed] = useState(false);
  const [target, visible] = useNearViewport<HTMLElement>();
  const preview = useExploreAssetUrl(visible && asset.mediaType === "image" ? asset.id : undefined);
  const Icon = asset.mediaType === "video" ? Film : asset.mediaType === "audio" ? Music2 : asset.mediaType === "model" ? Box : ImageIcon;
  return <AssetCardShell
    title={asset.title}
    preview={<>{preview.url && asset.mediaType === "image" && !previewFailed ? <img src={preview.url} alt="" onError={() => setPreviewFailed(true)} /> : null}{asset.mediaType !== "image" || !preview.url || previewFailed ? <Icon size={28} /> : null}</>}
    badge={<><Icon size={11} />{mediaTypeLabel(asset.mediaType)}</>}
    footer={<CommunityMeta className="library-asset-card-meta" type="asset" id={asset.id} author={asset.author} stats={asset.stats} useLabel="adds" onStatsChange={onStatsChange} />}
    className="explore-asset-card"
    articleRef={target}
    onOpen={onOpen}
  />;
}

function ExploreAssetDialog({ asset, onClose, onOpenProject, onStatsChange }: {
  asset: ExploreAsset;
  onClose: () => void;
  onOpenProject: (projectId: string) => void;
  onStatsChange: (stats: CommunityStats) => void;
}) {
  const preview = useExploreAssetUrl(asset.id);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectState[]>([]);
  const [query, setQuery] = useState("");
  const [phase, setPhase] = useState<"idle" | "loading" | "ready" | "adding" | "error">("idle");
  const [notice, setNotice] = useState<string>();
  const [addedProject, setAddedProject] = useState<ProjectState>();
  const recordUse = useCommunityUseRecorder();
  const like = useCommunityLike("asset", asset.id, asset.stats, onStatsChange);

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
      void recordUse("asset", asset.id).then((stats) => { if (stats) onStatsChange(stats); }).catch(() => undefined);
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
  return <AssetDialogShell
    title={asset.title}
    subtitle={<span>{asset.description || asset.fileName}</span>}
    labelledBy="explore-asset-title"
    onClose={onClose}
    onEscape={() => { if (pickerOpen) setPickerOpen(false); else onClose(); }}
    preview={<>
        {!preview.url && !preview.error ? <span className="library-dialog-state"><LoaderCircle className="spin" size={18} />Loading asset</span> : null}
        {preview.error ? <span className="library-dialog-state library-dialog-error"><X size={18} />{preview.error}</span> : null}
        {preview.url ? <AssetMedia type={asset.mediaType} url={preview.url} label={asset.title} /> : null}
      </>}
    footer={<footer className="library-dialog-footer">
        <div><div className="explore-asset-detail-author"><CommunityAuthorView author={asset.author} /><span>{like.counts.uses} adds</span></div><dl><div><dt>Type</dt><dd>{mediaTypeLabel(asset.mediaType)}</dd></div><div><dt>Size</dt><dd>{fileSize(asset.artifactBytes)}</dd></div><div className="library-dialog-path"><dt>File</dt><dd>{fileName(asset.fileName)}</dd></div></dl></div>
        <div className="library-dialog-footer-actions">
          {notice ? <span role="status">{notice}</span> : null}
          {addedProject ? <button type="button" onClick={() => onOpenProject(addedProject.id)}><Check size={15} />Open project</button> : null}
          <CommunityLikeButton busy={like.busy} count={like.counts.likes} liked={like.liked} showLabel onToggle={() => void like.toggle()} />
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
      </footer>}
  />;
}

function ExploreState({ children }: { children: React.ReactNode }) {
  return <div className="library-state">{children}</div>;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
