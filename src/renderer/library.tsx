import { useEffect, useMemo, useState } from "react";
import {
  AssetToolbar,
  fileExtension,
  fileName,
  fileStem,
  filterAssets,
  WorkspaceAssetCard,
  WorkspaceAssetDialog,
  type MediaFilter,
} from "./asset-browser.js";
import { deleteLibraryAsset, forceDeleteLibraryAsset, listLibraryAssetReferences, renameLibraryAsset, type LibraryAssetReference } from "./api.js";
import { Image as ImageIcon, LoaderCircle, RefreshCw, X } from "./icons.js";
import { loadLibraryAssets, type LibraryAsset } from "./library-assets.js";
import type { AppNavigationTarget } from "./routes.js";
import { SidebarPageHeader, SidebarPageLayout } from "./sidebar-page.js";

interface LibraryPageProps {
  onNavigate: (page: AppNavigationTarget) => void;
}

export function LibraryPage({ onNavigate }: LibraryPageProps) {
  const [assets, setAssets] = useState<LibraryAsset[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedAsset, setSelectedAsset] = useState<LibraryAsset>();
  const [deleteTarget, setDeleteTarget] = useState<{ asset: LibraryAsset; references: LibraryAssetReference[] }>();
  const [deleting, setDeleting] = useState(false);

  async function load(): Promise<void> {
    setPhase("loading");
    setError(undefined);
    try {
      setAssets(await loadLibraryAssets());
      setPhase("ready");
    } catch (cause) {
      setError(errorMessage(cause));
      setPhase("error");
    }
  }

  useEffect(() => { void load(); }, []);

  async function runAssetAction(action: () => Promise<unknown>): Promise<boolean> {
    setActionError(undefined);
    try {
      await action();
      await load();
      return true;
    } catch (cause) {
      setActionError(errorMessage(cause));
      return false;
    }
  }

  async function rename(asset: LibraryAsset): Promise<void> {
    const extension = fileExtension(asset.path);
    const name = window.prompt(`Rename asset (${extension} is preserved)`, fileStem(asset.path))?.trim();
    if (!name || name === fileStem(asset.path)) return;
    if (await runAssetAction(() => renameLibraryAsset(asset.id, name))) setSelectedAsset(undefined);
  }

  async function remove(asset: LibraryAsset): Promise<void> {
    setActionError(undefined);
    try {
      const references = await listLibraryAssetReferences(asset.id);
      if (references.length) {
        setSelectedAsset(undefined);
        setDeleteTarget({ asset, references });
        return;
      }
      if (!window.confirm(`Delete “${fileName(asset.path)}” from Library? This cannot be undone.`)) return;
      if (await runAssetAction(() => deleteLibraryAsset(asset.id))) setSelectedAsset(undefined);
    } catch (cause) {
      setActionError(errorMessage(cause));
    }
  }

  async function confirmForceDelete(): Promise<void> {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    const deleted = await runAssetAction(() => forceDeleteLibraryAsset(deleteTarget.asset.id));
    setDeleting(false);
    if (deleted) {
      setDeleteTarget(undefined);
      setSelectedAsset(undefined);
    }
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
      {visibleAssets.length ? <div className="library-grid">{visibleAssets.map((asset) => <WorkspaceAssetCard asset={asset} key={asset.id} onOpen={() => setSelectedAsset(asset)} onRename={() => void rename(asset)} onDelete={() => void remove(asset)} />)}</div> : null}
      {selectedAsset ? <WorkspaceAssetDialog
        asset={selectedAsset}
        onClose={() => setSelectedAsset(undefined)}
        onRename={() => void rename(selectedAsset)}
        onDelete={() => void remove(selectedAsset)}
      /> : null}
      {deleteTarget ? <div className="library-delete-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) setDeleteTarget(undefined); }}>
        <section className="library-delete-dialog" role="alertdialog" aria-modal="true" aria-labelledby="library-delete-title" onKeyDown={(event) => { if (event.key === "Escape" && !deleting) setDeleteTarget(undefined); }}>
          <h2 id="library-delete-title">Delete asset everywhere?</h2>
          <p><strong>{fileName(deleteTarget.asset.path)}</strong> is used by {deleteTarget.references.length === 1 ? "this project" : `${deleteTarget.references.length} projects`}.</p>
          <p className="library-delete-warning">Deleting it will remove the related project files and Scene clips. This cannot be undone.</p>
          <ul>{deleteTarget.references.map((reference) => <li key={reference.id}>{reference.name}</li>)}</ul>
          {actionError ? <p className="library-delete-error" role="alert">{actionError}</p> : null}
          <footer><button type="button" autoFocus disabled={deleting} onClick={() => setDeleteTarget(undefined)}>Cancel</button><button className="library-action-delete" type="button" disabled={deleting} onClick={() => void confirmForceDelete()}>{deleting ? "Deleting..." : "Delete everywhere"}</button></footer>
        </section>
      </div> : null}
    </SidebarPageLayout>
  );
}

export function filterLibraryAssets(assets: LibraryAsset[], media: MediaFilter, query: string): LibraryAsset[] {
  return filterAssets(assets, media, query);
}

function LibraryState({ children, error = false }: { children: React.ReactNode; error?: boolean }) {
  return <div className={`library-state${error ? " library-state-error" : ""}`} role={error ? "alert" : undefined}>{children}</div>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
