import { previewPageUrl as isolatedPreviewUrl } from "../shared/preview-page.js";
import {
  Check,
  Copy,
  Gamepad2,
  MoreHorizontal,
  MousePointer2,
  RotateCcw,
  ChevronDown,
  ChevronRight,
  Code2,
  ExternalLink,
  FileCode2,
  FileConfig,
  FileDocument,
  FilePlain,
  FileStyle,
  FileText,
  Folder,
  FolderOpen,
  Globe2,
  Music2,
  FolderPlus,
  Image as ImageIcon,
  LaptopMinimalistic,
  Layers3,
  LoaderCircle,
  Monitor,
  Pencil,
  Plus,
  Play,
  RefreshCw,
  Search,
  Smartphone,
  Tablet,
  Trash2,
  Video,
  Wrench,
  X,
  type IconComponent,
} from "./icons.js";
import { Fragment, lazy, Suspense, useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import { createPortal } from "react-dom";
import { Tree, type NodeRendererProps, type TreeApi } from "react-arborist";
import { PREVIEW_VIEWPORTS } from "../shared/contracts.js";
import type { PreviewViewport, ProjectFileOpenMode, ProjectState, WorkspaceFile, WorkspaceFileContent } from "../shared/contracts.js";
import type { PlaytestWatchState } from "../shared/playtest.js";
import { isWebRuntimeProjectType, supportsWebPreview } from "../shared/project-runtime.js";
import { createWorkspaceEntry, deleteWorkspaceEntry, setPreviewPicking, getProjectCover, getProjectCoverState, getWorkspaceFile, listWorkspaceFiles, renameWorkspaceEntry, saveProjectAssetToLibrary, setProjectCover } from "./api.js";
import { captureElementImage } from "./page-capture.js";
import { AssetThumbnail, WorkspaceAssetDialog, fileExtension, fileName, filterAssets, hasMediaType, libraryAssetOriginLabel, mediaTypeLabel, type BrowsableAsset, type MediaFilter, type ProjectAssetFilters } from "./asset-browser.js";
import { useNearViewport } from "./asset-gallery.js";
import { ProjectAssetFilterRow } from "./library-filters.js";
import "./library.css";
import { ProjectRenameDialog } from "./project-rename-dialog.js";
import { HighlightedCode } from "./highlighted-code.js";
import { MarkdownContent, workspaceLinkPath } from "./markdown-content.js";
import { PublishDialog, type PublishDetails } from "./publish-dialog.js";
import { ProjectSettingsDialog } from "./project-settings-dialog.js";
import { AssetMedia } from "./asset-gallery.js";
import { useWorkspaceAssetUrl } from "./use-workspace-asset-url.js";
import { useWebGamePlayer } from "./use-web-game-player.js";
import { ErrorBoundary } from "./error-boundary.js";
import { useRuntimeConnection } from "./runtime-connection.js";
import { DesktopGamePreview } from "./desktop-game-preview.js";
import { t } from "./i18n.js";
import { GitChangesList, useWorkspaceGitChanges, WorkspaceGitDiff } from "./workspace-git-changes.js";
import type { PanelNodes } from "./panel-layout.js";
import { useCanvasDocuments } from "./use-canvas-documents.js";
import { Button, CategoryMark, DropdownMenu, Empty, IconButton, MediaTile, SearchInput, Tabs } from "./ui/index.js";

type WorkspaceTab = "preview" | "code" | "assets";
const CanvasWorkspace = lazy(() => import("./canvas-workspace.js").then((module) => ({ default: module.CanvasWorkspace })));
const DesignDocumentPanel = lazy(() => import("./design-document-panel.js").then((module) => ({ default: module.DesignDocumentPanel })));
type WorkspaceContextMenu = { path: string; directory: boolean; x: number; y: number };
type WorkspaceFileChange = { from?: string; to?: string };
type WorkspaceEntryAction = "new-file" | "new-folder" | "rename" | "delete" | "copy-path" | "save-library";

export function workspacePathAfterChange(selectedPath: string | undefined, change: WorkspaceFileChange): string | undefined {
  if (!change.from) return change.to ?? selectedPath;
  if (!selectedPath || (selectedPath !== change.from && !selectedPath.startsWith(`${change.from}/`))) return selectedPath;
  return change.to ? `${change.to}${selectedPath.slice(change.from.length)}` : undefined;
}
interface CodingWorkspaceProps {
  project?: ProjectState;
  agentBusy: boolean;
  publishing: boolean;
  workspaceRevision: number;
  previewPaused?: boolean;
  onPublish: (details: PublishDetails) => Promise<boolean>;
  publishDialog?: "open" | "success";
  onClosePublish: () => void;
  onRestart: (project?: ProjectState, reinstall?: boolean) => void;
  onStop?: () => Promise<void>;
  onAskAgent?: (text: string) => void;
  /** Shows the canvas in place of the first view when there are no panels. */
  canvasOpen?: boolean;
  onDesignSaveReady?: (save: (() => Promise<void>) | undefined) => void;
  onDesignContextChange?: (context: import("../shared/contracts.js").PromptContext | undefined) => void;
  onProjectUpdated?: (project: ProjectState) => void;
  openFileRequest?: { path: string; id: number };
  /** The design document the next message references, by its workspace path. */
  referencedDocument?: string;
  /** References a design document in the next message, or stops referencing it. */
  onReferenceDocument?: (document: { id: string; title: string } | undefined) => void;
  /** Quotes text picked in the design document into the next message. */
  onQuoteDocument?: (text: string) => void;
  /** The preview page that is picking an element for the next message. */
  pickingClient?: string;
  onPickingChange?: (client: string | undefined) => void;
  /**
   * The panels the views render into. Without them (in tests), the first
   * view renders in place.
   */
  panels?: CodingPanels;
}

/** The workspace's views, each a panel of its own. */
export type CodingView = "preview" | "design" | "canvas" | "code" | "assets";

export interface CodingPanels {
  /** Where each view renders: its panel's body and its controls in the tab strip. */
  nodes: Record<CodingView, PanelNodes>;
  /** The views the person can see now. */
  visible: ReadonlySet<CodingView>;
  /** Brings a view forward, opening its panel if it was closed. */
  onShow: (view: CodingView) => void;
}

export function CodingWorkspace({
  project,
  agentBusy,
  publishing,
  workspaceRevision,
  previewPaused = false,
  onPublish,
  publishDialog,
  onClosePublish,
  onRestart,
  onStop,
  onAskAgent,
  canvasOpen = false,
  onDesignSaveReady,
  onDesignContextChange,
  onProjectUpdated,
  openFileRequest,
  referencedDocument,
  onReferenceDocument,
  onQuoteDocument,
  pickingClient,
  onPickingChange,
  panels,
}: CodingWorkspaceProps) {
  const supportsPreview = supportsWebPreview(project);
  const hasPreview = supportsWebPreview(project);
  const visible = panels?.visible ?? new Set<CodingView>([canvasOpen ? "canvas" : hasPreview ? "preview" : "code"]);
  const shows = (view: CodingView) => visible.has(view);
  const show = (view: CodingView) => panels?.onShow(view);
  // A view's body mounts the first time it shows and then stays, so a hidden
  // panel keeps its place (the design canvas, the open file).
  const opened = useRef(new Set<CodingView>());
  for (const view of visible) opened.current.add(view);
  const [designHeaderActions, setDesignHeaderActions] = useState<HTMLDivElement | null>(null);
  const [documentToolbar, setDocumentToolbar] = useState<HTMLDivElement | null>(null);
  // The design document and the canvas show the same documents, so they share
  // them. Loading creates the project's canvas, so it waits for either to open.
  const documentsOpened = !!project && (opened.current.has("design") || opened.current.has("canvas"));
  const documents = useCanvasDocuments(project?.id ?? "", documentsOpened);
  const documentsRef = useRef(documents);
  documentsRef.current = documents;
  // Saving the design saves the canvas, which saves the documents too, or the
  // documents alone while the canvas hasn't opened.
  const canvasSave = useRef<(() => Promise<void>) | undefined>(undefined);
  const registerCanvasSave = useCallback((save: (() => Promise<void>) | undefined) => { canvasSave.current = save; }, []);
  const saveDesign = useCallback(() => canvasSave.current ? canvasSave.current() : documentsRef.current.flush(), []);
  useEffect(() => {
    if (!documentsOpened) return;
    onDesignSaveReady?.(saveDesign);
    return () => onDesignSaveReady?.(undefined);
  }, [documentsOpened, onDesignSaveReady, saveDesign]);
  const [viewport, setViewport] = useState<PreviewViewport>(project?.previewViewport ?? "fit");
  const [previewPath, setPreviewPath] = useState(project?.previewPath ?? "/");
  const [previewClient] = useState(() => crypto.randomUUID());
  const [actualPreviewPath, setActualPreviewPath] = useState(project?.previewPath ?? "/");
  const [logsOpen, setLogsOpen] = useState(false);
  const [knownPaths, setKnownPaths] = useState<string[]>(["/"]);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [selectedCodePath, setSelectedCodePath] = useState<string>();
  const [selectedFile, setSelectedFile] = useState<WorkspaceFileContent>();
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string>();
  const [filesRevision, setFilesRevision] = useState(0);
  const [reload, setReload] = useState(0);
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);
  const [agentPlaytestWatch, setAgentPlaytestWatch] = useState<PlaytestWatchState | undefined>(() => (
    typeof window !== "undefined" && window.ohMyGameDesktop?.agentPlaytests ? { visible: false, activeSessions: 0 } : undefined
  ));
  const [agentPlaytestWatchPending, setAgentPlaytestWatchPending] = useState(false);
  const fileRequest = useRef(0);
  const preview = project?.preview;
  const previewBaseUrl = preview?.status === "ready" ? preview.url : undefined;
  const player = useWebGamePlayer(supportsPreview ? project?.id : undefined, previewBaseUrl, preview?.revision, preview?.pages?.find((page) => page.source === "player")?.path);
  const nativePreview = typeof window !== "undefined" && window.ohMyGameDesktop?.webGamePlayer?.preview;
  const gameClient = nativePreview ? player.client ?? previewClient : previewClient;
  const previewPageUrl = previewBaseUrl ? isolatedPreviewUrl(new URL(previewPath, previewBaseUrl).toString(), "editor", gameClient) : undefined;
  const currentPreviewUrl = previewBaseUrl ? isolatedPreviewUrl(new URL(actualPreviewPath, previewBaseUrl).toString(), "editor", gameClient) : undefined;
  const previewStage = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const page = preview?.pages?.find((page) => nativePreview ? page.client === gameClient : player.open ? page.source === "player" : page.client === previewClient);
    if (!page) return;
    setActualPreviewPath(page.path);
    setKnownPaths((current) => current.includes(page.path) ? current : [...current, page.path]);
  }, [preview?.pages, gameClient, previewClient, player.open, nativePreview]);

  useEffect(() => {
    setPreviewPath(project?.previewPath ?? "/");
    setActualPreviewPath(project?.previewPath ?? "/");
  }, [project?.id, project?.previewPath]);

  useEffect(() => {
    if (preview?.status !== "ready") setPreviewPath(actualPreviewPath);
  }, [preview?.status]);
  const previousPlayerOpen = useRef(false);
  useEffect(() => {
    if (!nativePreview && previousPlayerOpen.current && !player.open) {
      const page = preview?.pages?.find((page) => page.source === "player");
      if (page) { setPreviewPath(page.path); setActualPreviewPath(page.path); }
    }
    previousPlayerOpen.current = player.open;
  }, [player.open]);

  useEffect(() => {
    setViewport(project?.previewViewport ?? "fit");
  }, [project?.id, project?.previewViewport]);

  useEffect(() => {
    setKnownPaths(["/"]);
  }, [project?.id]);

  useEffect(() => {
    const watch = window.ohMyGameDesktop?.agentPlaytests;
    if (!watch) return;
    let disposed = false;
    const unsubscribe = watch.onState((state) => { if (!disposed) setAgentPlaytestWatch(state); });
    void watch.state().then((state) => { if (!disposed) setAgentPlaytestWatch(state); }).catch(() => undefined);
    return () => { disposed = true; unsubscribe(); };
  }, []);

  useEffect(() => {
    fileRequest.current += 1;
    setFiles([]);
    setSelectedCodePath(undefined);
    setSelectedFile(undefined);
    setFilesError(undefined);
  }, [project?.id]);

  useEffect(() => {
    if (!project || !(shows("code") || shows("assets"))) return;
    let disposed = false;
    const request = ++fileRequest.current;
    setFilesLoading(true);
    setFilesError(undefined);
    void listWorkspaceFiles(project.id).then(async (result) => {
      if (disposed) return;
      setFiles(result);
      if (fileRequest.current === request && shows("code") && selectedCodePath) {
        const selected = result.find((file) => file.path === selectedCodePath);
        if (selected) {
          const content = await loadWorkspaceFile(project.id, selectedCodePath, result);
          if (!disposed && fileRequest.current === request) setSelectedFile(content);
        } else {
          setSelectedCodePath(undefined);
          setSelectedFile(undefined);
        }
      }
    }).catch((cause) => {
      if (!disposed && fileRequest.current === request) setFilesError(errorMessage(cause));
    }).finally(() => {
      if (!disposed && fileRequest.current === request) setFilesLoading(false);
    });
    return () => { disposed = true; };
  }, [project?.id, shows("code"), shows("assets"), workspaceRevision, filesRevision]);

  async function selectFile(filePath: string): Promise<void> {
    if (!project) return;
    const request = ++fileRequest.current;
    setSelectedCodePath(filePath);
    setSelectedFile(undefined);
    setFilesLoading(true);
    setFilesError(undefined);
    try {
      const content = await loadWorkspaceFile(project.id, filePath, files);
      if (fileRequest.current === request) setSelectedFile(content);
    } catch (cause) {
      if (fileRequest.current === request) setFilesError(errorMessage(cause));
    } finally {
      if (fileRequest.current === request) setFilesLoading(false);
    }
  }

  useEffect(() => {
    if (!openFileRequest) return;
    if (shows("code")) {
      void selectFile(openFileRequest.path);
    } else {
      setSelectedCodePath(openFileRequest.path);
      show("code");
    }
  }, [openFileRequest?.id]);

  function navigatePreview(path: string): void {
    if (!previewBaseUrl) return;
    const nextPath = normalizePreviewPath(path);
    setPreviewPath(nextPath);
    setActualPreviewPath(nextPath);
    setKnownPaths((current) => current.includes(nextPath) ? current : [...current, nextPath]);
  }

  function refreshPreview(): void {
    if (preview?.status === "ready") {
      if (player.open) void player.reload();
      else if (nativePreview) setReload((value) => value + 1);
      else { setPreviewPath(actualPreviewPath); setReload((value) => value + 1); }
    } else if (preview?.status === "error" || preview?.status === "stopped") {
      onRestart();
    }
  }

  function playGame(): void {
    const bounds = previewStage.current?.getBoundingClientRect();
    void player.play({ path: actualPreviewPath, viewport: playerViewport(viewport, bounds) });
  }

  async function toggleAgentPlaytestWatch(): Promise<void> {
    const watch = window.ohMyGameDesktop?.agentPlaytests;
    if (!watch || agentPlaytestWatchPending) return;
    setAgentPlaytestWatchPending(true);
    try { setAgentPlaytestWatch(await watch.setVisible(!agentPlaytestWatch?.visible)); }
    catch { try { setAgentPlaytestWatch(await watch.state()); } catch {} }
    finally { setAgentPlaytestWatchPending(false); }
  }

  const picking = pickingClient !== undefined && pickingClient === gameClient;
  async function setPicking(active: boolean): Promise<void> {
    if (!project) return;
    onPickingChange?.(active ? gameClient : undefined);
    try { await setPreviewPicking(project.id, gameClient, active); }
    catch { if (active) onPickingChange?.(undefined); }
  }
  // Picking ends when the page it was in goes away.
  useEffect(() => {
    if (pickingClient !== undefined && (pickingClient !== gameClient || preview?.status !== "ready" || !shows("preview"))) {
      if (project) void setPreviewPicking(project.id, pickingClient, false).catch(() => undefined);
      onPickingChange?.(undefined);
    }
  }, [pickingClient, gameClient, preview?.status, shows("preview")]);
  useEffect(() => {
    if (!picking) return;
    const onKey = (event: globalThis.KeyboardEvent) => { if (event.key === "Escape") void setPicking(false); };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [picking]);

  const canPlay = !player.open && (!project || preview?.status === "waiting" || preview?.status === "starting");
  const settingsButton = project && !project.integration && project.pluginType?.preview !== "native" && isWebRuntimeProjectType(project.type) ? <button
    className="icon-button pane-header-action"
    type="button"
    aria-label={t("projectSettings.title")}
    data-tooltip={t("projectSettings.title")}
    onClick={() => setProjectSettingsOpen(true)}
  ><Wrench size={14} /></button> : null;
  const [codeToolbar, setCodeToolbar] = useState<HTMLDivElement | null>(null);
  const openCode = (path: string) => {
    setSelectedCodePath(path);
    show("code");
  };

  const views: Record<CodingView, { toolbar?: ReactNode; body: ReactNode } | undefined> = {
    preview: hasPreview ? {
      toolbar: supportsPreview ? <>
        <PreviewControls
          path={actualPreviewPath}
          paths={knownPaths}
          status={preview?.status}
          previewUrl={currentPreviewUrl}
          refreshDisabled={!project || preview?.status === "waiting" || preview?.status === "starting"}
          refreshLabel={preview?.status === "ready" ? t("workspace.reloadPreview") : t("workspace.restartPreview")}
          viewport={viewport}
          agentPlaytestWatch={agentPlaytestWatch}
          agentPlaytestWatchPending={agentPlaytestWatchPending}
          picking={picking}
          pickDisabled={!project || preview?.status !== "ready" || player.open}
          onOpenSettings={() => setProjectSettingsOpen(true)}
          onNavigate={navigatePreview}
          onRefresh={refreshPreview}
          onRestart={() => onRestart()}
          onTogglePicking={() => void setPicking(!picking)}
          onToggleAgentPlaytestWatch={() => void toggleAgentPlaytestWatch()}
          onViewportChange={setViewport}
        />
        <button
          className={`icon-button pane-header-action preview-play-button${player.open ? " is-active" : ""}`}
          type="button"
          aria-label={player.open ? t("workspace.returnToGame") : t("workspace.play")}
          data-tooltip={player.pending ? t("workspace.openingGame") : player.open ? t("workspace.returnToGame") : t("workspace.playInWindow")}
          disabled={player.pending || (player.checking && !player.error) || canPlay}
          onClick={playGame}
        >{player.pending ? <LoaderCircle className="spin" size={14} /> : <Play size={14} />}</button>
      </> : undefined,
      body: <>
        {supportsPreview ? (
          <div className="coding-workspace-preview-panel">
            <ErrorBoundary label={t("errorBoundary.label.preview")} resetKey={previewPageUrl}>
            <PreviewView
              project={project} client={gameClient} onAskAgent={onAskAgent} onLogs={() => setLogsOpen(true)} onOpenFile={(path) => { openCode(path); void selectFile(path); }} reload={reload} revision={workspaceRevision} url={previewPageUrl} viewport={viewport}
              pausedAfterRecovery={previewPaused}
              active={shows("preview")} playerOpen={player.open} suspended={player.suspended} pending={player.pending || player.checking}
              error={player.error} onPlay={playGame} stageRef={previewStage}
              onRetry={() => onRestart()} onSettings={() => setProjectSettingsOpen(true)}
            />
            </ErrorBoundary>
            {picking ? <span className="preview-pick-hint" role="status">{t("workspace.pickHint")}</span> : null}
          </div>
        ) : null}
      </>,
    } : undefined,
    design: project ? {
      toolbar: <div className="viewer-publish design-doc-toolbar" ref={setDocumentToolbar} />,
      body: <Suspense fallback={<div className="design-loading"><LoaderCircle className="spin" size={18} /></div>}><DesignDocumentPanel
        project={project} documents={documents} toolbarTarget={documentToolbar} referenced={referencedDocument}
        onReference={(document) => onReferenceDocument?.(document)} onQuote={(text) => onQuoteDocument?.(text)} onAskAgent={onAskAgent}
      /></Suspense>,
    } : undefined,
    canvas: project ? {
      toolbar: <div className="viewer-publish design-header-actions" ref={setDesignHeaderActions} />,
      body: <Suspense fallback={<div className="design-loading"><LoaderCircle className="spin" size={18} /></div>}><CanvasWorkspace
        project={project} documents={documents} onProjectUpdated={onProjectUpdated} headerActionsTarget={designHeaderActions} onSaveReady={registerCanvasSave} onContextChange={onDesignContextChange}
      /></Suspense>,
    } : undefined,
    code: {
      toolbar: <><div className="code-toolbar" ref={setCodeToolbar} />{settingsButton}</>,
      body: <WorkspaceFileBrowser
        toolbarTarget={codeToolbar}
        files={files}
        selectedPath={selectedCodePath}
        selectedFile={selectedFile}
        loading={filesLoading}
        error={filesError}
        onSelect={selectFile}
        projectId={project?.id}
        revision={workspaceRevision}
        filesRevision={filesRevision}
        openFileRequestId={openFileRequest?.id}
        onFilesChanged={(change) => {
          fileRequest.current += 1;
          setSelectedCodePath((current) => workspacePathAfterChange(current, change));
          setSelectedFile(undefined);
          setFilesRevision((value) => value + 1);
        }}
        onOpenExternal={project && typeof window !== "undefined" && window.ohMyGameDesktop?.openProjectFile
          ? (path, mode) => window.ohMyGameDesktop!.openProjectFile(project.id, path, mode)
          : undefined}
      />,
    },
    assets: {
      toolbar: settingsButton,
      body: <AssetsView
        key={project?.id}
        projectId={project?.id}
        files={files.filter((file) => file.mediaType && !file.directory)}
        loading={filesLoading}
        error={filesError}
        revision={workspaceRevision + filesRevision}
        onShowInCode={openCode}
      />,
    },
  };

  // Each view keeps the workspace's classes, so its styles hold inside any panel.
  // The preview logs cover the bottom of the view in sight, the game's first.
  const logsView = (["preview", "code", "assets", "canvas", "design"] as const).find((view) => views[view] && shows(view));
  const viewPane = (view: CodingView, body: ReactNode, header?: ReactNode) => (
    <section className="viewer-pane coding-workspace" data-active-tab={view} aria-label={t("workspace.label")}>
      {header}
      {body}
      {supportsPreview && logsOpen && view === logsView ? <PreviewLogs project={project} onClose={() => setLogsOpen(false)} /> : null}
    </section>
  );
  const placed = (Object.keys(views) as CodingView[]).map((view) => {
    const content = views[view];
    if (!content) return null;
    if (!panels) {
      // In place: only what shows, with its controls in a header.
      return shows(view) ? <Fragment key={view}>{viewPane(view, content.body, content.toolbar ? <header className="pane-header viewer-header"><div className="viewer-publish">{content.toolbar}</div></header> : null)}</Fragment> : null;
    }
    if (!opened.current.has(view)) return null;
    const nodes = panels.nodes[view];
    return <Fragment key={view}>
      {content.toolbar ? createPortal(<div className="viewer-publish">{content.toolbar}</div>, nodes.toolbar) : null}
      {createPortal(viewPane(view, content.body), nodes.body)}
    </Fragment>;
  });

  return (
    <>
      {placed}
      {project && publishDialog ? <PublishDialog project={project} publishing={publishing} justPublished={publishDialog === "success"} onClose={onClosePublish} onPublish={onPublish} /> : null}
      {project && projectSettingsOpen ? <ProjectSettingsDialog
        project={project}
        previewUrl={currentPreviewUrl}
        previewActions={supportsPreview ? {
          onRestart: (reinstall) => onRestart(undefined, reinstall),
          onStop: onStop ? () => { void player.close().catch(() => {}).then(onStop); } : undefined,
          onLogs: () => { setProjectSettingsOpen(false); setLogsOpen(true); },
        } : undefined}
        onClose={() => setProjectSettingsOpen(false)}
        onSaved={(updated) => onProjectUpdated?.(updated)}
      /> : null}
    </>
  );
}

