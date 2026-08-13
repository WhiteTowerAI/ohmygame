import {
  ArrowLeft,
  Check,
  LoaderCircle,
  RefreshCw,
  X,
} from "lucide-react";
import { useEffect, useReducer, useRef, useState } from "react";
import type { ConversationSummary, PromptReference } from "../shared/contracts.js";
import {
  cancelPrompt,
  createConversation,
  getConversation,
  getProject,
  listConversations,
  publishProject,
  removePendingPrompt,
  resolveApproval,
  renameConversation,
  sendPrompt,
  startPreview,
  subscribeToProject,
  waitForRuntime,
} from "./api.js";
import { ConversationMenu } from "./conversation-menu.js";
import { AgentTimeline } from "./agent-timeline.js";
import { CodingWorkspace } from "./coding-workspace.js";
import { Composer } from "./composer.js";
import { initialRendererState, rendererReducer } from "./state.js";

interface ProjectShellProps {
  projectId: string;
  conversationId?: string;
  initialPrompt?: string;
  onInitialPromptHandled?: () => void;
  onOpenConversation: (conversationId: string, replace?: boolean) => void;
  onHome: () => void;
}

export function ProjectShell({
  projectId,
  conversationId,
  initialPrompt,
  onInitialPromptHandled,
  onOpenConversation,
  onHome,
}: ProjectShellProps) {
  const [state, dispatch] = useReducer(rendererReducer, initialRendererState);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [sendingInitialPrompt, setSendingInitialPrompt] = useState(false);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const initialPromptAttempted = useRef(false);
  const unsubscribeEvents = useRef<(() => void) | undefined>(undefined);
  const timeline = useRef<HTMLDivElement>(null);
  const followTimeline = useRef(true);

  function subscribe(cursor: number, selectedConversationId: string): void {
    unsubscribeEvents.current?.();
    unsubscribeEvents.current = subscribeToProject(projectId, cursor, {
      onEvent: (event) => {
        dispatch({ type: "runtime-event", event });
        if (event.type === "agent.completed") setWorkspaceRevision((value) => value + 1);
        if (
          event.type === "agent.started" || event.type === "agent.completed" ||
          event.type === "agent.cancelled" || event.type === "agent.error"
        ) {
          void listConversations(projectId).then(setConversations).catch(() => {});
        }
      },
      onOpen: () => dispatch({ type: "connection", status: "open" }),
      onError: () => dispatch({ type: "connection", status: "reconnecting" }),
      onReset: async () => {
        const detail = await getConversation(projectId, selectedConversationId, true);
        dispatch({
          type: "conversation-loaded",
          conversation: detail.conversation,
          items: detail.items,
          activeTurn: detail.activeTurn,
          pendingPrompt: detail.pendingPrompt,
          pendingApproval: detail.pendingApproval,
          cursor: detail.cursor,
        });
        return detail.cursor;
      },
    });
  }

  useEffect(() => {
    let disposed = false;

    async function bootstrap() {
      try {
        await waitForRuntime();
        const [project, availableConversations] = await Promise.all([getProject(projectId), listConversations(projectId)]);
        if (disposed) return;
        setConversations(availableConversations);
        const requestedConversation = availableConversations.find((item) => item.id === conversationId);
        const selected = requestedConversation ?? availableConversations[0] ?? await createConversation(projectId);
        if (disposed) return;
        if (!requestedConversation) {
          if (availableConversations.length === 0) setConversations([selected]);
          onOpenConversation(selected.id, true);
        }
        const detail = await getConversation(projectId, selected.id);
        if (disposed) return;
        dispatch({
          type: "initialized",
          project,
          conversation: detail.conversation,
          items: detail.items,
          activeTurn: detail.activeTurn,
          pendingPrompt: detail.pendingPrompt,
          pendingApproval: detail.pendingApproval,
          cursor: detail.cursor,
        });
        subscribe(detail.cursor, selected.id);

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
      unsubscribeEvents.current?.();
      unsubscribeEvents.current = undefined;
    };
  }, [projectId]);

  useEffect(() => {
    if (!state.project || state.phase !== "ready" || !conversationId || state.conversation?.id === conversationId) return;
    let disposed = false;
    async function loadSelectedConversation() {
      try {
        unsubscribeEvents.current?.();
        unsubscribeEvents.current = undefined;
        dispatch({ type: "connection", status: "connecting" });
        const availableConversations = await listConversations(projectId);
        if (disposed) return;
        setConversations(availableConversations);
        const requestedConversation = availableConversations.find((item) => item.id === conversationId);
        if (!requestedConversation) {
          const selected = availableConversations[0];
          if (selected) onOpenConversation(selected.id, true);
          return;
        }
        const detail = await getConversation(projectId, requestedConversation.id);
        if (!disposed) dispatch({
          type: "conversation-loaded",
          conversation: detail.conversation,
          items: detail.items,
          activeTurn: detail.activeTurn,
          pendingPrompt: detail.pendingPrompt,
          pendingApproval: detail.pendingApproval,
          cursor: detail.cursor,
        });
        if (!disposed) subscribe(detail.cursor, requestedConversation.id);
      } catch (error) {
        if (!disposed) dispatch({ type: "fatal", message: errorMessage(error) });
      }
    }
    void loadSelectedConversation();
    return () => { disposed = true; };
  }, [projectId, conversationId, state.project?.id, state.phase, state.conversation?.id]);

  useEffect(() => {
    const project = state.project;
    const conversation = state.conversation;
    if (
      state.connection !== "open" || !project || !conversation || conversation.id !== conversationId ||
      !initialPrompt || initialPromptAttempted.current
    ) return;
    initialPromptAttempted.current = true;
    setSendingInitialPrompt(true);
    void sendPrompt(project.id, conversation.id, initialPrompt).catch((error) => {
      dispatch({ type: "notice", message: errorMessage(error) });
    }).finally(() => {
      onInitialPromptHandled?.();
      setSendingInitialPrompt(false);
    });
  }, [state.connection, state.project?.id, state.conversation?.id, conversationId, initialPrompt]);

  useEffect(() => {
    const element = timeline.current;
    if (element && followTimeline.current) element.scrollTop = element.scrollHeight;
  }, [state.items]);

  if (state.phase === "fatal") {
    return <FatalState message={state.notice ?? "Could not reach the local runtime."} onHome={onHome} />;
  }

  const project = state.project;
  const conversation = state.conversation;
  const projectBusy = Boolean(state.activeTurn);
  const agentBusy = sendingInitialPrompt || projectBusy || conversation?.agent.status === "running" || conversation?.agent.status === "cancelling";
  const currentConversationBusy = state.activeTurn?.conversationId === conversation?.id;
  const anotherConversationBusy = projectBusy && !currentConversationBusy;

  async function submitPrompt(nextPrompt: string, references: PromptReference[]): Promise<boolean> {
    if (!project || !conversation || anotherConversationBusy) return false;
    followTimeline.current = true;
    dispatch({ type: "notice", message: undefined });
    try {
      await sendPrompt(project.id, conversation.id, nextPrompt, references);
      return true;
    } catch (error) {
      dispatch({ type: "notice", message: errorMessage(error) });
      return false;
    }
  }

  async function stopAgent() {
    const turnId = conversation?.agent.turnId ?? (currentConversationBusy ? state.activeTurn?.turnId : undefined);
    if (!project || !conversation || !turnId || !currentConversationBusy) return;
    try {
      await cancelPrompt(project.id, conversation.id, turnId);
    } catch (error) {
      dispatch({ type: "notice", message: errorMessage(error) });
    }
  }

  async function removeFollowUp(turnId: string): Promise<boolean> {
    if (!project || !conversation) return false;
    try {
      await removePendingPrompt(project.id, conversation.id, turnId);
      return true;
    } catch (error) {
      dispatch({ type: "notice", message: errorMessage(error) });
      return false;
    }
  }

  async function decideApproval(approvalId: string, decision: "allow" | "deny"): Promise<void> {
    if (!project || !conversation) return;
    try {
      await resolveApproval(project.id, conversation.id, approvalId, decision);
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

  async function newConversation() {
    if (!project || creatingConversation) return;
    setCreatingConversation(true);
    dispatch({ type: "notice", message: undefined });
    try {
      const created = await createConversation(project.id);
      setCreatingConversation(false);
      onOpenConversation(created.id);
    } catch (error) {
      dispatch({ type: "notice", message: errorMessage(error) });
      setCreatingConversation(false);
    }
  }

  async function rename(conversationId: string, title: string): Promise<void> {
    if (!project) return;
    const renamed = await renameConversation(project.id, conversationId, title);
    setConversations((items) => items.map((item) => item.id === renamed.id ? renamed : item));
  }

  return (
    <main className="workspace-shell">
      <section className="agent-pane" aria-label="Agent">
        <PaneHeader
          title={project?.name ?? "Loading project"}
          status={agentStatusLabel(state.connection, conversation?.agent.status, state.retry, anotherConversationBusy)}
          busy={state.connection !== "open" || agentBusy}
          onHome={onHome}
        />

        <div className="agent-body">
          <div className="section-heading conversation-heading">
            <ConversationMenu
              conversations={conversations}
              currentConversationId={conversation?.id}
              activeConversationId={state.activeTurn?.conversationId}
              creating={creatingConversation}
              disabled={!conversation}
              onCreate={() => void newConversation()}
              onRename={rename}
              onSelect={onOpenConversation}
            />
          </div>

          <div
            className="timeline"
            aria-live="polite"
            ref={timeline}
            onScroll={(event) => {
              const element = event.currentTarget;
              followTimeline.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
            }}
          >
            {state.phase === "loading" ? <TimelineSkeleton /> : null}
            {state.phase === "ready" && state.items.length === 0 ? (
              <div className="empty-timeline">Ready</div>
            ) : null}
            <AgentTimeline
              items={state.items}
              approval={state.pendingApproval}
              onApproval={decideApproval}
            />
          </div>

          <Composer
            key={conversation?.id}
            projectId={project?.id}
            conversationReady={Boolean(conversation) && !anotherConversationBusy && state.connection === "open"}
            running={currentConversationBusy}
            stopping={conversation?.agent.status === "cancelling" || sendingInitialPrompt}
            pendingPrompt={state.pendingPrompt}
            notice={state.notice}
            onSubmit={submitPrompt}
            onStop={() => void stopAgent()}
            onRemovePending={removeFollowUp}
          />
        </div>
      </section>

      <CodingWorkspace
        project={project}
        agentBusy={agentBusy}
        publishing={publishing}
        workspaceRevision={workspaceRevision}
        onPublish={publish}
        onRestart={restartPreview}
      />
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

function agentStatusLabel(
  connection: string,
  status?: string,
  retry?: { attempt: number; maxAttempts: number },
  anotherConversationBusy = false,
): string {
  if (connection !== "open") return connection === "connecting" ? "Connecting" : "Reconnecting";
  if (anotherConversationBusy) return "Working in another conversation";
  if (retry) return `Retrying ${retry.attempt}/${retry.maxAttempts}`;
  if (status === "running") return "Working";
  if (status === "cancelling") return "Stopping";
  if (status === "error") return "Needs attention";
  return "Ready";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
