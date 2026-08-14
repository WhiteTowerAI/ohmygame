import {
  Check,
  ChevronDown,
  ExternalLink,
  FileCode2,
  Film,
  Image as ImageIcon,
  LoaderCircle,
  Music2,
  Monitor,
  RefreshCw,
  Search,
  Share2,
  Smartphone,
  Tablet,
  X,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type { ProjectState, WorkspaceFile, WorkspaceFileContent } from "../shared/contracts.js";
import { getWorkspaceAsset, getWorkspaceFile, listWorkspaceFiles } from "./api.js";

type WorkspaceTab = "preview" | "code" | "assets";
type PreviewViewport = "fit" | "tablet" | "mobile";

interface CodingWorkspaceProps {
  project?: ProjectState;
  agentBusy: boolean;
  publishing: boolean;
  workspaceRevision: number;
  onPublish: () => void;
  onRestart: () => void;
}

export function CodingWorkspace({
  project,
  agentBusy,
  publishing,
  workspaceRevision,
  onPublish,
  onRestart,
}: CodingWorkspaceProps) {
  const [activeTab, setActiveTab] = useState<WorkspaceTab>("preview");
  const [viewport, setViewport] = useState<PreviewViewport>("fit");
  const [previewPath, setPreviewPath] = useState("/");
  const [knownPaths, setKnownPaths] = useState<string[]>(["/"]);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [selectedCodePath, setSelectedCodePath] = useState<string>();
  const [selectedFile, setSelectedFile] = useState<WorkspaceFileContent>();
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string>();
  const [reload, setReload] = useState(0);
  const fileRequest = useRef(0);
  const preview = project?.preview;
  const previewBaseUrl = preview?.status === "ready" ? preview.url : undefined;
  const previewPageUrl = previewBaseUrl ? new URL(previewPath, previewBaseUrl).toString() : undefined;

  useEffect(() => {
    setPreviewPath("/");
  }, [project?.id, previewBaseUrl]);

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
        if (result.some((file) => !file.mediaType && file.path === selectedCodePath)) {
          const content = await getWorkspaceFile(project.id, selectedCodePath);
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
  }, [project?.id, activeTab, workspaceRevision]);

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
      const content = await getWorkspaceFile(project.id, filePath);
      if (fileRequest.current === request) setSelectedFile(content);
    } catch (cause) {
      if (fileRequest.current === request) setFilesError(errorMessage(cause));
    } finally {
      if (fileRequest.current === request) setFilesLoading(false);
    }
  }

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
    <section className="viewer-pane coding-workspace" aria-label="Coding workspace">
      <header className="pane-header viewer-header">
        <nav className="workspace-tabs" aria-label="Workspace views">
          <Tab active={activeTab === "preview"} onClick={() => setActiveTab("preview")}>Preview</Tab>
          <Tab active={activeTab === "code"} onClick={() => setActiveTab("code")}>Code</Tab>
          <Tab active={activeTab === "assets"} onClick={() => setActiveTab("assets")}>Assets</Tab>
        </nav>
        <div className="viewer-controls-slot">
          {activeTab === "preview" ? (
            <PreviewControls
              path={previewPath}
              paths={knownPaths}
              previewUrl={previewPageUrl}
              refreshDisabled={!project || preview?.status === "waiting" || preview?.status === "starting"}
              refreshLabel={preview?.status === "ready" ? "Reload preview" : "Restart preview"}
              viewport={viewport}
              onOpen={() => previewPageUrl && window.open(previewPageUrl, "_blank", "noopener,noreferrer")}
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
            onClick={onPublish}
            disabled={!project || publishing || agentBusy}
            title={publishing ? "Publishing" : "Publish"}
            aria-label={publishing ? "Publishing" : "Publish"}
          >
            {publishing ? <LoaderCircle className="spin" size={14} /> : <Share2 size={14} />}
            <span>Publish</span>
          </button>
        </div>
      </header>

      {activeTab === "preview" ? (
        <PreviewView project={project} reload={reload} url={previewPageUrl} viewport={viewport} />
      ) : activeTab === "code" ? (
        <CodeView
          files={files.filter((file) => !file.mediaType)}
          selectedPath={selectedCodePath}
          selectedFile={selectedFile}
          loading={filesLoading}
          error={filesError}
          onSelect={selectFile}
        />
      ) : (
        <AssetsView
          projectId={project?.id}
          files={files.filter((file) => file.mediaType)}
          loading={filesLoading}
          error={filesError}
          revision={workspaceRevision}
        />
      )}
    </section>
  );
}

function Tab({ active, children, onClick }: { active: boolean; children: React.ReactNode; onClick: () => void }) {
  return <button className={`workspace-tab${active ? " workspace-tab-active" : ""}`} type="button" onClick={onClick}>{children}</button>;
}

