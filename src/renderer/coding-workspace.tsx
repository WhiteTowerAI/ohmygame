import {
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  ExternalLink,
  FileCode2,
  FileText,
  Folder,
  FolderOpen,
  Globe2,
  Image as ImageIcon,
  LaptopMinimalistic,
  Layers3,
  LoaderCircle,
  Monitor,
  PanelToggle,
  RefreshCw,
  Search,
  Share2,
  Smartphone,
  Tablet,
  Wrench,
  X,
  type IconComponent,
} from "./icons.js";
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { Tree, type NodeRendererProps } from "react-arborist";
import type { PreviewViewport, ProjectFileOpenMode, ProjectState, WorkspaceFile, WorkspaceFileContent } from "../shared/contracts.js";
import { deleteAsset, getWorkspaceFile, listWorkspaceFiles, renameAsset, setProjectCover } from "./api.js";
import { AssetToolbar, WorkspaceAssetCard, WorkspaceAssetDialog, fileExtension, fileName, fileStem, filterAssets, hasMediaType, type BrowsableAsset, type MediaFilter } from "./asset-browser.js";
import { HighlightedCode } from "./highlighted-code.js";
import { PublishDialog, type PublishDetails } from "./publish-dialog.js";
import { ProjectSettingsDialog } from "./project-settings-dialog.js";
import { AssetMedia } from "./asset-gallery.js";
import { useWorkspaceAssetUrl } from "./use-workspace-asset-url.js";

type WorkspaceTab = "preview" | "code" | "assets";
type WorkspaceContextMenu = { path: string; directory: boolean; x: number; y: number };
interface CodingWorkspaceProps {
  project?: ProjectState;
  agentBusy: boolean;
  publishing: boolean;
  workspaceRevision: number;
  onPublish: (details: PublishDetails) => Promise<boolean>;
  onRestart: () => void;
  onProjectUpdated?: (project: ProjectState) => void;
  onClose?: () => void;
  openFileRequest?: { path: string; id: number };
}

