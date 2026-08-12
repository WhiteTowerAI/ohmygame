import {
  ArrowLeft,
  ArrowUp,
  Check,
  FilePenLine,
  FileText,
  LoaderCircle,
  RefreshCw,
  Search,
  Share2,
  Square,
  Terminal,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { useEffect, useReducer, useRef, useState, type FormEvent, type KeyboardEvent } from "react";
import { cancelPrompt, getProject, publishProject, sendPrompt, startPreview, subscribeToProject, waitForRuntime } from "./api.js";
import { initialRendererState, rendererReducer, type TimelineItem } from "./state.js";

interface ProjectShellProps {
  projectId: string;
  initialPrompt?: string;
  onInitialPromptHandled?: () => void;
  onHome: () => void;
}

export function ProjectShell({ projectId, initialPrompt, onInitialPromptHandled, onHome }: ProjectShellProps) {
  const [state, dispatch] = useReducer(rendererReducer, initialRendererState);
  const [prompt, setPrompt] = useState(initialPrompt ?? "");
  const [sendingInitialPrompt, setSendingInitialPrompt] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const initialPromptAttempted = useRef(false);
  const timelineEnd = useRef<HTMLDivElement>(null);

  useEffect(() => {
    let disposed = false;
    let unsubscribe: (() => void) | undefined;

    async function bootstrap() {
      try {
        await waitForRuntime();
        const project = await getProject(projectId);
        if (disposed) return;
        dispatch({ type: "initialized", project });
        unsubscribe = subscribeToProject(project.id, {
          onEvent: (event) => { if (!disposed) dispatch({ type: "runtime-event", event }); },
          onOpen: () => {
            if (disposed) return;
            dispatch({ type: "connection", status: "open" });
            void getProject(projectId).catch(() => project).then((latestProject) => {
              if (disposed) return;
              dispatch({ type: "initialized", project: latestProject });
              if (!initialPrompt || initialPromptAttempted.current) return;
              initialPromptAttempted.current = true;
              setSendingInitialPrompt(true);
              void sendPrompt(project.id, initialPrompt).then(() => {
                if (!disposed) setPrompt("");
              }).catch((error) => {
                if (!disposed) dispatch({ type: "notice", message: errorMessage(error) });
              }).finally(() => {
                onInitialPromptHandled?.();
                if (!disposed) setSendingInitialPrompt(false);
              });
            });
          },
          onError: () => { if (!disposed) dispatch({ type: "connection", status: "reconnecting" }); },
        });

        if (project.preview.status === "stopped") {
          void startPreview(project.id).catch((error) => {
            if (!disposed) dispatch({ type: "notice", message: errorMessage(error) });
          });
        }

      } catch (error) {
        if (!disposed) dispatch({ type: "fatal", message: errorMessage(error) });
      }
    }

    void bootstrap();
    return () => {
      disposed = true;
      unsubscribe?.();
    };
  }, [projectId]);

  useEffect(() => {
    timelineEnd.current?.scrollIntoView({ block: "end" });
  }, [state.items]);

  if (state.phase === "fatal") {
    return <FatalState message={state.notice ?? "Could not reach the local runtime."} onHome={onHome} />;
  }

  const project = state.project;
  const agentBusy = sendingInitialPrompt || project?.agent.status === "running" || project?.agent.status === "cancelling";

  async function submitPrompt(event?: FormEvent) {
    event?.preventDefault();
    const nextPrompt = prompt.trim();
    if (!project || !nextPrompt || agentBusy) return;
    dispatch({ type: "notice", message: undefined });
    try {
      await sendPrompt(project.id, nextPrompt);
      setPrompt("");
    } catch (error) {
      dispatch({ type: "notice", message: errorMessage(error) });
    }
  }

  async function stopAgent() {
    if (!project || !agentBusy) return;
    try {
      await cancelPrompt(project.id);
    } catch (error) {
      dispatch({ type: "notice", message: errorMessage(error) });
    }
  }

  async function restartPreview() {
    if (!project || project.preview.status === "starting") return;
    dispatch({ type: "notice", message: undefined });
    try {
      await startPreview(project.id);
    } catch (error) {
      dispatch({ type: "notice", message: errorMessage(error) });
    }
  }

  async function publish() {
    if (!project || publishing || agentBusy) return;
    setPublishing(true);
    dispatch({ type: "notice", message: undefined });
    try {
      await publishProject(project.id);
    } catch (error) {
      dispatch({ type: "notice", message: errorMessage(error) });
    } finally {
      setPublishing(false);
    }
  }

  return (
    <main className="workspace-shell">
      <section className="agent-pane" aria-label="Agent">
        <PaneHeader
          title={project?.name ?? "Loading project"}
          status={agentStatusLabel(state.connection, project?.agent.status, state.retry)}
          busy={state.connection !== "open" || agentBusy}
          onHome={onHome}
        />

        <div className="agent-body">
          <div className="section-heading">
            <h1>Agent</h1>
          </div>

          <div className="timeline" aria-live="polite">
            {state.phase === "loading" ? <TimelineSkeleton /> : null}
            {state.phase === "ready" && state.items.length === 0 ? (
              <div className="empty-timeline">Ready</div>
            ) : null}
            {state.items.map((item) => <TimelineEntry key={item.id} item={item} />)}
            <div ref={timelineEnd} />
          </div>

          <form className="composer" onSubmit={submitPrompt}>
            {state.notice ? <p className="composer-error" role="alert">{state.notice}</p> : null}
            <div className="composer-control">
              <textarea
                aria-label="Prompt"
                disabled={!project}
                onChange={(event) => setPrompt(event.target.value)}
                onInput={(event) => {
                  event.currentTarget.style.height = "auto";
                  event.currentTarget.style.height = `${Math.min(event.currentTarget.scrollHeight, 132)}px`;
                }}
                onKeyDown={(event: KeyboardEvent<HTMLTextAreaElement>) => {
                  if (event.key === "Enter" && !event.shiftKey) {
                    event.preventDefault();
                    void submitPrompt();
                  }
                }}
                placeholder="Ask for a change"
                rows={1}
                value={prompt}
              />
              {agentBusy ? (
                <button className="icon-button stop-button" type="button" onClick={stopAgent} title="Stop agent" aria-label="Stop agent">
                  <Square size={14} fill="currentColor" />
                </button>
              ) : (
                <button className="icon-button send-button" type="submit" disabled={!project || !prompt.trim()} title="Send prompt" aria-label="Send prompt">
                  <ArrowUp size={17} />
                </button>
              )}
            </div>
          </form>
        </div>
      </section>

      <ViewerPane project={project} publishing={publishing} onPublish={publish} onRestart={restartPreview} />
    </main>
  );
}

function PaneHeader({
  title,
  status,
  busy,
  onHome,
}: {
  title: string;
  status: string;
  busy: boolean;
  onHome: () => void;
}) {
  return (
    <header className="pane-header">
      <div className="project-heading">
        <button className="icon-button header-back-button" type="button" onClick={onHome} title="Back to Home" aria-label="Back to Home">
          <ArrowLeft size={15} />
        </button>
        <span className="project-name" title={title}>{title}</span>
      </div>
      <div className="header-actions">
        <span className="runtime-status">
          {busy ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}
          {status}
        </span>
      </div>
    </header>
  );
}

function ViewerPane({
  project,
  publishing,
  onPublish,
  onRestart,
}: {
  project?: import("../shared/contracts.js").ProjectState;
  publishing: boolean;
  onPublish: () => void;
  onRestart: () => void;
}) {
  const preview = project?.preview;
  return (
    <section className="viewer-pane" aria-label="Preview">
      <header className="pane-header viewer-header">
        <span className="viewer-title">Preview</span>
        <div className="viewer-actions">
          <span className={`preview-status preview-status-${preview?.status ?? "starting"}`}>
            {previewStatusLabel(preview?.status)}
          </span>
          <button
            className="icon-button quiet-button"
            type="button"
            onClick={onRestart}
            disabled={!project || preview?.status === "waiting" || preview?.status === "starting"}
            title="Restart preview"
            aria-label="Restart preview"
          >
            <RefreshCw className={preview?.status === "starting" ? "spin" : undefined} size={15} />
          </button>
          <button
            className="publish-button"
            type="button"
            onClick={onPublish}
            disabled={!project || publishing || project.agent.status === "running" || project.agent.status === "cancelling"}
          >
            {publishing ? <LoaderCircle className="spin" size={14} /> : <Share2 size={14} />}
            {publishing ? "Publishing" : project?.publication ? "Publish update" : "Publish"}
          </button>
        </div>
      </header>

      <div className="viewer-stage">
        {preview?.status === "ready" && preview.url ? (
          <iframe
            key={preview.url}
            className="preview-frame"
            src={preview.url}
            title={`${project?.name ?? "Project"} preview`}
            sandbox="allow-forms allow-modals allow-pointer-lock allow-same-origin allow-scripts"
          />
        ) : (
          <PreviewState status={preview?.status} error={preview?.error} />
        )}
      </div>
    </section>
  );
}

function PreviewState({ status, error }: { status?: string; error?: string }) {
  if (status === "error") {
    return (
      <div className="centered-state error-state" role="alert">
        <X size={22} />
        <strong>Preview failed</strong>
        <span>{error ?? "The preview process stopped."}</span>
      </div>
    );
  }
  if (status === "stopped") {
    return <div className="centered-state"><span>Preview stopped</span></div>;
  }
  if (status === "waiting") {
    return <div className="centered-state"><span>Waiting for a runnable project</span></div>;
  }
  return (
    <div className="centered-state">
      <LoaderCircle className="spin" size={22} />
      <span>Preparing preview</span>
    </div>
  );
}

function TimelineEntry({ item }: { item: TimelineItem }) {
  if (item.kind === "user") return <div className="user-message">{item.text}</div>;
  if (item.kind === "tool") return <ToolActivity item={item} />;
  return (
    <div className={`assistant-message assistant-${item.status}`}>
      {item.text ? <div>{item.text}</div> : item.status === "streaming" ? (
        <span className="thinking-label"><LoaderCircle className="spin" size={13} />Thinking</span>
      ) : null}
      {item.status === "cancelled" && !item.text ? <span className="muted-text">Stopped</span> : null}
      {item.retry ? <p className="message-retry">{item.retry}</p> : null}
      {item.error ? <p className="message-error" role="alert">{item.error}</p> : null}
    </div>
  );
}

function ToolActivity({ item }: { item: Extract<TimelineItem, { kind: "tool" }> }) {
  const { icon: Icon, label } = toolPresentation(item.toolName);
  return (
    <div className={`tool-activity tool-${item.status}`}>
      <Icon size={14} />
      <span>{label}</span>
      <span className="tool-result" aria-label={item.status}>
        {item.status === "running" ? <LoaderCircle className="spin" size={13} /> : null}
        {item.status === "complete" ? <Check size={13} /> : null}
        {item.status === "error" ? <X size={13} /> : null}
      </span>
    </div>
  );
}

function TimelineSkeleton() {
  return (
    <div className="timeline-skeleton" aria-label="Loading project">
      <span />
      <span />
      <span />
    </div>
  );
}

function FatalState({ message, onHome }: { message: string; onHome: () => void }) {
  return (
    <main className="fatal-state">
      <X size={24} />
      <h1>Workspace unavailable</h1>
      <p>{message}</p>
      <div className="fatal-actions">
        <button type="button" onClick={onHome}><ArrowLeft size={15} />Home</button>
        <button type="button" onClick={() => window.location.reload()}><RefreshCw size={15} />Reload</button>
      </div>
    </main>
  );
}

function toolPresentation(toolName: string): { icon: LucideIcon; label: string } {
  switch (toolName) {
    case "bash": return { icon: Terminal, label: "Running command" };
    case "edit": return { icon: FilePenLine, label: "Editing file" };
    case "write": return { icon: FileText, label: "Writing file" };
    case "read": return { icon: Search, label: "Reading file" };
    default: return { icon: Wrench, label: toolName };
  }
}

function agentStatusLabel(connection: string, status?: string, retry?: { attempt: number; maxAttempts: number }): string {
  if (connection !== "open") return connection === "connecting" ? "Connecting" : "Reconnecting";
  if (retry) return `Retrying ${retry.attempt}/${retry.maxAttempts}`;
  if (status === "running") return "Working";
  if (status === "cancelling") return "Stopping";
  if (status === "error") return "Needs attention";
  return "Ready";
}

function previewStatusLabel(status?: string): string {
  if (status === "ready") return "Ready";
  if (status === "error") return "Error";
  if (status === "stopped") return "Stopped";
  if (status === "waiting") return "Waiting";
  return "Starting";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