function PreviewControls({
  path,
  paths,
  previewUrl,
  refreshDisabled,
  refreshLabel,
  viewport,
  onOpen,
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
  onOpen: () => void;
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
        className="icon-button quiet-button preview-external-button"
        type="button"
        onClick={onOpen}
        disabled={!previewUrl}
        title="Open preview in browser"
        aria-label="Open preview in browser"
      >
        <ExternalLink size={15} />
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

function PreviewView({ project, reload, url, viewport }: { project?: ProjectState; reload: number; url?: string; viewport: PreviewViewport }) {
  const preview = project?.preview;
  return (
    <div className={`viewer-stage viewer-stage-${viewport}`}>
      {preview?.status === "ready" && url ? (
        <div className="preview-frame-wrap">
          <iframe
            key={`${url}:${reload}`}
            className="preview-frame"
            src={url}
            title={`${project?.name ?? "Project"} preview`}
            sandbox="allow-forms allow-modals allow-pointer-lock allow-same-origin allow-scripts"
          />
        </div>
      ) : <PreviewState status={preview?.status} error={preview?.error} />}
    </div>
  );
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
}: {
  files: WorkspaceFile[];
  selectedPath?: string;
  selectedFile?: WorkspaceFileContent;
  loading: boolean;
  error?: string;
  onSelect: (path: string) => void;
}) {
  if (loading && files.length === 0) return <WorkspaceState loading label="Loading code" />;
  if (error && !selectedPath) return <WorkspaceState error={error} />;
  if (files.length === 0) return <WorkspaceState icon={<FileCode2 size={20} />} label="No code files" />;
  return (
    <div className="code-view">
      <div className="file-list">
        {files.map((file) => (
          <button
            className={`file-row${file.path === selectedPath ? " file-row-active" : ""}`}
            type="button"
            key={file.path}
            onClick={() => onSelect(file.path)}
            title={file.path}
          >
            <FileCode2 size={13} />
            <span>{file.path}</span>
          </button>
        ))}
      </div>
      <div className="file-content">
        {error ? <WorkspaceState error={error} /> : loading ? <WorkspaceState loading label="Loading file" /> : selectedFile ? (
          selectedFile.binary ? (
            <WorkspaceState label="Binary file preview is unavailable" />
          ) : (
            <>
              <div className="file-content-header">{selectedFile.path}{selectedFile.truncated ? " (truncated)" : ""}</div>
              <pre className="workspace-code">{selectedFile.content}</pre>
            </>
          )
        ) : <WorkspaceState label="Select a file" />}
      </div>
    </div>
  );
}

function AssetsView({
  projectId,
  files,
  loading,
  error,
  revision,
}: {
  projectId?: string;
  files: WorkspaceFile[];
  loading: boolean;
  error?: string;
  revision: number;
}) {
  const [selectedPath, setSelectedPath] = useState<string>();
  const selected = files.find((file) => file.path === selectedPath);

  useEffect(() => {
    if (selectedPath && !files.some((file) => file.path === selectedPath)) setSelectedPath(undefined);
  }, [files, selectedPath]);

  if (loading && files.length === 0) return <WorkspaceState loading label="Loading assets" />;
  if (error) return <WorkspaceState error={error} />;
  if (!projectId || files.length === 0) return <WorkspaceState icon={<ImageIcon size={20} />} label="No media assets" />;
  return (
    <div className="assets-view">
      <div className="asset-grid">
        {files.map((file) => (
          <button
            className={`asset-card${file.path === selectedPath ? " asset-card-active" : ""}`}
            key={file.path}
            type="button"
            onClick={() => setSelectedPath(file.path)}
            title={file.path}
          >
            <AssetThumbnail projectId={projectId} file={file} revision={revision} />
            <span>{file.path}</span>
          </button>
        ))}
      </div>
      <div className="asset-detail">
        {selected ? <AssetPreview projectId={projectId} file={selected} revision={revision} /> : <WorkspaceState label="Select an asset" />}
      </div>
    </div>
  );
}

function AssetThumbnail({ projectId, file, revision }: { projectId: string; file: WorkspaceFile; revision: number }) {
  const asset = useAssetUrl(file.mediaType === "image" ? projectId : undefined, file.path, revision);
  if (file.mediaType === "image" && asset.url) return <img src={asset.url} alt="" />;
  if (file.mediaType === "video") return <Film size={22} />;
  if (file.mediaType === "audio") return <Music2 size={22} />;
  return <ImageIcon size={22} />;
}

function AssetPreview({ projectId, file, revision }: { projectId: string; file: WorkspaceFile; revision: number }) {
  const asset = useAssetUrl(projectId, file.path, revision);
  if (asset.error) return <WorkspaceState error={asset.error} />;
  if (!asset.url) return <WorkspaceState loading label="Loading asset" />;
  return (
    <>
      <div className="file-content-header">{file.path}</div>
      <div className="asset-preview">
        {file.mediaType === "image" ? <img src={asset.url} alt={file.path} /> : null}
        {file.mediaType === "video" ? <video src={asset.url} controls /> : null}
        {file.mediaType === "audio" ? <audio src={asset.url} controls /> : null}
      </div>
    </>
  );
}

function useAssetUrl(projectId: string | undefined, filePath: string, revision: number): { url?: string; error?: string } {
  const [state, setState] = useState<{ url?: string; error?: string }>({});
  useEffect(() => {
    if (!projectId) {
      setState({});
      return;
    }
    let disposed = false;
    let objectUrl: string | undefined;
    setState({});
    void getWorkspaceAsset(projectId, filePath).then((blob) => {
      if (disposed) return;
      objectUrl = URL.createObjectURL(blob);
      setState({ url: objectUrl });
    }).catch((cause) => {
      if (!disposed) setState({ error: errorMessage(cause) });
    });
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [projectId, filePath, revision]);
  return state;
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
    case "stopped":
    case "ready":
    case undefined:
      return null;
    default:
      status satisfies never;
      return null;
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
