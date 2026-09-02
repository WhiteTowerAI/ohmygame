import { useEffect, useMemo, useState } from "react";
import type { ProjectState, WorkspaceFile } from "../shared/contracts.js";
import {
  AssetCard,
  AssetDetailDialog,
  AssetToolbar,
  fileExtension,
  fileName,
  fileStem,
  filterAssets,
  hasMediaType,
  type BrowsableAsset,
  type MediaFilter,
} from "./asset-browser.js";
import { deleteAsset, listProjects, listWorkspaceFiles, renameAsset, waitForRuntime } from "./api.js";
import { Image as ImageIcon, LoaderCircle, RefreshCw, X } from "./icons.js";
import type { AppNavigationTarget } from "./routes.js";
import { SidebarPageHeader, SidebarPageLayout } from "./sidebar-page.js";

interface LibraryPageProps {
  onNavigate: (page: AppNavigationTarget) => void;
  onOpenProject: (projectId: string) => void;
}

export interface LibraryAsset extends BrowsableAsset {
  projectName: string;
  projectUpdatedAt: string;
}

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

  const visibleAssets = useMemo(() => filterAssets(assets, mediaFilter, query), [assets, mediaFilter, query]);

  return (
    <SidebarPageLayout active="library" onNavigate={onNavigate}>
      <SidebarPageHeader title="Library">
        <AssetToolbar mediaFilter={mediaFilter} query={query} onMediaFilterChange={setMediaFilter} onQueryChange={setQuery} />
      </SidebarPageHeader>
      {actionError ? <p className="library-action-error" role="alert">{actionError}</p> : null}
      {phase === "loading" && assets.length === 0 ? <LibraryState><LoaderCircle className="spin" size={18} />Loading assets</LibraryState> : null}
      {phase === "error" ? <LibraryState error><X size={18} />{error}<button type="button" onClick={() => void load()}><RefreshCw size={14} />Retry</button></LibraryState> : null}
      {phase === "ready" && visibleAssets.length === 0 ? <LibraryState><ImageIcon size={18} />{assets.length ? "No assets match these filters" : "No media assets yet"}</LibraryState> : null}
      {visibleAssets.length ? <div className="library-grid">{visibleAssets.map((asset) => <AssetCard asset={asset} key={`${asset.projectId}:${asset.path}`} onOpen={() => setSelectedAsset(asset)} onRename={() => rename(asset)} onDelete={() => remove(asset)} />)}</div> : null}
      {selectedAsset ? <AssetDetailDialog
        asset={selectedAsset}
        onClose={() => setSelectedAsset(undefined)}
        onOpenProject={() => onOpenProject(selectedAsset.projectId)}
        onRename={() => { if (rename(selectedAsset)) setSelectedAsset(undefined); }}
        onDelete={() => { if (remove(selectedAsset)) setSelectedAsset(undefined); }}
      /> : null}
    </SidebarPageLayout>
  );
}

export function filterLibraryAssets(assets: LibraryAsset[], media: MediaFilter, query: string): LibraryAsset[] {
  return filterAssets(assets, media, query);
}

function LibraryState({ children, error = false }: { children: React.ReactNode; error?: boolean }) {
  return <div className={`library-state${error ? " library-state-error" : ""}`} role={error ? "alert" : undefined}>{children}</div>;
}

function toLibraryAsset(project: ProjectState, file: WorkspaceFile & { mediaType: NonNullable<WorkspaceFile["mediaType"]> }): LibraryAsset {
  return { ...file, projectId: project.id, projectName: project.name, projectUpdatedAt: project.updatedAt };
}

function compareAssets(left: LibraryAsset, right: LibraryAsset): number {
  return right.projectUpdatedAt.localeCompare(left.projectUpdatedAt) || left.projectName.localeCompare(right.projectName) || left.path.localeCompare(right.path);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
