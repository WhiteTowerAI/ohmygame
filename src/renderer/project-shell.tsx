import { isAccountRuntimeId, isAgentRuntimeId, type ApprovalDecision, type AgentAccountProfileStatus } from "../shared/agent-runtimes.js";
import {
  Play,
  Plug,
  History,
  Palette,
  ArrowLeft,
  Download,
  FolderOpen,
  LoaderCircle,
  MessageSquarePlus,
  Book,
  ChatSquare,
  Code,
  FileDocument,
  GalleryWide,
  Gamepad2,
  Layers3,
  LayoutGrid,
  Pencil,
  RefreshCw,
  Globe2,
  Share2,
  Upload,
  UserRound,
  X,
} from "./icons.js";
import { createPortal } from "react-dom";
import { observeWorkspaceVersion, workspaceVersion } from "./workspace-version.js";
import {
  Activity,
  useEffect,
  useLayoutEffect,
  useCallback,
  useMemo,
  useReducer,
  useRef,
  useState,
  lazy,
  Suspense,
} from "react";
import { previewElementContext } from "../shared/playable-chat-context.js";
import { isProgressLink } from "../shared/extension-host-protocol.js";
import type { AgentContextUsage, AgentModel, AgentModelRef, AgentReasoningLevel, CheckpointChangeItem, ConversationCapabilities, ConversationSummary, PendingPrompt, PluginMention, PromptAttachment, PromptContext, PromptImage, PromptMode, PromptReference, ThreadItem } from "../shared/contracts.js";
import { findAgentModel, preferredAgentModel } from "../shared/agent-models.js";
import { isWebRuntimeProjectType, supportsWebPreview } from "../shared/project-runtime.js";
import {
  ApiError,
  acquirePreview,
  buildWebGame,
  ensureProjectPreview,
  exportProject,
  renameProject,
  releasePreview,
  stopPreview,
  approvePlan,
  answerApproval,
  answerQuestionnaire,
  cancelPrompt,
  cancelPlan,
  compactConversation,
  createConversation,
  branchConversation,
  getConversation,
  getConversationContextUsage,
  getConversationCapabilities,
  getCheckpointChanges,
  getCheckpointFile,
  getProject,
  getUnfinishedChanges,
  getUnfinishedRestore,
  listModels,
  listConversations,
  publishProject,
  removePendingPrompt,
  renameConversation,
  archiveConversation,
  listArchivedConversations,
  unarchiveConversation,
  deleteArchivedConversation,
  reapplyCheckpoint,
  restoreUnfinished,
  reviseLastPrompt,
  refinePlan,
  sendPrompt,
  steerPendingPrompt,
  setConversationModel,
  setConversationAccountProfile,
  listAccountProfiles,
  MODELS_CHANGED_EVENT,
  setConversationReasoning,
  startPreview,
  subscribeToProject,
  undoCheckpoint,
  waitForRuntime,
  getPluginPageValue,
  setPluginPageValue,
  runPluginCommand,
  undoProjectPluginChange,
  type PluginPanel,
} from "./api.js";
import { CanvasChipSelect } from "./canvas-chip-select.js";
import { ConversationMenu } from "./conversation-menu.js";
import { ProjectPluginsSheet } from "./project-plugins-sheet.js";
import { ProjectAppearanceDialog } from "./project-appearance-settings.js";
import { AgentTimeline } from "./agent-timeline.js";
import type { TurnChangesControls } from "./turn-changes.js";
import { CodingWorkspace } from "./coding-workspace.js";
import { isHtmlWorkspaceFile } from "./markdown-content.js";
import { PlayableEditorWorkspace, type StoryView } from "./playable-editor-workspace.js";
import type { PlayableChatState } from "./playable-chat.js";
import { Composer, type ComposerDraft } from "./composer.js";
import { FloatingChat } from "./floating-chat.js";
import { composerDrafts } from "./composer-drafts.js";
import { canvasDocumentPath } from "../shared/canvas-document.js";
import { QuestionnaireCard } from "./questionnaire-card.js";
import { ApprovalCard } from "./approval-card.js";
import { PlanApprovalCard } from "./plan-approval-card.js";
import { initialRendererState, rendererReducer } from "./state.js";
import { useAgentModels } from "./model-selector.js";
import { useAuth } from "./auth.js";
import { forgetPendingPublish, rememberPendingPublish, takePendingPublish } from "./pending-publish.js";
import type { PublishDetails } from "./publish-dialog.js";
import { usePlaytestAskRequests } from "./playable-playtest.js";
import { useRuntimeConnection } from "./runtime-connection.js";
import { ErrorBoundary } from "./error-boundary.js";
import { closePanel, createPanelNodes, PanelLayout, PanelMount, place, showPanel, visiblePanels, areaOf, type Layout, type PanelNodes } from "./panel-layout.js";
import { fitLayout, homeOf, loadingLayout, mergeLayout, openingLayout, panelsOf, presetLayout, presetsFor, saveLayout, type PanelHomes, type PanelId, type SavedLayout, type WorkspacePanel } from "./workspace-layout.js";
import { commandPrompt, commandsForSlot, pageCommand, pluginPanelId, PluginChangesSheet, slashCommands, useProjectPluginContributions } from "./project-plugin-contributions.js";
import { PluginFrame, type CommandProgress } from "./plugin-frame.js";
import { pluginHash } from "./routes.js";
import type { ProjectPluginCommand } from "../shared/plugins.js";
import type { CodingView } from "./coding-workspace.js";
import { ProjectRail, refreshRecentProject } from "./app-sidebar.js";
import { desktopSave } from "./desktop-save.js";
import { ProjectFrame, ProjectTop, publishAction } from "./project-frame.js";
import { ProjectRenameDialog } from "./project-rename-dialog.js";
import { Button, Dialog, DropdownMenu, Empty, IconButton, useToast, type Command, type MenuEntry } from "./ui/index.js";
import { useCommands, useLeaveGuard } from "./command-menu.js";
import type { IconComponent } from "./icons.js";
import type { AppNavigationTarget } from "./routes.js";
import { language, t } from "./i18n.js";

interface ProjectShellProps {
  projectId: string;
  conversationId?: string;
  view?: "design";
  onViewChange?: (view: "design" | "workspace", options?: { replace?: boolean }) => void;
  initialPrompt?: { generation: number; prompt: string; mentions: PluginMention[]; images: PromptImage[]; mode: PromptMode; attachments?: PromptAttachment[] };
  initialDraft?: ComposerDraft;
  showStoryMap?: boolean;
  onStoryMapShown?: () => void;
  onInitialPromptHandled?: () => void;
  onInitialDraftHandled?: () => void;
  onOpenConversation: (conversationId: string, replace?: boolean) => void;
  /** Where the rail goes: Home, the other pages and settings. */
  onNavigate: (page: AppNavigationTarget) => void;
  onHome: () => void;
  homeLabel?: string;
}

const CanvasWorkspace = lazy(() => import("./canvas-workspace.js").then((module) => ({ default: module.CanvasWorkspace })));
const PANELS: Record<WorkspacePanel, { title: () => string; icon: IconComponent }> = {
  chat: { title: () => t("panels.chat"), icon: ChatSquare },
  game: { title: () => t("panels.game"), icon: Gamepad2 },
  design: { title: () => t("panels.design"), icon: FileDocument },
  code: { title: () => t("workspace.tab.code"), icon: Code },
  assets: { title: () => t("workspace.tab.assets"), icon: Layers3 },
  story: { title: () => t("panels.story"), icon: Book },
  canvas: { title: () => t("panels.canvas"), icon: GalleryWide },
};
const EMPTY_CAPABILITIES: ConversationCapabilities = { plugins: [], skills: [] };
/** How many of those files are named before they are only counted. */
const NAMED_UNFINISHED_FILES = 10;

const MAX_PREVIEW_PICKS = 6;

