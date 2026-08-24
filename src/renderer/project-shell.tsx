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
import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { AgentModel, AgentReasoningLevel, ConversationSummary, PromptImage, PromptMode } from "../shared/contracts.js";
import {
  approvePlan,
  answerQuestionnaire,
  cancelPrompt,
  cancelPlan,
  compactConversation,
  createConversation,
  getConversation,
  getConversationContextUsage,
  getProject,
  listConversations,
  publishProject,
  removePendingPrompt,
  renameConversation,
  reviseLastPrompt,
  refinePlan,
  sendPrompt,
  steerPendingPrompt,
  setConversationModel,
  setConversationReasoning,
  startPreview,
  subscribeToProject,
  waitForRuntime,
} from "./api.js";
import { ConversationMenu } from "./conversation-menu.js";
import { AgentTimeline } from "./agent-timeline.js";
import { CodingWorkspace } from "./coding-workspace.js";
import { Composer } from "./composer.js";
import { QuestionnaireCard } from "./questionnaire-card.js";
import { PlanApprovalCard } from "./plan-approval-card.js";
import { initialRendererState, rendererReducer } from "./state.js";
import { useAgentModels } from "./model-selector.js";
import { useAuth } from "./auth.js";
import { forgetPendingPublish, rememberPendingPublish, takePendingPublish } from "./pending-publish.js";

interface ProjectShellProps {
  projectId: string;
  conversationId?: string;
  initialPrompt?: { prompt: string; images: PromptImage[]; mode: PromptMode };
  onInitialPromptHandled?: () => void;
  onOpenConversation: (conversationId: string, replace?: boolean) => void;
  onHome: () => void;
}

const DEFAULT_AGENT_WIDTH = 430;
const MIN_AGENT_WIDTH = 320;
const AGENT_WIDTH_STORAGE_KEY = "open-game-agent-width";

