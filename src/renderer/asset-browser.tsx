import { useEffect, useRef, useState, type ReactNode } from "react";
import type { LibraryAssetOrigin, LibraryAssetProject, LibraryAssetPurpose, WorkspaceFile } from "../shared/contracts.js";
import { Box, Code2, ExternalLink, Film, Image as ImageIcon, LoaderCircle, MoreHorizontal, Music2, Play, X } from "./icons.js";
import { useWorkspaceAssetUrl } from "./use-workspace-asset-url.js";
import { AssetDialogShell, AssetMedia } from "./asset-gallery.js";
import { ModelPreview } from "./model-preview.js";
import { VideoTrimmer } from "./video-trimmer.js";
import type { VideoTrim } from "./video-trim.js";
import { t } from "./i18n.js";

export type MediaFilter = "all" | NonNullable<WorkspaceFile["mediaType"]>;

export interface ProjectAssetFilters {
  origin?: "all" | LibraryAssetOrigin;
  purpose?: "all" | LibraryAssetPurpose;
}

export interface BrowsableAsset extends Omit<WorkspaceFile, "mediaType"> {
  mediaType: NonNullable<WorkspaceFile["mediaType"]>;
  audio?: import("../shared/audio.js").AudioAssetData;
  projectId?: string;
  assetId?: string;
  projectName?: string;
  revision?: number;
  origin?: LibraryAssetOrigin;
  purpose?: LibraryAssetPurpose;
  projects?: LibraryAssetProject[];
  referenceOnly?: boolean;
  saved?: boolean;
}

export function libraryAssetOriginLabel(origin: LibraryAssetOrigin | undefined): string {
  return t(`assets.origin.${origin ?? "unknown"}`);
}

/** An asset's thumbnail: an image, a video's first frame, or a still 3D model, loaded once `visible`. Thumbnails sit inside open buttons, so they carry no clip picker. */
export function AssetThumbnail({ asset, visible }: { asset: BrowsableAsset; visible: boolean }) {
  const [previewFailed, setPreviewFailed] = useState(false);
  const preview = useWorkspaceAssetUrl(visible && asset.mediaType !== "audio" ? asset.projectId : undefined, asset.path, asset.revision, visible ? asset.assetId : undefined);
  const showPreview = Boolean(preview.url) && !previewFailed;
  const FallbackIcon = asset.mediaType === "video" ? Film : asset.mediaType === "audio" ? Music2 : asset.mediaType === "model" ? Box : preview.error || previewFailed ? X : ImageIcon;
  return <>
    {showPreview && asset.mediaType === "video" ? <video src={preview.url} muted playsInline preload="metadata" onError={() => setPreviewFailed(true)} onLoadedMetadata={(event) => { event.currentTarget.currentTime = 0.01; }} /> : null}
    {showPreview && asset.mediaType === "image" ? <img src={preview.url} alt="" onError={() => setPreviewFailed(true)} /> : null}
    {preview.url && !previewFailed && asset.mediaType === "model" ? <ModelPreview source={preview.url} label={fileName(asset.path)} interactive={false} clipPicker={false} /> : null}
    {!showPreview && visible && asset.mediaType === "model" && !preview.error ? <LoaderCircle className="spin" size={18} /> : null}
    {!showPreview && (!visible || asset.mediaType !== "model" || preview.error) ? <FallbackIcon size={FallbackIcon === X ? 22 : 28} /> : null}
  </>;
}

/** The corner badge on a thumbnail, for media a still frame does not make obvious. */
export function assetTypeBadge(mediaType: BrowsableAsset["mediaType"]): ReactNode {
  if (mediaType === "video") return <><Play size={11} />{t("assets.video")}</>;
  if (mediaType === "model") return <><Box size={11} />3D</>;
  return undefined;
}

