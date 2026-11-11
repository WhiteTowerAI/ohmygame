import { useListPage } from "./use-list-page.js";
import { useReadyRuntimeGeneration } from "./runtime-connection.js";
import { useCallback, useEffect, useMemo, useRef, useState, type FormEvent } from "react";
import { assetSortDetail, fileExtension, fileName, fileSize, fileStem, libraryAssetOriginLabel, mediaTypeLabel, type MediaFilter } from "./asset-browser.js";
import { assetDateTime, sortAssets, type AssetSort } from "./asset-sort.js";
import { AssetMedia, useNearViewport } from "./asset-gallery.js";
import { getLibraryAsset, removeLibraryAsset, renameLibraryAsset, uploadLibraryAsset } from "./api.js";
import { ModelPreview } from "./model-preview.js";
import { Copy, Layers3, LoaderCircle, Pause, Pencil, Play, Scissors, Trash2, Upload } from "./icons.js";
import { onGameRecordingSaved } from "./game-recording.js";
import { hasTransferredFiles } from "./file-transfer.js";
import { filterLibraryAssets, loadLibraryAssets, type LibraryAsset } from "./library-assets.js";
import { AssetPeriodSelect, AssetSortSelect, useAssetSort } from "./library-filters.js";
import type { AssetPeriod } from "./asset-sort.js";
import { mediaFileInfo, MEDIA_FILE_TYPES } from "../shared/media-files.js";
import { readMediaFileDuration } from "./video-reference-files.js";
import type { AppNavigationTarget } from "./routes.js";
import { SidebarPageHeader, SidebarPageLayout } from "./sidebar-page.js";
import { Button, CategoryMark, ContextMenu, Dialog, DropdownMenu, Empty, IconButton, Input, MediaTile, SearchInput, Sheet, Skeleton, Tabs, type MenuEntry } from "./ui/index.js";
import { useWorkspaceAssetUrl } from "./use-workspace-asset-url.js";
import { saveTrimmedVideo, VideoTrimmer } from "./video-trimmer.js";
import type { VideoTrim } from "./video-trim.js";
import { t } from "./i18n.js";
import { pluginChangeLines } from "./plugin-hook-labels.js";
import "./library.css";

interface LibraryPageProps {
  onNavigate: (page: AppNavigationTarget) => void;
  onOpenProject: (projectId: string) => void;
}

type Kind = LibraryAsset["mediaType"];
/** Where the page browses: the person's own media, for now; sources such as plugins come later. */
type LibrarySource = "local";
/** Kinds in the order the tabs list them; each kind is also its category hue. */
const KINDS: readonly Kind[] = ["image", "video", "audio", "model"];

/** The largest file the Library takes, as on the canvas. */
const MAX_UPLOAD_BYTES = 200 * 1024 * 1024;
const UPLOAD_ACCEPT = Object.keys(MEDIA_FILE_TYPES).join(",");

/** A dialog over the page; the details sheet steps aside while one is open and comes back after. */
type LibraryDialog =
  | { kind: "rename"; asset: LibraryAsset }
  | { kind: "remove"; asset: LibraryAsset }
  | { kind: "trim"; asset: LibraryAsset };

/**
 * The Library holds what the person put there: files uploaded here, project
 * files saved to it and game recordings. Media a project generates or uploads
 * stays with that project until someone saves it.
 */
