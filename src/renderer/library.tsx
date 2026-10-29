import { useReadyRuntimeGeneration } from "./runtime-connection.js";
import { useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { fileExtension, fileName, fileSize, fileStem, libraryAssetOriginLabel, mediaTypeLabel, type MediaFilter } from "./asset-browser.js";
import { AssetMedia, useNearViewport } from "./asset-gallery.js";
import { deleteLibraryAsset, forceDeleteLibraryAsset, getLibraryAsset, listLibraryAssetReferences, renameLibraryAsset, saveLibraryAsset, type LibraryAssetReference } from "./api.js";
import { AudioCompanionDownloads } from "./canvas-audio-controls.js";
import { ModelPreview } from "./model-preview.js";
import { Copy, Layers3, LoaderCircle, Pencil, Scissors, Trash2 } from "./icons.js";
import { filterLibraryAssets, loadLibraryAssets, type LibraryAsset, type LibraryAssetFilters } from "./library-assets.js";
import { LibraryFilterRow, libraryFiltersActive } from "./library-filters.js";
import type { AppNavigationTarget } from "./routes.js";
import { SidebarPageHeader, SidebarPageLayout } from "./sidebar-page.js";
import { Button, CategoryMark, ContextMenu, Dialog, DropdownMenu, Empty, IconButton, Input, MediaTile, SearchInput, Sheet, Skeleton, Tabs, type MenuEntry } from "./ui/index.js";
import { useWorkspaceAssetUrl } from "./use-workspace-asset-url.js";
import { VideoTrimEditor } from "./video-trim-editor.js";
import { saveTrimmedVideo, TrimProgress, trimSummary, useVideoTrimSave } from "./video-trimmer.js";
import type { VideoTrim } from "./video-trim.js";
import { t, tNodes } from "./i18n.js";
import "./library.css";

interface LibraryPageProps {
  onNavigate: (page: AppNavigationTarget) => void;
  onOpenProject: (projectId: string) => void;
}

type Kind = LibraryAsset["mediaType"];
/** Kinds in the order the tabs list them; each kind is also its category hue. */
const KINDS: readonly Kind[] = ["image", "video", "audio", "model"];

/** A dialog over the page; the details sheet steps aside while one is open and comes back after. */
type LibraryDialog =
  | { kind: "rename"; asset: LibraryAsset }
  | { kind: "delete"; asset: LibraryAsset; references: LibraryAssetReference[] }
  | { kind: "trim"; asset: LibraryAsset };

export function LibraryPage({ onNavigate, onOpenProject }: LibraryPageProps) {
  const serviceGeneration = useReadyRuntimeGeneration();
  const [assets, setAssets] = useState<LibraryAsset[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>("all");
  const [query, setQuery] = useState("");
  const [filters, setFilters] = useState<LibraryAssetFilters>({});
  const [selectedId, setSelectedId] = useState<string>();
  const [dialog, setDialog] = useState<LibraryDialog>();
  const [busy, setBusy] = useState(false);

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

  useEffect(() => { void load(); }, [serviceGeneration]);

  async function runAssetAction(action: () => Promise<unknown>): Promise<boolean> {
    setActionError(undefined);
    setBusy(true);
    try {
      await action();
      await load();
      return true;
    } catch (cause) {
      setActionError(errorMessage(cause));
      return false;
    } finally {
      setBusy(false);
    }
  }

  function openDialog(next: LibraryDialog): void {
    setActionError(undefined);
    setDialog(next);
  }

  function closeDialog(): void {
    if (busy) return;
    setActionError(undefined);
    setDialog(undefined);
  }

  async function beginDelete(asset: LibraryAsset): Promise<void> {
    setActionError(undefined);
    try {
      openDialog({ kind: "delete", asset, references: await listLibraryAssetReferences(asset.id) });
    } catch (cause) {
      setActionError(errorMessage(cause));
    }
  }

  async function confirmDelete(target: Extract<LibraryDialog, { kind: "delete" }>): Promise<void> {
    if (busy) return;
    const remove = target.references.length ? forceDeleteLibraryAsset : deleteLibraryAsset;
    if (await runAssetAction(() => remove(target.asset.id))) {
      setDialog(undefined);
      if (selectedId === target.asset.id) setSelectedId(undefined);
    }
  }

  async function confirmRename(asset: LibraryAsset, input: string): Promise<void> {
    const name = input.trim();
    if (!name || name === fileStem(asset.path)) { setDialog(undefined); return; }
    if (await runAssetAction(() => renameLibraryAsset(asset.id, name))) setDialog(undefined);
  }

  /** Saves the kept part of a video as a new Library asset and shows it. */
  async function saveTrimmed(asset: LibraryAsset, video: Blob, trim: VideoTrim): Promise<void> {
    const saved = await saveTrimmedVideo(video, trim, { name: asset.name, libraryAssetId: asset.id });
    await load();
    setDialog(undefined);
    setSelectedId(saved.id);
  }

  function assetMenu(asset: LibraryAsset): MenuEntry[] {
    return [
      ...(canSave(asset) ? [{ label: t("workspace.saveToLibrary"), onSelect: () => void runAssetAction(() => saveLibraryAsset(asset.id)) }] : []),
      { label: t("common.rename"), icon: <Pencil size={14} />, onSelect: () => openDialog({ kind: "rename", asset }) },
      ...(asset.mediaType === "video" ? [{ label: t("library.trim"), icon: <Scissors size={14} />, onSelect: () => openDialog({ kind: "trim", asset }) }] : []),
      { label: t("common.delete"), icon: <Trash2 size={14} />, danger: true, onSelect: () => void beginDelete(asset) },
    ];
  }

  // Counts follow every filter except the kind, so each tab says what picking it would show.
  const narrowed = useMemo(() => filterLibraryAssets(assets, "all", query, filters), [assets, query, filters]);
  const visibleAssets = useMemo(() => mediaFilter === "all" ? narrowed : narrowed.filter((asset) => asset.mediaType === mediaFilter), [narrowed, mediaFilter]);
  const filtered = Boolean(query.trim()) || libraryFiltersActive(filters);
  const selected = assets.find((asset) => asset.id === selectedId);
  const trimmedFrom = selected?.derivedFrom ? assets.find((candidate) => candidate.id === selected.derivedFrom!.assetId)?.name ?? selected.derivedFrom.assetId : undefined;
  const resetFilters = () => { setQuery(""); setFilters({}); };

  return (
    <SidebarPageLayout active="library" onNavigate={onNavigate}>
      <SidebarPageHeader title={t("library.title")} actions={<div className="library-page-search"><SearchInput value={query} onChange={setQuery} label={t("assets.search")} placeholder={t("library.searchPlaceholder")} /></div>} />
      <div className="library-filter-row">
        <Tabs variant="pills" label={t("assets.mediaTypes")} value={mediaFilter} onChange={setMediaFilter} tabs={[
          { value: "all", label: t("assets.filter.all"), icon: <Layers3 size={14} />, count: narrowed.length },
          ...KINDS.map((kind) => ({ value: kind, label: t(`assets.filter.${kind}`), icon: <CategoryMark category={kind} />, count: narrowed.filter((asset) => asset.mediaType === kind).length })),
        ]} />
        <span className="library-filter-spacer" />
        <LibraryFilterRow assets={assets} filters={filters} onChange={setFilters} />
        {filtered ? <Button size="sm" variant="ghost" onClick={resetFilters}>{t("libraryFilters.reset")}</Button> : null}
      </div>
      {actionError && !dialog ? <p className="library-page-error" role="alert">{actionError}</p> : null}

      {phase === "error" ? <Empty title={t("library.loadFailed")} description={error} action={<Button size="sm" onClick={() => void load()}>{t("common.retry")}</Button>} />
        : phase === "loading" && assets.length === 0 ? <div className="library-tiles" aria-busy="true" aria-label={t("library.loading")}>{Array.from({ length: 12 }, (_, index) => <span className="library-skeleton" key={index}><Skeleton height="auto" radius={12} /><Skeleton width="60%" /></span>)}</div>
        : visibleAssets.length === 0 ? <Empty title={assets.length ? t("library.noMatch") : t("library.none")} action={filtered ? <Button size="sm" onClick={resetFilters}>{t("libraryFilters.reset")}</Button> : undefined} />
        : <div className="library-tiles">{visibleAssets.map((asset) => <ContextMenu key={asset.id} items={assetMenu(asset)}>
            <LibraryTile asset={asset} selected={selectedId === asset.id} onOpen={() => setSelectedId(asset.id)} />
          </ContextMenu>)}</div>}

      <Sheet open={Boolean(selected) && !dialog} onClose={() => setSelectedId(undefined)} title={selected ? fileName(selected.path) : ""}
        footer={selected ? <>
          <IconButton label={t("common.delete")} onClick={() => void beginDelete(selected)}><Trash2 size={16} /></IconButton>
          <IconButton label={t("common.rename")} onClick={() => openDialog({ kind: "rename", asset: selected })}><Pencil size={16} /></IconButton>
          {selected.mediaType === "video" ? <Button icon={<Scissors size={14} />} onClick={() => openDialog({ kind: "trim", asset: selected })}>{t("library.trim")}</Button> : null}
          <span className="library-filter-spacer" />
          {canSave(selected) ? <Button variant={selected.projects?.length ? "secondary" : "primary"} disabled={busy} onClick={() => void runAssetAction(() => saveLibraryAsset(selected.id))}>{t("workspace.saveToLibrary")}</Button> : null}
          <OpenProjectButton asset={selected} onOpenProject={onOpenProject} />
        </> : undefined}>
        {selected ? <LibraryDetails asset={selected} trimmedFrom={trimmedFrom} /> : null}
      </Sheet>

      {dialog?.kind === "delete" ? <Dialog open size="sm" onClose={closeDialog}
        title={dialog.references.length ? t("library.deleteEverywhereTitle") : t("library.deleteTitle", { name: fileName(dialog.asset.path) })}
        description={dialog.references.length
          ? tNodes(dialog.references.length === 1 ? "library.usedByProject" : "library.usedByProjects", { name: <strong>{fileName(dialog.asset.path)}</strong>, count: dialog.references.length })
          : t("library.deleteDescription")}
        footer={<>
          <Button disabled={busy} onClick={closeDialog}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={busy} onClick={() => void confirmDelete(dialog)}>{busy ? t("library.deletingEllipsis") : dialog.references.length ? t("library.deleteEverywhere") : t("common.delete")}</Button>
        </>}>
        {dialog.references.length ? <>
          <ul className="library-delete-projects">{dialog.references.map((reference) => <li key={reference.id}>{reference.name}</li>)}</ul>
          <p className="library-delete-note">{t("library.deleteWarning")}</p>
        </> : null}
        {actionError ? <p className="library-page-dialog-error" role="alert">{actionError}</p> : null}
      </Dialog> : null}

      {dialog?.kind === "rename" ? <RenameDialog asset={dialog.asset} busy={busy} error={actionError} onClose={closeDialog} onConfirm={(name) => void confirmRename(dialog.asset, name)} /> : null}

      {dialog?.kind === "trim" ? <Dialog open size="lg" onClose={() => setDialog(undefined)} title={t("library.trimTitle", { name: fileName(dialog.asset.path) })}>
        <TrimEditor asset={dialog.asset} onSave={(video, trim) => saveTrimmed(dialog.asset, video, trim)} onCancel={() => setDialog(undefined)} />
      </Dialog> : null}
    </SidebarPageLayout>
  );
}

export { filterLibraryAssets } from "./library-assets.js";

/** A length as m:ss, rounded to the second. */
function clock(seconds: number): string {
  const whole = Math.max(1, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

function canSave(asset: LibraryAsset): boolean {
  return asset.saved === false || Boolean(asset.referenceOnly);
}

/** Where the asset is used, then where it came from. */
function assetMeta(asset: LibraryAsset): string {
  const projects = asset.projects ?? [];
  const where = projects.length === 1 ? projects[0]!.name : projects.length ? t("library.projectCount", { count: projects.length }) : t("libraryFilters.noProject");
  return `${where} · ${asset.referenceOnly ? t("assets.reference") : libraryAssetOriginLabel(asset.origin)}`;
}

function LibraryTile({ asset, selected, onOpen }: { asset: LibraryAsset; selected: boolean; onOpen: () => void }) {
  const [tile, visible] = useNearViewport<HTMLButtonElement>();
  return <MediaTile ref={tile} category={asset.mediaType} name={fileName(asset.path)} meta={assetMeta(asset)} selected={selected} onClick={onOpen}
    preview={<TilePreview asset={asset} visible={visible} />}
    badge={asset.mediaType === "video" && asset.duration ? clock(asset.duration) : undefined} />;
}

/** An image, a video's first frame or a still 3D model, loaded once the tile is near the screen; otherwise its kind and file type. */
function TilePreview({ asset, visible }: { asset: LibraryAsset; visible: boolean }) {
  const [failed, setFailed] = useState(false);
  const load = visible && asset.mediaType !== "audio";
  const preview = useWorkspaceAssetUrl(undefined, asset.path, asset.revision, load ? asset.assetId : undefined);
  if (preview.url && !failed && asset.mediaType === "image") return <img src={preview.url} alt="" draggable={false} onError={() => setFailed(true)} />;
  if (preview.url && !failed && asset.mediaType === "video") return <video src={preview.url} muted playsInline preload="metadata" onError={() => setFailed(true)} onLoadedMetadata={(event) => { event.currentTarget.currentTime = 0.01; }} />;
  if (preview.url && asset.mediaType === "model") return <span className="library-model-still"><ModelPreview source={preview.url} label={fileName(asset.path)} minHeight={0} interactive={false} clipPicker={false} /></span>;
  return <FileMark asset={asset} />;
}

function FileMark({ asset }: { asset: LibraryAsset }) {
  const extension = fileExtension(asset.path).slice(1).toUpperCase();
  return <span className="library-file-mark"><CategoryMark category={asset.mediaType} size={22} />{extension ? <small>{extension}</small> : null}</span>;
}

function LibraryDetails({ asset, trimmedFrom }: { asset: LibraryAsset; trimmedFrom?: string }) {
  const preview = useWorkspaceAssetUrl(undefined, asset.path, asset.revision, asset.assetId);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1600);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const projects = asset.projects?.map((project) => project.name).join(", ");
  return <>
    <div className={`library-sheet-preview is-${asset.mediaType}`}>
      {preview.url ? <AssetMedia type={asset.mediaType} url={preview.url} label={fileName(asset.path)} />
        : preview.error ? <span className="library-sheet-state" role="alert">{preview.error}</span>
        : <span className="library-sheet-state"><LoaderCircle className="spin" size={16} />{t("assets.loading")}</span>}
    </div>
    <AudioCompanionDownloads data={asset.audio} name={fileName(asset.path)} />
    <dl className="library-sheet-props">
      <dt>{t("assets.type")}</dt><dd>{mediaTypeLabel(asset.mediaType)}</dd>
      {asset.width && asset.height ? <><dt>{t("library.dimensions")}</dt><dd>{asset.width} × {asset.height}</dd></> : null}
      {asset.duration ? <><dt>{t("library.length")}</dt><dd>{clock(asset.duration)}</dd></> : null}
      <dt>{t("assets.size")}</dt><dd>{fileSize(asset.size)}</dd>
      {asset.origin ? <><dt>{t("assets.source")}</dt><dd>{libraryAssetOriginLabel(asset.origin)}</dd></> : null}
      {trimmedFrom ? <><dt>{t("assets.trimmedFrom")}</dt><dd>{trimmedFrom}</dd></> : null}
      {asset.referenceOnly ? <><dt>{t("assets.use")}</dt><dd>{t("assets.reference")}</dd></> : null}
      {projects ? <><dt>{t("assets.projects")}</dt><dd>{projects}</dd></> : null}
      <dt>{t("assets.path")}</dt><dd className="library-mono">{asset.path}</dd>
    </dl>
    {asset.prompt ? <section className="library-sheet-section">
      <header>
        <h3>{t("library.prompt")}</h3>
        <Button size="sm" variant="ghost" icon={<Copy size={14} />} onClick={() => {
          void navigator.clipboard?.writeText(asset.prompt ?? "").then(() => setCopied(true), () => undefined);
        }}>{copied ? t("common.copied") : t("common.copy")}</Button>
      </header>
      <p>{asset.prompt}</p>
    </section> : null}
  </>;
}

/** Opens the one project using the asset, or lists them when there are several. */
function OpenProjectButton({ asset, onOpenProject }: { asset: LibraryAsset; onOpenProject: (projectId: string) => void }) {
  const projects = asset.projects ?? [];
  if (projects.length === 1) return <Button variant="primary" onClick={() => onOpenProject(projects[0]!.id)}>{t("assets.openProject")}</Button>;
  if (!projects.length) return null;
  return <DropdownMenu placement="bottom-end" items={projects.map((project) => ({ label: project.name, onSelect: () => onOpenProject(project.id) }))}
    trigger={(props) => <Button {...props} variant="primary">{t("assets.openProject")}</Button>} />;
}

function RenameDialog({ asset, busy, error, onClose, onConfirm }: { asset: LibraryAsset; busy: boolean; error?: string; onClose: () => void; onConfirm: (name: string) => void }) {
  const [name, setName] = useState(fileStem(asset.path));
  const formId = `library-rename-${asset.id}`;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    onConfirm(name);
  };
  return <Dialog open size="sm" onClose={onClose} title={t("library.rename")} footer={<>
    <Button disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
    <Button variant="primary" type="submit" form={formId} disabled={busy || !name.trim()}>{busy ? t("common.saving") : t("common.save")}</Button>
  </>}>
    <form id={formId} onSubmit={submit}>
      <Input aria-label={t("common.name")} value={name} disabled={busy} onChange={(event) => setName(event.target.value)} onFocus={(event) => event.currentTarget.select()} suffix={fileExtension(asset.path) || undefined} />
    </form>
    {error ? <p className="library-page-dialog-error" role="alert">{error}</p> : null}
  </Dialog>;
}

/** The trim timeline with its actions; the kept part is saved as a new video. */
function TrimEditor({ asset, onSave, onCancel }: { asset: LibraryAsset; onSave: (video: Blob, trim: VideoTrim) => Promise<void>; onCancel: () => void }) {
  const preview = useWorkspaceAssetUrl(undefined, asset.path, asset.revision, asset.assetId);
  const loadSource = useRef(() => getLibraryAsset(asset.id)).current;
  const { file, trim, setTrim, saving, error, save } = useVideoTrimSave(loadSource, onSave);
  if (!preview.url) return <span className="library-sheet-state" role={preview.error ? "alert" : undefined}>{preview.error ?? <><LoaderCircle className="spin" size={16} />{t("assets.loading")}</>}</span>;
  return <div className="library-trim">
    <VideoTrimEditor url={preview.url} label={fileName(asset.path)} loadSource={file} trim={trim} onTrimChange={setTrim} disabled={Boolean(saving)}
      renderFooter={({ trim: selected, changed, reset, pause }) => <div className="library-trim-footer">
        <span className="library-trim-summary" aria-live="polite">{trimSummary(selected, changed)}</span>
        {error ? <span className="library-page-dialog-error" role="alert">{error}</span> : null}
        {saving ? <>
          <TrimProgress progress={saving.progress} />
          <Button disabled={saving.uploading} onClick={() => saving.controller.abort()}>{t("common.cancel")}</Button>
        </> : <>
          {changed ? <Button variant="ghost" onClick={reset}>{t("videoTrim.reset")}</Button> : <Button variant="ghost" onClick={onCancel}>{t("common.cancel")}</Button>}
          <Button variant="primary" icon={<Scissors size={14} />} disabled={!changed} title={t("videoTrim.saveTitle")} onClick={() => selected && void save(selected, pause)}>{t("videoTrim.save")}</Button>
        </>}
      </div>} />
  </div>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