function PreviewControls({
  path,
  paths,
  status,
  previewUrl,
  refreshDisabled,
  refreshLabel,
  viewport,
  agentPlaytestWatch,
  agentPlaytestWatchPending,
  picking,
  pickDisabled,
  onOpenSettings,
  onNavigate,
  onRefresh,
  onRestart,
  onTogglePicking,
  onToggleAgentPlaytestWatch,
  onViewportChange,
}: {
  path: string;
  paths: string[];
  status?: ProjectState["preview"]["status"];
  previewUrl?: string;
  refreshDisabled: boolean;
  refreshLabel: string;
  viewport: PreviewViewport;
  agentPlaytestWatch?: PlaytestWatchState;
  agentPlaytestWatchPending: boolean;
  picking: boolean;
  pickDisabled: boolean;
  onOpenSettings: () => void;
  onNavigate: (path: string) => void;
  onRefresh: () => void;
  onRestart: () => void;
  onTogglePicking: () => void;
  onToggleAgentPlaytestWatch: () => void;
  onViewportChange: (viewport: PreviewViewport) => void;
}) {
  // Like a browser's toolbar: where the preview is, then how it shows, then the rest.
  return (
    <div className="preview-controls">
      <PreviewLocation disabled={!previewUrl} path={path} paths={paths} onNavigate={onNavigate} />
      <ViewportMenu value={viewport} onChange={onViewportChange} />
      <IconButton size="sm" className="preview-pick-button" label={picking ? t("workspace.stopPicking") : t("workspace.pickElement")}
        active={picking} disabled={pickDisabled && !picking} onClick={onTogglePicking}><MousePointer2 size={14} /></IconButton>
      {/* Only while the agent plays the game, or the window was asked for, does the toggle do anything. */}
      {agentPlaytestWatch && (agentPlaytestWatch.activeSessions > 0 || agentPlaytestWatch.visible) ? (
        <Button size="sm" variant="ghost" className={`preview-agent-watch-button${agentPlaytestWatch.visible ? " is-active" : ""}`}
          aria-pressed={agentPlaytestWatch.visible} disabled={agentPlaytestWatchPending}
          title={agentPlaytestWatch.visible ? t("workspace.hidePlaytest") : t("workspace.showPlaytest")}
          icon={<Gamepad2 size={14} />} onClick={onToggleAgentPlaytestWatch}>{t("workspace.agentPlaytest")}</Button>
      ) : null}
      <IconButton size="sm" className="preview-refresh-button" label={refreshLabel} disabled={refreshDisabled} onClick={onRefresh}><RefreshCw size={14} /></IconButton>
      <DropdownMenu placement="bottom-end" trigger={(props) => <IconButton {...props} size="sm" label={t("workspace.moreActions")}><MoreHorizontal size={14} /></IconButton>} items={[
        ...(previewUrl ? [{ label: t("workspace.openInBrowser"), icon: <ExternalLink size={14} />, onSelect: () => openPreviewInBrowser(previewUrl) }] : []),
        { label: t("workspace.restartPreview"), icon: <RotateCcw size={14} />, disabled: status === "waiting" || status === "starting", onSelect: onRestart },
        "separator",
        { label: t("projectSettings.title"), icon: <Wrench size={14} />, onSelect: onOpenSettings },
      ]} />
    </div>
  );
}