export function CodingWorkspace({
  project,
  agentBusy,
  publishing,
  workspaceRevision,
  onPublish,
  onRestart,
  onProjectUpdated,
  onClose,
  openFileRequest,
}: CodingWorkspaceProps) {
  const supportsPreview = project?.type === "web-game";
  const publishingUnavailable = project?.type === "godot-game";
  const publishLabel = publishingUnavailable
    ? "Godot publishing is not available yet"
    : publishing ? "Publishing" : "Publish";
  const [activeTab, setActiveTab] = useState<WorkspaceTab>(supportsPreview ? "preview" : "code");
  const [viewport, setViewport] = useState<PreviewViewport>(project?.previewViewport ?? "fit");
  const [previewPath, setPreviewPath] = useState(project?.previewPath ?? "/");
  const [knownPaths, setKnownPaths] = useState<string[]>(["/"]);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [selectedCodePath, setSelectedCodePath] = useState<string>();
  const [selectedFile, setSelectedFile] = useState<WorkspaceFileContent>();
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string>();
  const [filesRevision, setFilesRevision] = useState(0);
  const [reload, setReload] = useState(0);
  const [publishDialogOpen, setPublishDialogOpen] = useState(false);
  const [projectSettingsOpen, setProjectSettingsOpen] = useState(false);
  const fileRequest = useRef(0);
  const preview = project?.preview;
  const previewBaseUrl = preview?.status === "ready" ? preview.url : undefined;
  const previewPageUrl = previewBaseUrl ? new URL(previewPath, previewBaseUrl).toString() : undefined;

  useEffect(() => {
    setPreviewPath(project?.previewPath ?? "/");
  }, [project?.id, project?.previewPath, previewBaseUrl]);

  useEffect(() => {
    setViewport(project?.previewViewport ?? "fit");
  }, [project?.id, project?.previewViewport]);

  useEffect(() => {
    setKnownPaths(["/"]);
  }, [project?.id]);

  useEffect(() => {
    if (!project || activeTab === "preview") return;
    let disposed = false;
    setFilesLoading(true);
    setFilesError(undefined);
    void listWorkspaceFiles(project.id).then(async (result) => {
      if (disposed) return;
      setFiles(result);
      if (activeTab === "code" && selectedCodePath) {
        const selected = result.find((file) => file.path === selectedCodePath);
        if (selected) {
          const content = await loadWorkspaceFile(project.id, selectedCodePath, result);
          if (!disposed) setSelectedFile(content);
        } else {
          setSelectedCodePath(undefined);
          setSelectedFile(undefined);
        }
      }
    }).catch((cause) => {
      if (!disposed) setFilesError(errorMessage(cause));
    }).finally(() => {
      if (!disposed) setFilesLoading(false);
    });
    return () => { disposed = true; };
  }, [project?.id, activeTab, workspaceRevision, filesRevision]);

  useEffect(() => {
    fileRequest.current += 1;
    setFiles([]);
    setSelectedCodePath(undefined);
    setSelectedFile(undefined);
    setFilesError(undefined);
  }, [project?.id]);

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
    if (activeTab === "code") {
      void selectFile(openFileRequest.path);
    } else {
      setSelectedCodePath(openFileRequest.path);
      setActiveTab("code");
    }
  }, [openFileRequest?.id]);

  function navigatePreview(path: string): void {
    if (!previewBaseUrl) return;
    const nextPath = normalizePreviewPath(path);
    setPreviewPath(nextPath);
    setKnownPaths((current) => current.includes(nextPath) ? current : [...current, nextPath]);
  }

  function refreshPreview(): void {
    if (preview?.status === "ready") {
      setReload((value) => value + 1);
    } else if (preview?.status === "error" || preview?.status === "stopped") {
      onRestart();
    }
  }

  return (
    <section className="viewer-pane coding-workspace" data-active-tab={activeTab} aria-label="Coding workspace">
      <header className="pane-header viewer-header window-drag-handle">
        <span className="workspace-navigation-drag-exclusion" aria-hidden="true" />
        <nav
          className="workspace-tabs"
          data-active-tab={activeTab}
          data-tab-count={supportsPreview ? 3 : 2}
          aria-label="Workspace views"
        >
          {supportsPreview ? (
            <Tab active={activeTab === "preview"} icon={<Globe2 size={14} />} label="Preview" onClick={() => setActiveTab("preview")} />
          ) : null}
          <Tab active={activeTab === "code"} icon={<Code2 size={15} />} label="Code" onClick={() => setActiveTab("code")} />
          <Tab active={activeTab === "assets"} icon={<Layers3 size={15} />} label="Library" onClick={() => setActiveTab("assets")} />
        </nav>
        <div className="viewer-controls-slot">
          {supportsPreview && activeTab === "preview" ? (
            <PreviewControls
              path={previewPath}
              paths={knownPaths}
              previewUrl={previewPageUrl}
              refreshDisabled={!project || preview?.status === "waiting" || preview?.status === "starting"}
              refreshLabel={preview?.status === "ready" ? "Reload preview" : "Restart preview"}
              viewport={viewport}
              onOpenSettings={() => setProjectSettingsOpen(true)}
              onNavigate={navigatePreview}
              onRefresh={refreshPreview}
              onViewportChange={setViewport}
            />
          ) : null}
        </div>
        <div className="viewer-publish">
          <button
            className="publish-button workspace-publish-button"
            type="button"
            onClick={() => setPublishDialogOpen(true)}
            disabled={!project || publishingUnavailable || publishing || agentBusy}
            title={publishLabel}
            aria-label={publishLabel}
          >
            {publishing ? <LoaderCircle className="spin" size={14} /> : <Share2 size={14} />}
            <span>Publish</span>
          </button>
          {onClose ? (
            <button
              className="icon-button pane-header-action"
              type="button"
              onClick={onClose}
              title="Hide workspace"
              aria-label="Hide workspace"
            >
              <PanelToggle size={14} />
            </button>
          ) : null}
        </div>
      </header>

      {supportsPreview ? (
        <div
          className="coding-workspace-preview-panel"
          hidden={activeTab !== "preview"}
          aria-hidden={activeTab !== "preview"}
        >
          <PreviewView project={project} reload={reload} revision={workspaceRevision} url={previewPageUrl} viewport={viewport} />
        </div>
      ) : null}
      {activeTab === "code" ? (
        <CodeView
          files={files}
          selectedPath={selectedCodePath}
          selectedFile={selectedFile}
          loading={filesLoading}
          error={filesError}
          onSelect={selectFile}
          projectId={project?.id}
          revision={workspaceRevision}
          onOpenExternal={project && typeof window !== "undefined" && window.ohMyGameDesktop?.openProjectFile
            ? (path, mode) => window.ohMyGameDesktop!.openProjectFile(project.id, path, mode)
            : undefined}
        />
      ) : activeTab === "assets" ? (
        <AssetsView
          projectId={project?.id}
          files={files.filter((file) => file.mediaType && !file.directory)}
          loading={filesLoading}
          error={filesError}
          revision={workspaceRevision}
          onFilesChanged={() => setFilesRevision((value) => value + 1)}
        />
      ) : null}
      {project && publishDialogOpen ? <PublishDialog project={project} publishing={publishing} onClose={() => setPublishDialogOpen(false)} onPublish={onPublish} /> : null}
      {project && projectSettingsOpen ? <ProjectSettingsDialog project={project} previewUrl={previewPageUrl} onClose={() => setProjectSettingsOpen(false)} onSaved={async (updated) => {
        const restartRequired = updated.startupDirectory !== project.startupDirectory ||
          updated.startupScript !== project.startupScript || updated.packageManager !== project.packageManager;
        onProjectUpdated?.(updated);
        if (restartRequired) onRestart();
      }} /> : null}
    </section>
  );
}

