import {
  Check,
  ChevronDown,
  ChevronRight,
  Code2,
  ExternalLink,
  FileCode2,
  Film,
  Box,
  Folder,
  FolderOpen,
  Globe2,
  Image as ImageIcon,
  Layers3,
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
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from "react";
import { Tree, type NodeRendererProps } from "react-arborist";
import type { ProjectState, WorkspaceFile, WorkspaceFileContent } from "../shared/contracts.js";
import { getWorkspaceFile, listWorkspaceFiles, setProjectCover } from "./api.js";
import { ModelPreview } from "./model-preview.js";
import { HighlightedCode } from "./highlighted-code.js";
import { useWorkspaceAssetUrl } from "./use-workspace-asset-url.js";

type WorkspaceTab = "preview" | "code" | "assets";
type PreviewViewport = "fit" | "tablet" | "mobile";

interface CodingWorkspaceProps {
  project?: ProjectState;
  agentBusy: boolean;
  publishing: boolean;
  workspaceRevision: number;
  onPublish: () => void;
  onRestart: () => void;
  collapsedActions?: ReactNode;
}

export function CodingWorkspace({
  project,
  agentBusy,
  publishing,
  workspaceRevision,
  onPublish,
  onRestart,
  collapsedActions,
}: CodingWorkspaceProps) {
  const supportsPreview = project?.type === "web-game";
  const [activeTab, setActiveTab] = useState<WorkspaceTab>(supportsPreview ? "preview" : "code");
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
      <header className="pane-header viewer-header window-drag-handle">
        {collapsedActions}
        <nav className="workspace-tabs" aria-label="Workspace views">
          {supportsPreview ? (
            <>
              <Tab active={activeTab === "preview"} icon={<Globe2 size={14} />} label="Preview" onClick={() => setActiveTab("preview")} />
              <span className="workspace-tab-divider" aria-hidden="true" />
            </>
          ) : null}
          <Tab active={activeTab === "code"} icon={<Code2 size={15} />} label="Code" onClick={() => setActiveTab("code")} />
          <span className="workspace-tab-divider" aria-hidden="true" />
          <Tab active={activeTab === "assets"} icon={<Layers3 size={15} />} label="Assets" onClick={() => setActiveTab("assets")} />
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

      {supportsPreview && activeTab === "preview" ? (
        <PreviewView project={project} reload={reload} revision={workspaceRevision} url={previewPageUrl} viewport={viewport} />
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
    if (!project || !window.openGameDesktop?.capturePage) return;
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
  const png = await window.openGameDesktop!.capturePage({
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
}: {
  files: WorkspaceFile[];
  selectedPath?: string;
  selectedFile?: WorkspaceFileContent;
  loading: boolean;
  error?: string;
  onSelect: (path: string) => void;
}) {
  const [searchTerm, setSearchTerm] = useState("");
  const tree = useMemo(() => workspaceFileTree(files), [files]);
  const [treeElement, setTreeElement] = useState<HTMLDivElement | null>(null);
  const treeSize = useElementSize(treeElement);
  if (loading && files.length === 0) return <WorkspaceState loading label="Loading code" />;
  if (error && !selectedPath) return <WorkspaceState error={error} />;
  if (files.length === 0) return <WorkspaceState icon={<FileCode2 size={20} />} label="No code files" />;
  return (
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
                if (node.data.path) onSelect(node.data.path);
                else node.toggle();
              }}
              aria-label="Workspace files"
            >
              {WorkspaceTreeNode}
            </Tree>
          ) : null}
        </div>
      </div>
      <div className="file-content">
        {error ? <WorkspaceState error={error} /> : loading ? <WorkspaceState loading label="Loading file" /> : selectedFile ? (
          selectedFile.binary ? (
            <WorkspaceState label="Binary file preview is unavailable" />
          ) : (
            <>
              <div className="file-content-header">{selectedFile.path}{selectedFile.truncated ? " (truncated)" : ""}</div>
              <HighlightedCode path={selectedFile.path} content={selectedFile.content ?? ""} />
            </>
          )
        ) : <WorkspaceState icon={<FolderOpen size={20} />} label="Select a file from the workspace tree" />}
      </div>
    </div>
  );
}

export interface WorkspaceFileNode {
  id: string;
  name: string;
  path?: string;
  children?: WorkspaceFileNode[];
}

interface MutableWorkspaceFileNode {
  id: string;
  name: string;
  path?: string;
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
      if (index === parts.length - 1) node.path = file.path;
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
      ...(node.children.size > 0 ? { children: finalizeWorkspaceNodes(node.children) } : {}),
    }));
}

function WorkspaceTreeNode({ node, style }: NodeRendererProps<WorkspaceFileNode>) {
  return (
    <div className={`file-tree-node${node.isSelected ? " file-tree-node-selected" : ""}`} style={style} title={node.id}>
      {node.isLeaf ? <span className="file-tree-spacer" /> : (
        <button
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
        </button>
      )}
      {node.isLeaf
        ? <FileCode2 className="file-tree-file-icon" size={13} aria-hidden="true" />
        : node.isOpen
          ? <FolderOpen className="file-tree-folder-icon" size={14} aria-hidden="true" />
          : <Folder className="file-tree-folder-icon" size={14} aria-hidden="true" />}
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
  const asset = useWorkspaceAssetUrl(file.mediaType === "image" ? projectId : undefined, file.path, revision);
  if (file.mediaType === "image" && asset.url) return <img src={asset.url} alt="" />;
  if (file.mediaType === "video") return <Film size={22} />;
  if (file.mediaType === "audio") return <Music2 size={22} />;
  if (file.mediaType === "model") return <Box size={22} />;
  return <ImageIcon size={22} />;
}

function AssetPreview({ projectId, file, revision }: { projectId: string; file: WorkspaceFile; revision: number }) {
  const asset = useWorkspaceAssetUrl(projectId, file.path, revision);
  if (asset.error) return <WorkspaceState error={asset.error} />;
  if (!asset.url) return <WorkspaceState loading label="Loading asset" />;
  return (
    <>
      <div className="file-content-header">{file.path}</div>
      <div className="asset-preview">
        {file.mediaType === "image" ? <img src={asset.url} alt={file.path} /> : null}
        {file.mediaType === "video" ? <video src={asset.url} controls /> : null}
        {file.mediaType === "audio" ? <audio src={asset.url} controls /> : null}
        {file.mediaType === "model" ? <ModelPreview source={asset.url} label="3D model asset" /> : null}
      </div>
    </>
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
