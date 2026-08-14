import {
  ArrowLeft,
  House,
  LoaderCircle,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  X,
} from "lucide-react";
import { useEffect, useReducer, useRef, useState, type ReactNode } from "react";
import type { ConversationSummary, PromptReference } from "../shared/contracts.js";
import {
  cancelPrompt,
  createConversation,
  getConversation,
  getProject,
  listConversations,
  publishProject,
  removePendingPrompt,
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
  const [agentCollapsed, setAgentCollapsed] = useState(false);
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
    <main className={`workspace-shell${agentCollapsed ? " workspace-shell-agent-collapsed" : ""}`}>
      {agentCollapsed ? (
        <button
          className="icon-button agent-expand-button"
          type="button"
          onClick={() => setAgentCollapsed(false)}
          title="Show agent"
          aria-label="Show agent"
        >
          <PanelLeftOpen size={15} />
        </button>
      ) : null}

      <section className="agent-pane" aria-label="Agent">
        <PaneHeader
          title={project?.name ?? "Loading project"}
          onHome={onHome}
        >
          <button
            className="icon-button pane-header-action"
            type="button"
            disabled={!project || creatingConversation}
            onClick={() => void newConversation()}
            title="New conversation"
            aria-label="New conversation"
          >
            {creatingConversation ? <LoaderCircle className="spin" size={14} /> : <MessageSquarePlus size={14} />}
          </button>
          <ConversationMenu
            conversations={conversations}
            currentConversationId={conversation?.id}
            activeConversationId={state.activeTurn?.conversationId}
            disabled={!conversation}
            onRename={rename}
            onSelect={onOpenConversation}
          />
          <button
            className="icon-button pane-header-action"
            type="button"
            onClick={() => setAgentCollapsed(true)}
            title="Hide agent"
            aria-label="Hide agent"
          >
            <PanelLeftClose size={14} />
          </button>
        </PaneHeader>

        <div className="agent-body">
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
            <AgentTimeline items={state.items} />
          </div>

          <Composer
            key={conversation?.id}
            projectId={project?.id}
            conversationReady={Boolean(conversation) && !anotherConversationBusy && state.connection === "open"}
            running={currentConversationBusy}
            stopping={conversation?.agent.status === "cancelling" || sendingInitialPrompt}
            pendingPrompt={state.pendingPrompt}
            notice={state.connection === "reconnecting" ? "Connection lost. Reconnecting..." : state.notice}
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
  onHome,
  children,
}: {
  title: string;
  onHome: () => void;
  children: ReactNode;
}) {
  return (
    <header className="pane-header">
      <div className="project-heading">
        <button className="icon-button pane-header-action" type="button" onClick={onHome} title="Home" aria-label="Home">
          <House size={14} />
        </button>
        <span className="project-name" title={title}>{title}</span>
      </div>
      <div className="pane-header-actions">{children}</div>
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