function Tab({ active, icon, label, onClick }: { active: boolean; icon: React.ReactNode; label: string; onClick: () => void }) {
  return (
    <button
      className={`workspace-tab${active ? " workspace-tab-active" : ""}`}
      type="button"
      aria-pressed={active}
      title={label}
      onClick={onClick}
    >
      {icon}
      <span>{label}</span>
    </button>
  );
}

function PreviewControls({
  path,
  paths,
  previewUrl,
  refreshDisabled,
  refreshLabel,
  viewport,
  onOpenSettings,
  onNavigate,
  onRefresh,
  onViewportChange,
}: {
  path: string;
  paths: string[];
  previewUrl?: string;
  refreshDisabled: boolean;
  refreshLabel: string;
  viewport: PreviewViewport;
  onOpenSettings: () => void;
  onNavigate: (path: string) => void;
  onRefresh: () => void;
  onViewportChange: (viewport: PreviewViewport) => void;
}) {
  return (
    <div className="preview-controls">
      <ViewportMenu value={viewport} onChange={onViewportChange} />
      <PreviewLocation
        disabled={!previewUrl}
        path={path}
        paths={paths}
        refreshDisabled={refreshDisabled}
        refreshLabel={refreshLabel}
        onNavigate={onNavigate}
        onRefresh={onRefresh}
      />
      <button
        className="icon-button quiet-button preview-settings-button"
        type="button"
        onClick={onOpenSettings}
        title="Project settings"
        aria-label="Project settings"
      >
        <Wrench size={15} />
      </button>
    </div>
  );
}