export function ProjectShell({
  projectId,
  conversationId,
  view,
  onViewChange,
  initialPrompt,
  initialDraft,
  showStoryMap,
  onStoryMapShown,
  onInitialPromptHandled,
  onInitialDraftHandled,
  onOpenConversation,
  onNavigate,
  onHome,
  homeLabel = t("navigation.backTo", { page: t("sidebar.projects") }),
}: ProjectShellProps) {
  const auth = useAuth();
  const runtime = useRuntimeConnection();
  const openedGeneration = useRef(runtime.generation);
  // The conversation the route opens now, for answers that arrive after the person moved on.
  const routeConversation = useRef(conversationId);
  routeConversation.current = conversationId;
  const previewPaused = runtime.generation !== openedGeneration.current || runtime.status !== "ready";
  const [state, dispatch] = useReducer(rendererReducer, initialRendererState);
  const [conversations, setConversations] = useState<ConversationSummary[]>([]);
  const latestConversations = useRef(conversations);
  latestConversations.current = conversations;
  const [sendingInitialPrompt, setSendingInitialPrompt] = useState(false);
  const [initialPromptDeferred, setInitialPromptDeferred] = useState(false);
  const [creatingConversation, setCreatingConversation] = useState(false);
  // The workspace's panels, in the one layout every project shares (see
  // workspace-layout.ts). Each panel's view renders into nodes of its own,
  // which the panel shows.
  // Bumped when the project's plugins change, so the chat offers their skills
  // and commands, and their panels come and go.
  const [capabilitiesRevision, setCapabilitiesRevision] = useState(0);
  // Plugins' panels follow the type's own, in the areas they name.
  const plugins = useProjectPluginContributions(state.project, capabilitiesRevision);
  const pluginPanels = new Map(plugins.panels.map((panel) => [pluginPanelId(panel), panel]));
  const homes: PanelHomes = Object.fromEntries(plugins.panels.map((panel) => [pluginPanelId(panel), panel.area]));
  const offered: PanelId[] = state.project ? [...panelsOf(state.project), ...pluginPanels.keys()] : [];
  const [saved, setSaved] = useState<SavedLayout | undefined>();
  const opening = useMemo(() => state.project ? openingLayout(offered, homes) : undefined, [!!state.project]);
  const current = saved ?? opening;
  const layout = state.project && current ? fitLayout(current, offered, presetLayout("default", offered, homes)) : undefined;
  const visible = layout ? visiblePanels(layout, new Set(offered)) : [];
  const chatShown = !layout || visible.includes("chat");
  const [nodes] = useState(() => Object.fromEntries(Object.keys(PANELS).map((id) => [id, createPanelNodes()])) as Record<WorkspacePanel, PanelNodes>);
  // A plugin page gets its nodes once its panel is first placed, and keeps
  // them, so moving or closing the panel never reloads the page.
  const pluginNodes = useRef(new Map<PanelId, PanelNodes>()).current;
  for (const id of pluginPanels.keys())
    if (layout && areaOf(layout, id) && !pluginNodes.has(id)) pluginNodes.set(id, createPanelNodes());
  const latestLayout = useRef({ current, offered, layout, homes });
  latestLayout.current = { current, offered, layout, homes };
  function changeLayout(next: Layout): void {
    const { current, offered, layout } = latestLayout.current;
    if (!offered.length || !layout) return;
    const value = mergeLayout(current, layout, next, offered);
    latestLayout.current = { ...latestLayout.current, current: value, layout: next };
    setSaved(value);
    saveLayout(value);
  }
  /** Brings a panel forward, opening it where it belongs if it was closed. */
  function revealPanel(id: PanelId): void {
    const { layout, offered, homes } = latestLayout.current;
    if (layout && offered.includes(id)) changeLayout(showPanel(layout, id, homeOf(id, homes)));
  }
  /** A panel's name and icon; a plugin's panel shows its title with the plugin icon. */
  function panelInfo(id: PanelId): { title: string; icon: IconComponent; source?: string } {
    const plugin = pluginPanels.get(id);
    if (plugin) return { title: plugin.title, icon: Plug, source: plugin.plugin };
    const builtIn = PANELS[id as WorkspacePanel];
    return { title: id === "game" && state.project?.type === "asset-canvas" ? t("workspace.tab.preview") : builtIn.title(), icon: builtIn.icon };
  }
  const [publishing, setPublishing] = useState(false);
  const [publishDialog, setPublishDialog] = useState<{ projectId: string; status: "open" | "success" }>();
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  const [workspaceEpoch, setWorkspaceEpoch] = useState(() => workspaceVersion(projectId));
  const [restoring, setRestoring] = useState(false);
  /** Set while a restore or an undo that was cut off has not been taken back, unless the user put the offer aside. */
  const [unfinishedRestore, setUnfinishedRestore] = useState(false);
  const [openFileRequest, setOpenFileRequest] = useState<{ path: string; id: number }>();
  const [openPreviewRequest, setOpenPreviewRequest] = useState<{ projectId: string; path: string; id: number }>();
  const [modelChanging, setModelChanging] = useState(false);
  const [accountProfiles, setAccountProfiles] = useState<AgentAccountProfileStatus[]>([]);
  const [capabilities, setCapabilities] = useState<ConversationCapabilities>(EMPTY_CAPABILITIES);
  const [playableChat, setPlayableChat] = useState<PlayableChatState>();
  /** The Playable surface whose chip the user removed from the next message. */
  const [dismissedSurface, setDismissedSurface] = useState<string>();
  const saveDesign = useRef<(() => Promise<void>) | undefined>(undefined);
  const registerDesignSave = useCallback((save: (() => Promise<void>) | undefined) => { saveDesign.current = save; }, []);
  const [designContext, setDesignContext] = useState<PromptContext>();
  const [dismissedDesign, setDismissedDesign] = useState<string>();
  // Elements picked in the game preview, and the preview page picking one now.
  const [previewPicks, setPreviewPicks] = useState<Array<{ key: string; context: PromptContext }>>([]);
  const [pickingClient, setPickingClient] = useState<string>();
  const pickingRef = useRef(pickingClient);
  pickingRef.current = pickingClient;
  const [pluginsOpen, setPluginsOpen] = useState(false);
  const [playSlot, setPlaySlot] = useState<HTMLSpanElement | null>(null);
  const [pluginChangesOpen, setPluginChangesOpen] = useState(false);
  /** A plugin command's link, shown with its host before it opens. */
  /** A link a plugin command offers, opened only once the person sees its host; `message` is the plugin's. */
  const [pluginLink, setPluginLink] = useState<{ url: URL; message?: string }>();
  const [pluginProgress, setPluginProgress] = useState<CommandProgress>();
  const toast = useToast();
  const [appearanceOpen, setAppearanceOpen] = useState(false);
  // "Ask AI to fix" in the Playtest window lands in this chat, ready to send.
  // The chat takes the request once its conversation is open.
  usePlaytestAskRequests(state.conversation ? state.project?.id : undefined, requestPrompt);
  const accountRuntime = isAccountRuntimeId(state.settings.model?.provider) ? state.settings.model.provider : undefined;
  const storedProfileId = accountRuntime ? state.settings.accountProfiles?.[accountRuntime] ?? "system" : "system";
  const selectedProfileId = accountProfiles.length && !accountProfiles.some((profile) => profile.id === storedProfileId) ? "system" : storedProfileId;
  const modelCatalog = useAgentModels({ agentRuntimes: true, accountProfiles: state.conversation ? { "claude-code-cli": state.settings.accountProfiles?.["claude-code-cli"] ?? "system", "codex-cli": state.settings.accountProfiles?.["codex-cli"] ?? "system" } : undefined });
  useEffect(() => {
    setAccountProfiles([]);
    if (!accountRuntime) return;
    let disposed = false;
    const load = () => void listAccountProfiles(accountRuntime).then((profiles) => { if (!disposed) setAccountProfiles(profiles); }).catch(() => {});
    load();
    window.addEventListener("focus", load);
    window.addEventListener(MODELS_CHANGED_EVENT, load);
    return () => { disposed = true; window.removeEventListener("focus", load); window.removeEventListener(MODELS_CHANGED_EVENT, load); };
  }, [accountRuntime]);
  const effectiveModel = findAgentModel(modelCatalog.hiddenModels ?? [], state.settings.model) ?? preferredAgentModel(modelCatalog.models, state.settings.model, modelCatalog.defaultModel);
  const initialPromptAttempted = useRef(false);
  const unsubscribeEvents = useRef<(() => void) | undefined>(undefined);
  const timeline = useRef<HTMLDivElement>(null);
  // The cards that wait on an answer and the composer render into this node,
  // which moves between the chat panel and the floating bar, so neither a
  // half-answered question nor a draft is lost on the way.
  const [chatInputNode] = useState(() => {
    const node = document.createElement("div");
    node.className = "chat-input";
    return node;
  });
  useLayoutEffect(() => {
    if (chatShown && timeline.current) place(timeline.current, chatInputNode);
  }, [chatShown, chatInputNode]);
  const followTimeline = useRef(true);

  // Games and stories put their canvas beside their other panels. Their
  // route's design view is the canvas, which it brings forward, and the route
  // follows it.
  const story = offered.includes("story");
  // An asset canvas is the canvas, with its files in a Code panel beside it.
  const canvasOnly = state.project?.type === "asset-canvas";
  // The canvas saves its edits after a pause, so showing an asset canvas's
  // Code saves them first and then reads the files again.
  const canvasCode = canvasOnly && visible.includes("code");
  const [canvasCodeRevision, setCanvasCodeRevision] = useState(0);
  useEffect(() => {
    if (!canvasCode) return;
    let disposed = false;
    void (saveDesign.current?.() ?? Promise.resolve()).catch(() => {})
      .then(() => { if (!disposed) setCanvasCodeRevision((value) => value + 1); });
    return () => { disposed = true; };
  }, [canvasCode]);
  const coding = offered.includes("code") && !story;
  const panelled = offered.includes("code") && !canvasOnly;
  const designShown = visible.includes("canvas");
  useEffect(() => { if (view === "design" && panelled) revealPanel("canvas"); }, [view, panelled]);
  useEffect(() => {
    if (layout && panelled && designShown !== (view === "design")) onViewChange?.(designShown ? "design" : "workspace", { replace: true });
  }, [designShown, panelled]);

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
  }, [projectId, state.conversation?.id, state.connection, capabilitiesRevision]);

  function subscribe(cursor: number, selectedConversationId: string): void {
    unsubscribeEvents.current?.();
    let disposed = false;
    const unsubscribe = subscribeToProject(projectId, cursor, {
      onEvent: (event) => {
        dispatch({ type: "runtime-event", event });
        if (event.type === "project.plugins.changed") setCapabilitiesRevision((value) => value + 1);
        if (event.type === "plugin.command.progress") {
          setPluginProgress({ command: event.data.command, message: event.data.message });
          if (isProgressLink(event.data.url)) setPluginLink({ url: new URL(event.data.url), message: event.data.message });
        }
        if (event.type === "workspace.restored") {
          observeWorkspaceVersion(projectId, event.data.version);
          setWorkspaceEpoch(event.data.version);
          setWorkspaceRevision((value) => value + 1);
          void getProject(projectId).then((project) => {
            if (!disposed) dispatch({ type: "project-updated", project });
          }).catch(() => {});
          void getUnfinishedRestore(projectId).then((pending) => { if (!disposed) setUnfinishedRestore(pending); }).catch(() => {});
        }
        if (event.type === "agent.completed") setWorkspaceRevision((value) => value + 1);
        if (event.type === "preview.picked") {
          // Only the pick this window asked for; another window's goes to it.
          const asked = pickingRef.current === event.data.client;
          setPickingClient((current) => current === event.data.client ? undefined : current);
          const pick = event.data.pick;
          if (pick && asked) {
            const key = `preview:${pick.path}:${pick.selector}`;
            // A message carries at most 12 contexts, so the oldest picks give way.
            setPreviewPicks((current) => current.some((item) => item.key === key) ? current : [...current, { key, context: previewElementContext(pick) }].slice(-MAX_PREVIEW_PICKS));
            revealPanel("chat");
          }
        }
        // A restored conversation lost its later messages. Undo is marked by
        // the event; reloading its conversation could drop a newly started turn.
        if (event.type === "workspace.restored" && event.conversationId === selectedConversationId) {
          void getConversation(projectId, selectedConversationId, true)
            .then((detail) => { if (!disposed) dispatch({ type: "conversation-loaded", detail }); })
            .catch(() => {});
        }
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
        const [project, detail] = await Promise.all([getProject(projectId), getConversation(projectId, selectedConversationId, true)]);
        if (disposed) return detail.cursor;
        setWorkspaceEpoch(workspaceVersion(projectId));
        void getUnfinishedRestore(projectId).then((pending) => { if (!disposed) setUnfinishedRestore(pending); }).catch(() => {});
        dispatch({ type: "initialized", project, detail });
        setWorkspaceRevision((value) => value + 1);
        return detail.cursor;
      },
    });
    unsubscribeEvents.current = () => { disposed = true; unsubscribe(); };
  }

  useEffect(() => {
    if (runtime.status !== "ready") {
      dispatch({ type: "connection", status: "reconnecting" });
      return;
    }
    let disposed = false;

    async function bootstrap() {
      try {
        await waitForRuntime();
        const [project, availableConversations] = await Promise.all([getProject(projectId), listConversations(projectId)]);
        if (disposed) return;
        setWorkspaceEpoch(workspaceVersion(projectId));
        void getUnfinishedRestore(projectId).then((pending) => { if (!disposed) setUnfinishedRestore(pending); }).catch((cause: unknown) => { if (!disposed) dispatch({ type: "notice", message: errorMessage(cause) }); });
        if (project.workspaceAvailable === false) {
          dispatch({ type: "fatal", message: t("projectShell.folderMissing") });
          return;
        }
        setConversations(availableConversations);
        const requestedConversation = availableConversations.find((item) => item.id === conversationId);
        let selected = requestedConversation ?? availableConversations[0];
        if (!selected) {
          const model = await initialConversationModel();
          if (disposed) return;
          selected = await createConversation(projectId, model);
        }
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
        if (runtime.recovered) setWorkspaceRevision((value) => value + 1);
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
  }, [projectId, runtime.generation, runtime.status]);

  const previewSupported = supportsWebPreview(state.project) || canvasOnly;
  useEffect(() => {
    if (!previewSupported || unfinishedRestore || runtime.status !== "ready") return;
    const leaseId = crypto.randomUUID();
    void acquirePreview(projectId, leaseId, !canvasOnly, previewPaused).catch(() => {});
    const timer = setInterval(() => { void acquirePreview(projectId, leaseId).catch(() => {}); }, 20_000);
    return () => { clearInterval(timer); void releasePreview(projectId, leaseId).catch(() => {}); };
  }, [projectId, previewSupported, canvasOnly, unfinishedRestore, runtime.generation, runtime.status]);

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
      !initialPrompt || initialPromptAttempted.current || initialPrompt.generation !== runtime.generation || runtime.status !== "ready"
    ) return;
    sendInitialPrompt();
  }, [state.connection, state.project?.id, state.conversation?.id, conversationId, initialPrompt, runtime.generation, runtime.status]);

  function sendInitialPrompt(): void {
    const project = state.project;
    const conversation = state.conversation;
    if (!initialPrompt || !project || !conversation || conversation.id !== conversationId || sendingInitialPrompt || runtime.status !== "ready") return;
    initialPromptAttempted.current = true;
    setSendingInitialPrompt(true);
    setInitialPromptDeferred(false);
    let sent = true;
    void sendPrompt(project.id, conversation.id, initialPrompt.prompt, [], initialPrompt.images, initialPrompt.mode, initialPrompt.mentions, initialPrompt.attachments).then(() => {
      if (sent && (initialPrompt.images.length || initialPrompt.attachments?.length)) setWorkspaceRevision((value) => value + 1);
    }).catch((error) => {
      // The message waits, as when it was paused, until the project is set up.
      if (revealSetupPanel(error)) sent = false;
      dispatch({ type: "notice", message: errorMessage(error) });
    }).finally(() => {
      if (sent) onInitialPromptHandled?.();
      else setInitialPromptDeferred(true);
      setSendingInitialPrompt(false);
    });
  }

  useEffect(() => {
    const element = timeline.current;
    if (element && followTimeline.current && chatShown) {
      const frame = requestAnimationFrame(() => { element.scrollTop = element.scrollHeight; });
      return () => cancelAnimationFrame(frame);
    }
  }, [state.turns, chatShown]);

  useEffect(() => {
    const element = timeline.current;
    if (!element) return;
    const observer = new ResizeObserver(() => {
      if (followTimeline.current) element.scrollTop = element.scrollHeight;
    });
    // The composer and cards sit in a node without a box of its own; watch them.
    for (const child of element.children) {
      for (const box of child === chatInputNode ? child.children : [child]) observer.observe(box);
    }
    observer.observe(element);
    return () => observer.disconnect();
  }, [state.conversation?.id, state.agent.status, state.plan.mode, chatShown]);

  useEffect(() => {
    const project = state.project;
    const busy = sendingInitialPrompt ||
      state.agent.status === "running" || state.agent.status === "cancelling";
    if (runtime.recovered || !project || (!isWebRuntimeProjectType(project.type) && project.type !== "interactive-story") || auth.state.status !== "signed-in" || state.phase !== "ready" || publishing || busy) return;
    const pending = takePendingPublish(sessionStorage, project.id);
    if (pending) void publish(pending).catch(() => undefined);
  }, [auth.state.status, state.phase, state.project?.id, state.project?.type, state.agent.status, sendingInitialPrompt, publishing]);

  const project = state.project;
  const conversation = state.conversation;
  const publishDialogStatus = publishDialog?.projectId === project?.id ? publishDialog?.status : undefined;

  const displayedModel = state.settings.model ?? modelCatalog.defaultModel ?? modelCatalog.models[0];
  const activeTurn = state.turns.findLast((turn) => turn.status === "inProgress");
  const items = state.turns.flatMap((turn) => turn.items);
  const questionnaire = activeTurn?.items.find((item): item is Extract<ThreadItem, { type: "userInputRequest" }> => (
    item.type === "userInputRequest" && item.status === "inProgress"
  ));
  const approvals = (activeTurn?.items ?? []).filter((item): item is Extract<ThreadItem, { type: "approvalRequest" }> => (
    item.type === "approvalRequest" && item.status === "inProgress"
  ));
  const approval = approvals[0];
  const approvalAgent = approval ? modelCatalog.models.find((model) => model.provider === state.settings.model?.provider)?.providerName : undefined;
  const currentConversationBusy = Boolean(activeTurn);
  const agentBusy = sendingInitialPrompt || currentConversationBusy || state.agent.status === "running" || state.agent.status === "cancelling";
  const activePlanItem = activeTurn
    ? activeTurn.items.findLast((item) => item.type === "plan")
    : undefined;
  const activePlan = activePlanItem?.type === "plan"
    ? activePlanItem.plan
    : state.plan.mode !== "normal" ? state.plan.plan : undefined;

  const canvasOpen = designShown || project?.type === "asset-canvas";
  // The open Scene goes with the message while the story shows, the canvas's selection while the canvas does.
  const storyShown = visible.includes("story");
  const playableSurface = storyShown && playableChat?.surface && playableChat.surface.key !== dismissedSurface ? playableChat.surface : undefined;
  const designChipKey = designContext ? `design:${designContext.text}` : undefined;
  const currentDesignContext = canvasOpen && designChipKey !== dismissedDesign ? designContext : undefined;
  const chatContexts = [playableSurface?.chip, ...(storyShown ? playableChat?.attachments ?? [] : []).map((attachment) => attachment.chip), ...(currentDesignContext ? [{ key: designChipKey!, kind: currentDesignContext.kind, label: currentDesignContext.label }] : []),
    ...previewPicks.map(({ key, context }) => ({ key, kind: context.kind, label: context.label }))].filter((chip) => chip !== undefined);

  async function submitPrompt(nextPrompt: string, mentions: PluginMention[], images: PromptImage[], mode: PromptMode, attachments: PromptAttachment[] = [], references: PromptReference[] = [], designContexts: PromptContext[] = []): Promise<boolean> {
    if (!project || !conversation) return false;
    followTimeline.current = true;
    dispatch({ type: "notice", message: undefined });
    try {
      await saveDesign.current?.();
      const surface = playableSurface;
      const previewContexts = storyShown ? playableChat?.attachments ?? [] : [];
      const previewImage = previewContexts.length ? await playableChat?.capture().catch(() => undefined) : undefined;
      const contexts = [surface?.context, ...previewContexts.map((attachment) => attachment.context)].filter((context) => context !== undefined);
      const sentImages = previewImage ? [...images, previewImage] : images;
      const allReferences = [...(surface?.references ?? []), ...references.filter((reference) => !(surface?.references ?? []).some((current) => current.path === reference.path))];
      const picks = previewPicks;
      await sendPrompt(project.id, conversation.id, nextPrompt, allReferences, sentImages, mode, mentions, attachments, [...contexts, ...designContexts, ...(currentDesignContext ? [currentDesignContext] : []), ...picks.map((item) => item.context)]);
      if (picks.length) setPreviewPicks((current) => current.filter((item) => !picks.includes(item)));
      if (sentImages.length || attachments.length) setWorkspaceRevision((value) => value + 1);
      if (previewContexts.length) playableChat?.clearAttachments();
      return true;
    } catch (error) {
      revealSetupPanel(error);
      dispatch({ type: "notice", message: errorMessage(error) });
      return false;
    }
  }

  /** A prompt refused until a plugin type's project is set up opens the panel that sets it up. */
  function revealSetupPanel(error: unknown): boolean {
    if (!(error instanceof ApiError) || error.code !== "project-not-ready" || !error.panel) return false;
    const at = error.panel.lastIndexOf(":");
    revealPanel(pluginPanelId({ plugin: error.panel.slice(0, at), id: error.panel.slice(at + 1) }));
    return true;
  }

  /**
   * Sends a request the editor wrote, such as a text edit it cannot make
   * itself, with the open Node as context. Picks stay for the user's message.
   */
  async function sendEditorRequest(text: string, contexts: PromptContext[]): Promise<boolean> {
    if (!project || !conversation || state.connection !== "open") return false;
    followTimeline.current = true;
    const surface = playableChat?.surface;
    try {
      await saveDesign.current?.();
      await sendPrompt(project.id, conversation.id, text, surface?.references ?? [], [], "normal", [], [], [...(surface ? [surface.context] : []), ...contexts]);
      revealPanel("chat");
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

  async function currentContextUsage(passive = false): Promise<AgentContextUsage | undefined> {
    if (!project || !conversation) return undefined;
    return getConversationContextUsage(project.id, conversation.id, passive);
  }

  async function executePlan(): Promise<boolean> {
    if (!project || !conversation) return false;
    try {
      await saveDesign.current?.();
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

  async function respondToApproval(decision: ApprovalDecision): Promise<boolean> {
    if (!project || !conversation || !approval) return false;
    try {
      await answerApproval(project.id, conversation.id, approval.requestId, decision);
      return true;
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

  const revisePrompt = useCallback(async (nextPrompt: string): Promise<boolean> => {
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
  }, [project, conversation, agentBusy, state.pendingPrompts.length, state.connection]);

  const loadedConversationId = conversation?.id;
  const turnChangesDisabled = agentBusy || restoring || unfinishedRestore || publishing || state.connection !== "open";
  const turnChanges = useMemo((): TurnChangesControls | undefined => {
    if (loadedConversationId === undefined) return undefined;
    const change = (operation: typeof undoCheckpoint): TurnChangesControls["undo"] => async (checkpointId, conflicts, expected) => {
      setRestoring(true);
      try {
        await saveDesign.current?.();
        return { status: "done", ...await operation(projectId, loadedConversationId, checkpointId, conflicts, expected) };
      } catch (error) {
        if (error instanceof ApiError && error.status === 409 && error.conflicts) {
          return { status: "conflicts", conflicts: error.conflicts, blocked: Boolean(error.blocked) };
        }
        if (leftUnfinished(error)) setUnfinishedRestore(true);
        return { status: "failed", message: errorMessage(error) };
      } finally { setRestoring(false); }
    };
    return {
      disabled: turnChangesDisabled,
      load: (checkpointId) => getCheckpointChanges(projectId, loadedConversationId, checkpointId),
      file: (checkpointId, path) => getCheckpointFile(projectId, loadedConversationId, checkpointId, path),
      undo: change(undoCheckpoint),
      reapply: change(reapplyCheckpoint),
    };
  }, [projectId, loadedConversationId, turnChangesDisabled]);

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

  async function editFollowUp(item: PendingPrompt): Promise<boolean> {
    return removeFollowUp(item.turnId);
  }

  async function restartPreview(updated = project, reinstall = false) {
    if (!updated || updated.preview.status === "starting") return;
    dispatch({ type: "notice", message: undefined });
    try {
      await startPreview(updated.id, reinstall);
    } catch (error) {
      if (error instanceof ApiError && error.code === "PREVIEW_CANCELLED") return;
      dispatch({ type: "notice", message: errorMessage(error) });
    }
  }

  async function publish(details: PublishDetails): Promise<boolean> {
    if (!project || publishing || agentBusy) return false;
    const resumeAfterWebSignIn = !window.ohMyGameDesktop && auth.state.status !== "signed-in";
    if (resumeAfterWebSignIn) rememberPendingPublish(sessionStorage, project.id, details);
    setPublishing(true);
    dispatch({ type: "notice", message: undefined });
    try {
      const accessToken = await auth.requestAccessToken();
      if (!accessToken) {
        if (resumeAfterWebSignIn) forgetPendingPublish(sessionStorage);
        return false;
      }
      forgetPendingPublish(sessionStorage);
      const result = await publishProject(project.id, accessToken, details);
      const publication = {
        gameId: result.game.id,
        deploymentId: result.game.deploymentId,
        playUrl: result.game.playUrl,
        publishedAt: result.game.publishedAt,
        title: result.game.title,
        description: result.game.description,
      };
      dispatch({ type: "publication-updated", projectId: project.id, publication });
      setPublishDialog({ projectId: project.id, status: "success" });
      return true;
    } catch (error) {
      dispatch({ type: "notice", message: errorMessage(error) });
      throw error;
    } finally {
      setPublishing(false);
    }
  }

  async function newConversation() {
    if (!project || creatingConversation) return;
    setCreatingConversation(true);
    dispatch({ type: "notice", message: undefined });
    try {
      // A new conversation stays with the coding agent the person was using; otherwise it takes the default model.
      const current = state.settings.model;
      const created = await createConversation(project.id, current && isAgentRuntimeId(current.provider) ? current : undefined);
      setCreatingConversation(false);
      onOpenConversation(created.id);
    } catch (error) {
      dispatch({ type: "notice", message: errorMessage(error) });
      setCreatingConversation(false);
    }
  }

  async function changeAccountProfile(profileId: string) {
    if (!project || !conversation || !accountRuntime || agentBusy || modelChanging) return;
    setModelChanging(true);
    try {
      const changed = await setConversationAccountProfile(project.id, conversation.id, accountRuntime, profileId);
      dispatch({ type: "conversation-settings", settings: {
        ...state.settings,
        accountProfiles: { ...state.settings.accountProfiles, [accountRuntime]: profileId },
        ...(changed.model ? { model: changed.model, nativeReasoningLevel: changed.nativeReasoningLevel } : {}),
      } });
    } catch (error) { dispatch({ type: "notice", message: errorMessage(error) }); }
    finally { setModelChanging(false); }
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

  async function branchChat(entryId: string) {
    if (!project || !conversation || creatingConversation || !window.confirm(t("timeline.branchConfirm"))) return;
    setCreatingConversation(true);
    dispatch({ type: "notice", message: undefined });
    try {
      const created = await branchConversation(project.id, conversation.id, entryId);
      onOpenConversation(created.id);
    } catch (error) {
      dispatch({ type: "notice", message: errorMessage(error) });
    } finally { setCreatingConversation(false); }
  }

  async function changeReasoning(level: AgentReasoningLevel) {
    if (!project || !conversation || agentBusy || modelChanging) return;
    setModelChanging(true);
    dispatch({ type: "notice", message: undefined });
    try {
      const reasoningLevel = await setConversationReasoning(project.id, conversation.id, level);
      if (!displayedModel) return;
      dispatch({ type: "conversation-settings", settings: { model: displayedModel, reasoningLevel } });
    } catch (error) {
      dispatch({ type: "notice", message: errorMessage(error) });
    } finally {
      setModelChanging(false);
    }
  }

  async function changeNativeReasoning(level: string) {
    if (!project || !conversation || !displayedModel || agentBusy || modelChanging) return;
    setModelChanging(true);
    try {
      const nativeReasoningLevel = await setConversationReasoning(project.id, conversation.id, level);
      dispatch({ type: "conversation-settings", settings: { model: displayedModel, nativeReasoningLevel } });
    } catch (error) { dispatch({ type: "notice", message: errorMessage(error) }); }
    finally { setModelChanging(false); }
  }

  async function rename(conversationId: string, title: string): Promise<void> {
    if (!project) return;
    const renamed = await renameConversation(project.id, conversationId, title);
    setConversations((items) => items.map((item) => item.id === renamed.id ? renamed : item));
  }

  // An archived conversation leaves the list; the one open moves to the next.
  async function archive(conversationId: string): Promise<void> {
    if (!project) return;
    await archiveConversation(project.id, conversationId);
    setConversations((items) => items.filter((item) => item.id !== conversationId));
    // Another conversation opened while this one was archived stays open.
    if (conversationId !== routeConversation.current) return;
    const next = latestConversations.current.find((item) => item.id !== conversationId);
    if (next) onOpenConversation(next.id, true);
    else await newConversation();
  }

  async function unarchive(conversationId: string): Promise<void> {
    if (!project) return;
    const restored = await unarchiveConversation(project.id, conversationId);
    setConversations((items) => [restored, ...items.filter((item) => item.id !== restored.id)].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
  }

  // Leaving the project saves the open design first.
  function leave(go: () => void): void {
    const save = saveDesign.current;
    if (!save) { go(); return; }
    void save().then(go).catch((cause) => {
      dispatch({ type: "notice", message: errorMessage(cause) });
    });
  }
  const requestHome = () => leave(onHome);
  useLeaveGuard(leave);

  const [renaming, setRenaming] = useState(false);
  const [exporting, setExporting] = useState<"project" | "web">();
  const openProjectFile = window.ohMyGameDesktop?.openProjectFile;
  // The project file from the project menu, or the web build from Publish.
  async function exportFile(kind: "project" | "web"): Promise<void> {
    if (!project || exporting) return;
    setExporting(kind);
    // A restore while the edits save makes the build fail rather than build the restored files.
    const version = workspaceVersion(project.id);
    try {
      // Both are read from disk, so pending edits are saved first.
      await saveDesign.current?.();
      await desktopSave.flush();
      const file = kind === "web" ? await buildWebGame(project.id, version) : await exportProject(project.id);
      const url = URL.createObjectURL(file);
      const link = document.createElement("a");
      link.href = url;
      link.download = kind === "web" ? `${project.name} (${t("workspace.webBuildSuffix")}).zip` : `${project.name}.zip`;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (cause) {
      dispatch({ type: "notice", message: errorMessage(cause) });
    } finally {
      setExporting(undefined);
    }
  }
  async function renameTo(input: string): Promise<void> {
    setRenaming(false);
    const name = input.trim();
    if (!project || !name || name === project.name) return;
    try {
      const updated = await renameProject(project.id, name);
      dispatch({ type: "project-updated", project: updated });
      refreshRecentProject(updated);
    } catch (cause) {
      dispatch({ type: "notice", message: errorMessage(cause) });
    }
  }
  /** Runs a plugin command where its manifest says: the chat, a panel, a page, a link, or the plugin's code. */
  async function runProjectPluginCommand(command: ProjectPluginCommand): Promise<void> {
    if (!project) return;
    const run = command.run;
    if ("prompt" in run) {
      const prompt = commandPrompt(run);
      if (run.insert) requestPrompt(prompt);
      else if (await submitPrompt(prompt, [], [], "normal")) revealPanel("chat");
      return;
    }
    if ("openPanel" in run) return revealPanel(pluginPanelId({ plugin: command.plugin, id: run.openPanel }));
    if ("openSettings" in run) {
      window.location.hash = pluginHash(command.plugin);
      return;
    }
    if ("url" in run) {
      // The manifest only checks that it starts with https://.
      const url = URL.canParse(run.url) ? new URL(run.url) : undefined;
      if (url) setPluginLink({ url });
      else toast({ title: command.title, description: t("pluginCommands.badLink"), tone: "danger" });
      return;
    }
    try {
      const { change } = await runPluginCommand(project.id, command.id);
      showPluginChange(command.title, change);
    } catch (cause) {
      toast({ title: command.title, description: errorMessage(cause), tone: "danger" });
    }
  }
  /** Says a plugin's code ran, with Undo when it changed files. */
  function showPluginChange(title: string, change: { id: string; changed: string[] } | undefined): void {
    if (!project) return;
    const projectId = project.id;
    if (change?.changed.length) setWorkspaceRevision((value) => value + 1);
    toast({
      title: t("pluginCommands.done", { title }),
      ...(change?.changed.length ? {
        description: t("pluginChanges.files", { count: change.changed.length }),
        action: { label: t("pluginChanges.undo"), onClick: () => void undoProjectPluginChange(projectId, change.id).then(
          () => setWorkspaceRevision((value) => value + 1),
          (cause: unknown) => toast({ title: t("pluginChanges.undo"), description: errorMessage(cause), tone: "danger" }),
        ) },
      } : {}),
    });
  }
  /** Menu entries for the plugin commands a slot shows. */
  function pluginCommandEntries(slot: string): MenuEntry[] {
    const commands = commandsForSlot(plugins.commands, slot, plugins.when);
    return commands.length ? ["separator", ...commands.map((command): MenuEntry => ({ label: command.title, icon: <Plug size={14} />, onSelect: () => void runProjectPluginCommand(command) }))] : [];
  }
  /** A plugin's page in its panel, talking to the app through its frame. */
  function pluginPanelContent(panel: PluginPanel, shown: boolean) {
    const current = project!;
    return <PluginFrame url={panel.url!} title={panel.title} visible={shown} progress={pluginProgress} context={{
      plugin: { id: panel.plugin, version: panel.version, panel: panel.id },
      locale: language,
      capabilities: panel.capabilities,
      commands: panel.commands,
      project: () => ({ name: current.name, type: current.pluginType?.id ?? current.type }),
      fillComposer: (text) => requestPrompt(text),
      storage: {
        get: (key) => getPluginPageValue(current.id, panel.plugin, key),
        set: (key, value) => setPluginPageValue(current.id, panel.plugin, key, value),
      },
      runCommand: async (command, input) => {
        const id = `${panel.plugin}:${command}`;
        const found = plugins.commands.find((item) => item.id === id);
        // Commands that run in the app run here; the page only gets back that they did.
        const action = pageCommand(panel, found);
        if (input !== undefined && action.kind !== "plugin") throw new Error(`${id} runs in the app and takes no input`);
        if (action.kind === "fill") requestPrompt(action.text);
        else if (action.kind === "app") await runProjectPluginCommand(action.command);
        if (action.kind !== "plugin") return null;
        const { result, change } = await runPluginCommand(current.id, id, input);
        if (change?.changed.length) showPluginChange(found?.title ?? command, change);
        return result;
      },
    }} />;
  }
  const projectMenu: MenuEntry[] = [
    { label: t("projectShell.renameProject"), icon: <Pencil size={14} />, disabled: !project, onSelect: () => setRenaming(true) },
    ...(openProjectFile && project ? [{ label: t("projectCard.openFolder"), icon: <FolderOpen size={14} />, onSelect: () => {
      void openProjectFile(project.id, ".", "default").catch((cause: unknown) => dispatch({ type: "notice", message: errorMessage(cause) }));
    } }] : []),
    { label: exporting === "project" ? t("projectCard.exporting") : t("projectCard.export"), icon: <Download size={14} />, disabled: !project || !!exporting, onSelect: () => void exportFile("project") },
    { label: t("projectPlugins.menu"), icon: <Plug size={14} />, disabled: !project, onSelect: () => setPluginsOpen(true) },
    { label: t("pluginChanges.menu"), icon: <History size={14} />, disabled: !project, onSelect: () => setPluginChangesOpen(true) },
    ...pluginCommandEntries("project.menu"),
    { label: t("projectAppearance.menu"), icon: <Palette size={14} />, disabled: !project, onSelect: () => setAppearanceOpen(true) },
    "separator",
    { label: homeLabel, icon: <ArrowLeft size={14} />, onSelect: requestHome },
  ];
  const publishButton = project ? publishAction(project, { publishing, agentBusy }) : undefined;

  // Canvas HTML links open the isolated preview; other files open in Code.
  const openWorkspaceFile = useCallback((path: string): void => {
    if (canvasOnly && isHtmlWorkspaceFile(path)) {
      setOpenPreviewRequest((current) => ({ projectId, path, id: (current?.id ?? 0) + 1 }));
      revealPanel("game");
      void ensureProjectPreview(projectId).catch((cause) => dispatch({ type: "notice", message: errorMessage(cause) }));
      return;
    }
    if (story || canvasOnly) revealPanel("code");
    setOpenFileRequest((current) => ({ path, id: (current?.id ?? 0) + 1 }));
  }, [story, canvasOnly, projectId]);
  const addToChat = useCallback((text: string) => {
    if (!conversation) return;
    composerDrafts.get({ projectId, conversationId: conversation.id }).update({ reference: { text } });
  }, [projectId, conversation?.id]);

  // The design document panel shows whether the next message references it.
  const [referencedDocument, setReferencedDocument] = useState<string>();
  useEffect(() => {
    setReferencedDocument(undefined);
    if (!conversation) return;
    const scope = { projectId, conversationId: conversation.id };
    const read = () => setReferencedDocument(composerDrafts.peek(scope)?.designReference?.references[0]?.path);
    read();
    return composerDrafts.watch(scope, read);
  }, [projectId, conversation?.id]);
  const referenceDocument = useCallback((document: { id: string; title: string } | undefined) => {
    revealPanel("chat");
    if (!conversation) return;
    composerDrafts.get({ projectId, conversationId: conversation.id }).update({ designReference: document ? {
      references: [{ type: "workspace-file", path: canvasDocumentPath(document.id) }],
      context: { kind: "design-document", label: document.title || t("composer.gameDesign"), text: "Reference the saved game design document for this message." },
    } : undefined });
  }, [projectId, conversation?.id]);
  const quoteDocument = useCallback((text: string) => {
    revealPanel("chat");
    addToChat(text);
  }, [addToChat]);

  function requestPrompt(text: string): void {
    revealPanel("chat");
    if (!state.conversation) return;
    composerDrafts.get({ projectId, conversationId: state.conversation.id }).insertPrompt(text);
  }

  const toggleMenu: MenuEntry[] = offered.length ? [
    { heading: t("panels.layout") },
    ...presetsFor(offered).map((preset) => ({ label: t(`panels.preset.${preset}`), onSelect: () => changeLayout(presetLayout(preset, offered, homes)) })),
    "separator",
    { heading: t("panels.list") },
    ...offered.map((id) => {
      const { title, icon: Icon } = panelInfo(id);
      const open = !!layout && !!areaOf(layout, id);
      return { label: title, icon: <Icon size={14} />, checked: open, onSelect: () => layout && changeLayout(open ? closePanel(layout, id) : showPanel(layout, id, homeOf(id, homes))) };
    }),
  ] : [];
  // The command menu shows this project's panels and applies its layouts.
  useCommands(() => offered.length ? [
    ...offered.map((id): Command => {
      const { title, icon: Icon } = panelInfo(id);
      return { id: `panel-${id}`, group: t("commandMenu.panels"), label: t("commandMenu.showPanel", { panel: title }), keywords: id, icon: <Icon size={16} />, run: () => revealPanel(id) };
    }),
    ...presetsFor(offered).map((preset): Command => ({
      id: `layout-${preset}`, group: t("commandMenu.panels"), label: t("commandMenu.layout", { preset: t(`panels.preset.${preset}`) }), keywords: `layout ${preset}`, icon: <LayoutGrid size={16} />,
      run: () => changeLayout(presetLayout(preset, offered, homes)),
    })),
  ] : []);
  // The cards that wait on an answer and the composer: in the chat panel, or
  // in the floating bar over the middle while the panel is closed.
  const chatInput = createPortal(<>
    {approval ? (
      <ApprovalCard
        request={approval}
        agentName={approvalAgent}
        waiting={approvals.length - 1}
        onDecide={respondToApproval}
      />
    ) : null}

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

    {initialPrompt && (initialPromptDeferred || (initialPrompt.generation !== runtime.generation && !initialPromptAttempted.current)) ? <div className="paused-initial-prompt" role="status">
      <p>{t(initialPromptDeferred ? "projectShell.promptNotSent" : "projectShell.promptPaused")}</p>
      <details><summary>{t("projectShell.reviewMessage")}</summary><pre>{initialPrompt.prompt}</pre>
        {initialPrompt.images.length || initialPrompt.attachments?.length ? <p>{t("projectShell.attachmentsRetained", { count: initialPrompt.images.length + (initialPrompt.attachments?.length ?? 0) })}</p> : null}
      </details>
      <button type="button" disabled={runtime.status !== "ready" || state.connection !== "open" || !conversation || conversation.id !== conversationId} onClick={sendInitialPrompt}>{t("projectShell.sendOriginal")}</button>
    </div> : null}
    {unfinishedRestore ? <UnfinishedRestoreBanner
      projectId={projectId}
      disabled={agentBusy || state.connection !== "open"}
      workspaceRevision={workspaceRevision}
      onClose={() => setUnfinishedRestore(false)}
    /> : null}
    {!questionnaire && state.plan.mode !== "awaiting_approval" ? <Composer
      key={conversation?.id}
      projectId={project?.id}
      conversationId={conversation?.id}
      supportsDesign={project?.type !== "asset-canvas"}
      conversationReady={Boolean(conversation) && state.connection === "open"}
      running={currentConversationBusy}
      stopping={state.agent.status === "cancelling" || sendingInitialPrompt}
      pendingPrompts={state.pendingPrompts}
      plan={activePlan}
      planMode={state.plan.mode}
      notice={state.connection === "reconnecting" ? t("projectShell.reconnecting") : state.notice}
      limitReached={!currentConversationBusy && items.findLast((item) => item.type === "agentMessage")?.error?.code === "quota_exceeded"}
      models={modelCatalog.models}
      modelStatus={modelCatalog.status}
      model={effectiveModel}
      reasoningLevel={state.settings.reasoningLevel}
      nativeReasoningLevel={state.settings.nativeReasoningLevel}
      accountProfileId={accountRuntime ? selectedProfileId : undefined}
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
      contexts={chatContexts}
      onRemoveContext={(key) => {
        if (key === designChipKey) setDismissedDesign(key);
        else if (previewPicks.some((item) => item.key === key)) setPreviewPicks((current) => current.filter((item) => item.key !== key));
        else if (key === playableChat?.surface?.key) setDismissedSurface(key);
        else playableChat?.removeAttachment(key);
      }}
      onCompact={compactCurrentConversation}
      onContextUsage={currentContextUsage}
      onCancelPlan={discardPlan}
      onModelChange={(model) => void changeModel(model)}
      onReasoningChange={(level) => void changeReasoning(level)}
      onNativeReasoningChange={(level) => void changeNativeReasoning(level)}
      onStop={() => void stopAgent()}
      onRemovePending={removeFollowUp}
      onSteerPending={steerFollowUp}
      onEditPending={editFollowUp}
      canPublish={Boolean(project && (isWebRuntimeProjectType(project.type) || project.type === "interactive-story") && !publishing && !agentBusy)}
      onPublish={project ? () => setPublishDialog({ projectId: project.id, status: "open" }) : undefined}
      pluginCommands={{ slash: slashCommands(plugins.commands, plugins.when), add: commandsForSlot(plugins.commands, "composer.add", plugins.when) }}
      onPluginCommand={(command) => void runProjectPluginCommand(command)}
    /> : null}
  </>, chatInputNode);
  const codingVisible = new Set(visible.flatMap((id): CodingView[] => id === "game" ? ["preview"] : id === "design" || id === "canvas" || id === "code" || id === "assets" ? [id] : []));
  const storyVisible = new Set(visible.filter((id): id is StoryView => id === "story" || id === "design" || id === "canvas" || id === "code" || id === "assets"));

  // After every hook, so a project that fails to load renders the same hooks.
  if (state.phase === "fatal") {
    return <FatalState message={state.notice ?? t("projectShell.runtimeUnreachable")} onHome={onHome} homeLabel={homeLabel} />;
  }

  return (
    <>
    {chatInput}
    {project ? <PluginChangesSheet projectId={project.id} open={pluginChangesOpen} busy={agentBusy} onClose={() => setPluginChangesOpen(false)}
      onUndone={() => setWorkspaceRevision((value) => value + 1)} /> : null}
    {pluginLink ? <Dialog open title={t("pluginCommands.openLinkTitle")} onClose={() => setPluginLink(undefined)} footer={<>
      <Button variant="ghost" onClick={() => setPluginLink(undefined)}>{t("common.cancel")}</Button>
      <Button variant="primary" onClick={() => { openExternalLink(pluginLink.url.href); setPluginLink(undefined); }}>{t("pluginCommands.openLink")}</Button>
    </>}>
      {pluginLink.message ? <p>{pluginLink.message}</p> : null}
      <p>{t("pluginCommands.openLinkHint", { host: pluginLink.url.host })}</p>
    </Dialog> : null}
    {project ? <ProjectPluginsSheet projectId={project.id} open={pluginsOpen} busy={agentBusy} onClose={() => setPluginsOpen(false)} onChanged={() => setCapabilitiesRevision((value) => value + 1)} onOpenPlugins={() => onNavigate("plugins")} /> : null}
    {project && appearanceOpen ? <ProjectAppearanceDialog project={project} open onClose={() => setAppearanceOpen(false)} /> : null}
    {renaming && project ? <ProjectRenameDialog name={project.name} returnFocus={null} onClose={() => setRenaming(false)} onConfirm={(name) => void renameTo(name)} /> : null}
    <ProjectFrame
      rail={<ProjectRail projectId={projectId} project={project} onNavigate={onNavigate} onLeave={leave} conversations={{
        items: conversations,
        current: conversation?.id,
        onOpen: (id) => onOpenConversation(id),
        onNew: () => void newConversation(),
      }} />}
      top={<ProjectTop name={project?.name ?? ""} menu={projectMenu}>
        {toggleMenu.length ? <DropdownMenu placement="bottom-end" items={toggleMenu} trigger={(props) => (
          <IconButton {...props} size="sm" label={t("panels.menu")}><LayoutGrid size={16} /></IconButton>
        )} /> : null}
        {/* Play stays in place from every view. A Web preview fills the slot
            with Play in its own window; an external preview can only be shown. */}
        {project && offered.includes("game") ? previewSupported ? <span className="project-top-play" ref={setPlaySlot} />
          : <Button size="sm" variant="ghost" icon={<Play size={14} />} onClick={() => revealPanel("game")}>{t("workspace.play")}</Button> : null}
        {project && publishButton ? <DropdownMenu placement="bottom-end" items={[
          { label: t("workspace.publishToCommunity"), icon: <Globe2 size={14} />, disabled: exporting === "web", onSelect: () => setPublishDialog({ projectId: project.id, status: "open" }) },
          "separator",
          { label: exporting === "web" ? t("workspace.exportingWebBuild") : t("workspace.exportWebBuild"), icon: <Upload size={14} />, disabled: !!exporting, onSelect: () => void exportFile("web") },
        ]} trigger={(props) => (
          <Button {...props} size="sm" variant="primary" icon={publishing || exporting === "web" ? <LoaderCircle className="spin" size={14} /> : <Share2 size={14} />}
            disabled={publishButton.disabled} title={publishButton.label}>{t("workspace.publish")}</Button>
        )} /> : null}
      </ProjectTop>}>
    {layout || !project ? <PanelLayout layout={layout ?? loadingLayout()} onChange={changeLayout}
      panels={(project ? offered : ["chat" as const]).map((id) => {
        const { title, icon: Icon, source } = panelInfo(id);
        const target = source ? pluginNodes.get(id) : nodes[id as WorkspacePanel];
        return { id, title, icon: <Icon size={14} />, home: homeOf(id, homes), ...(source ? { source } : {}),
          content: target ? <PanelMount nodes={target} /> : null };
      })}
      overlay={project && !chatShown ? <FloatingChat
        key={conversation?.id}
        turnCount={state.turns.length}
        thread={(since) => (
          <ErrorBoundary label={t("errorBoundary.label.conversation")} resetKey={conversation?.id}>
            <AgentTimeline
              turns={state.turns.slice(since)}
              projectId={projectId}
              workspacePath={project.workspacePath}
              onOpenWorkspaceFile={openWorkspaceFile}
              previewHtmlLinks={canvasOnly}
              waitingForInput={Boolean(questionnaire || approval)}
              changeControls={turnChanges}
              workspaceRevision={workspaceRevision}
              plugins={capabilities.plugins}
            />
          </ErrorBoundary>
        )}
        running={currentConversationBusy}
        attention={Boolean(approval || questionnaire || state.plan.mode === "awaiting_approval")}
        onExpand={() => revealPanel("chat")}
        input={chatInputNode}
      /> : undefined}
      empty={project ? <Empty title={t("panels.empty")} action={<Button onClick={() => changeLayout(presetLayout("default", offered, homes))}>{t("panels.reset")}</Button>} /> : null} /> : null}
    {createPortal(<div className="pane-header-actions chat-header-actions">
            <ConversationMenu
              conversations={conversations}
              currentConversationId={conversation?.id}
              activeConversationId={activeTurn?.conversationId}
              disabled={!conversation}
              onRename={rename}
              onSelect={onOpenConversation}
              onArchive={archive}
              archive={project ? {
                list: () => listArchivedConversations(project.id),
                restore: unarchive,
                remove: (conversationId) => deleteArchivedConversation(project.id, conversationId),
              } : undefined}
            />
            <span className="chat-header-spacer" />
            {accountRuntime && accountProfiles.length > 1 ? <div className="chat-account-selector">
              <CanvasChipSelect icon={UserRound} label={t("codingAgents.chatProfile", { name: accountRuntime === "codex-cli" ? "Codex" : "Claude Code" })} value={selectedProfileId}
                options={accountProfiles.map((profile) => {
                  const name = profile.id === "system" ? t("codingAgents.profileSystem") : profile.name;
                  return { value: profile.id, shortLabel: name, label: profile.auth.account ? `${name} · ${profile.auth.account}` : name };
                })}
                disabled={agentBusy || modelChanging || state.connection !== "open"} onChange={(profileId) => void changeAccountProfile(profileId)} />
            </div> : null}
            <button
              className="icon-button pane-header-action"
              type="button"
              disabled={!project || creatingConversation}
              onClick={() => void newConversation()}
              title={t("projectShell.newConversation")}
              aria-label={t("projectShell.newConversation")}
            >
              {creatingConversation ? <LoaderCircle className="spin" size={14} /> : <MessageSquarePlus size={14} />}
            </button>
    </div>, nodes.chat.toolbar)}
    {createPortal(<section className="agent-pane" aria-label={t("workspace.agent")}>
      <div className="agent-body" ref={timeline} onScroll={(event) => {
        const element = event.currentTarget;
        followTimeline.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
      }}>
          <div className="timeline" aria-live="polite">
            {state.phase === "loading" ? <TimelineSkeleton /> : null}
            <Activity mode={chatShown ? "visible" : "hidden"}>
              <ErrorBoundary label={t("errorBoundary.label.conversation")} resetKey={conversation?.id}>
              <AgentTimeline
                turns={state.turns}
                projectId={projectId}
                workspacePath={project?.workspacePath}
                onOpenWorkspaceFile={project ? openWorkspaceFile : undefined}
                previewHtmlLinks={canvasOnly}
                revisionDisabled={agentBusy || restoring || unfinishedRestore || state.plan.mode !== "normal" || state.pendingPrompts.length > 0 || state.connection !== "open"}
                waitingForInput={Boolean(questionnaire || approval)}
                onRevise={revisePrompt}
                changeControls={turnChanges}
                workspaceRevision={workspaceRevision}
                onAddToChat={addToChat}
                onBranch={branchChat}
                branchDisabled={creatingConversation || state.connection !== "open"}
                plugins={capabilities.plugins}
              />
              </ErrorBoundary>
            </Activity>
          </div>

      </div>
    </section>, nodes.chat.body)}
      <ErrorBoundary key={`${projectId}:${workspaceEpoch}`} label={t("errorBoundary.label.workspace")} resetKey={project?.id} onHome={onHome} homeLabel={homeLabel}>
      {!project ? null : coding ? (
        <CodingWorkspace
          project={project}
          publishing={publishing}
          workspaceRevision={workspaceRevision + (canvasOnly ? canvasCodeRevision : 0)}
          previewPaused={previewPaused}
          openFileRequest={openFileRequest}
          openPreviewRequest={openPreviewRequest}
          onOpenWorkspaceFile={canvasOnly ? openWorkspaceFile : undefined}
          onPublish={publish}
          publishDialog={publishDialogStatus}
          onClosePublish={() => setPublishDialog(undefined)}
          onRestart={restartPreview}
          onStop={async () => {
            try { await stopPreview(project.id); } catch (cause) { dispatch({ type: "notice", message: errorMessage(cause) }); }
          }}
          onAskAgent={requestPrompt}
          onDesignSaveReady={registerDesignSave}
          onDesignContextChange={setDesignContext}
          onProjectUpdated={(updated) => dispatch({ type: "project-updated", project: updated })}
          referencedDocument={referencedDocument}
          onReferenceDocument={referenceDocument}
          onQuoteDocument={quoteDocument}
          pickingClient={pickingClient}
          onPickingChange={setPickingClient}
          panels={{
            nodes: { preview: nodes.game, design: nodes.design, canvas: nodes.canvas, code: nodes.code, assets: nodes.assets },
            visible: codingVisible,
            onShow: (view) => revealPanel(view === "preview" ? "game" : view),
            play: playSlot,
          }}
        />
      ) : story ? <PlayableEditorWorkspace
        project={project}
        showStoryMap={showStoryMap}
        onStoryMapShown={onStoryMapShown}
        onProjectUpdated={(updated) => dispatch({ type: "project-updated", project: updated })}
        onDesignSaveReady={registerDesignSave}
        onDesignContextChange={setDesignContext}
        publishing={publishing}
        workspaceRevision={workspaceRevision}
        openFileRequest={openFileRequest}
        onPublish={publish}
        publishDialog={publishDialogStatus}
        onClosePublish={() => setPublishDialog(undefined)}
        onChatContextChange={setPlayableChat}
        onAskAgent={requestPrompt}
        onSendToAgent={sendEditorRequest}
        referencedDocument={referencedDocument}
        onReferenceDocument={referenceDocument}
        onQuoteDocument={quoteDocument}
        panels={{
          nodes: { story: nodes.story, design: nodes.design, canvas: nodes.canvas, code: nodes.code, assets: nodes.assets },
          visible: storyVisible,
          onShow: revealPanel,
        }}
      /> : createPortal(<Suspense fallback={<div className="design-loading"><LoaderCircle className="spin" size={18} /></div>}><CanvasWorkspace
        project={project}
        onProjectUpdated={(updated) => dispatch({ type: "project-updated", project: updated })}
        onSaveReady={registerDesignSave}
        onContextChange={setDesignContext}
        headerActionsTarget={nodes.canvas.toolbar}
      /></Suspense>, nodes.canvas.body)}
      {project ? [...pluginNodes].flatMap(([id, target]) => {
        const panel = pluginPanels.get(id);
        return panel ? [createPortal(pluginPanelContent(panel, visible.includes(id)), target.body, id)] : [];
      }) : null}
      </ErrorBoundary>
    </ProjectFrame>
    </>
  );
}

function TimelineSkeleton() {
  return (
    <div className="timeline-skeleton" aria-label={t("projectShell.loading")}>
      <span />
      <span />
      <span />
    </div>
  );
}

/**
 * Offers to take back a restore or an undo that was cut off. Taking it back
 * restores files too, so it first lists what it does to them and asks.
 */
function UnfinishedRestoreBanner({ projectId, disabled, workspaceRevision, onClose }: {
  projectId: string;
  disabled: boolean;
  workspaceRevision: number;
  /** Nothing is left to offer, or the user put the offer aside. */
  onClose: () => void;
}) {
  const [changes, setChanges] = useState<CheckpointChangeItem[]>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  // The list holds for the files as they stood when it was read, so the user is asked again once they changed.
  useEffect(() => { setChanges(undefined); }, [workspaceRevision]);

  async function attempt(request: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await request();
    } catch (cause) {
      // Nothing is unfinished any more: a later restore or undo ran to its end.
      if (cause instanceof ApiError && cause.status === 404) return onClose();
      setChanges(undefined);
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="unfinished-restore" role="status">
      <p>{t("checkpoints.unfinished.interrupted")}</p>
      {error ? <p className="unfinished-restore-error" role="alert">{error}</p> : null}
      {changes?.length === 0 ? <>
        <p>{t("checkpoints.unfinished.alreadyBack")}</p>
        <div className="unfinished-restore-actions">
          <button type="button" disabled={busy || disabled} onClick={() => void attempt(async () => { await restoreUnfinished(projectId); onClose(); })}>{t("checkpoints.unfinished.ok")}</button>
        </div>
      </> : changes ? <>
        <p>{t("checkpoints.unfinished.willPutBack", { count: changes.length })}</p>
        <ul className="unfinished-restore-files">
          {changes.slice(0, NAMED_UNFINISHED_FILES).map((change) => <li key={change.path}><span>{t(`checkpoints.unfinished.kind.${change.kind}`)}</span>{change.path}</li>)}
          {changes.length > NAMED_UNFINISHED_FILES ? <li>{t("checkpoints.andMore", { count: changes.length - NAMED_UNFINISHED_FILES })}</li> : null}
        </ul>
        <div className="unfinished-restore-actions">
          <button type="button" disabled={busy || disabled} onClick={() => void attempt(async () => { await restoreUnfinished(projectId); onClose(); })}>{t("checkpoints.unfinished.putBack", { count: changes.length })}</button>
          <button type="button" disabled={busy} onClick={onClose}>{t("checkpoints.unfinished.notNow")}</button>
        </div>
      </> : <button type="button" disabled={busy || disabled} onClick={() => void attempt(async () => setChanges(await getUnfinishedChanges(projectId)))}>{t("checkpoints.unfinished.putFilesBack")}</button>}
    </div>
  );
}

function FatalState({ message, onHome, homeLabel }: { message: string; onHome: () => void; homeLabel: string }) {
  return (
    <main className="fatal-state">
      <X size={24} />
      <h1>{t("projectShell.unavailable")}</h1>
      <p>{message}</p>
      <div className="fatal-actions">
        <button type="button" onClick={onHome}><ArrowLeft size={15} />{homeLabel}</button>
        <button type="button" onClick={() => window.location.reload()}><RefreshCw size={15} />{t("common.reload")}</button>
      </div>
    </main>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function openExternalLink(url: string): void {
  const external = window.ohMyGameDesktop?.openExternal;
  if (external) void external(url).catch(() => undefined);
  else window.open(url, "_blank", "noopener,noreferrer");
}

/** Whether a restore or an undo failed part way and could not take back what it had already changed. */
function leftUnfinished(error: unknown): boolean {
  return error instanceof ApiError && (error.code === "CHECKPOINT_INCOMPLETE" || error.code === "workspace_recovery");
}

async function initialConversationModel(): Promise<AgentModelRef | undefined> {
  try {
    // OhMyGame's own models come first; with none connected, the first coding agent that is set up.
    const catalog = await listModels({ agentRuntimes: true });
    return catalog.defaultModel ?? catalog.models[0];
  } catch {
    return undefined;
  }
}