export function WorkspaceAssetDialog({ asset, onClose, onOpenProject, onRename, onDelete, onSaveToLibrary, onShowInCode, trimmer, trimmedFrom }: {
  asset: BrowsableAsset;
  onClose: () => void;
  onOpenProject?: () => void;
  onRename?: () => void;
  onDelete?: () => void;
  onSaveToLibrary?: () => void;
  onShowInCode?: () => void;
  /** Shows a video with handles to trim it, saving the kept part as a new video. */
  trimmer?: { loadSource: () => Promise<Blob>; onSave: (video: Blob, trim: VideoTrim) => Promise<void> };
  /** The name of the video this one was trimmed from. */
  trimmedFrom?: string;
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
    headerActions={onRename || onDelete || onSaveToLibrary ? <>
      <button type="button" aria-label={t("assets.actions", { name: fileName(asset.path) })} aria-expanded={menuOpen} aria-haspopup="menu" onClick={() => setMenuOpen((open) => !open)}><MoreHorizontal size={17} /></button>
      {menuOpen ? <div className="library-dialog-actions-menu" role="menu">
        {onSaveToLibrary ? <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onSaveToLibrary(); }}>{t("workspace.saveToLibrary")}</button> : null}
        {onRename ? <button type="button" role="menuitem" onClick={() => { setMenuOpen(false); onRename(); }}>{t("common.rename")}</button> : null}
        {onDelete ? <button className="library-action-delete" type="button" role="menuitem" onClick={() => { setMenuOpen(false); onDelete(); }}>{t("common.delete")}</button> : null}
      </div> : null}
    </> : undefined}
    preview={<>
          {!preview.url && !preview.error ? <span className="library-dialog-state"><LoaderCircle className="spin" size={18} />{t("assets.loading")}</span> : null}
          {preview.error ? <span className="library-dialog-state library-dialog-error" role="alert"><X size={18} />{preview.error}</span> : null}
          {preview.url && trimmer && asset.mediaType === "video"
            ? <VideoTrimmer key={asset.assetId ?? asset.path} url={preview.url} label={fileName(asset.path)} loadSource={trimmer.loadSource} onSave={trimmer.onSave} />
            : preview.url ? <AssetMedia type={asset.mediaType} url={preview.url} label={fileName(asset.path)} /> : null}
        </>}
    footer={<footer className={`library-dialog-footer${onOpenProject ? "" : " library-dialog-footer-compact"}${asset.origin || asset.projects?.length ? " library-dialog-footer-library" : ""}`}>
          <dl>
            <div><dt>{t("assets.type")}</dt><dd>{mediaTypeLabel(asset.mediaType)}</dd></div>
            <div><dt>{t("assets.size")}</dt><dd>{fileSize(asset.size)}</dd></div>
            {asset.origin ? <div><dt>{t("assets.source")}</dt><dd>{libraryAssetOriginLabel(asset.origin)}</dd></div> : null}
            {trimmedFrom ? <div><dt>{t("assets.trimmedFrom")}</dt><dd title={trimmedFrom}>{trimmedFrom}</dd></div> : null}
            {asset.referenceOnly ? <div><dt>{t("assets.use")}</dt><dd>{t("assets.reference")}</dd></div> : null}
            {asset.projects?.length ? <div className="library-dialog-projects"><dt>{t("assets.projects")}</dt><dd title={asset.projects.map((project) => project.name).join(", ")}>{asset.projects.map((project) => project.name).join(", ")}</dd></div> : null}
            {asset.projectName ? <div><dt>{t("assets.project")}</dt><dd title={asset.projectName}>{asset.projectName}</dd></div> : null}
            <div className="library-dialog-path"><dt>{t("assets.path")}</dt><dd title={asset.path}>{asset.path}</dd></div>
          </dl>
          <div className="library-dialog-footer-actions">
            {onOpenProject ? <button type="button" onClick={onOpenProject}><ExternalLink size={15} />{t("assets.openProject")}</button> : null}
            {onShowInCode ? <button type="button" onClick={onShowInCode}><Code2 size={15} />{t("assets.showInCode")}</button> : null}
          </div>
        </footer>}
  />;
}

export function filterAssets<T extends BrowsableAsset>(assets: readonly T[], media: MediaFilter, query: string, filters: ProjectAssetFilters = {}): T[] {
  const normalizedQuery = query.trim().toLowerCase();
  return assets.filter((asset) => (
    (media === "all" || asset.mediaType === media) &&
    (!filters.origin || filters.origin === "all" || (asset.origin ?? "workspace") === filters.origin) &&
    (!filters.purpose || filters.purpose === "all" || (asset.purpose ?? "asset") === filters.purpose) &&
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
  return t(`assets.mediaType.${mediaType}`);
}

export function fileSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}