/**
 * The page in the person's browser, as a client of its own: sharing the
 * editor's id would take over the editor's reload stream and element picking.
 */
function openPreviewInBrowser(url: string): void {
  const page = isolatedPreviewUrl(url, "external");
  const external = window.ohMyGameDesktop?.openExternal;
  if (external) void external(page).catch(() => undefined);
  else window.open(page, "_blank", "noopener,noreferrer");
}

function PreviewLocation({
  disabled,
  path,
  paths,
  onNavigate,
}: {
  disabled: boolean;
  path: string;
  paths: string[];
  onNavigate: (path: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const popoverId = useId();
  const normalizedQuery = query.trim() ? normalizePreviewPath(query) : undefined;
  const matchingPaths = paths.filter((knownPath) => knownPath.toLowerCase().includes(query.trim().toLowerCase()));
  const options = normalizedQuery && !matchingPaths.includes(normalizedQuery)
    ? [...matchingPaths, normalizedQuery]
    : matchingPaths;

  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  function navigate(nextPath: string): void {
    onNavigate(nextPath);
    setOpen(false);
    setQuery("");
    trigger.current?.focus();
  }

  // A game with one page at the root needs no address.
  if (path === "/" && paths.every((knownPath) => knownPath === "/")) return null;
  return (
    <div className="preview-location" ref={root}>
      <button
        ref={trigger}
        className="preview-location-trigger"
        type="button"
        aria-controls={popoverId}
        aria-expanded={open}
        aria-haspopup="dialog"
        disabled={disabled}
        onClick={() => {
          setQuery("");
          setOpen((current) => !current);
        }}
        title={path}
      >
        <span className="preview-location-path">{path}</span>
        <ChevronDown className={open ? "preview-location-chevron-open" : undefined} size={13} />
      </button>
      {open ? (
        <div className="preview-location-popover" id={popoverId} role="dialog" aria-label={t("workspace.previewPages")}>
          <form
            className="preview-location-search"
            onSubmit={(event) => {
              event.preventDefault();
              if (normalizedQuery) navigate(normalizedQuery);
            }}
          >
            <Search size={16} />
            <input
              ref={search}
              aria-label={t("workspace.findPage")}
              placeholder={t("workspace.findPage")}
              spellCheck={false}
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={(event) => {
                if (event.key !== "Enter" || !normalizedQuery) return;
                event.preventDefault();
                navigate(normalizedQuery);
              }}
            />
          </form>
          <div className="preview-location-options">
            {options.map((option) => (
              <button
                className="preview-location-option"
                type="button"
                aria-current={option === path ? "page" : undefined}
                key={option}
                onClick={() => navigate(option)}
              >
                <span>{option === path ? <Check size={14} /> : null}</span>
                <strong>{option}</strong>
              </button>
            ))}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function ViewportMenu({ value, onChange }: { value: PreviewViewport; onChange: (value: PreviewViewport) => void }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menuId = useId();

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="viewport-menu" ref={root}>
      <button
        ref={trigger}
        className="viewport-trigger"
        type="button"
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup="menu"
        aria-label={t("workspace.viewportLabel")}
        title={viewportLabel(value)}
        onClick={() => setOpen((current) => !current)}
      >
        <ViewportIcon viewport={value} />
        <ChevronDown size={11} />
      </button>
      {open ? (
        <div className="viewport-menu-popover" id={menuId} role="menu" aria-label={t("workspace.viewportLabel")}>
          {PREVIEW_VIEWPORTS.map((viewport) => (
            <button
              className="viewport-option"
              type="button"
              role="menuitemradio"
              aria-checked={viewport === value}
              key={viewport}
              onClick={() => {
                onChange(viewport);
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              <ViewportIcon viewport={viewport} />
              <span>{viewportLabel(viewport)}</span>
              {viewport === value ? <Check size={13} /> : null}
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function ViewportIcon({ viewport }: { viewport: PreviewViewport }) {
  if (viewport === "tablet") return <Tablet size={14} />;
  if (viewport === "mobile") return <Smartphone size={14} />;
  if (viewport === "mobile-landscape") return <Smartphone size={14} style={{ transform: "rotate(90deg)" }} />;
  return <Monitor size={14} />;
}

function viewportLabel(viewport: PreviewViewport): string {
  if (viewport === "tablet") return t("workspace.viewport.tablet");
  if (viewport === "mobile") return t("workspace.viewport.mobile");
  if (viewport === "mobile-landscape") return t("workspace.viewport.mobileLandscape");
  return t("projectSettings.device.fit");
}

export function playerViewport(viewport: PreviewViewport, bounds?: { width: number; height: number }): { width: number; height: number } {
  if (viewport === "mobile") return { width: 375, height: 667 };
  if (viewport === "mobile-landscape") return { width: 667, height: 375 };
  if (viewport === "tablet") return { width: 768, height: 1024 };
  const size = (value: number | undefined, fallback: number) => Math.min(8192, Math.max(240, Math.round(value || fallback)));
  return { width: size(bounds?.width, 1280), height: size(bounds?.height, 720) };
}

export function PreviewView({ project, client, onAskAgent, onOpenFile, onLogs, reload, revision, url, viewport, active = true, playerOpen = false, suspended = false, pending = false, pausedAfterRecovery = false, error, onPlay, onRetry, onSettings, stageRef }: {
  client?: string; onAskAgent?: (text: string) => void; onOpenFile?: (path: string) => void; onLogs?: () => void;
  project?: ProjectState; reload: number; revision: number; url?: string; viewport: PreviewViewport;
  active?: boolean; playerOpen?: boolean; suspended?: boolean; pending?: boolean; error?: string; onPlay?: () => void;
  pausedAfterRecovery?: boolean;
  stageRef?: React.Ref<HTMLDivElement>;
  onRetry?: () => void; onSettings?: () => void;
}) {
  const runtime = useRuntimeConnection();
  const preview = project?.preview;
  const frame = useRef<HTMLElement | null>(null);
  const native = typeof window !== "undefined" ? window.ohMyGameDesktop?.webGamePlayer?.preview : undefined;
  const captureTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [started, setStarted] = useState(active && !suspended);
  const [cover, setCover] = useState<string>();
  const diagnostic = preview?.diagnostics?.length
    ? preview.diagnostics.find((item) => native ? item.client === client : playerOpen ? item.source === "player" : item.client === client)
    : preview?.diagnostic;
  const captureBlocked = useRef(false);
  captureBlocked.current = !!diagnostic || runtime.status !== "ready";

  useEffect(() => {
    if (diagnostic || runtime.status !== "ready") clearTimeout(captureTimer.current);
  }, [diagnostic, runtime.status]);

  useEffect(() => {
    if (suspended) { if (!native) setStarted(false); clearTimeout(captureTimer.current); }
    else if (active) setStarted(true);
  }, [suspended, active]);

  useEffect(() => {
    setCover(undefined);
    if (!project || !playerOpen) return;
    let disposed = false;
    let objectUrl: string | undefined;
    void getProjectCover(project.id).then((blob) => {
      if (disposed || !blob) return;
      objectUrl = URL.createObjectURL(blob);
      setCover(objectUrl);
    }).catch(() => {});
    return () => { disposed = true; if (objectUrl) URL.revokeObjectURL(objectUrl); };
  }, [project?.id, playerOpen]);

  useEffect(() => () => clearTimeout(captureTimer.current), []);
  useEffect(() => {
    if (revision > 0 && frame.current) scheduleCoverCapture(frame.current);
  }, [revision]);

  function scheduleCoverCapture(element: HTMLElement): void {
    frame.current = element;
    clearTimeout(captureTimer.current);
    if (!project || !window.ohMyGameDesktop?.capturePage) return;
    captureTimer.current = setTimeout(() => {
      if (captureBlocked.current) return;
      void captureProjectCover(project.id, element, native ? () => native.capture(project.id) : undefined).catch(() => {});
    }, 1_000);
  }

  const showFrame = (active || started || (native && playerOpen)) && (native || !suspended) && preview?.status === "ready" && url;
  return (
    <div ref={stageRef} className={`viewer-stage viewer-stage-${viewport}`}>
      {showFrame ? <div className="preview-frame-wrap" hidden={suspended}>
        {native && project ? <DesktopGamePreview
          bridge={native} refresh={window.ohMyGameDesktop!.webGamePlayer!.refresh} projectId={project.id} url={url!} reload={reload}
          visible={active && !suspended && !diagnostic && !error && runtime.status === "ready"}
          onReady={scheduleCoverCapture}
        /> : <iframe
          ref={(element) => { frame.current = element; }}
          key={`${url}:${reload}`} className="preview-frame" src={url}
          title={t("workspace.previewTitle", { name: project?.name ?? t("workspace.project") })}
          sandbox="allow-forms allow-modals allow-pointer-lock allow-same-origin allow-scripts"
          onLoad={(event) => scheduleCoverCapture(event.currentTarget)}
        />}
      </div> : null}
      {suspended ? <div className="preview-player-state">
        {cover ? <img className="preview-player-cover" src={cover} alt="" /> : null}
        <div className="preview-empty-state">
          <div className="preview-empty-mark" aria-hidden="true">{pending ? <LoaderCircle className="spin" size={20} /> : <Play size={20} />}</div>
          <p className="preview-empty-title">{pending ? t("workspace.openingGame") : t("workspace.gameInWindow")}</p>
          <p className="preview-empty-description">{t("workspace.closeWindowHint")}</p>
          {playerOpen && onPlay ? <button type="button" className="preview-return-button" disabled={pending} onClick={onPlay}>{t("workspace.returnToGame")}</button> : null}
        </div>
      </div> : !showFrame ? <div className="preview-status-panel">
        <PreviewState status={preview?.status} error={preview?.error} phase={preview?.phase} startedAt={preview?.startedAt} />
        {(pausedAfterRecovery || preview?.stopReason === "recovery") && preview?.status === "stopped" ? <p>{t("workspace.pausedAfterRecovery")}</p> : null}
        {preview?.status === "stopped" && preview.stopReason === "manual" ? <p>{t("workspace.stoppedManual")}</p> : preview?.status === "stopped" && preview.stopReason === "idle" ? <p>{t("workspace.stoppedIdle")}</p> : preview?.status === "stopped" && project?.previewAutoStart === false ? <p>{t("workspace.autoDisabled")}</p> : null}
        {onRetry && (preview?.status === "error" || preview?.status === "stopped") ? <div className="preview-recovery-actions">
          <button type="button" disabled={runtime.status !== "ready"} onClick={onRetry}>{preview.status === "stopped" ? t("projectSettings.startPreview") : t("workspace.retryPreview")}</button>
          {onSettings ? <button type="button" onClick={onSettings}>{t("projectSettings.title")}</button> : null}
          {onLogs ? <button type="button" onClick={onLogs}>{t("workspace.viewLogs")}</button> : null}
          {preview?.error && onAskAgent ? <button type="button" onClick={() => onAskAgent(previewRepairPrompt(project, preview.error!))}>{t("workspace.askAgent")}</button> : null}
        </div> : null}
      </div> : null}
      {diagnostic ? <div className="preview-diagnostic" role="alert">
        <strong>{diagnostic.kind === "compile" ? t("workspace.compileFailed") : diagnostic.kind === "runtime" ? t("workspace.runtimeError") : t("workspace.loadFailed")}</strong>
        <details><summary>{t("common.errorDetails")}</summary><pre>{diagnostic.message}</pre></details>
        <p>{diagnostic.source === "playtest" ? t("workspace.source.playtest") : diagnostic.source === "player" ? t("workspace.source.player") : t("workspace.previewSource")}{diagnostic.path ? ` · ${diagnostic.path}` : ""}</p>
        <div className="preview-recovery-actions">
          <button type="button" onClick={() => void navigator.clipboard.writeText(diagnostic.message)}>{t("workspace.copyError")}</button>
          {onLogs ? <button type="button" onClick={onLogs}>{t("workspace.viewLogs")}</button> : null}
          {onAskAgent ? <button type="button" onClick={() => onAskAgent(previewRepairPrompt(project, diagnostic.message))}>{t("workspace.askAgent")}</button> : null}
          {onOpenFile && previewErrorFile(project, diagnostic.message) ? <button type="button" onClick={() => onOpenFile(previewErrorFile(project, diagnostic.message)!)}>{t("workspace.openSource")}</button> : null}
        </div>
      </div> : null}
      {error ? <div className="preview-player-error" role="alert">{error}</div> : null}
    </div>
  );
}

async function captureProjectCover(projectId: string, frame: HTMLElement, capture?: () => Promise<Uint8Array>): Promise<void> {
  if ((await getProjectCoverState(projectId)).mode === "custom") return;
  // A publish dialog can cover the preview in the desktop window's screenshot.
  if (document.querySelector('[role="dialog"][aria-modal="true"]')) return;
  const cover = await captureElementImage(frame, 800, undefined, capture);
  if (cover) await setProjectCover(projectId, cover, "auto");
}

export function normalizePreviewPath(value: string): string {
  const path = value.trim().replaceAll("\\", "/").replace(/^\/+/, "");
  return path ? `/${path}` : "/";
}

export function WorkspaceFileBrowser({
  files,
  selectedPath,
  selectedFile,
  loading,
  error,
  onSelect,
  onOpenExternal,
  projectId,
  revision = 0,
  filesRevision = 0,
  openFileRequestId,
  onFilesChanged = () => {},
  fileActions,
  renderFile,
  toolbarTarget,
}: {
  files: WorkspaceFile[];
  selectedPath?: string;
  selectedFile?: WorkspaceFileContent;
  loading: boolean;
  error?: string;
  onSelect: (path: string) => void;
  onOpenExternal?: (path: string, mode: ProjectFileOpenMode) => Promise<void>;
  projectId?: string;
  revision?: number;
  filesRevision?: number;
  openFileRequestId?: number;
  onFilesChanged?: (change: WorkspaceFileChange) => void;
  fileActions?: ReactNode;
  renderFile?: (file: WorkspaceFileContent) => ReactNode;
  /** The panel toolbar, where the open file's path and actions go. Without it they get a header. */
  toolbarTarget?: HTMLElement | null;
}) {
  const [searchTerm, setSearchTerm] = useState("");
  const [browserView, setBrowserView] = useState<"files" | "changes">("files");
  const [selectedGitPath, setSelectedGitPath] = useState<string>();
  const git = useWorkspaceGitChanges(projectId, revision, filesRevision);
  const showChanges = browserView === "changes" && git.data?.available;
  useEffect(() => { setBrowserView("files"); }, [projectId, openFileRequestId]);
  useEffect(() => {
    if (!git.data?.available) return;
    const items = git.data.changes;
    setSelectedGitPath((current) => items.some((item) => item.path === current) ? current : items[0]?.path);
  }, [git.data]);
  const tree = useMemo(() => workspaceFileTree(files), [files]);
  const selectedEntry = selectedPath ? files.find((file) => file.path === selectedPath && !file.directory) : undefined;
  const selectedMedia = selectedEntry && hasMediaType(selectedEntry) ? selectedEntry : undefined;
  const [treeElement, setTreeElement] = useState<HTMLDivElement | null>(null);
  const [contextMenu, setContextMenu] = useState<WorkspaceContextMenu>();
  const [entryDialog, setEntryDialog] = useState<{ kind: "rename" | "file" | "folder"; path: string }>();
  const [actionError, setActionError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const codeElement = useRef<HTMLDivElement>(null);
  const [explorerWidth, setExplorerWidth] = useState(240);
  const explorerResize = useRef<{ clientX: number; width: number }>(null);
  const treeSize = useElementSize(treeElement);
  const fileTree = useRef<TreeApi<WorkspaceFileNode>>(null);

  function finishExplorerResize(): void {
    explorerResize.current = null;
  }

  useEffect(() => {
    const tree = fileTree.current;
    if (!tree || !selectedPath || !files.some((file) => file.path === selectedPath)) return;
    let active = true;
    void tree.scrollTo(selectedPath)?.then(() => { if (active) tree.select(selectedPath, { focus: false }); });
    return () => { active = false; };
  }, [files, selectedPath, treeSize.height]);

  async function mutate(operation: () => Promise<WorkspaceFileChange>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setActionError(undefined);
    try { onFilesChanged(await operation()); }
    catch (cause) { setActionError(errorMessage(cause)); }
    finally { setBusy(false); }
  }

  function entryAction(action: WorkspaceEntryAction, entry: WorkspaceContextMenu): void {
    setContextMenu(undefined);
    setActionError(undefined);
    if (!projectId || busy) return;
    if (action === "rename") { setEntryDialog({ kind: "rename", path: entry.path }); return; }
    if (action === "new-file" || action === "new-folder") {
      const parent = entry.directory ? entry.path : entry.path.split("/").slice(0, -1).join("/");
      setEntryDialog({ kind: action === "new-file" ? "file" : "folder", path: parent });
      return;
    }
    if (action === "copy-path") {
      void navigator.clipboard.writeText(entry.path).catch((cause) => setActionError(errorMessage(cause)));
      return;
    }
    if (action === "save-library") {
      void mutate(async () => { await saveProjectAssetToLibrary(projectId, entry.path); return {}; });
      return;
    }
    if (!window.confirm(entry.directory ? t("workspace.confirmDeleteFolder", { path: entry.path }) : t("workspace.confirmDelete", { path: entry.path }))) return;
    void mutate(async () => { await deleteWorkspaceEntry(projectId, entry.path); return { from: entry.path }; });
  }
  const fileHeader = selectedFile && !showChanges ? <>
    <span className="file-content-path" title={selectedFile.path}>
      {selectedFile.path.split("/").map((part, index, parts) => index === parts.length - 1
        ? <span key={index} className="file-content-name">{part}</span>
        : <span key={index}>{part}<span className="file-content-separator">/</span></span>)}
      {selectedFile.truncated ? ` ${t("workspace.truncated")}` : ""}
    </span>
    {fileActions}
    {onOpenExternal ? <FileOpenActions path={selectedFile.path} onOpen={onOpenExternal} /> : null}
  </> : null;
  const toolbar = toolbarTarget ? createPortal(<>
    {fileHeader ?? <span className="file-content-path" />}
  </>, toolbarTarget) : null;
  if (loading && files.length === 0) return <WorkspaceState loading label={t("workspace.loadingCode")} />;
  if (error && !selectedPath) return <WorkspaceState error={error} />;
  return <>
    {toolbar}
    <div className="code-view" ref={codeElement} style={{ "--file-explorer-width": `${explorerWidth}px` } as CSSProperties}>
      <div className="file-explorer">
        {git.data?.available || git.error ? <div className="file-explorer-views">
          {git.data?.available ? <nav aria-label={t("workspace.gitViews")}>
            <button type="button" aria-pressed={!showChanges} onClick={() => setBrowserView("files")}>{t("workspace.gitFiles")}</button>
            <button type="button" aria-pressed={Boolean(showChanges)} onClick={() => { setBrowserView("changes"); git.refresh(); }}>
              {t("workspace.gitChanges")}<span className="git-change-count">{git.data.changes.length}</span>
            </button>
          </nav> : <span className="git-changes-note" role="alert">{t("workspace.gitFailed")}</span>}
          <button type="button" className="icon-button" disabled={git.loading} onClick={git.refresh}
            title={t("workspace.gitRefresh")} aria-label={t("workspace.gitRefresh")}>
            <RefreshCw size={12} className={git.loading ? "spin" : undefined} />
          </button>
        </div> : null}
        <label className="file-filter">
          <Search size={13} aria-hidden="true" />
          <input
            type="search"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder={t("workspace.filterFiles")}
            aria-label={t("workspace.filterFilesLabel")}
          />
        </label>
        {actionError ? <p className="file-action-error" role="alert">{actionError}</p> : null}
        {showChanges ? <GitChangesList data={git.data} loading={git.loading} error={git.error} search={searchTerm}
          selectedPath={selectedGitPath} onSelect={setSelectedGitPath} /> : <div className="file-tree" ref={setTreeElement} onContextMenu={(event) => {
          event.preventDefault();
          if (projectId && !busy) setContextMenu({ path: "", directory: true, x: event.clientX, y: event.clientY });
        }}>
          {treeSize.height > 0 ? (
            <Tree
              ref={fileTree}
              data={tree}
              width={treeSize.width}
              height={treeSize.height}
              rowHeight={24}
              indent={12}
              openByDefault={false}
              selection={selectedPath}
              searchTerm={searchTerm}
              searchMatch={(node, term) => node.data.name.toLocaleLowerCase().includes(term.toLocaleLowerCase())}
              disableDrag
              disableDrop
              disableEdit
              disableMultiSelection
              onActivate={(node) => {
                if (node.data.path && !node.data.directory) onSelect(node.data.path);
                else node.toggle();
              }}
              aria-label={t("workspace.files")}
            >
              {(props) => <WorkspaceTreeNode {...props} onContextMenu={projectId ? (node, event) => {
                event.preventDefault();
                event.stopPropagation();
                if (busy) return;
                if (node.data.path && !node.data.directory) onSelect(node.data.path);
                setContextMenu({
                  path: node.data.path ?? node.data.id,
                  directory: Boolean(node.data.directory || !node.isLeaf),
                  x: event.clientX,
                  y: event.clientY,
                });
              } : undefined} />}
            </Tree>
          ) : null}
        </div>}
      </div>
      <div
        className="file-explorer-resizer"
        role="separator"
        aria-label={t("workspace.resizeExplorer")}
        aria-orientation="vertical"
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          explorerResize.current = { clientX: event.clientX, width: event.currentTarget.previousElementSibling!.getBoundingClientRect().width };
          setContextMenu(undefined);
        }}
        onPointerMove={(event) => {
          const resize = explorerResize.current;
          const bounds = codeElement.current?.getBoundingClientRect();
          if (!resize || !bounds || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
          setExplorerWidth(Math.round(Math.max(140, Math.min(480, bounds.width - 241, resize.width + event.clientX - resize.clientX))));
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
          finishExplorerResize();
        }}
        onPointerCancel={finishExplorerResize}
        onLostPointerCapture={finishExplorerResize}
      />
      <div className="file-content">
        {showChanges && projectId ? <WorkspaceGitDiff key={`${projectId}:${selectedGitPath}`} projectId={projectId} path={selectedGitPath} changes={git.data} />
          : error ? <WorkspaceState error={error} /> : loading ? <WorkspaceState loading label={t("workspace.loadingFile")} /> : selectedFile ? (
          <>
            {toolbarTarget ? null : <div className="file-content-header">{fileHeader}</div>}
            {selectedMedia && projectId
              ? <WorkspaceMediaPreview projectId={projectId} file={selectedMedia} revision={revision} />
              : selectedFile.binary
              ? <WorkspaceState label={t("workspace.binaryUnavailable")} />
              : renderFile ? renderFile(selectedFile)
              : isMarkdownFile(selectedFile.path) ? <WorkspaceMarkdownPreview projectId={projectId} revision={revision} file={selectedFile} onOpenFile={onSelect} />
              : <HighlightedCode path={selectedFile.path} content={selectedFile.content ?? ""} />}
          </>
        ) : <WorkspaceState icon={<FolderOpen size={20} />} label={t("workspace.selectFile")} />}
      </div>
    </div>
    {contextMenu ? <WorkspaceTreeContextMenu menu={contextMenu} file={files.find((file) => file.path === contextMenu.path)} onClose={() => setContextMenu(undefined)} onOpen={onOpenExternal} onAction={(action) => entryAction(action, contextMenu)} /> : null}
    {entryDialog ? <ProjectRenameDialog title={entryDialog.kind === "rename" ? t("workspace.renameEntry", { name: fileName(entryDialog.path) }) : entryDialog.kind === "file" ? t("workspace.newFile") : t("workspace.newFolder")} name={entryDialog.kind === "rename" ? fileName(entryDialog.path) : ""} returnFocus={null} onClose={() => setEntryDialog(undefined)} onConfirm={(name) => {
      const entry = entryDialog;
      setEntryDialog(undefined);
      if (!projectId || !name.trim()) return;
      void mutate(async () => {
        if (entry.kind === "rename") return { from: entry.path, to: (await renameWorkspaceEntry(projectId, entry.path, name)).path };
        const created = await createWorkspaceEntry(projectId, entry.path, name, entry.kind);
        return entry.kind === "file" ? { to: created.path } : {};
      });
    }} /> : null}
  </>;
}

export function WorkspaceCodeView({ projectId, revision, openFileRequest }: { projectId: string; revision: number; openFileRequest?: { path: string; id: number } }) {
  const [filesRevision, setFilesRevision] = useState(0);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [selectedPath, setSelectedPath] = useState<string>();
  const [selectedFile, setSelectedFile] = useState<WorkspaceFileContent>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const request = useRef(0);
  const handledOpenFileRequest = useRef(openFileRequest?.id);

  useEffect(() => {
    let disposed = false;
    const currentRequest = ++request.current;
    setLoading(true);
    setError(undefined);
    void listWorkspaceFiles(projectId).then(async (result) => {
      if (disposed) return;
      setFiles(result);
      if (request.current !== currentRequest) return;
      const requestedPath = openFileRequest?.path;
      const nextPath = selectedPath && result.some((file) => file.path === selectedPath)
        ? selectedPath
        : requestedPath && result.some((file) => file.path === requestedPath)
        ? requestedPath
        : result.find((file) => !file.directory)?.path;
      setSelectedPath(nextPath);
      if (!nextPath) {
        setSelectedFile(undefined);
        return;
      }
      const content = await loadWorkspaceFile(projectId, nextPath, result);
      if (!disposed && request.current === currentRequest) setSelectedFile(content);
    }).catch((cause) => {
      if (!disposed && request.current === currentRequest) setError(errorMessage(cause));
    }).finally(() => {
      if (!disposed && request.current === currentRequest) setLoading(false);
    });
    return () => { disposed = true; };
  }, [projectId, revision, filesRevision]);

  async function selectFile(path: string): Promise<void> {
    const currentRequest = ++request.current;
    setSelectedPath(path);
    setSelectedFile(undefined);
    setLoading(true);
    setError(undefined);
    try {
      const content = await loadWorkspaceFile(projectId, path, files);
      if (request.current === currentRequest) setSelectedFile(content);
    } catch (cause) {
      if (request.current === currentRequest) setError(errorMessage(cause));
    } finally {
      if (request.current === currentRequest) setLoading(false);
    }
  }

  useEffect(() => {
    if (!openFileRequest || handledOpenFileRequest.current === openFileRequest.id) return;
    handledOpenFileRequest.current = openFileRequest.id;
    void selectFile(openFileRequest.path);
  }, [openFileRequest?.id]);

  return <WorkspaceFileBrowser
    files={files}
    selectedPath={selectedPath}
    selectedFile={selectedFile}
    loading={loading}
    error={error}
    onSelect={(path) => void selectFile(path)}
    projectId={projectId}
    revision={revision}
    filesRevision={filesRevision}
    openFileRequestId={openFileRequest?.id}
    onFilesChanged={(change) => {
      request.current += 1;
      setSelectedPath((current) => workspacePathAfterChange(current, change));
      setSelectedFile(undefined);
      setFilesRevision((value) => value + 1);
    }}
    onOpenExternal={typeof window !== "undefined" && window.ohMyGameDesktop?.openProjectFile
      ? (path, mode) => window.ohMyGameDesktop!.openProjectFile(projectId, path, mode)
      : undefined}
  />;
}

function FileOpenActions({ path, onOpen }: { path: string; onOpen: (path: string, mode: ProjectFileOpenMode) => Promise<void> }) {
  const [open, setOpen] = useState(false);
  const actions = useRef<HTMLDivElement>(null);
  const platform = typeof window === "undefined" ? "" : window.ohMyGameDesktop?.platform;
  const options = projectEntryOpenOptions(platform, false);
  const opener = useProjectEntryOpener(path, onOpen, () => setOpen(false), () => setOpen(true));

  useEffect(() => {
    if (!open) return;
    const close = (event: MouseEvent) => {
      if (!actions.current?.contains(event.target as Node)) setOpen(false);
    };
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpen(false);
    };
    document.addEventListener("mousedown", close);
    window.addEventListener("keydown", closeOnEscape);
    return () => {
      document.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", closeOnEscape);
    };
  }, [open]);

  return (
    <div className="file-open-actions" ref={actions}>
      <button type="button" disabled={opener.opening} onClick={() => void opener.choose("default")} title={t("workspace.openDefault")} aria-label={t("workspace.openDefaultLabel")}>
        <ExternalLink size={13} />
      </button>
      <button className="file-open-menu-button" type="button" onClick={() => setOpen((value) => !value)} title={t("workspace.chooseOpen")} aria-label={t("workspace.chooseOpenLabel")} aria-expanded={open} aria-haspopup="menu">
        <ChevronDown size={12} />
      </button>
      {open ? (
        <div className="file-open-menu" role="menu">
          {options.map(({ mode, label, icon: Icon }) => (
            <button type="button" role="menuitem" disabled={opener.opening} key={mode} onClick={() => void opener.choose(mode)}><Icon size={13} />{label}</button>
          ))}
          {opener.error ? <p className="file-open-error" role="alert">{opener.error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}

function WorkspaceTreeContextMenu({ menu, file, onClose, onOpen, onAction }: {
  menu: WorkspaceContextMenu;
  file?: WorkspaceFile;
  onClose: () => void;
  onOpen?: (path: string, mode: ProjectFileOpenMode) => Promise<void>;
  onAction: (action: WorkspaceEntryAction) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: menu.x, y: menu.y });
  const platform = window.ohMyGameDesktop?.platform;
  const options = onOpen && menu.path ? projectEntryOpenOptions(platform, menu.directory) : [];
  const opener = useProjectEntryOpener(menu.path, onOpen, onClose);

  useLayoutEffect(() => {
    const bounds = root.current?.getBoundingClientRect();
    if (!bounds) return;
    setPosition({
      x: Math.max(6, Math.min(menu.x, window.innerWidth - bounds.width - 6)),
      y: Math.max(6, Math.min(menu.y, window.innerHeight - bounds.height - 6)),
    });
    root.current?.focus();
  }, [menu.x, menu.y]);

  useEffect(() => {
    const closeOutside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) onClose();
    };
    const closeOnKey = (event: KeyboardEvent) => { if (event.key === "Escape") onClose(); };
    const closeOnLayout = () => onClose();
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("scroll", closeOnLayout, true);
    window.addEventListener("keydown", closeOnKey);
    window.addEventListener("resize", closeOnLayout);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("scroll", closeOnLayout, true);
      window.removeEventListener("keydown", closeOnKey);
      window.removeEventListener("resize", closeOnLayout);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={root}
      className="workspace-tree-context-menu"
      role="menu"
      aria-label={menu.directory ? t("workspace.folderActions") : t("workspace.fileActions")}
      tabIndex={-1}
      style={{ left: position.x, top: position.y }}
      onContextMenu={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        const items = [...(root.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
        if (!items.length || !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
        event.preventDefault();
        const current = items.indexOf(document.activeElement as HTMLButtonElement);
        const index = current < 0 && event.key === "ArrowUp" ? 0 : current;
        const next = event.key === "Home" ? 0 : event.key === "End" ? items.length - 1 : (index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
        items[next]?.focus();
      }}
    >
      <button type="button" role="menuitem" onClick={() => onAction("new-file")}><Plus size={14} /><span>{t("workspace.newFile")}</span></button>
      <button type="button" role="menuitem" onClick={() => onAction("new-folder")}><FolderPlus size={14} /><span>{t("workspace.newFolder")}</span></button>
      {menu.path ? <>
        <hr />
        <button type="button" role="menuitem" onClick={() => onAction("rename")}><Pencil size={14} /><span>{t("common.rename")}</span></button>
        <button type="button" role="menuitem" onClick={() => onAction("copy-path")}><Copy size={14} /><span>{t("workspace.copyPath")}</span></button>
        {file?.mediaType ? <button type="button" role="menuitem" onClick={() => onAction("save-library")}><Layers3 size={14} /><span>{t("workspace.saveToLibrary")}</span></button> : null}
      </> : null}
      {options.length ? <hr /> : null}
      {options.map(({ mode, label, icon: Icon }) => (
        <button type="button" role="menuitem" disabled={opener.opening} key={mode} onClick={() => void opener.choose(mode)}><Icon size={14} /><span>{label}</span></button>
      ))}
      {menu.path ? <><hr /><button type="button" role="menuitem" className="workspace-file-delete" onClick={() => onAction("delete")}><Trash2 size={14} /><span>{t("common.delete")}</span></button></> : null}
      {opener.error ? <p className="file-open-error" role="alert">{opener.error}</p> : null}
    </div>,
    document.body,
  );
}

function useProjectEntryOpener(
  path: string,
  onOpen: ((path: string, mode: ProjectFileOpenMode) => Promise<void>) | undefined,
  onOpened: () => void,
  onFailed?: () => void,
) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string>();

  async function choose(mode: ProjectFileOpenMode): Promise<void> {
    if (opening || !onOpen) return;
    setOpening(true);
    setError(undefined);
    try {
      await onOpen(path, mode);
      onOpened();
    } catch (cause) {
      setError(errorMessage(cause));
      onFailed?.();
    } finally {
      setOpening(false);
    }
  }

  return { opening, error, choose };
}

function projectEntryOpenOptions(platform: string | undefined, directory: boolean): Array<{ mode: ProjectFileOpenMode; label: string; icon: IconComponent }> {
  const fileManager = platform === "darwin" ? "Finder" : platform === "win32" ? t("workspace.fileExplorer") : t("workspace.fileManager");
  return [
    { mode: "default", label: directory ? t("workspace.openIn", { app: fileManager }) : t("workspace.defaultApp"), icon: ExternalLink },
    { mode: "reveal", label: directory ? t("workspace.showInFolder") : t("workspace.showIn", { app: fileManager }), icon: FolderOpen },
    { mode: "vscode", label: directory ? t("workspace.openFolderIn", { app: "VS Code" }) : t("workspace.openIn", { app: "VS Code" }), icon: Code2 },
    { mode: "zed", label: directory ? t("workspace.openFolderIn", { app: "Zed" }) : t("workspace.openIn", { app: "Zed" }), icon: Code2 },
    ...(!directory && (platform === "darwin" || platform === "win32") ? [{
      mode: "text-editor" as const,
      label: t("workspace.openIn", { app: platform === "darwin" ? t("workspace.textEdit") : t("workspace.notepad") }),
      icon: FileText,
    }] : []),
  ];
}

function WorkspaceMediaPreview({ projectId, file, revision }: {
  projectId: string;
  file: WorkspaceFile & { mediaType: NonNullable<WorkspaceFile["mediaType"]> };
  revision: number;
}) {
  const preview = useWorkspaceAssetUrl(projectId, file.path, revision);
  return (
    <div className="workspace-media-preview">
      {!preview.url && !preview.error ? <span className="workspace-media-state"><LoaderCircle className="spin" size={16} />{t("workspace.loadingPreview")}</span> : null}
      {preview.error ? <span className="workspace-media-state workspace-media-error" role="alert"><X size={16} />{preview.error}</span> : null}
      {preview.url ? <AssetMedia type={file.mediaType} url={preview.url} label={fileName(file.path)} /> : null}
    </div>
  );
}

function WorkspaceMarkdownPreview({ projectId, revision, file, onOpenFile }: {
  projectId?: string;
  revision: number;
  file: WorkspaceFileContent;
  onOpenFile: (path: string) => void;
}) {
  const baseDir = file.path.split("/").slice(0, -1).join("/");
  const renderImage = useCallback((src: string | undefined, alt: string | undefined) => (
    <WorkspaceMarkdownImage projectId={projectId} revision={revision} baseDir={baseDir} src={src} alt={alt} />
  ), [projectId, revision, baseDir]);
  return <MarkdownContent className="file-content-markdown" text={file.content ?? ""} baseDir={baseDir} onOpenWorkspaceFile={onOpenFile} renderImage={renderImage} />;
}

function WorkspaceMarkdownImage({ projectId, revision, baseDir, src, alt }: {
  projectId?: string;
  revision: number;
  baseDir: string;
  src?: string;
  alt?: string;
}) {
  const path = workspaceLinkPath(src, undefined, baseDir);
  const { url } = useWorkspaceAssetUrl(path ? projectId : undefined, path ?? "", revision);
  const external = src && /^(?:https?:|data:image\/)/i.test(src) ? src : undefined;
  const resolved = url ?? external;
  return resolved ? <img src={resolved} alt={alt ?? ""} loading="lazy" /> : <span className="file-content-markdown-image">{alt}</span>;
}

function loadWorkspaceFile(projectId: string, filePath: string, files: WorkspaceFile[]): Promise<WorkspaceFileContent> {
  const file = files.find((candidate) => candidate.path === filePath);
  if (file?.directory) return Promise.reject(new Error("Path is a directory"));
  if (file && hasMediaType(file)) {
    return Promise.resolve({ path: file.path, size: file.size, binary: true });
  }
  return getWorkspaceFile(projectId, filePath);
}

export interface WorkspaceFileNode {
  id: string;
  name: string;
  path?: string;
  directory?: true;
  children?: WorkspaceFileNode[];
}

interface MutableWorkspaceFileNode {
  id: string;
  name: string;
  path?: string;
  directory?: true;
  children: Map<string, MutableWorkspaceFileNode>;
}

function isMarkdownFile(path: string): boolean {
  const ext = path.split(".").at(-1)?.toLocaleLowerCase();
  return ext === "md" || ext === "markdown";
}

export function workspaceFileTree(files: readonly WorkspaceFile[]): WorkspaceFileNode[] {
  const roots = new Map<string, MutableWorkspaceFileNode>();
  for (const file of files) {
    const parts = file.path.split("/").filter(Boolean);
    let children = roots;
    let currentPath = "";
    for (const [index, name] of parts.entries()) {
      currentPath = currentPath ? `${currentPath}/${name}` : name;
      let node = children.get(name);
      if (!node) {
        node = { id: currentPath, name, children: new Map() };
        children.set(name, node);
      }
      if (index === parts.length - 1) {
        node.path = file.directory ? undefined : file.path;
        if (file.directory) node.directory = true;
      }
      children = node.children;
    }
  }
  return finalizeWorkspaceNodes(roots);
}

function finalizeWorkspaceNodes(nodes: Map<string, MutableWorkspaceFileNode>): WorkspaceFileNode[] {
  return [...nodes.values()]
    .sort((left, right) => Number(Boolean(left.path)) - Number(Boolean(right.path)) || left.name.localeCompare(right.name))
    .map((node) => ({
      id: node.id,
      name: node.name,
      ...(node.path ? { path: node.path } : {}),
      ...(node.directory ? { directory: true as const } : {}),
      ...(node.directory || node.children.size > 0 ? { children: finalizeWorkspaceNodes(node.children) } : {}),
    }));
}

/** A file's icon from its extension, tinted with the kind of file it is. */
function fileIcon(name: string): { icon: IconComponent; tone: string } {
  const extension = name.slice(name.lastIndexOf(".") + 1).toLowerCase();
  if (["ts", "tsx", "js", "jsx", "mjs", "cjs", "gd", "cs", "py"].includes(extension)) return { icon: FileCode2, tone: "code" };
  if (["css", "scss"].includes(extension)) return { icon: FileStyle, tone: "video" };
  if (["html", "htm"].includes(extension)) return { icon: Globe2, tone: "data" };
  if (["json", "toml", "yaml", "yml"].includes(extension)) return { icon: FileConfig, tone: "audio" };
  if (["md", "txt"].includes(extension)) return { icon: FileDocument, tone: "document" };
  if (["png", "jpg", "jpeg", "webp", "svg", "gif"].includes(extension)) return { icon: ImageIcon, tone: "image" };
  if (["mp3", "ogg", "wav"].includes(extension)) return { icon: Music2, tone: "audio" };
  return { icon: FilePlain, tone: "text" };
}

function WorkspaceTreeNode({ node, style, onContextMenu }: NodeRendererProps<WorkspaceFileNode> & {
  onContextMenu?: (node: NodeRendererProps<WorkspaceFileNode>["node"], event: React.MouseEvent<HTMLDivElement>) => void;
}) {
  const folder = Boolean(node.data.directory || !node.isLeaf);
  const expandable = Boolean(node.data.children?.length);
  return (
    <div className={`file-tree-node${node.isSelected ? " file-tree-node-selected" : ""}`} style={style} title={node.id} onContextMenu={(event) => onContextMenu?.(node, event)}>
      {expandable ? <button
        className={`file-tree-toggle${node.isOpen ? " file-tree-toggle-open" : ""}`}
        type="button"
        tabIndex={-1}
        aria-label={node.isOpen ? t("workspace.collapse", { name: node.data.name }) : t("workspace.expand", { name: node.data.name })}
        onClick={(event) => {
          event.stopPropagation();
          node.toggle();
        }}
      >
        <ChevronRight size={13} aria-hidden="true" />
      </button> : <span className="file-tree-spacer" />}
      {folder ? (
        node.isOpen
          ? <FolderOpen className="file-tree-folder-icon" size={14} aria-hidden="true" />
          : <Folder className="file-tree-folder-icon" size={14} aria-hidden="true" />
      ) : (() => {
        const { icon: Icon, tone } = fileIcon(node.data.name);
        return <Icon className={`file-tree-file-icon tone-${tone}`} size={14} aria-hidden="true" />;
      })()}
      <span>{node.data.name}</span>
    </div>
  );
}

function useElementSize(element: HTMLElement | null): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!element) return;
    // Hidden, it measures 0. Keeping the last size keeps what it holds mounted,
    // such as the file tree's open folders.
    const update = () => {
      if (!element.clientWidth && !element.clientHeight) return;
      setSize({ width: element.clientWidth, height: element.clientHeight });
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return size;
}

/** The Assets view for a workspace that does not load its file list already, such as an Interactive Story. */
export function WorkspaceAssetsView({ projectId, revision, onShowInCode }: { projectId: string; revision: number; onShowInCode: (path: string) => void }) {
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(undefined);
    void listWorkspaceFiles(projectId).then((result) => {
      if (!disposed) setFiles(result);
    }).catch((cause) => {
      if (!disposed) setError(errorMessage(cause));
    }).finally(() => {
      if (!disposed) setLoading(false);
    });
    return () => { disposed = true; };
  }, [projectId, revision]);

  return <AssetsView
    projectId={projectId}
    files={files.filter((file) => file.mediaType && !file.directory)}
    loading={loading}
    error={error}
    revision={revision}
    onShowInCode={onShowInCode}
  />;
}

export function AssetsView({
  projectId,
  files,
  loading,
  error,
  revision,
  onShowInCode,
}: {
  projectId?: string;
  files: WorkspaceFile[];
  loading: boolean;
  error?: string;
  revision: number;
  onShowInCode: (path: string) => void;
}) {
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState<string>();
  const [filters, setFilters] = useState<ProjectAssetFilters>({});
  const assets = useMemo(() => files.filter(hasMediaType).map((file) => ({ ...file, projectId: projectId ?? "", revision, referenceOnly: file.purpose === "reference" })), [files, projectId, revision]);
  // Laid out as the Library page: kind tabs with counts, the source and use
  // filters beside them, and tiles below.
  const narrowed = useMemo(() => filterAssets(assets, "all", query, filters), [assets, query, filters]);
  const visibleAssets = useMemo(() => mediaFilter === "all" ? narrowed : narrowed.filter((asset) => asset.mediaType === mediaFilter), [narrowed, mediaFilter]);
  const selectedAsset = assets.find((asset) => asset.path === selectedPath);
  const filtered = Boolean(query.trim()) || (filters.origin ?? "all") !== "all" || (filters.purpose ?? "all") !== "all";
  const resetFilters = () => { setQuery(""); setFilters({}); };

  if (loading && files.length === 0) return <WorkspaceState loading label={t("workspace.loadingAssets")} />;
  if (error) return <WorkspaceState error={error} />;
  if (!projectId || files.length === 0) return <WorkspaceState icon={<ImageIcon size={20} />} label={t("workspace.noMedia")} />;
  return (
    <div className="assets-view">
      <div className="assets-search"><SearchInput value={query} onChange={setQuery} label={t("assets.search")} placeholder={t("assets.search")} /></div>
      <div className="library-filter-row assets-filter-row">
        <Tabs variant="pills" label={t("assets.mediaTypes")} value={mediaFilter} onChange={setMediaFilter} tabs={[
          { value: "all", label: t("assets.filter.all"), icon: <Layers3 size={14} />, count: narrowed.length },
          ...ASSET_KINDS.map((kind) => ({ value: kind, label: t(`assets.filter.${kind}`), icon: <CategoryMark category={kind} />, count: narrowed.filter((asset) => asset.mediaType === kind).length })),
        ]} />
        <span className="library-filter-spacer" />
        <ProjectAssetFilterRow assets={assets} filters={filters} onChange={setFilters} />
        {filtered ? <Button size="sm" variant="ghost" onClick={resetFilters}>{t("libraryFilters.reset")}</Button> : null}
      </div>
      {visibleAssets.length ? <div className="library-tiles">{visibleAssets.map((asset) => (
        <ProjectAssetTile key={asset.path} asset={asset} selected={selectedPath === asset.path} onOpen={() => setSelectedPath(asset.path)} />
      ))}</div> : <Empty title={t("library.noMatch")} action={filtered ? <Button size="sm" onClick={resetFilters}>{t("libraryFilters.reset")}</Button> : undefined} />}
      {selectedAsset ? <WorkspaceAssetDialog
        asset={selectedAsset}
        onClose={() => setSelectedPath(undefined)}
        onShowInCode={() => { setSelectedPath(undefined); onShowInCode(selectedAsset.path); }}
      /> : null}
    </div>
  );
}

const ASSET_KINDS = ["image", "video", "audio", "model"] as const;

/** A project asset as a Library tile: its kind and where it came from below the preview. */
function ProjectAssetTile({ asset, selected, onOpen }: { asset: BrowsableAsset; selected: boolean; onOpen: () => void }) {
  const [tile, visible] = useNearViewport<HTMLButtonElement>();
  const extension = fileExtension(asset.path).slice(1).toUpperCase();
  return <MediaTile ref={tile} category={asset.mediaType} name={fileName(asset.path)} selected={selected} onClick={onOpen}
    meta={`${mediaTypeLabel(asset.mediaType)} · ${asset.referenceOnly ? t("assets.reference") : libraryAssetOriginLabel(asset.origin)}`}
    preview={asset.mediaType === "audio"
      ? <span className="library-file-mark"><CategoryMark category="audio" size={22} />{extension ? <small>{extension}</small> : null}</span>
      : <AssetThumbnail asset={asset} visible={visible} />} />;
}

function WorkspaceState({ label, error, loading, icon }: { label?: string; error?: string; loading?: boolean; icon?: React.ReactNode }) {
  return (
    <div className={`workspace-state${error ? " error-state" : ""}`} role={error ? "alert" : undefined}>
      {loading ? <LoaderCircle className="spin" size={20} /> : error ? <X size={20} /> : icon}
      <span>{error ?? label}</span>
    </div>
  );
}

function PreviewState({ status, error, phase, startedAt }: { status?: ProjectState["preview"]["status"]; error?: string; phase?: ProjectState["preview"]["phase"]; startedAt?: string }) {
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (status !== "starting" || !startedAt) return;
    const update = () => setElapsed(Math.max(0, Math.floor((Date.now() - Date.parse(startedAt)) / 1_000)));
    update(); const timer = setInterval(update, 1_000); return () => clearInterval(timer);
  }, [status, startedAt]);
  switch (status) {
    case "error": return <WorkspaceState error={error ?? t("workspace.processStopped")} />;
    case "starting": return <div className="preview-starting" role="status"><LoaderCircle className="spin" size={14} /><span>{t(`workspace.phase.${phase ?? "launching"}`)} · {elapsed}s</span></div>;
    case "waiting": return error ? <WorkspaceState label={error} /> : <PreviewEmptyState />;
    case undefined: return <PreviewEmptyState />;
    case "stopped": case "ready": return null;
    default: status satisfies never; return null;
  }
}

function PreviewLogs({ project, onClose }: { project?: ProjectState; onClose: () => void }) {
  const preview = project?.preview;
  return <aside className="preview-logs" aria-label={t("workspace.logs")}>
    <header><strong>{t("workspace.logs")}</strong><button type="button" onClick={onClose} aria-label={t("workspace.closeLogs")}><X size={14} /></button></header>
    <p>{preview?.directory ?? project?.startupDirectory ?? "."} · {preview?.command ?? t("workspace.notStarted")}</p>
    {preview?.manager ? <p>{preview.manager} · {preview.managerSource}</p> : null}
    <pre>{preview?.logs || preview?.error || t("workspace.noOutput")}</pre>
    {preview?.diagnostics?.map((diagnostic, index) => <details key={`${diagnostic.client}:${index}`}><summary>{diagnostic.source ?? t("workspace.previewSource")} · {diagnostic.path ?? "/"}</summary><pre>{diagnostic.message}</pre></details>)}
  </aside>;
}

function previewRepairPrompt(project: ProjectState | undefined, message: string): string {
  return `Please diagnose and fix this project's preview error. Preserve the configured runtime and package manager, and verify the result.\n\nStartup directory: ${project?.startupDirectory ?? "."}\nCommand: ${project?.preview.command ?? project?.startupScript ?? "dev"}\n\n${message}\n\nRecent output:\n${project?.preview.logs ?? "(none)"}`;
}

function previewErrorFile(project: ProjectState | undefined, message: string): string | undefined {
  const match = message.match(/from ["']([^"']+\.(?:[jt]sx?|css|vue|svelte))["']/) ?? message.match(/(?:^|\n)([^\n]+\.(?:[jt]sx?|css|vue|svelte|html)):\d+/);
  if (!match) return;
  const file = match[1].trim().replaceAll("\\", "/");
  const root = project?.workspacePath.replaceAll("\\", "/");
  const relative = root && file.startsWith(`${root}/`) ? file.slice(root.length + 1) : file.replace(/^\.\//, "");
  return relative.startsWith("/") || relative.split("/").includes("..") ? undefined : relative;
}

function PreviewEmptyState() {
  return (
    <div className="preview-empty-state">
      <div className="preview-empty-mark" aria-hidden="true">
        <LaptopMinimalistic size={20} />
      </div>
      <p className="preview-empty-title">{t("workspace.emptyTitle")}</p>
      <p className="preview-empty-description">{t("workspace.emptyDescription")}</p>
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