export function ProjectShell({
  projectId,
  conversationId,
  initialPrompt,
  onInitialPromptHandled,
  onOpenConversation,
  onHome,
}: ProjectShellProps) {
  const auth = useAuth();
  const [state, dispatch] = useReducer(rendererReducer, initialRendererState);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const [sendingInitialPrompt, setSendingInitialPrompt] = useState(false);
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [agentCollapsed, setAgentCollapsed] = useState(false);
  const [agentWidth, setAgentWidth] = useState(readAgentWidth);
  const [maximumAgentWidth, setMaximumAgentWidth] = useState(DEFAULT_AGENT_WIDTH);
  const [resizingAgent, setResizingAgent] = useState(false);
  const [publishing, setPublishing] = useState(false);
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const [modelChanging, setModelChanging] = useState(false);
  const modelCatalog = useAgentModels();
  const initialPromptAttempted = useRef(false);
  const unsubscribeEvents = useRef<(() => void) | undefined>(undefined);
  const timeline = useRef<HTMLDivElement>(null);
  const followTimeline = useRef(true);
  const workspaceShell = useRef<HTMLElement>(null);
  const agentWidthRef = useRef(agentWidth);
  const resizingAgentRef = useRef(false);

  function resizeAgent(clientX: number): void {
    const shell = workspaceShell.current;
    const bounds = shell?.getBoundingClientRect();
    if (!shell || !bounds) return;
    const maximum = getMaximumAgentWidth(bounds.width);
    const width = Math.round(Math.min(maximum, Math.max(MIN_AGENT_WIDTH, clientX - bounds.left)));
    agentWidthRef.current = width;
    shell.style.setProperty("--agent-width", `${width}px`);
  }

  function saveAgentWidth(): void {
    localStorage.setItem(AGENT_WIDTH_STORAGE_KEY, String(agentWidthRef.current));
  }

  function finishAgentResize(): void {
    if (!resizingAgentRef.current) return;
    resizingAgentRef.current = false;
    setResizingAgent(false);
    setAgentWidth(agentWidthRef.current);
    saveAgentWidth();
  }

  function resetAgentWidth(): void {
    const width = Math.min(DEFAULT_AGENT_WIDTH, maximumAgentWidth);
    agentWidthRef.current = width;
    setAgentWidth(width);
    localStorage.setItem(AGENT_WIDTH_STORAGE_KEY, String(width));
  }

  function resizeAgentWithKeyboard(event: KeyboardEvent<HTMLDivElement>): void {
    if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
    event.preventDefault();
    const direction = event.key === "ArrowLeft" ? -1 : 1;
    const bounds = workspaceShell.current?.getBoundingClientRect();
    if (!bounds) return;
    resizeAgent(bounds.left + agentWidthRef.current + direction * 16);
    setAgentWidth(agentWidthRef.current);
    saveAgentWidth();
  }

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
          pendingPrompts: detail.pendingPrompts,
          questionnaire: detail.questionnaire,
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
          pendingPrompts: detail.pendingPrompts,
          questionnaire: detail.questionnaire,
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
          pendingPrompts: detail.pendingPrompts,
          questionnaire: detail.questionnaire,
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
    void sendPrompt(project.id, conversation.id, initialPrompt.prompt, [], initialPrompt.images, initialPrompt.mode).catch((error) => {
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

  useEffect(() => {
    const updateMaximum = () => {
      if (window.matchMedia("(max-width: 720px)").matches) return;
      const bounds = workspaceShell.current?.getBoundingClientRect();
      if (!bounds) return;
      const maximum = getMaximumAgentWidth(bounds.width);
      setMaximumAgentWidth(maximum);
      if (agentWidthRef.current > maximum) {
        agentWidthRef.current = maximum;
        setAgentWidth(maximum);
        localStorage.setItem(AGENT_WIDTH_STORAGE_KEY, String(maximum));
      }
    };
    updateMaximum();
    window.addEventListener("resize", updateMaximum);
    return () => window.removeEventListener("resize", updateMaximum);
  }, []);

  useEffect(() => {
    const project = state.project;
    const busy = sendingInitialPrompt ||
      state.conversation?.agent.status === "running" || state.conversation?.agent.status === "cancelling";
    if (auth.state.status !== "signed-in" || state.phase !== "ready" || !project || publishing || busy) return;
    if (takePendingPublish(sessionStorage, project.id)) void publish();
  }, [auth.state.status, state.phase, state.project?.id, state.conversation?.agent.status, sendingInitialPrompt, publishing]);

  if (state.phase === "fatal") {
    return <FatalState message={state.notice ?? "Could not reach the local runtime."} onHome={onHome} />;
  }

  const project = state.project;
  const conversation = state.conversation;
  const currentConversationBusy = Boolean(state.activeTurn);
  const agentBusy = sendingInitialPrompt || currentConversationBusy || conversation?.agent.status === "running" || conversation?.agent.status === "cancelling";
  const activePlanItem = state.activeTurn
    ? state.items.findLast((item) => item.kind === "plan" && item.turnId === state.activeTurn?.turnId)
    : undefined;
  const activePlan = activePlanItem?.kind === "plan"
    ? activePlanItem.plan
    : conversation?.planMode !== "normal" ? conversation?.plan : undefined;

  async function submitPrompt(nextPrompt: string, images: PromptImage[], mode: PromptMode): Promise<boolean> {
    if (!project || !conversation) return false;
    followTimeline.current = true;
    dispatch({ type: "notice", message: undefined });
    try {
      await sendPrompt(project.id, conversation.id, nextPrompt, [], images, mode);
      return true;
    } catch (error) {
      dispatch({ type: "notice", message: errorMessage(error) });
      return false;
    }
  }

  async function compactCurrentConversation(instructions?: string): Promise<void> {
    if (!project || !conversation || agentBusy || state.connection !== "open") return;
    dispatch({ type: "notice", message: undefined });
    try {
      await compactConversation(project.id, conversation.id, instructions);
    } catch (error) {
      dispatch({ type: "notice", message: errorMessage(error) });
    }
  }

  async function currentContextPercent(): Promise<number | undefined> {
    if (!project || !conversation) return undefined;
    const usage = await getConversationContextUsage(project.id, conversation.id);
    return usage?.percent === null || usage?.percent === undefined
      ? undefined
      : Math.round(Math.max(0, Math.min(100, usage.percent)));
  }

  async function executePlan(): Promise<boolean> {
    if (!project || !conversation) return false;
    try {
      await approvePlan(project.id, conversation.id);
      return true;
    } catch (error) {
      dispatch({ type: "notice", message: errorMessage(error) });
      return false;
    }
  }

  async function discardPlan(): Promise<boolean> {
    if (!project || !conversation) return false;
    try {
      await cancelPlan(project.id, conversation.id);
      return true;
    } catch (error) {
      dispatch({ type: "notice", message: errorMessage(error) });
      return false;
    }
  }

  async function refineCurrentPlan(feedback: string): Promise<boolean> {
    if (!project || !conversation || !feedback.trim()) return false;
    try {
      await refinePlan(project.id, conversation.id);
      return submitPrompt(feedback.trim(), [], "planning");
    } catch (error) {
      dispatch({ type: "notice", message: errorMessage(error) });
      return false;
    }
  }

  async function respondToQuestionnaire(answers: Array<{ questionId: string; value: string }>, cancelled = false): Promise<boolean> {
    if (!project || !conversation || !state.questionnaire) return false;
    try {
      await answerQuestionnaire(project.id, conversation.id, {
        requestId: state.questionnaire.id,
        ...(cancelled ? { cancelled: true } : { answers }),
      });
      return true;
    } catch (error) {
      dispatch({ type: "notice", message: errorMessage(error) });
      return false;
    }
  }

  async function revisePrompt(nextPrompt: string): Promise<boolean> {
    if (!project || !conversation || agentBusy || state.pendingPrompts.length > 0 || state.connection !== "open") return false;
    followTimeline.current = true;
    dispatch({ type: "notice", message: undefined });
    try {
      await reviseLastPrompt(project.id, conversation.id, nextPrompt);
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

  async function steerFollowUp(turnId: string): Promise<boolean> {
    if (!project || !conversation) return false;
    try {
      await steerPendingPrompt(project.id, conversation.id, turnId);
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
    const resumeAfterWebSignIn = !window.openGameDesktop && auth.state.status !== "signed-in";
    if (resumeAfterWebSignIn) rememberPendingPublish(sessionStorage, project.id);
    setPublishing(true);
    dispatch({ type: "notice", message: undefined });
    try {
      const accessToken = await auth.requestAccessToken();
      if (!accessToken) {
        if (resumeAfterWebSignIn) forgetPendingPublish(sessionStorage);
        return;
      }
      forgetPendingPublish(sessionStorage);
      await publishProject(project.id, accessToken);
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
      const created = await createConversation(project.id, conversation?.model, conversation?.reasoningLevel);
      setCreatingConversation(false);
      onOpenConversation(created.id);
    } catch (error) {
      dispatch({ type: "notice", message: errorMessage(error) });
      setCreatingConversation(false);
    }
  }

  async function changeModel(model: AgentModel) {
    if (!project || !conversation || agentBusy || modelChanging) return;
    setModelChanging(true);
    dispatch({ type: "notice", message: undefined });
    try {
      const settings = await setConversationModel(project.id, conversation.id, model);
      dispatch({ type: "conversation-settings", settings });
    } catch (error) {
      dispatch({ type: "notice", message: errorMessage(error) });
    } finally {
      setModelChanging(false);
    }
  }

  async function changeReasoning(level: AgentReasoningLevel) {
    if (!project || !conversation || agentBusy || modelChanging) return;
    setModelChanging(true);
    dispatch({ type: "notice", message: undefined });
    try {
      const reasoningLevel = await setConversationReasoning(project.id, conversation.id, level);
      if (!conversation.model) return;
      dispatch({ type: "conversation-settings", settings: { model: conversation.model, reasoningLevel } });
    } catch (error) {
      dispatch({ type: "notice", message: errorMessage(error) });
    } finally {
      setModelChanging(false);
    }
  }

  async function rename(conversationId: string, title: string): Promise<void> {
    if (!project) return;
    const renamed = await renameConversation(project.id, conversationId, title);
    setConversations((items) => items.map((item) => item.id === renamed.id ? renamed : item));
  }

  return (
    <main
      className={`workspace-shell${agentCollapsed ? " workspace-shell-agent-collapsed" : ""}${resizingAgent ? " workspace-shell-resizing" : ""}`}
      ref={workspaceShell}
      style={{ "--agent-width": `${agentWidth}px` } as CSSProperties}
    >
      {resizingAgent ? (
        <div className="workspace-resize-shield" />
      ) : null}

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
            <AgentTimeline
              items={state.items}
              projectId={projectId}
              activeTurnId={currentConversationBusy ? state.activeTurn?.turnId : undefined}
              revisionDisabled={agentBusy || conversation?.planMode !== "normal" || state.pendingPrompts.length > 0 || state.connection !== "open"}
              waitingForInput={Boolean(state.questionnaire)}
              onRevise={revisePrompt}
            />
          </div>

          {state.questionnaire ? (
            <QuestionnaireCard
              request={state.questionnaire}
              onSubmit={(answers) => respondToQuestionnaire(answers)}
              onSkip={() => respondToQuestionnaire([], true)}
            />
          ) : null}

          {conversation?.planMode === "awaiting_approval" ? (
            <div className="plan-review">
              <PlanApprovalCard
                disabled={agentBusy || state.connection !== "open"}
                onApprove={executePlan}
                onRefine={refineCurrentPlan}
                onCancel={discardPlan}
              />
            </div>
          ) : null}

          {!state.questionnaire && conversation?.planMode !== "awaiting_approval" ? <Composer
            key={conversation?.id}
            conversationReady={Boolean(conversation) && state.connection === "open"}
            running={currentConversationBusy}
            stopping={conversation?.agent.status === "cancelling" || sendingInitialPrompt}
            pendingPrompts={state.pendingPrompts}
            plan={activePlan}
            planMode={conversation?.planMode ?? "normal"}
            notice={state.connection === "reconnecting" ? "Connection lost. Reconnecting..." : state.notice}
            models={modelCatalog.models}
            model={conversation?.model}
            reasoningLevel={conversation?.reasoningLevel}
            modelChanging={modelChanging}
            promptHistory={[
              ...state.items.flatMap((item) => item.kind === "user" && item.text.trim() ? [item.text] : []),
              ...state.pendingPrompts.flatMap((item) => item.prompt.trim() ? [item.prompt] : []),
            ]}
            onSubmit={submitPrompt}
            onCompact={compactCurrentConversation}
            onContextUsage={currentContextPercent}
            onCancelPlan={discardPlan}
            onModelChange={(model) => void changeModel(model)}
            onReasoningChange={(level) => void changeReasoning(level)}
            onStop={() => void stopAgent()}
            onRemovePending={removeFollowUp}
            onSteerPending={steerFollowUp}
          /> : null}
        </div>
      </section>

      <div
        className="workspace-resizer"
        role="separator"
        aria-label="Resize agent panel"
        aria-orientation="vertical"
        aria-valuemin={MIN_AGENT_WIDTH}
        aria-valuemax={maximumAgentWidth}
        aria-valuenow={agentWidth}
        aria-hidden={agentCollapsed || undefined}
        tabIndex={agentCollapsed ? -1 : 0}
        onDoubleClick={resetAgentWidth}
        onKeyDown={resizeAgentWithKeyboard}
        onPointerDown={(event) => {
          if (!event.isPrimary || event.button !== 0) return;
          event.preventDefault();
          event.currentTarget.setPointerCapture(event.pointerId);
          resizingAgentRef.current = true;
          setResizingAgent(true);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId)) resizeAgent(event.clientX);
        }}
        onPointerUp={(event) => {
          event.currentTarget.releasePointerCapture(event.pointerId);
          finishAgentResize();
        }}
        onPointerCancel={finishAgentResize}
        onLostPointerCapture={finishAgentResize}
      />

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

function readAgentWidth(): number {
  const stored = Number(localStorage.getItem(AGENT_WIDTH_STORAGE_KEY));
  return Number.isFinite(stored) && stored >= MIN_AGENT_WIDTH ? stored : DEFAULT_AGENT_WIDTH;
}

function getMaximumAgentWidth(workspaceWidth: number): number {
  return Math.round(Math.max(MIN_AGENT_WIDTH, Math.min(workspaceWidth * 0.65, workspaceWidth - MIN_AGENT_WIDTH - 5)));
}
