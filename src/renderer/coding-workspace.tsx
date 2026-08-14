import {
  ExternalLink,
  FileCode2,
  Film,
  Image as ImageIcon,
  LoaderCircle,
  Music2,
  Monitor,
  RefreshCw,
  RotateCw,
  Share2,
  Smartphone,
  Tablet,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
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
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [selectedCodePath, setSelectedCodePath] = useState<string>();
  const [selectedFile, setSelectedFile] = useState<WorkspaceFileContent>();
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string>();
  const [reload, setReload] = useState(0);
  const fileRequest = useRef(0);

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

  const preview = project?.preview;
  return (
    <section className="viewer-pane coding-workspace" aria-label="Coding workspace">
      <header className="pane-header viewer-header">
        <nav className="workspace-tabs" aria-label="Workspace views">
          <Tab active={activeTab === "preview"} onClick={() => setActiveTab("preview")}>Preview</Tab>
          <Tab active={activeTab === "code"} onClick={() => setActiveTab("code")}>Code</Tab>
          <Tab active={activeTab === "assets"} onClick={() => setActiveTab("assets")}>Assets</Tab>
        </nav>
        <div className="viewer-actions">
          {activeTab === "preview" ? (
            <>
              <div className="viewport-control" aria-label="Preview viewport">
                <ViewportButton active={viewport === "fit"} label="Fit preview" onClick={() => setViewport("fit")}><Monitor size={14} /></ViewportButton>
                <ViewportButton active={viewport === "tablet"} label="Tablet preview, 768 pixels" onClick={() => setViewport("tablet")}><Tablet size={14} /></ViewportButton>
                <ViewportButton active={viewport === "mobile"} label="Mobile preview, 375 pixels" onClick={() => setViewport("mobile")}><Smartphone size={14} /></ViewportButton>
              </div>
              <button
                className="icon-button quiet-button preview-reload-button"
                type="button"
                onClick={() => setReload((value) => value + 1)}
                disabled={preview?.status !== "ready"}
                title="Reload preview"
                aria-label="Reload preview"
              >
                <RotateCw size={15} />
              </button>
              <button
                className="icon-button quiet-button preview-server-button"
                type="button"
                onClick={onRestart}
                disabled={!project || preview?.status === "waiting" || preview?.status === "starting"}
                title="Restart preview server"
                aria-label="Restart preview server"
              >
                <RefreshCw className={preview?.status === "starting" ? "spin" : undefined} size={15} />
              </button>
              <button
                className="icon-button quiet-button preview-external-button"
                type="button"
                onClick={() => preview?.url && window.open(preview.url, "_blank", "noopener,noreferrer")}
                disabled={preview?.status !== "ready"}
                title="Open preview in browser"
                aria-label="Open preview in browser"
              >
                <ExternalLink size={15} />
              </button>
            </>
          ) : null}
          <button
            className="publish-button workspace-publish-button"
            type="button"
            onClick={onPublish}
            disabled={!project || publishing || agentBusy}
            title={publishing ? "Publishing" : project?.publication ? "Publish update" : "Publish"}
            aria-label={publishing ? "Publishing" : project?.publication ? "Publish update" : "Publish"}
          >
            {publishing ? <LoaderCircle className="spin" size={14} /> : <Share2 size={14} />}
            <span>{publishing ? "Publishing" : project?.publication ? "Publish update" : "Publish"}</span>
          </button>
        </div>
      </header>

      {activeTab === "preview" ? (
        <PreviewView project={project} reload={reload} viewport={viewport} />
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

function ViewportButton({ active, label, children, onClick }: { active: boolean; label: string; children: React.ReactNode; onClick: () => void }) {
  return (
    <button
      className={`viewport-button${active ? " viewport-button-active" : ""}`}
      type="button"
      onClick={onClick}
      title={label}
      aria-label={label}
      aria-pressed={active}
    >
      {children}
    </button>
  );
}

function PreviewView({ project, reload, viewport }: { project?: ProjectState; reload: number; viewport: PreviewViewport }) {
  const preview = project?.preview;
  return (
    <div className={`viewer-stage viewer-stage-${viewport}`}>
      {preview?.status === "ready" && preview.url ? (
        <div className="preview-frame-wrap">
          <iframe
            key={`${preview.url}:${reload}`}
            className="preview-frame"
            src={preview.url}
            title={`${project?.name ?? "Project"} preview`}
            sandbox="allow-forms allow-modals allow-pointer-lock allow-same-origin allow-scripts"
          />
        </div>
      ) : <PreviewState status={preview?.status} error={preview?.error} />}
    </div>
  );
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

function PreviewState({ status, error }: { status?: string; error?: string }) {
  if (status === "error") return <WorkspaceState error={error ?? "The preview process stopped."} />;
  if (status === "stopped") return <WorkspaceState label="Preview stopped" />;
  if (status === "waiting") return <WorkspaceState label="Waiting for a runnable project" />;
  return <WorkspaceState loading label="Preparing preview" />;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
