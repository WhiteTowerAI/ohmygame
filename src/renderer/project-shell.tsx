import {
  ArrowLeft,
  House,
  LoaderCircle,
  MessageSquarePlus,
  PanelLeftClose,
  PanelLeftOpen,
  RefreshCw,
  X,
} from "./icons.js";
import {
  useEffect,
  useReducer,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import type { AgentModel, AgentReasoningLevel, ConversationCapabilities, ConversationSummary, PluginMention, ProjectState, PromptImage, PromptMode, ThreadItem } from "../shared/contracts.js";
import {
  approvePlan,
  answerQuestionnaire,
  cancelPrompt,
  cancelPlan,
  compactConversation,
  createConversation,
  getConversation,
  getConversationContextUsage,
  getConversationCapabilities,
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
import type { ChatReference } from "./chat-reference.js";
import { formatChatPrompt } from "./chat-reference.js";
import { CodingWorkspace } from "./coding-workspace.js";
import { InteractiveDramaWorkspace } from "./interactive-drama-workspace.js";
import { Composer } from "./composer.js";
import { QuestionnaireCard } from "./questionnaire-card.js";
import { PlanApprovalCard } from "./plan-approval-card.js";
import { initialRendererState, rendererReducer } from "./state.js";
import { useAgentModels } from "./model-selector.js";
import { useAuth } from "./auth.js";
import { forgetPendingPublish, rememberPendingPublish, takePendingPublish } from "./pending-publish.js";
import { ProjectSwitcher } from "./project-switcher.js";

interface ProjectShellProps {
  projectId: string;
  conversationId?: string;
  initialPrompt?: { prompt: string; images: PromptImage[]; mode: PromptMode };
  initialDraft?: string;
  onInitialPromptHandled?: () => void;
  onInitialDraftHandled?: () => void;
  onOpenConversation: (conversationId: string, replace?: boolean) => void;
  onOpenProject: (projectId: string) => void;
  onManageProjects: () => void;
  onHome: () => void;
}

const DEFAULT_AGENT_WIDTH = 430;
const MIN_AGENT_WIDTH = 320;
const AGENT_WIDTH_STORAGE_KEY = "open-game-agent-width";
const EMPTY_CAPABILITIES: ConversationCapabilities = { plugins: [], skills: [] };

export function ProjectShell({
  projectId,
  conversationId,
  initialPrompt,
  initialDraft,
  onInitialPromptHandled,
  onInitialDraftHandled,
  onOpenConversation,
  onOpenProject,
  onManageProjects,
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
  const [capabilities, setCapabilities] = useState<ConversationCapabilities>(EMPTY_CAPABILITIES);
  const [chatReference, setChatReference] = useState<ChatReference>();
  const [composerDirty, setComposerDirty] = useState(false);
  const modelCatalog = useAgentModels();
  const initialPromptAttempted = useRef(false);
  const unsubscribeEvents = useRef<(() => void) | undefined>(undefined);
  const timeline = useRef<HTMLDivElement>(null);
  const followTimeline = useRef(true);
  const workspaceShell = useRef<HTMLElement>(null);
  const agentWidthRef = useRef(agentWidth);
  const resizingAgentRef = useRef(false);

  useEffect(() => {
    setChatReference(undefined);
  }, [conversationId]);

  useEffect(() => {
    const current = state.conversation;
    if (!current || state.connection !== "open") {
      setCapabilities(EMPTY_CAPABILITIES);
      return;
    }
    let disposed = false;
    void getConversationCapabilities(projectId, current.id).then((next) => {
      if (!disposed) setCapabilities(next);
    }).catch(() => {
      if (!disposed) setCapabilities(EMPTY_CAPABILITIES);
    });
    return () => { disposed = true; };
  }, [projectId, state.conversation?.id, state.connection]);

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
        if (event.type === "conversation.renamed") {
          setConversations((current) => current.map((conversation) =>
            conversation.id === event.data.conversation.id ? event.data.conversation : conversation));
        }
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
          detail,
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
          detail,
        });
        subscribe(detail.cursor, selected.id);

        if (project.type === "web-game" && project.preview.status === "stopped") {
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
          detail,
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
  }, [state.turns]);

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
      state.agent.status === "running" || state.agent.status === "cancelling";
    if (project?.type !== "web-game" || auth.state.status !== "signed-in" || state.phase !== "ready" || publishing || busy) return;
    if (takePendingPublish(sessionStorage, project.id)) void publish();
  }, [auth.state.status, state.phase, state.project?.id, state.project?.type, state.agent.status, sendingInitialPrompt, publishing]);

  if (state.phase === "fatal") {
    return <FatalState message={state.notice ?? "Could not reach the local runtime."} onHome={onHome} />;
  }

  const project = state.project;
  const conversation = state.conversation;
  const activeTurn = state.turns.find((turn) => turn.status === "inProgress");
  const items = state.turns.flatMap((turn) => turn.items);
  const questionnaire = activeTurn?.items.find((item): item is Extract<ThreadItem, { type: "userInputRequest" }> => (
    item.type === "userInputRequest" && item.status === "inProgress"
  ));
  const currentConversationBusy = Boolean(activeTurn);
  const agentBusy = sendingInitialPrompt || currentConversationBusy || state.agent.status === "running" || state.agent.status === "cancelling";
  const activePlanItem = activeTurn
    ? activeTurn.items.findLast((item) => item.type === "plan")
    : undefined;
  const activePlan = activePlanItem?.type === "plan"
    ? activePlanItem.plan
    : state.plan.mode !== "normal" ? state.plan.plan : undefined;

  async function submitPrompt(nextPrompt: string, mentions: PluginMention[], images: PromptImage[], mode: PromptMode): Promise<boolean> {
    if (!project || !conversation) return false;
    followTimeline.current = true;
    dispatch({ type: "notice", message: undefined });
    try {
      await sendPrompt(project.id, conversation.id, chatReference ? formatChatPrompt(chatReference, nextPrompt) : nextPrompt, [], images, mode, mentions);
      setChatReference(undefined);
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
      return submitPrompt(feedback.trim(), [], [], "planning");
    } catch (error) {
      dispatch({ type: "notice", message: errorMessage(error) });
      return false;
    }
  }

  async function respondToQuestionnaire(answers: Array<{ questionId: string; value: string }>, cancelled = false): Promise<boolean> {
    if (!project || !conversation || !questionnaire) return false;
    try {
      await answerQuestionnaire(project.id, conversation.id, {
        requestId: questionnaire.requestId,
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
    const turnId = activeTurn?.id;
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
      const created = await createConversation(project.id, state.settings.model, state.settings.reasoningLevel);
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
      if (!state.settings.model) return;
      dispatch({ type: "conversation-settings", settings: { model: state.settings.model, reasoningLevel } });
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

  function confirmNavigation(): boolean {
    return !composerDirty || window.confirm("Discard the message you are composing?");
  }

  function requestHome(): void {
    if (confirmNavigation()) onHome();
  }

  function requestProject(projectId: string): void {
    onOpenProject(projectId);
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

      <WorkspaceNavigationActions
        collapsed={agentCollapsed}
        project={project}
        onBeforeNavigate={confirmNavigation}
        onHome={requestHome}
        onOpenProject={requestProject}
        onManageProjects={onManageProjects}
        onExpand={() => setAgentCollapsed(false)}
      />

      <section className="agent-pane" aria-label="Agent">
        <PaneHeader
          project={project}
          onBeforeNavigate={confirmNavigation}
          onOpenProject={requestProject}
          onManageProjects={onManageProjects}
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
            activeConversationId={activeTurn?.conversationId}
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
              turns={state.turns}
              projectId={projectId}
              revisionDisabled={agentBusy || state.plan.mode !== "normal" || state.pendingPrompts.length > 0 || state.connection !== "open"}
              waitingForInput={Boolean(questionnaire)}
              onRevise={revisePrompt}
              onAddToChat={(text) => setChatReference({ text })}
            />
          </div>

          {questionnaire ? (
            <QuestionnaireCard
              request={questionnaire}
              onSubmit={(answers) => respondToQuestionnaire(answers)}
              onSkip={() => respondToQuestionnaire([], true)}
            />
          ) : null}

          {state.plan.mode === "awaiting_approval" ? (
            <div className="plan-review">
              <PlanApprovalCard
                disabled={agentBusy || state.connection !== "open"}
                onApprove={executePlan}
                onRefine={refineCurrentPlan}
                onCancel={discardPlan}
              />
            </div>
          ) : null}

          {!questionnaire && state.plan.mode !== "awaiting_approval" ? <Composer
            key={conversation?.id}
            conversationReady={Boolean(conversation) && state.connection === "open"}
            running={currentConversationBusy}
            stopping={state.agent.status === "cancelling" || sendingInitialPrompt}
            pendingPrompts={state.pendingPrompts}
            plan={activePlan}
            planMode={state.plan.mode}
            notice={state.connection === "reconnecting" ? "Connection lost. Reconnecting..." : state.notice}
            models={modelCatalog.models}
            model={state.settings.model}
            reasoningLevel={state.settings.reasoningLevel}
            modelChanging={modelChanging}
            promptHistory={[
              ...items.flatMap((item) => item.type === "userMessage" && item.text.trim()
                ? [{ prompt: item.text, mentions: item.mentions ?? [] }]
                : []),
              ...state.pendingPrompts.flatMap((item) => item.prompt.trim()
                ? [{ prompt: item.prompt, mentions: item.mentions }]
                : []),
            ]}
            capabilities={capabilities}
            initialDraft={conversation?.id === conversationId ? initialDraft : undefined}
            onInitialDraftHandled={onInitialDraftHandled}
            onSubmit={submitPrompt}
            reference={chatReference}
            onClearReference={() => setChatReference(undefined)}
            onDirtyChange={setComposerDirty}
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

      {!project ? <section className="viewer-pane" /> : project.type !== "interactive-drama" ? (
        <CodingWorkspace
          project={project}
          agentBusy={agentBusy}
          publishing={publishing}
          workspaceRevision={workspaceRevision}
          onPublish={publish}
          onRestart={restartPreview}
        />
      ) : <InteractiveDramaWorkspace
        projectId={project.id}
      />}
    </main>
  );
}

function WorkspaceNavigationActions({ collapsed, project, onBeforeNavigate, onHome, onOpenProject, onManageProjects, onExpand }: {
  collapsed: boolean;
  project?: ProjectState;
  onBeforeNavigate: () => boolean;
  onHome: () => void;
  onOpenProject: (projectId: string) => void;
  onManageProjects: () => void;
  onExpand: () => void;
}) {
  return (
    <div className="workspace-navigation-actions" role="toolbar" aria-label="Workspace navigation">
      <button className="icon-button" type="button" onClick={onHome} title="Home" aria-label="Home">
        <House size={14} />
      </button>
      {collapsed && project ? <ProjectSwitcher compact project={project} onBeforeNavigate={onBeforeNavigate} onSelect={onOpenProject} onManage={onManageProjects} /> : null}
      {collapsed ? (
        <button className="icon-button" type="button" onClick={onExpand} title="Show agent" aria-label="Show agent">
          <PanelLeftOpen size={15} />
        </button>
      ) : null}
    </div>
  );
}

function PaneHeader({
  project,
  onBeforeNavigate,
  onOpenProject,
  onManageProjects,
  children,
}: {
  project?: ProjectState;
  onBeforeNavigate: () => boolean;
  onOpenProject: (projectId: string) => void;
  onManageProjects: () => void;
  children: ReactNode;
}) {
  return (
    <header className="pane-header window-drag-handle">
      <span className="workspace-navigation-drag-exclusion" aria-hidden="true" />
      <div className="project-heading">
        {project
          ? <ProjectSwitcher project={project} onBeforeNavigate={onBeforeNavigate} onSelect={onOpenProject} onManage={onManageProjects} />
          : <span className="project-name">Loading project</span>}
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