export function LibraryPage({ onNavigate, onOpenProject }: LibraryPageProps) {
  const serviceGeneration = useReadyRuntimeGeneration();
  const [assets, setAssets] = useState<LibraryAsset[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>("all");
  const [query, setQuery] = useState("");
  const [source, setSource] = useState<LibrarySource>("local");
  const [period, setPeriod] = useState<AssetPeriod>("all");
  const [sort, setSort] = useAssetSort("ohmygame:library-sort");
  const [selectedId, setSelectedId] = useState<string>();
  const [dialog, setDialog] = useState<LibraryDialog>();
  const [busy, setBusy] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [dropActive, setDropActive] = useState(false);
  const dragDepth = useRef(0);
  const fileInput = useRef<HTMLInputElement>(null);
  const audio = useTileAudio();

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
  // A recording can finish while this page is open, as when it is stopped from the Play window.
  useEffect(() => onGameRecordingSaved(() => void load()), []);

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

  async function confirmRemove(asset: LibraryAsset): Promise<void> {
    if (busy) return;
    if (await runAssetAction(() => removeLibraryAsset(asset.id))) {
      if (audio.playing?.id === asset.id) audio.stop();
      setDialog(undefined);
      if (selectedId === asset.id) setSelectedId(undefined);
    }
  }

  /** Uploads each file in turn; one that fails is named, and the rest still upload. */
  async function upload(files: readonly File[]): Promise<void> {
    if (uploading || !files.length) return;
    setActionError(undefined);
    setUploading(true);
    const failures: string[] = [];
    let last: string | undefined;
    for (const file of files) {
      try {
        last = (await uploadToLibrary(file)).id;
      } catch (cause) {
        failures.push(t("library.uploadFailed", { name: file.name, error: errorMessage(cause) }));
      }
    }
    await load();
    setUploading(false);
    if (failures.length) setActionError(failures.join("\n"));
    else if (files.length === 1 && last) setSelectedId(last);
  }

  async function confirmRename(asset: LibraryAsset, input: string): Promise<void> {
    const name = input.trim();
    if (!name || name === fileStem(asset.path)) { setDialog(undefined); return; }
    if (await runAssetAction(() => renameLibraryAsset(asset.id, name))) setDialog(undefined);
  }

  /** Saves the kept part of a video as a new Library asset and shows it. */
  async function saveTrimmed(asset: LibraryAsset, video: Blob, trim: VideoTrim): Promise<void> {
    const saved = await saveTrimmedVideo(video, trim, { name: asset.name, libraryAssetId: asset.id }, { saved: true });
    await load();
    setDialog(undefined);
    setSelectedId(saved.id);
  }

  function assetMenu(asset: LibraryAsset): MenuEntry[] {
    return [
      { label: t("common.rename"), icon: <Pencil size={14} />, onSelect: () => openDialog({ kind: "rename", asset }) },
      ...(asset.mediaType === "video" ? [{ label: t("library.trim"), icon: <Scissors size={14} />, onSelect: () => openDialog({ kind: "trim", asset }) }] : []),
      { label: t("library.remove"), icon: <Trash2 size={14} />, danger: true, onSelect: () => openDialog({ kind: "remove", asset }) },
    ];
  }

  // Counts follow every filter except the kind, so each tab says what picking it would show.
  const saved = useMemo(() => assets.filter((asset) => asset.saved), [assets]);
  const narrowed = useMemo(() => filterLibraryAssets(saved, "all", query, { origin: "all", includeReferences: true, period }), [saved, query, period]);
  // Sorted before paging, so the first page is the top of the whole list.
  const visibleAssets = useMemo(() => sortAssets(mediaFilter === "all" ? narrowed : narrowed.filter((asset) => asset.mediaType === mediaFilter), sort), [narrowed, mediaFilter, sort]);
  const filtered = Boolean(query.trim()) || period !== "all";
  const page = useListPage(visibleAssets.length);
  const selected = assets.find((asset) => asset.id === selectedId);
  const trimmedFrom = selected?.derivedFrom ? assets.find((candidate) => candidate.id === selected.derivedFrom!.assetId)?.name ?? selected.derivedFrom.assetId : undefined;
  const resetFilters = () => { setQuery(""); setPeriod("all"); };
  const uploadButton = <Button variant="primary" icon={uploading ? <LoaderCircle className="spin" size={14} /> : <Upload size={14} />} disabled={uploading} onClick={() => fileInput.current?.click()}>{uploading ? t("library.uploading") : t("library.upload")}</Button>;

  return (
    <SidebarPageLayout active="library" onNavigate={onNavigate}>
      <div className="library-drop-region"
        onDragEnter={(event) => {
          if (!hasTransferredFiles(event.dataTransfer)) return;
          event.preventDefault();
          dragDepth.current++;
          if (!uploading) setDropActive(true);
        }}
        onDragOver={(event) => {
          if (!hasTransferredFiles(event.dataTransfer)) return;
          event.preventDefault();
          event.dataTransfer.dropEffect = uploading ? "none" : "copy";
        }}
        onDragLeave={() => {
          dragDepth.current = Math.max(0, dragDepth.current - 1);
          if (!dragDepth.current) setDropActive(false);
        }}
        onDrop={(event) => {
          if (!hasTransferredFiles(event.dataTransfer)) return;
          event.preventDefault();
          dragDepth.current = 0;
          setDropActive(false);
          void upload([...event.dataTransfer.files]);
        }}>
      <SidebarPageHeader title={t("library.title")} actions={<div className="library-toolbar">
        <div className="library-page-search"><SearchInput value={query} onChange={setQuery} label={t("assets.search")} placeholder={t("library.searchPlaceholder")} /></div>
        {uploadButton}
        <input ref={fileInput} type="file" multiple hidden accept={UPLOAD_ACCEPT} onChange={(event) => {
          const files = [...(event.currentTarget.files ?? [])];
          event.currentTarget.value = "";
          void upload(files);
        }} />
      </div>} />
      <Tabs<LibrarySource> variant="pills" label={t("library.sources")} value={source} onChange={setSource} tabs={[
        { value: "local", label: t("library.localTab") },
      ]} />
      <div className="library-panel" role="tabpanel" aria-label={t("library.localTab")}>
      <div className="library-filter-row">
        <Tabs variant="underline" label={t("assets.mediaTypes")} value={mediaFilter} onChange={setMediaFilter} tabs={[
          { value: "all", label: t("assets.filter.all"), icon: <Layers3 size={14} />, count: narrowed.length },
          ...KINDS.map((kind) => ({ value: kind, label: t(`assets.filter.${kind}`), icon: <CategoryMark category={kind} />, count: narrowed.filter((asset) => asset.mediaType === kind).length })),
        ]} />
        <span className="library-filter-spacer" />
        <AssetPeriodSelect label={t("libraryFilters.added")} value={period} onChange={setPeriod} />
        {filtered ? <Button size="sm" variant="ghost" onClick={resetFilters}>{t("libraryFilters.reset")}</Button> : null}
        <AssetSortSelect value={sort} onChange={setSort} />
      </div>
      {actionError && !dialog ? <p className="library-page-error" role="alert">{actionError}</p> : null}

      {phase === "error" ? <Empty title={t("library.loadFailed")} description={error} action={<Button size="sm" onClick={() => void load()}>{t("common.retry")}</Button>} />
        : phase === "loading" && assets.length === 0 ? <div className="library-tiles" aria-busy="true" aria-label={t("library.loading")}>{Array.from({ length: 12 }, (_, index) => <span className="library-skeleton" key={index}><Skeleton height="auto" radius={12} /><Skeleton width="60%" /></span>)}</div>
        : visibleAssets.length === 0 ? (saved.length
          ? <Empty title={t("library.noMatch")} action={filtered ? <Button size="sm" onClick={resetFilters}>{t("libraryFilters.reset")}</Button> : undefined} />
          : <Empty title={t("library.none")} description={t("library.noneDescription")} action={uploadButton} />)
        : <div className="library-tiles">{visibleAssets.slice(0, page.limit).map((asset) => <ContextMenu key={asset.id} items={assetMenu(asset)}>
            <LibraryTile asset={asset} sort={sort} selected={selectedId === asset.id} onOpen={() => { audio.stop(); setSelectedId(asset.id); }}
              audio={asset.mediaType === "audio" ? { state: audio.playing?.id === asset.id ? audio.playing.state : undefined, toggle: () => audio.toggle(asset.id) } : undefined} />
          </ContextMenu>)}</div>}

      {phase === "ready" ? page.next : null}
      </div>
      <Sheet open={Boolean(selected) && !dialog} onClose={() => setSelectedId(undefined)} title={selected ? fileName(selected.path) : ""}
        footer={selected ? <>
          <IconButton label={t("library.remove")} onClick={() => openDialog({ kind: "remove", asset: selected })}><Trash2 size={16} /></IconButton>
          <IconButton label={t("common.rename")} onClick={() => openDialog({ kind: "rename", asset: selected })}><Pencil size={16} /></IconButton>
          {selected.mediaType === "video" ? <Button icon={<Scissors size={14} />} onClick={() => openDialog({ kind: "trim", asset: selected })}>{t("library.trim")}</Button> : null}
          <span className="library-filter-spacer" />
          <OpenProjectButton asset={selected} onOpenProject={onOpenProject} />
        </> : undefined}>
        {selected ? <LibraryDetails asset={selected} trimmedFrom={trimmedFrom} /> : null}
      </Sheet>

      {dialog?.kind === "remove" ? <Dialog open size="sm" onClose={closeDialog}
        title={t("library.removeTitle", { name: fileName(dialog.asset.path) })}
        description={dialog.asset.projects?.length
          ? (dialog.asset.projects.length === 1 ? t("library.removeKeptInProject") : t("library.removeKeptInProjects", { count: dialog.asset.projects.length }))
          : t("library.removeDeletes")}
        footer={<>
          <Button disabled={busy} onClick={closeDialog}>{t("common.cancel")}</Button>
          <Button variant="primary" disabled={busy} onClick={() => void confirmRemove(dialog.asset)}>{busy ? t("library.removingEllipsis") : t("library.remove")}</Button>
        </>}>
        {actionError ? <p className="library-page-dialog-error" role="alert">{actionError}</p> : null}
      </Dialog> : null}

      {dialog?.kind === "rename" ? <RenameDialog asset={dialog.asset} busy={busy} error={actionError} onClose={closeDialog} onConfirm={(name) => void confirmRename(dialog.asset, name)} /> : null}

      {dialog?.kind === "trim" ? <Dialog open size="lg" onClose={() => setDialog(undefined)} title={t("library.trimTitle", { name: fileName(dialog.asset.path) })}>
        <TrimEditor asset={dialog.asset} onSave={(video, trim) => saveTrimmed(dialog.asset, video, trim)} onCancel={() => setDialog(undefined)} />
      </Dialog> : null}
      {dropActive ? <div className="library-drop-overlay" role="status"><div className="library-drop-message"><Upload size={28} /><span>{t("library.dropHint")}</span></div></div> : null}
      </div>
    </SidebarPageLayout>
  );
}

export { filterLibraryAssets } from "./library-assets.js";

/** A length as m:ss, rounded to the second. */
function clock(seconds: number): string {
  const whole = Math.max(1, Math.round(seconds));
  return `${Math.floor(whole / 60)}:${String(whole % 60).padStart(2, "0")}`;
}

/** Uploads a file to the Library page; its kind comes from its extension, as the Library checks. */
async function uploadToLibrary(file: File): Promise<{ id: string }> {
  const info = mediaFileInfo(file.name);
  if (!info) throw new Error(t("library.uploadType"));
  if (file.size > MAX_UPLOAD_BYTES) throw new Error(t("assetCanvas.uploadSize"));
  const duration = info.mediaType === "video" || info.mediaType === "audio" ? await readMediaFileDuration(file, info.mediaType) : undefined;
  return uploadLibraryAsset(file, info.contentType, { ...(duration !== undefined ? { duration } : {}), saved: true });
}

/** The value it is sorted by, then the projects using the asset. */
function assetMeta(asset: LibraryAsset, sort: AssetSort): string {
  const projects = asset.projects ?? [];
  const where = projects.length === 1 ? projects[0]!.name : projects.length ? t("library.projectCount", { count: projects.length }) : libraryAssetOriginLabel(asset.origin);
  const detail = assetSortDetail(asset, sort);
  return `${detail ? `${detail} · ` : ""}${where}`;
}

type TileAudioState = "loading" | "playing" | "paused";
interface TilePlayer { id: string; element: HTMLAudioElement; url?: string }

/** One audio tile plays at a time; its file downloads on the first play. */
function useTileAudio() {
  const [playing, setPlaying] = useState<{ id: string; state: TileAudioState }>();
  const player = useRef<TilePlayer>(undefined);
  const stop = useCallback(() => {
    const current = player.current;
    player.current = undefined;
    if (current) {
      current.element.pause();
      current.element.removeAttribute("src");
      if (current.url) URL.revokeObjectURL(current.url);
    }
    setPlaying(undefined);
  }, []);
  useEffect(() => stop, [stop]);
  const toggle = useCallback((id: string) => {
    const current = player.current;
    if (current?.id === id) {
      if (!current.url) return;
      if (current.element.paused) void current.element.play().catch(() => undefined);
      else current.element.pause();
      return;
    }
    stop();
    const element = new Audio();
    const next: TilePlayer = { id, element };
    player.current = next;
    const update = (state: TileAudioState) => { if (player.current === next) setPlaying({ id, state }); };
    element.addEventListener("play", () => update("playing"));
    element.addEventListener("pause", () => update("paused"));
    update("loading");
    void getLibraryAsset(id).then((blob) => {
      if (player.current !== next) return;
      next.url = URL.createObjectURL(blob);
      element.src = next.url;
      return element.play();
    }).catch(() => { if (player.current === next) stop(); });
  }, [stop]);
  return { playing, toggle, stop };
}

function LibraryTile({ asset, sort, selected, onOpen, audio }: { asset: LibraryAsset; sort: AssetSort; selected: boolean; onOpen: () => void; audio?: { state?: TileAudioState; toggle: () => void } }) {
  const [tile, visible] = useNearViewport<HTMLButtonElement>();
  const media = <MediaTile ref={tile} category={asset.mediaType} name={fileName(asset.path)} meta={assetMeta(asset, sort)} selected={selected} onClick={onOpen}
    preview={<TilePreview asset={asset} visible={visible} />}
    badge={(asset.mediaType === "video" || asset.mediaType === "audio") && asset.duration ? clock(asset.duration) : undefined} />;
  if (!audio) return media;
  // The preview plays the sound; the name below it still opens the details.
  const name = fileName(asset.path);
  return <div className={`library-audio-tile${audio.state ? ` is-${audio.state}` : ""}`}>
    {media}
    <button type="button" className="library-audio-play" aria-label={audio.state === "playing" ? t("library.pauseAudio", { name }) : t("library.playAudio", { name })} onClick={audio.toggle}>
      <span>{audio.state === "loading" ? <LoaderCircle className="spin" size={18} /> : audio.state === "playing" ? <Pause size={18} /> : <Play size={18} />}</span>
    </button>
  </div>;
}

/** An image, a video's first frame or a still 3D model, loaded once the tile is near the screen; otherwise its kind and file type. */
function TilePreview({ asset, visible }: { asset: LibraryAsset; visible: boolean }) {
  const [failed, setFailed] = useState(false);
  const load = visible && asset.mediaType !== "audio";
  const preview = useWorkspaceAssetUrl(undefined, asset.path, asset.revision, load ? asset.assetId : undefined);
  if (preview.url && !failed && asset.mediaType === "image") return <img src={preview.url} alt="" draggable={false} onError={() => setFailed(true)} />;
  if (preview.url && !failed && asset.mediaType === "video") return <video src={preview.url} muted playsInline preload="metadata" onError={() => setFailed(true)} onLoadedMetadata={(event) => { event.currentTarget.currentTime = 0.01; }} />;
  if (preview.url && asset.mediaType === "model") return <span className="library-model-still"><ModelPreview source={preview.url} label={fileName(asset.path)} minHeight={0} interactive={false} controls={false} /></span>;
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
    <dl className="library-sheet-props">
      <dt>{t("assets.type")}</dt><dd>{mediaTypeLabel(asset.mediaType)}</dd>
      {asset.width && asset.height ? <><dt>{t("library.dimensions")}</dt><dd>{asset.width} × {asset.height}</dd></> : null}
      {asset.duration ? <><dt>{t("library.length")}</dt><dd>{clock(asset.duration)}</dd></> : null}
      <dt>{t("assets.size")}</dt><dd>{fileSize(asset.size)}</dd>
      <dt>{t("libraryFilters.added")}</dt><dd>{assetDateTime(asset)}</dd>
      {asset.origin ? <><dt>{t("assets.source")}</dt><dd>{libraryAssetOriginLabel(asset.origin)}</dd></> : null}
      {trimmedFrom ? <><dt>{t("assets.trimmedFrom")}</dt><dd>{trimmedFrom}</dd></> : null}
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
    {asset.pluginChanges?.length ? <section className="library-sheet-section">
      <header><h3>{t("pluginHooks.changedBy")}</h3></header>
      {pluginChangeLines(asset.pluginChanges).map((line) => <p key={line}>{line}</p>)}
    </section> : null}
    {asset.pluginChanges?.length && asset.requestedPrompt !== undefined && asset.requestedPrompt !== asset.prompt ? <section className="library-sheet-section">
      <header><h3>{t("pluginHooks.requestedPrompt")}</h3></header>
      <p>{asset.requestedPrompt}</p>
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
  if (!preview.url) return <span className="library-sheet-state" role={preview.error ? "alert" : undefined}>{preview.error ?? <><LoaderCircle className="spin" size={16} />{t("assets.loading")}</>}</span>;
  return <div className="library-trim">
    <VideoTrimmer url={preview.url} label={fileName(asset.path)} loadSource={loadSource} onSave={onSave} onCancel={onCancel} />
  </div>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