function PreviewLocation({
  disabled,
  path,
  paths,
  refreshDisabled,
  refreshLabel,
  onNavigate,
  onRefresh,
}: {
  disabled: boolean;
  path: string;
  paths: string[];
  refreshDisabled: boolean;
  refreshLabel: string;
  onNavigate: (path: string) => void;
  onRefresh: () => void;
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

  return (
    <div className="preview-location" ref={root}>
      <button
        className="preview-location-refresh"
        type="button"
        onClick={onRefresh}
        disabled={refreshDisabled}
        title={refreshLabel}
        aria-label={refreshLabel}
      >
        <RefreshCw size={15} />
      </button>
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
        <div className="preview-location-popover" id={popoverId} role="dialog" aria-label="Preview pages">
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
              aria-label="Find page or enter path"
              placeholder="Find page or enter path"
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
        aria-label="Preview viewport"
        title={viewportLabel(value)}
        onClick={() => setOpen((current) => !current)}
      >
        <ViewportIcon viewport={value} />
        <ChevronDown size={11} />
      </button>
      {open ? (
        <div className="viewport-menu-popover" id={menuId} role="menu" aria-label="Preview viewport">
          {(["fit", "tablet", "mobile"] as const).map((viewport) => (
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
  return <Monitor size={14} />;
}

function viewportLabel(viewport: PreviewViewport): string {
  if (viewport === "tablet") return "Tablet · 768px";
  if (viewport === "mobile") return "Mobile · 375px";
  return "Fit";
}

function PreviewView({ project, reload, revision, url, viewport }: { project?: ProjectState; reload: number; revision: number; url?: string; viewport: PreviewViewport }) {
  const preview = project?.preview;
  const frame = useRef<HTMLIFrameElement>(null);
  const captureTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => () => clearTimeout(captureTimer.current), []);
  useEffect(() => {
    if (revision > 0 && frame.current) scheduleCoverCapture(frame.current);
  }, [revision]);

  function scheduleCoverCapture(frame: HTMLIFrameElement): void {
    clearTimeout(captureTimer.current);
    if (!project || !window.ohMyGameDesktop?.capturePage) return;
    captureTimer.current = setTimeout(() => {
      void captureProjectCover(project.id, frame).catch(() => {});
    }, 1_000);
  }

  return (
    <div className={`viewer-stage viewer-stage-${viewport}`}>
      {preview?.status === "ready" && url ? (
        <div className="preview-frame-wrap">
          <iframe
            ref={frame}
            key={`${url}:${reload}`}
            className="preview-frame"
            src={url}
            title={`${project?.name ?? "Project"} preview`}
            sandbox="allow-forms allow-modals allow-pointer-lock allow-same-origin allow-scripts"
            onLoad={(event) => scheduleCoverCapture(event.currentTarget)}
          />
        </div>
      ) : <PreviewState status={preview?.status} error={preview?.error} />}
    </div>
  );
}

async function captureProjectCover(projectId: string, frame: HTMLIFrameElement): Promise<void> {
  const bounds = frame.getBoundingClientRect();
  if (bounds.width < 1 || bounds.height < 1) return;
  const png = await window.ohMyGameDesktop!.capturePage({
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
  });
  const image = await createImageBitmap(new Blob([png as BlobPart], { type: "image/png" }));
  try {
    const width = Math.min(800, image.width);
    const height = Math.max(1, Math.round(image.height * width / image.width));
    const canvas = document.createElement("canvas");
    canvas.width = width;
    canvas.height = height;
    canvas.getContext("2d")?.drawImage(image, 0, 0, width, height);
    const cover = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/webp", 0.8));
    if (cover) await setProjectCover(projectId, cover);
  } finally {
    image.close();
  }
}

export function normalizePreviewPath(value: string): string {
  const path = value.trim().replaceAll("\\", "/").replace(/^\/+/, "");
  return path ? `/${path}` : "/";
}

function CodeView({
  files,
  selectedPath,
  selectedFile,
  loading,
  error,
  onSelect,
  onOpenExternal,
  projectId,
  revision = 0,
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
}) {
  const [searchTerm, setSearchTerm] = useState("");
  const tree = useMemo(() => workspaceFileTree(files), [files]);
  const selectedEntry = selectedPath ? files.find((file) => file.path === selectedPath && !file.directory) : undefined;
  const selectedMedia = selectedEntry && hasMediaType(selectedEntry) ? selectedEntry : undefined;
  const [treeElement, setTreeElement] = useState<HTMLDivElement | null>(null);
  const [contextMenu, setContextMenu] = useState<WorkspaceContextMenu>();
  const treeSize = useElementSize(treeElement);
  if (loading && files.length === 0) return <WorkspaceState loading label="Loading code" />;
  if (error && !selectedPath) return <WorkspaceState error={error} />;
  if (files.length === 0) return <WorkspaceState icon={<FileCode2 size={20} />} label="No workspace files" />;
  return <>
    <div className="code-view">
      <div className="file-explorer">
        <label className="file-filter">
          <Search size={13} aria-hidden="true" />
          <input
            type="search"
            value={searchTerm}
            onChange={(event) => setSearchTerm(event.target.value)}
            placeholder="Filter files…"
            aria-label="Filter workspace files"
          />
        </label>
        <div className="file-tree" ref={setTreeElement}>
          {treeSize.height > 0 ? (
            <Tree
              data={tree}
              width={treeSize.width}
              height={treeSize.height}
              rowHeight={26}
              indent={15}
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
              aria-label="Workspace files"
            >
              {(props) => <WorkspaceTreeNode {...props} onContextMenu={onOpenExternal ? (node, event) => {
                event.preventDefault();
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
        </div>
      </div>
      <div className="file-content">
        {error ? <WorkspaceState error={error} /> : loading ? <WorkspaceState loading label="Loading file" /> : selectedFile ? (
          <>
            <div className="file-content-header">
              <span className="file-content-path" title={selectedFile.path}>{selectedFile.path}{selectedFile.truncated ? " (truncated)" : ""}</span>
              {onOpenExternal ? <FileOpenActions path={selectedFile.path} onOpen={onOpenExternal} /> : null}
            </div>
            {selectedMedia && projectId
              ? <WorkspaceMediaPreview projectId={projectId} file={selectedMedia} revision={revision} />
              : selectedFile.binary
              ? <WorkspaceState label="Binary file preview is unavailable" />
              : <HighlightedCode path={selectedFile.path} content={selectedFile.content ?? ""} />}
          </>
        ) : <WorkspaceState icon={<FolderOpen size={20} />} label="Select a file from the workspace tree" />}
      </div>
    </div>
    {contextMenu && onOpenExternal ? <WorkspaceTreeContextMenu menu={contextMenu} onClose={() => setContextMenu(undefined)} onOpen={onOpenExternal} /> : null}
  </>;
}

export function WorkspaceCodeView({ projectId, revision, openFileRequest }: { projectId: string; revision: number; openFileRequest?: { path: string; id: number } }) {
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [selectedPath, setSelectedPath] = useState<string>();
  const [selectedFile, setSelectedFile] = useState<WorkspaceFileContent>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string>();
  const request = useRef(0);
  const handledOpenFileRequest = useRef(openFileRequest?.id);

  useEffect(() => {
    let disposed = false;
    setLoading(true);
    setError(undefined);
    void listWorkspaceFiles(projectId).then(async (result) => {
      if (disposed) return;
      setFiles(result);
      const requestedPath = openFileRequest?.path;
      const nextPath = requestedPath && result.some((file) => file.path === requestedPath)
        ? requestedPath
        : selectedPath && result.some((file) => file.path === selectedPath)
        ? selectedPath
        : result.find((file) => file.path === "story.json" && !file.directory)?.path ?? result.find((file) => !file.directory)?.path;
      setSelectedPath(nextPath);
      if (!nextPath) {
        setSelectedFile(undefined);
        return;
      }
      const content = await loadWorkspaceFile(projectId, nextPath, result);
      if (!disposed) setSelectedFile(content);
    }).catch((cause) => {
      if (!disposed) setError(errorMessage(cause));
    }).finally(() => {
      if (!disposed) setLoading(false);
    });
    return () => { disposed = true; };
  }, [projectId, revision]);

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

  return <CodeView
    files={files}
    selectedPath={selectedPath}
    selectedFile={selectedFile}
    loading={loading}
    error={error}
    onSelect={(path) => void selectFile(path)}
    projectId={projectId}
    revision={revision}
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
      <button type="button" disabled={opener.opening} onClick={() => void opener.choose("default")} title="Open in default app" aria-label="Open file in default app">
        <ExternalLink size={13} />
      </button>
      <button className="file-open-menu-button" type="button" onClick={() => setOpen((value) => !value)} title="Choose how to open" aria-label="Choose how to open file" aria-expanded={open} aria-haspopup="menu">
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

function WorkspaceTreeContextMenu({ menu, onClose, onOpen }: {
  menu: WorkspaceContextMenu;
  onClose: () => void;
  onOpen: (path: string, mode: ProjectFileOpenMode) => Promise<void>;
}) {
  const root = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ x: menu.x, y: menu.y });
  const platform = window.ohMyGameDesktop?.platform;
  const options = projectEntryOpenOptions(platform, menu.directory);
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
      aria-label={menu.directory ? "Folder actions" : "File actions"}
      tabIndex={-1}
      style={{ left: position.x, top: position.y }}
      onContextMenu={(event) => event.preventDefault()}
    >
      {options.map(({ mode, label, icon: Icon }) => (
        <button type="button" role="menuitem" disabled={opener.opening} key={mode} onClick={() => void opener.choose(mode)}><Icon size={14} /><span>{label}</span></button>
      ))}
      {opener.error ? <p className="file-open-error" role="alert">{opener.error}</p> : null}
    </div>,
    document.body,
  );
}

function useProjectEntryOpener(
  path: string,
  onOpen: (path: string, mode: ProjectFileOpenMode) => Promise<void>,
  onOpened: () => void,
  onFailed?: () => void,
) {
  const [opening, setOpening] = useState(false);
  const [error, setError] = useState<string>();

  async function choose(mode: ProjectFileOpenMode): Promise<void> {
    if (opening) return;
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
  const fileManager = platform === "darwin" ? "Finder" : platform === "win32" ? "File Explorer" : "file manager";
  return [
    { mode: "default", label: directory ? `Open in ${fileManager}` : "Default app", icon: ExternalLink },
    { mode: "reveal", label: directory ? "Show in enclosing folder" : `Show in ${fileManager}`, icon: FolderOpen },
    { mode: "vscode", label: directory ? "Open folder in VS Code" : "Open in VS Code", icon: Code2 },
    { mode: "zed", label: directory ? "Open folder in Zed" : "Open in Zed", icon: Code2 },
    ...(!directory && (platform === "darwin" || platform === "win32") ? [{
      mode: "text-editor" as const,
      label: platform === "darwin" ? "Open in TextEdit" : "Open in Notepad",
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
      {!preview.url && !preview.error ? <span className="workspace-media-state"><LoaderCircle className="spin" size={16} />Loading preview</span> : null}
      {preview.error ? <span className="workspace-media-state workspace-media-error" role="alert"><X size={16} />{preview.error}</span> : null}
      {preview.url ? <AssetMedia type={file.mediaType} url={preview.url} label={fileName(file.path)} /> : null}
    </div>
  );
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
        aria-label={node.isOpen ? `Collapse ${node.data.name}` : `Expand ${node.data.name}`}
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
      ) : (
        <>
          <FileCode2 className="file-tree-file-icon" size={13} aria-hidden="true" />
        </>
      )}
      <span>{node.data.name}</span>
    </div>
  );
}

function useElementSize(element: HTMLElement | null): { width: number; height: number } {
  const [size, setSize] = useState({ width: 0, height: 0 });
  useEffect(() => {
    if (!element) return;
    const update = () => setSize({ width: element.clientWidth, height: element.clientHeight });
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [element]);
  return size;
}

function AssetsView({
  projectId,
  files,
  loading,
  error,
  revision,
  onFilesChanged,
}: {
  projectId?: string;
  files: WorkspaceFile[];
  loading: boolean;
  error?: string;
  revision: number;
  onFilesChanged: () => void;
}) {
  const [mediaFilter, setMediaFilter] = useState<MediaFilter>("all");
  const [query, setQuery] = useState("");
  const [selectedPath, setSelectedPath] = useState<string>();
  const [actionError, setActionError] = useState<string>();
  const assets = useMemo(() => files.filter(hasMediaType).map((file) => ({ ...file, projectId: projectId ?? "", revision })), [files, projectId, revision]);
  const visibleAssets = useMemo(() => filterAssets(assets, mediaFilter, query), [assets, mediaFilter, query]);
  const selectedAsset = assets.find((asset) => asset.path === selectedPath);

  async function runAssetAction(action: () => Promise<unknown>): Promise<void> {
    setActionError(undefined);
    try {
      await action();
      onFilesChanged();
    } catch (cause) {
      setActionError(errorMessage(cause));
    }
  }

  function rename(asset: BrowsableAsset): boolean {
    const extension = fileExtension(asset.path);
    const name = window.prompt(`Rename asset (${extension} is preserved)`, fileStem(asset.path))?.trim();
    if (!name || name === fileStem(asset.path)) return false;
    void runAssetAction(() => renameAsset(asset.projectId!, asset.path, name));
    return true;
  }

  function remove(asset: BrowsableAsset): boolean {
    if (!window.confirm(`Delete “${fileName(asset.path)}”? This may break references in the project and cannot be undone.`)) return false;
    void runAssetAction(() => deleteAsset(asset.projectId!, asset.path));
    return true;
  }

  if (loading && files.length === 0) return <WorkspaceState loading label="Loading assets" />;
  if (error) return <WorkspaceState error={error} />;
  if (!projectId || files.length === 0) return <WorkspaceState icon={<ImageIcon size={20} />} label="No media assets" />;
  return (
    <div className="assets-view">
      <div className="assets-toolbar">
        <AssetToolbar mediaFilter={mediaFilter} query={query} onMediaFilterChange={setMediaFilter} onQueryChange={setQuery} />
      </div>
      {actionError ? <p className="library-action-error" role="alert">{actionError}</p> : null}
      {visibleAssets.length ? <div className="library-grid assets-grid">{visibleAssets.map((asset) => (
        <WorkspaceAssetCard key={asset.path} asset={asset} onOpen={() => setSelectedPath(asset.path)} onRename={() => rename(asset)} onDelete={() => remove(asset)} />
      ))}</div> : <WorkspaceState icon={<ImageIcon size={20} />} label="No assets match these filters" />}
      {selectedAsset ? <WorkspaceAssetDialog
        asset={selectedAsset}
        onClose={() => setSelectedPath(undefined)}
        onRename={() => { if (rename(selectedAsset)) setSelectedPath(undefined); }}
        onDelete={() => { if (remove(selectedAsset)) setSelectedPath(undefined); }}
      /> : null}
    </div>
  );
}

function WorkspaceState({ label, error, loading, icon }: { label?: string; error?: string; loading?: boolean; icon?: React.ReactNode }) {
  return (
    <div className={`workspace-state${error ? " error-state" : ""}`} role={error ? "alert" : undefined}>
      {loading ? <LoaderCircle className="spin" size={20} /> : error ? <X size={20} /> : icon}
      <span>{error ?? label}</span>
    </div>
  );
}

function PreviewState({ status, error }: { status?: ProjectState["preview"]["status"]; error?: string }) {
  switch (status) {
    case "error":
      return <WorkspaceState error={error ?? "The preview process stopped."} />;
    case "starting":
      return (
        <div className="preview-starting" role="status">
          <LoaderCircle className="spin" size={14} />
          <span>Starting preview</span>
        </div>
      );
    case "waiting":
    case undefined:
      return <PreviewEmptyState />;
    case "stopped":
    case "ready":
      return null;
    default:
      status satisfies never;
      return null;
  }
}

function PreviewEmptyState() {
  return (
    <div className="preview-empty-state">
      <div className="preview-empty-mark" aria-hidden="true">
        <LaptopMinimalistic size={20} />
      </div>
      <p className="preview-empty-title">Preview will appear here</p>
      <p className="preview-empty-description">Describe your game in the agent panel to create a playable build.</p>
    </div>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
