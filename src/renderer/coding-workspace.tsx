import {
  ExternalLink,
  FileCode2,
  GitCompareArrows,
  LoaderCircle,
  Monitor,
  RefreshCw,
  RotateCw,
  Share2,
  Smartphone,
  Tablet,
  TerminalSquare,
  X,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { PreviewLogLine, ProjectState, WorkspaceChanges, WorkspaceFile, WorkspaceFileContent } from "../shared/contracts.js";
import { getPreviewLogs, getWorkspaceChanges, getWorkspaceFile, listWorkspaceFiles } from "./api.js";

type WorkspaceTab = "preview" | "changes" | "files" | "logs";
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
  const [changes, setChanges] = useState<WorkspaceChanges>();
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [selectedPath, setSelectedPath] = useState<string>();
  const [selectedFile, setSelectedFile] = useState<WorkspaceFileContent>();
  const [logs, setLogs] = useState<PreviewLogLine[]>([]);
  const [changesLoading, setChangesLoading] = useState(false);
  const [changesError, setChangesError] = useState<string>();
  const [filesLoading, setFilesLoading] = useState(false);
  const [filesError, setFilesError] = useState<string>();
  const [logsError, setLogsError] = useState<string>();
  const [reload, setReload] = useState(0);
  const fileRequest = useRef(0);

  useEffect(() => {
    if (!project) return;
    let disposed = false;
    setChangesLoading(true);
    setChangesError(undefined);
    void getWorkspaceChanges(project.id).then((result) => {
      if (!disposed) setChanges(result);
    }).catch((cause) => {
      if (!disposed) setChangesError(errorMessage(cause));
    }).finally(() => {
      if (!disposed) setChangesLoading(false);
    });
    return () => { disposed = true; };
  }, [project?.id, workspaceRevision]);

  useEffect(() => {
    if (!project || activeTab !== "files") return;
    let disposed = false;
    setFilesLoading(true);
    setFilesError(undefined);
    void listWorkspaceFiles(project.id).then(async (result) => {
      if (disposed) return;
      setFiles(result);
      if (selectedPath) {
        if (result.some((file) => file.path === selectedPath)) {
          const content = await getWorkspaceFile(project.id, selectedPath);
          if (!disposed) setSelectedFile(content);
        } else {
          setSelectedPath(undefined);
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
    if (!project || activeTab !== "logs") return;
    const projectId = project.id;
    let disposed = false;
    async function refreshLogs() {
      try {
        const result = await getPreviewLogs(projectId);
        if (!disposed) {
          setLogs(result);
          setLogsError(undefined);
        }
      } catch (cause) {
        if (!disposed) setLogsError(errorMessage(cause));
      }
    }
    void refreshLogs();
    const interval = window.setInterval(() => void refreshLogs(), 1_000);
    return () => { disposed = true; window.clearInterval(interval); };
  }, [project?.id, activeTab]);

  async function selectFile(filePath: string): Promise<void> {
    if (!project) return;
    const request = ++fileRequest.current;
    setSelectedPath(filePath);
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
          <Tab active={activeTab === "changes"} onClick={() => setActiveTab("changes")}>
            Changes{changes?.files.length ? ` ${changes.files.length}` : ""}
          </Tab>
          <Tab active={activeTab === "files"} onClick={() => setActiveTab("files")}>Files</Tab>
          <Tab active={activeTab === "logs"} onClick={() => setActiveTab("logs")}>Logs</Tab>
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
      ) : activeTab === "changes" ? (
        <ChangesView changes={changes} loading={changesLoading} error={changesError} />
      ) : activeTab === "files" ? (
        <FilesView
          files={files}
          selectedPath={selectedPath}
          selectedFile={selectedFile}
          loading={filesLoading}
          error={filesError}
          onSelect={selectFile}
        />
      ) : (
        <LogsView logs={logs} error={logsError} />
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

function ChangesView({ changes, loading, error }: { changes?: WorkspaceChanges; loading: boolean; error?: string }) {
  if (error) return <WorkspaceState error={error} />;
  if (loading && !changes) return <WorkspaceState loading label="Loading changes" />;
  if (!changes?.files.length) return <WorkspaceState icon={<GitCompareArrows size={20} />} label="No changes" />;
  return (
    <div className="changes-view">
      <div className="changes-list">
        {changes.files.map((file) => (
          <div className="change-row" key={`${file.previousPath ?? ""}:${file.path}`} title={file.path}>
            <span className={`change-status change-status-${file.status}`}>{statusLetter(file.status)}</span>
            <span>{file.path}</span>
          </div>
        ))}
      </div>
      <pre className="workspace-code">{changes.diff || "No text diff available."}{changes.truncated ? "\n\n... diff truncated" : ""}</pre>
    </div>
  );
}

function FilesView({
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
  if (loading && files.length === 0) return <WorkspaceState loading label="Loading files" />;
  if (error && !selectedPath) return <WorkspaceState error={error} />;
  if (files.length === 0) return <WorkspaceState icon={<FileCode2 size={20} />} label="Workspace is empty" />;
  return (
    <div className="files-view">
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

function LogsView({ logs, error }: { logs: PreviewLogLine[]; error?: string }) {
  const container = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  useEffect(() => {
    const element = container.current;
    if (element && follow.current) element.scrollTop = element.scrollHeight;
  }, [logs]);
  if (error) return <WorkspaceState error={error} />;
  if (logs.length === 0) return <WorkspaceState icon={<TerminalSquare size={20} />} label="No preview logs" />;
  return (
    <div
      className="logs-view"
      ref={container}
      onScroll={(event) => {
        const element = event.currentTarget;
        follow.current = element.scrollHeight - element.scrollTop - element.clientHeight < 48;
      }}
    >
      {logs.map((line) => (
        <div className={`log-line log-line-${line.stream}`} key={line.id}>
          <span>{line.stream === "stderr" ? "err" : "out"}</span>
          <pre>{line.text || " "}</pre>
        </div>
      ))}
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

function PreviewState({ status, error }: { status?: string; error?: string }) {
  if (status === "error") return <WorkspaceState error={error ?? "The preview process stopped."} />;
  if (status === "stopped") return <WorkspaceState label="Preview stopped" />;
  if (status === "waiting") return <WorkspaceState label="Waiting for a runnable project" />;
  return <WorkspaceState loading label="Preparing preview" />;
}

function statusLetter(status: string): string {
  if (status === "added") return "A";
  if (status === "deleted") return "D";
  if (status === "renamed") return "R";
  return "M";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
