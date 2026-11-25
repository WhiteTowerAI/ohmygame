import type { GameTuningState } from "../shared/game-tuning.js";
import { HOOK_FILES_MAX } from "../shared/plugin-hooks.js";
import { isAccountRuntimeId, isAgentRuntimeId, type ApprovalDecision, type AgentAccountProfileStatus } from "../shared/agent-runtimes.js";
import {
  Play,
  Plug,
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
  Settings,
  RefreshCw,
  Globe2,
  Share2,
  Upload,
  X,
  Package
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
  type ReactNode,
} from "react";
import { previewElementContext } from "../shared/playable-chat-context.js";
import { isProgressLink } from "../shared/extension-host-protocol.js";
import { publicationOf } from "../shared/publish-v1.js";
import type { AgentContextUsage, AgentModel, AgentReasoningLevel, CheckpointChangeItem, ConversationCapabilities, ConversationDetail, ConversationSummary, LimitResume, PendingPrompt, PluginMention, PromptAttachment, PromptContext, PromptImage, PromptMode, PromptReference, QuestionnaireResponse, RuntimeEvent, RuntimeEventData, ThreadItem } from "../shared/contracts.js";
import { findAgentModel, preferredAgentModel } from "../shared/agent-models.js";
import { isWebRuntimeProjectType, supportsWebPreview } from "../shared/project-runtime.js";
import {
  ApiError,
  acquirePreview,
  buildWebGame,
  exportProject,
  renameProject,
  releasePreview,
  stopPreview,
  answerApproval,
  answerQuestionnaire,
  holdQuestionnaire,
  cancelPrompt,
  compactConversation,
  createConversation,
  branchConversation,
  getConversation,
  getConversationContextUsage,
  getConversationCapabilities,
  turnOnProjectPlugin,
  setProjectPlugin,
  getCheckpointChanges,
  getCheckpointFile,
  getProject,
  getUnfinishedChanges,
  getUnfinishedRestore,
  listConversations,
  publishProject,
  removePendingPrompt,
  removeScheduledMessage,
  scheduleMessage,
  renameConversation,
  archiveConversation,
  listArchivedConversations,
  unarchiveConversation,
  deleteArchivedConversation,
  reapplyCheckpoint,
  restoreUnfinished,
  reviseLastPrompt,
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
  createPluginFolder,
  deletePluginFile,
  getPluginPageValue,
  listPluginFiles,
  getPluginHistory,
  getPluginUsage,
  listPluginModels,
  completePluginModel,
  listPluginGenerationModels,
  generatePluginMedia,
  runPluginAssistant,
  getPluginAssistantHistory,
  clearPluginAssistant,
  addPluginLibraryAsset,
  movePluginFile,
  readPluginFile,
  writePluginFile,
  setPluginPageValue,
  runPluginCommand,
  pluginNetFetch,
  reportPluginPanelError,
  reportProjectPluginError,
  undoProjectPluginChange,
  type PluginPanel,
  skipLimitResume,
  updateAgentRuntime,
  makeProjectPluginShared,
  answerDraftCapture,
  answerPluginPanelCapture,
  answerPluginPageTool,
  runDraftPageCommand,
} from "./api.js";
import { AgentAccountMenu } from "./agent-account-menu.js";
import { PluginLogDialog } from "./plugin-log.js";
import { ConversationMenu } from "./conversation-menu.js";
import { ConversationInstructionsDialog } from "./conversation-instructions-dialog.js";
import { ProjectPluginsSheet } from "./project-plugins-sheet.js";
import { ProjectSettings, type ProjectSettingsSlot, type ProjectSettingsTab } from "./project-settings.js";
import { AgentTimeline } from "./agent-timeline.js";
import type { TurnChangesControls } from "./turn-changes.js";
import { CodingWorkspace, WorkspaceCodeView } from "./coding-workspace.js";
import { PlayableEditorWorkspace, type StoryView } from "./playable-editor-workspace.js";
import type { PlayableChatState } from "./playable-chat.js";
import { Composer, type ComposerDraft } from "./composer.js";
import { useViewedProjectResult } from "./project-attention.js";
import { FloatingChat } from "./floating-chat.js";
import { composerDrafts } from "./composer-drafts.js";
import { appendAttachments, attachmentFiles, imageAttachment } from "./composer-attachments.js";
import { canvasDocumentPath } from "../shared/canvas-document.js";
import { QuestionnaireCard } from "./questionnaire-card.js";
import { ApprovalCard } from "./approval-card.js";
import { notifyPromptSent, useNotificationView } from "./agent-notifications.js";
import { initialRendererState, rendererReducer } from "./state.js";
import { useAgentModels } from "./model-selector.js";
import { useAuth } from "./auth.js";
import { forgetPendingPublish, rememberPendingPublish, takePendingPublish } from "./pending-publish.js";
import type { PluginUiConfirm } from "../shared/plugin-ui-protocol.js";
import type { PublishDetails } from "./publish-dialog.js";
import { usePlaytestAskRequests } from "./playable-playtest.js";
import { useRuntimeConnection } from "./runtime-connection.js";
import { ErrorBoundary } from "./error-boundary.js";
import { createPanelNodes, PanelLayout, PanelMount, place, showPanel, visiblePanels, areaOf, type Layout, type PanelNodes } from "./panel-layout.js";
import { fitLayout, gamePanelAddable, homeOf, panelTitle, loadingLayout, mergeLayout, openingLayout, panelsOf, presetLayout, presetsFor, saveLayout, type OnRequestPanels, type PanelHomes, type PanelId, type SavedLayout, type WorkspacePanel } from "./workspace-layout.js";
import { announceProjectPluginsChanged, commandPrompt, commandsForSlot, pageCommand, type PluginCommandTarget, pluginPanelId, PluginPanelToolbar, PluginSlotsContext, slashCommands, useProjectPluginContributions } from "./project-plugin-contributions.js";
import { currentTheme, PluginFrame, PLUGIN_TOAST_LIMIT, PLUGIN_TOAST_WINDOW_MS, rateLimit, type CommandProgress, type PageToolHost, type PluginToolbarRun } from "./plugin-frame.js";
import { draftSetupId, PANEL_SCREENSHOT_CAPTURE_MS, type PanelCapture } from "../shared/plugin-setup.js";
import { blobBase64, captureElement, nextPaint } from "./page-capture.js";

import { pluginHash } from "./routes.js";
import type { ProjectPluginCommand } from "../shared/plugins.js";
import type { CodingView } from "./coding-workspace.js";
import { ProjectRail, type RailConversations } from "./app-sidebar.js";
import { refreshSidebarProject } from "./sidebar-projects.js";
import { desktopSave } from "./desktop-save.js";
import { ProjectFrame, ProjectTop, publishAction } from "./project-frame.js";
import { Button, Dialog, DropdownMenu, Empty, IconButton, useToast, type Command, type MenuEntry } from "./ui/index.js";
import { openPluginWorkspace } from "./plugin-builder-navigation.js";
import { useCommands, useLeaveGuard } from "./command-menu.js";
import type { IconComponent } from "./icons.js";
import { BrowserPanel, type BrowserOpenRequest } from "./browser-panel.js";
import type { AppNavigationTarget } from "./routes.js";
import { language, t } from "./i18n.js";

/** How long a plugin panel gets to draw after it is shown, before an agent's capture of it. */
const PANEL_CAPTURE_SETTLE_MS = 600;
/** The widest a capture of a plugin panel is, in pixels. */
const PANEL_CAPTURE_MAX_WIDTH = 1600;
/** How long before the daemon stops waiting a capture answers anyway, with why it has no image. */
const PANEL_CAPTURE_ANSWER_MARGIN_MS = 1500;
/** How long a window reads its panels again for one an agent names that it doesn't list. */
const PANEL_CAPTURE_LIST_MS = 3_000;

/** `get`'s value once it has one, checked every 100 ms until `deadline` (epoch milliseconds). */
async function waitFor<T>(get: () => T | undefined, deadline: number): Promise<T | undefined> {
  for (;;) {
    const value = get();
    if (value !== undefined || Date.now() >= deadline) return value;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

interface ProjectShellProps {
  projectId: string;
  conversationId?: string;
  view?: "design";
  onViewChange?: (view: "design" | "workspace", options?: { replace?: boolean }) => void;
  initialPrompt?: { generation: number; prompt: string; mentions: PluginMention[]; images: PromptImage[]; mode: PromptMode; attachments?: PromptAttachment[] };
  initialDraft?: ComposerDraft;
  /** A canvas node to select once an Asset Canvas project opens, such as a new template's start. */
  initialCanvasNodeId?: string;
  onInitialCanvasNodeHandled?: () => void;
  showStoryMap?: boolean;
  onStoryMapShown?: () => void;
  onInitialPromptHandled?: () => void;
  onInitialDraftHandled?: () => void;
  onOpenConversation: (conversationId: string, replace?: boolean) => void;
  /** Where the rail goes: Home, the other pages and settings. */
  onNavigate: (page: AppNavigationTarget) => void;
  onHome: () => void;
  homeLabel?: string;
  /** A plugin workspace's own rail, top bar and Overview, around the project's chat and files. */
  workspace?: ProjectWorkspace;
}

/** What a workspace that isn't a game puts around the project's chat. */
export interface ProjectWorkspace {
  /** Given the open project's conversations, for its item's hover list. */
  rail: (conversations: RailConversations) => ReactNode;
  placeholder: string;
  /** The top bar and the `plugin` panel, rendered into the nodes given. */
  render: (view: ProjectWorkspaceView) => ReactNode;
}

export interface ProjectWorkspaceView {
  /** Whether the project's agent is working. */
  busy: boolean;
  /** Changes whenever the workspace's files may have changed. */
  revision: number;
  /** Puts a prompt in the chat's box. */
  ask: (text: string) => void;
  openFile: (path: string) => void;
  top: HTMLElement;
  panel: PanelNodes;
}

const CanvasWorkspace = lazy(() => import("./canvas-workspace.js").then((module) => ({ default: module.CanvasWorkspace })));
const PANEL_ICONS: Record<WorkspacePanel, IconComponent> = {
  chat: ChatSquare,
  game: Gamepad2,
  design: FileDocument,
  code: Code,
  assets: Layers3,
  story: Book,
  canvas: GalleryWide,
  plugin: Package,
  browser: Globe2,
};
const EMPTY_CAPABILITIES: ConversationCapabilities = { plugins: [], skills: [] };
/** How many of those files are named before they are only counted. */
const NAMED_UNFINISHED_FILES = 10;

const MAX_PREVIEW_PICKS = 6;
/** A message carries at most 12 contexts; plugin panels' take what is left, this many at most. */
const MAX_PROMPT_CONTEXTS = 12;
const MAX_PANEL_CONTEXTS = 3;
/** How long a panel's page has to load for a call to one of its tools, once a window has taken it. */
const PAGE_TOOL_LOAD_MS = 20_000;
/** The most JSON a page tool may answer with, within what the daemon takes. */
const PAGE_TOOL_RESULT_MAX_CHARS = 1_000_000;

/** A panel context's label, `Panel: label`, within the 200 characters a context's label may have; the panel's title gives way. */
export function panelContextLabel(title: string, label: string): string {
  const room = 200 - label.length - 2;
  return `${room >= title.length ? title : `${title.slice(0, Math.max(1, room - 1))}…`}: ${label}`.slice(0, 200);
}

/** How often streamed text renders: often enough to read as it arrives, far less than once a token. */
const TEXT_INTERVAL_MS = 50;

export function ProjectShell({
  projectId,
  conversationId,
  view,
  onViewChange,
  initialPrompt,
  initialDraft,
  initialCanvasNodeId,
  onInitialCanvasNodeHandled,
  showStoryMap,
  onStoryMapShown,
  onInitialPromptHandled,
  onInitialDraftHandled,
  onOpenConversation,
  onNavigate,
  onHome,
  homeLabel = t("navigation.backTo", { page: t("sidebar.projects") }),
  workspace,
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
  /** Says why a new project's first message is back in the input box, until a message is sent. */
  const [initialPromptReturned, setInitialPromptReturned] = useState<string>();
  const [creatingConversation, setCreatingConversation] = useState(false);
  const [instructionsOpen, setInstructionsOpen] = useState(false);
  // The workspace's panels, in the one layout every project shares (see
  // workspace-layout.ts). Each panel's view renders into nodes of its own,
  // which the panel shows.
  // Bumped when the project's plugins change, so the chat offers their skills
  // and commands, and their panels come and go.
  const [capabilitiesRevision, setCapabilitiesRevision] = useState(0);
  const [workspaceRevision, setWorkspaceRevision] = useState(0);
  // Plugins' panels follow the type's own, in the areas they name; the
  // project's own plugins are files, so they're read again when files change.
  const plugins = useProjectPluginContributions(state.project, capabilitiesRevision, workspaceRevision);
  useEffect(() => { if (capabilitiesRevision) announceProjectPluginsChanged(); }, [capabilitiesRevision]);
  const pluginPanels = new Map(plugins.panels.map((panel) => [pluginPanelId(panel), panel]));
  const homes: PanelHomes = Object.fromEntries(plugins.panels.map((panel) => [pluginPanelId(panel), panel.area]));
  const onRequest: OnRequestPanels = new Set(plugins.panels.filter((panel) => panel.opens === "onRequest").map(pluginPanelId));
  // A General project without Web preview leaves the Game panel out until the
  // person adds it, here and only for this project.
  const [gameAddedTo, setGameAddedTo] = useState<string>();
  const gameAddable = !!state.project && gamePanelAddable(state.project);
  const offered: PanelId[] = state.project ? [...panelsOf(state.project, gameAddedTo === state.project.id), ...pluginPanels.keys()] : [];
  /** What the panel menu lists: what the project offers, and the Game panel it can add. */
  const listed: PanelId[] = state.project ? [...panelsOf(state.project, gameAddable), ...pluginPanels.keys()] : [];
  const [saved, setSaved] = useState<SavedLayout | undefined>();
  const opening = useMemo(() => state.project ? openingLayout(offered, homes, onRequest) : undefined, [!!state.project]);
  const current = saved ?? opening;
  const layout = state.project && current ? fitLayout(current, offered, presetLayout("default", offered, homes, onRequest), onRequest) : undefined;
  const visible = layout ? visiblePanels(layout, new Set(offered)) : [];
  const chatShown = !layout || visible.includes("chat");
  const [nodes] = useState(() => Object.fromEntries(Object.keys(PANEL_ICONS).map((id) => [id, createPanelNodes()])) as Record<WorkspacePanel, PanelNodes>);
  // A plugin page gets its nodes once its panel is first placed, and keeps
  // them, so moving or closing the panel never reloads the page.
  const pluginNodes = useRef(new Map<PanelId, PanelNodes>()).current;
  // How to call each connected plugin page's tools, and the calls running, by request.
  const pageToolHosts = useRef(new Map<PanelId, PageToolHost>()).current;
  const pageToolCalls = useRef(new Map<string, AbortController>()).current;
  /** Panel captures this window took for agents, by request, so one an agent gave up on stops. */
  const panelCaptures = useRef(new Map<string, AbortController>()).current;
  // What each plugin page says the person is looking at, and what the person removed from the composer.
  const [panelContexts, setPanelContexts] = useState<ReadonlyMap<PanelId, { label: string; text: string }>>(() => new Map());
  const [dismissedPanelContexts, setDismissedPanelContexts] = useState<ReadonlySet<string>>(() => new Set());
  // The latest state each plugin panel was opened with, a new object each time, which its page hears once.
  const [panelOpens, setPanelOpens] = useState<Readonly<Partial<Record<PanelId, { state: unknown }>>>>({});
  for (const id of pluginPanels.keys())
    if (layout && areaOf(layout, id) && !pluginNodes.has(id)) pluginNodes.set(id, createPanelNodes());
  // The browser starts its tabs once the person first opens it in a project, and keeps them until the project closes.
  const [browserOpenedIn, setBrowserOpenedIn] = useState<string>();
  const [browserOpenRequests, setBrowserOpenRequests] = useState<Array<BrowserOpenRequest & { projectId: string }>>([]);
  const browserPlaced = !!layout && !!areaOf(layout, "browser");
  useEffect(() => { if (browserPlaced && state.project) setBrowserOpenedIn(state.project.id); }, [browserPlaced, state.project?.id]);
  useEffect(() => window.ohMyGameDesktop?.browser?.onCommand((id, command) => {
    if (command === "reveal" && id === state.project?.id) revealPanel("browser");
  }), [state.project?.id]);
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
  /** Shows a plugin's panel; with `state`, its page hears it was opened with that. */
  function openPluginPanel(plugin: string, panel: string, state?: unknown): void {
    const id = pluginPanelId({ plugin, id: panel });
    if (state !== undefined) setPanelOpens((opens) => ({ ...opens, [id]: { state } }));
    revealPanel(id);
  }
  /** Brings a panel forward, opening it where it belongs if it was closed. */
  function revealPanel(id: PanelId): void {
    const { layout, offered, homes } = latestLayout.current;
    if (layout && offered.includes(id)) changeLayout(showPanel(layout, id, homeOf(id, homes)));
    // The Game panel joins once added, then shows on the next render.
    else if (id === "game" && gameAddable && state.project) setGameAddedTo(state.project.id);
  }
  const browserProjectId = window.ohMyGameDesktop?.browser ? state.project?.id : undefined;
  const openInBrowserPanel = useCallback((url: string): void => {
    if (!browserProjectId) return;
    setBrowserOpenRequests((requests) => [...requests, { projectId: browserProjectId, url }]);
    revealPanel("browser");
  }, [browserProjectId]);
  useEffect(() => { if (gameAddedTo && gameAddedTo === state.project?.id) revealPanel("game"); }, [gameAddedTo]);
  /** The + menu lists the Game panel a project can add; picking it adds it first. */
  function changeLayoutOrAddGame(next: Layout): void {
    if (gameAddable && !latestLayout.current.offered.includes("game") && areaOf(next, "game")) revealPanel("game");
    else changeLayout(next);
  }
  /** A panel's name and icon; a plugin's panel shows its title with the plugin icon. */
  function panelInfo(id: PanelId): { title: string; icon: IconComponent; source?: string } {
    const plugin = pluginPanels.get(id);
    if (plugin?.draft) return { title: t("pluginBuilder.previewPanel", { title: plugin.title }), icon: Plug };
    if (plugin) return { title: plugin.title, icon: Plug, source: plugin.plugin };
    return { title: panelTitle(id as WorkspacePanel), icon: PANEL_ICONS[id as WorkspacePanel] };
  }
  const [publishing, setPublishing] = useState(false);
  const [publishDialog, setPublishDialog] = useState<{ projectId: string; status: "open" | "success" }>();
  const [gameTuning, setGameTuning] = useState<GameTuningState>();
  const savedTuning = useRef<string | undefined>(undefined);
  const [workspaceEpoch, setWorkspaceEpoch] = useState(() => workspaceVersion(projectId));
  const [restoring, setRestoring] = useState(false);
  /** Set while a restore or an undo that was cut off has not been taken back, unless the user put the offer aside. */
  const [unfinishedRestore, setUnfinishedRestore] = useState(false);
  const [openFileRequest, setOpenFileRequest] = useState<{ path: string; id: number }>();
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
  // The project's settings, on this tab while they are open. A game or story shows its own tab through the slot.
  const [settingsTab, setSettingsTab] = useState<ProjectSettingsTab>();
  const [settingsNode, setSettingsNode] = useState<HTMLDivElement | null>(null);
  const [settingsBusy, setSettingsBusy] = useState(false);
  const closeSettings = useCallback(() => { setSettingsTab(undefined); setSettingsBusy(false); }, []);
  const settingsSlot = useMemo<ProjectSettingsSlot | undefined>(() => settingsNode ? { node: settingsNode, onBusyChange: setSettingsBusy, onClose: closeSettings } : undefined, [settingsNode, closeSettings]);
  /** A plugin command's link, shown with its host before it opens. */
  /** A link a plugin command offers, opened only once the person sees its host; `message` is the plugin's. */
  const [pluginLink, setPluginLink] = useState<{ url: URL; message?: string }>();
  const [pluginProgress, setPluginProgress] = useState<CommandProgress>();
  /** The latest files the daemon saw change, for pages that read the project's files. */
  const [pluginFileChange, setPluginFileChange] = useState<{ paths: string[]; truncated?: boolean }>();
  /** Changes that arrived since pages last heard: several can come before one render. */
  const pendingFileChange = useRef<{ paths: string[]; truncated?: boolean }>(undefined);
  useEffect(() => { pendingFileChange.current = undefined; }, [pluginFileChange]);
  /** Each plugin's hooks show at most as many notices as its pages may show toasts. */
  const noticeLimits = useRef(new Map<string, () => boolean>());
  const [pluginToolbarRuns] = useState(() => new Set<(run: PluginToolbarRun) => void>());
  const onPluginToolbarRun = useCallback((listener: (run: PluginToolbarRun) => void) => {
    pluginToolbarRuns.add(listener);
    return () => { pluginToolbarRuns.delete(listener); };
  }, [pluginToolbarRuns]);
  /** The question a plugin's page is asking, in a dialog the app draws. */
  const [pluginConfirm, setPluginConfirm] = useState<{ panel: PanelId; plugin: string; request: PluginUiConfirm; answer: (yes: boolean) => void }>();
  // The plugin whose log is open, from an error it caused.
  const [pluginLog, setPluginLog] = useState<string>();
  // A panel's uncaught errors go to its log; the first one each session says so.
  const pluginErrorsShown = useRef(new Set<string>());
  const pluginConfirmOpen = useRef(false);
  // A question from a panel that's gone has nobody to answer to.
  useEffect(() => {
    if (pluginConfirm && !pluginPanels.has(pluginConfirm.panel)) answerPluginConfirm(false);
  }, [pluginConfirm, plugins.panels]);
  const toast = useToast();
  // "Ask AI to fix" in the Playtest window lands in this chat, ready to send.
  // The chat takes the request once its conversation is open.
  usePlaytestAskRequests(state.conversation ? state.project?.id : undefined, requestPrompt);
  const accountRuntime = isAccountRuntimeId(state.settings.model?.provider) ? state.settings.model.provider : undefined;
  const storedProfileId = accountRuntime ? state.settings.accountProfiles?.[accountRuntime] ?? "system" : "system";
  const selectedProfileId = accountProfiles.length && !accountProfiles.some((profile) => profile.id === storedProfileId) ? "system" : storedProfileId;
  const modelCatalog = useAgentModels({
    enabled: Boolean(state.conversation),
    agentRuntimes: true,
    accountProfiles: {
      "claude-code-cli": state.settings.accountProfiles?.["claude-code-cli"] ?? "system",
      "codex-cli": state.settings.accountProfiles?.["codex-cli"] ?? "system",
    },
  });
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
  const selectedModel = state.settings.model;
  const effectiveModel = selectedModel
    ? findAgentModel(modelCatalog.models, selectedModel) ?? findAgentModel(modelCatalog.hiddenModels ?? [], selectedModel) ?? selectedModel
    : preferredAgentModel(modelCatalog.models, undefined, modelCatalog.defaultModel);
  const initialPromptAttempted = useRef(false);
  const unsubscribeEvents = useRef<(() => void) | undefined>(undefined);
  const timeline = useRef<HTMLDivElement>(null);
  // The cards that wait on an answer and the composer render into this node,
  // which moves between the chat panel and the floating bar, so neither a
  // half-answered question nor a draft is lost on the way.
  const [workspaceTop, setWorkspaceTop] = useState<HTMLElement | null>(null);
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
  // A plugin workspace has its files in a Code panel beside its Overview.
  const codeBeside = canvasOnly || state.project?.type === "plugin";
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
  const coding = offered.includes("code") && !story && !codeBeside;
  const panelled = offered.includes("code") && !codeBeside;
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

  // A plugin mentioned while it is off here is turned on first; mentioning it is turning it on, which allows it.
  async function turnOnMentionedPlugin(plugin: ConversationCapabilities["plugins"][number]): Promise<boolean> {
    if (agentBusy) throw new Error(t("projectPlugins.busy"));
    const blocked = await turnOnProjectPlugin(projectId, plugin.id);
    if (blocked) throw new Error(blocked === "not-offered" ? t("pluginStore.doesNotSuitProject") : t(`projectPlugins.status.${blocked}`));
    setCapabilitiesRevision((value) => value + 1);
    return true;
  }

  function subscribe(detail: ConversationDetail): void {
    unsubscribeEvents.current?.();
    let disposed = false;
    setGameTuning(undefined);
    // Streamed text arrives a token per event, and applying one renders the
    // whole project, about 10 ms with its panels open. Text waits to go in
    // together, at most every TEXT_INTERVAL_MS and on a frame; any other event
    // applies it first, so events still apply in order.
    let text: RuntimeEvent[] = [];
    let frame = 0;
    let applied = -Infinity;
    const applyText = () => {
      cancelAnimationFrame(frame);
      frame = 0;
      if (!text.length) return;
      applied = performance.now();
      const pending = text;
      text = [];
      for (const event of pending) dispatch({ type: "runtime-event", event });
    };
    const awaitTextFrame = (now: number) => {
      if (now - applied < TEXT_INTERVAL_MS) frame = requestAnimationFrame(awaitTextFrame);
      else applyText();
    };
    const dropText = () => { cancelAnimationFrame(frame); frame = 0; text = []; };
    const selectedConversationId = detail.conversation.id;
    const unsubscribe = subscribeToProject(projectId, detail, {
      onEvent: (event) => {
        if (event.type === "item.agentMessage.delta" || event.type === "item.reasoning.textDelta") {
          text.push(event);
          frame ||= requestAnimationFrame(awaitTextFrame);
          return;
        }
        applyText();
        dispatch({ type: "runtime-event", event });
        if (event.type === "project.plugins.changed") setCapabilitiesRevision((value) => value + 1);
        if (event.type === "project.files.changed") {
          pendingFileChange.current = mergeFileChanges(pendingFileChange.current, event.data);
          setPluginFileChange(pendingFileChange.current);
        }
        if (event.type === "plugin.notice") {
          const limits = noticeLimits.current;
          if (!limits.has(event.data.plugin)) limits.set(event.data.plugin, rateLimit(PLUGIN_TOAST_LIMIT, PLUGIN_TOAST_WINDOW_MS));
          // Under the plugin's id, as its pages' toasts are.
          if (limits.get(event.data.plugin)!()) toast({ title: event.data.plugin, description: event.data.message, ...(event.data.tone === "danger" ? { tone: "danger" } : {}) });
        }
        if (event.type === "plugin.draft.capture") void draftCapture.current?.(event.data);
        if (event.type === "plugin.panel.capture") void panelCapture.current?.(event.data);
        if (event.type === "plugin.panel.capture.cancel") panelCaptures.get(event.data.request)?.abort();
        if (event.type === "plugin.page.tool") void pageToolCall.current?.(event.data);
        if (event.type === "plugin.page.tool.cancel") pageToolCalls.get(event.data.request)?.abort();
        // An installed plugin's native code showing one of its panels; one this project doesn't show is left alone.
        // Only while fresh: a window that reconnects later doesn't bring it forward again.
        if (event.type === "plugin.panel.open" && Date.now() <= event.data.expires) {
          const { plugin, panel, state: opened } = event.data;
          if (latestPanels.current.some((item) => !item.draft && item.plugin === plugin && item.id === panel)) openPluginPanel(plugin, panel, opened);
        }
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
        if (event.type === "preview.tuning") {
          setGameTuning(event.data);
          // Saved values are in a file, which the Code and Git views show.
          const saved = JSON.stringify([event.data.file, event.data.values]);
          if (savedTuning.current !== saved) setWorkspaceRevision((value) => value + 1);
          savedTuning.current = saved;
        }
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
        if (disposed) return detail;
        // The reloaded conversation already holds the text still waiting.
        dropText();
        setWorkspaceEpoch(workspaceVersion(projectId));
        void getUnfinishedRestore(projectId).then((pending) => { if (!disposed) setUnfinishedRestore(pending); }).catch(() => {});
        dispatch({ type: "initialized", project, detail });
        setWorkspaceRevision((value) => value + 1);
        return detail;
      },
    });
    unsubscribeEvents.current = () => { disposed = true; dropText(); unsubscribe(); };
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
          selected = await createConversation(projectId);
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
        subscribe(detail);
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

  const previewSupported = supportsWebPreview(state.project);
  useEffect(() => {
    if (!previewSupported || unfinishedRestore || runtime.status !== "ready") return;
    const leaseId = crypto.randomUUID();
    void acquirePreview(projectId, leaseId, true, previewPaused).catch(() => {});
    const timer = setInterval(() => { void acquirePreview(projectId, leaseId).catch(() => {}); }, 20_000);
    return () => { clearInterval(timer); void releasePreview(projectId, leaseId).catch(() => {}); };
  }, [projectId, previewSupported, unfinishedRestore, runtime.generation, runtime.status]);

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
        if (!disposed) subscribe(detail);
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

  useEffect(() => {
    // A message held while the service restarted is never sent on its own: it goes back to the input box.
    if (
      !state.project || !state.conversation || state.conversation.id !== conversationId ||
      !initialPrompt || initialPromptAttempted.current || initialPrompt.generation === runtime.generation
    ) return;
    initialPromptAttempted.current = true;
    returnInitialPrompt(state.conversation.id, t("projectShell.promptPaused"));
  }, [state.project?.id, state.conversation?.id, conversationId, initialPrompt, runtime.generation]);

  function sendInitialPrompt(): void {
    const project = state.project;
    const conversation = state.conversation;
    if (!initialPrompt || !project || !conversation || conversation.id !== conversationId || sendingInitialPrompt || runtime.status !== "ready") return;
    initialPromptAttempted.current = true;
    setSendingInitialPrompt(true);
    notifyPromptSent();
    // Plan is a switch on the conversation's input box; a first message sent in plan mode turns it on there.
    if (initialPrompt.mode === "planning") composerDrafts.get({ projectId: project.id, conversationId: conversation.id }).update({ planning: true });
    void sendPrompt(project.id, conversation.id, initialPrompt.prompt, [], initialPrompt.images, initialPrompt.mode, initialPrompt.mentions, initialPrompt.attachments).then(() => {
      readStartingSettings(project.id, conversation.id);
      if (initialPrompt.images.length || initialPrompt.attachments?.length) setWorkspaceRevision((value) => value + 1);
      onInitialPromptHandled?.();
    }, (error) => {
      // Only a refusal is certainly not sent. A request lost on the way may have started the
      // turn, so the message is not offered again, where sending it would make a second turn.
      if (!(error instanceof ApiError)) {
        dispatch({ type: "notice", message: errorMessage(error) });
        onInitialPromptHandled?.();
        return;
      }
      // A project that isn't set up says what to do in its panel; any other refusal is shown as one.
      const notReady = revealSetupPanel(error);
      returnInitialPrompt(conversation.id, notReady ? t("projectShell.promptReturnedBecause", { reason: errorMessage(error) }) : t("projectShell.promptReturned"));
      if (!notReady) dispatch({ type: "notice", message: errorMessage(error) });
    }).finally(() => setSendingInitialPrompt(false));
  }

  /** Puts a new project's first message, which was not sent, back in the input box to send again or change. */
  function returnInitialPrompt(target: string, reason: string): void {
    if (!initialPrompt) return;
    const { prompt, mentions, images, mode, attachments = [] } = initialPrompt;
    composerDrafts.get({ projectId, conversationId: target }).update((current) => ({
      prompt: current.prompt.trim() ? `${prompt}\n${current.prompt}` : prompt,
      mentions: [...mentions, ...current.mentions],
      planning: current.planning || mode === "planning",
      attachments: [...current.attachments, ...images.map(imageAttachment)],
      uploaded: attachments.length ? [...current.uploaded ?? [], ...attachments] : current.uploaded,
      focusRequestId: crypto.randomUUID(),
    }));
    setInitialPromptReturned(reason);
    onInitialPromptHandled?.();
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
  }, [state.conversation?.id, state.agent.status, chatShown]);

  useEffect(() => {
    const project = state.project;
    const busy = sendingInitialPrompt ||
      state.agent.status === "running" || state.agent.status === "cancelling";
    if (runtime.recovered || !project || (!isWebRuntimeProjectType(project.type) && project.type !== "interactive-story") || auth.state.status !== "signed-in" || state.phase !== "ready" || publishing || busy) return;
    const pending = takePendingPublish(sessionStorage, project.id);
    if (pending) void publish(pending).catch(() => undefined);
  }, [auth.state.status, state.phase, state.project?.id, state.project?.type, state.agent.status, sendingInitialPrompt, publishing]);

  useNotificationView(state.project?.id, state.conversation?.id);
  const viewResult = useViewedProjectResult(projectId, state.conversation?.id, state.eventEpoch, state.lastEventId,
    state.phase === "ready" && state.connection === "open" && runtime.status === "ready" && chatShown, followTimeline);

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
  const activePlan = activePlanItem?.type === "plan" ? activePlanItem.plan : undefined;

  const canvasOpen = designShown || project?.type === "asset-canvas";
  // The open Scene goes with the message while the story shows, the canvas's selection while the canvas does.
  const storyShown = visible.includes("story");
  const playableSurface = storyShown && playableChat?.surface && playableChat.surface.key !== dismissedSurface ? playableChat.surface : undefined;
  const designChipKey = designContext ? `design:${designContext.text}` : undefined;
  const currentDesignContext = canvasOpen && designChipKey !== dismissedDesign ? designContext : undefined;
  // What showing plugin panels say the person is looking at, unless the person removed it.
  const shownPanelContexts = [...panelContexts].flatMap(([id, value]) => {
    const panel = pluginPanels.get(id);
    const key = `panel:${id}:${value.label}\n${value.text}`;
    return panel && visible.includes(id) && !dismissedPanelContexts.has(key)
      ? [{ key, context: { kind: "plugin-panel" as const, label: panelContextLabel(panel.title, value.label), text: value.text } }]
      : [];
  }).slice(0, MAX_PANEL_CONTEXTS);
  const chatContexts = [playableSurface?.chip, ...(storyShown ? playableChat?.attachments ?? [] : []).map((attachment) => attachment.chip), ...(currentDesignContext ? [{ key: designChipKey!, kind: currentDesignContext.kind, label: currentDesignContext.label }] : []),
    ...previewPicks.map(({ key, context }) => ({ key, kind: context.kind, label: context.label })),
    ...shownPanelContexts.map(({ key, context }) => ({ key, kind: context.kind, label: context.label }))].filter((chip) => chip !== undefined);

  // Sending gives a conversation with no model the one its picker shows; read it back so the controls follow it.
  function readStartingSettings(projectId: string, conversationId: string): void {
    if (state.settings.model) return;
    void getConversation(projectId, conversationId)
      .then((detail) => dispatch({ type: "conversation-settings", conversationId, settings: detail.settings }))
      .catch(() => undefined);
  }

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
      notifyPromptSent();
      const picks = previewPicks;
      const sent = [...contexts, ...designContexts, ...(currentDesignContext ? [currentDesignContext] : []), ...picks.map((item) => item.context)];
      await sendPrompt(project.id, conversation.id, nextPrompt, allReferences, sentImages, mode, mentions, attachments, [...sent, ...shownPanelContexts.slice(0, Math.max(0, MAX_PROMPT_CONTEXTS - sent.length)).map((item) => item.context)]);
      readStartingSettings(project.id, conversation.id);
      if (picks.length) setPreviewPicks((current) => current.filter((item) => !picks.includes(item)));
      if (sentImages.length || attachments.length) setWorkspaceRevision((value) => value + 1);
      if (previewContexts.length) playableChat?.clearAttachments();
      setInitialPromptReturned(undefined);
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
      notifyPromptSent();
      await sendPrompt(project.id, conversation.id, text, surface?.references ?? [], [], "normal", [], [], [...(surface ? [surface.context] : []), ...contexts]);
      readStartingSettings(project.id, conversation.id);
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

  const limitProvider = state.settings.model?.provider;
  const [limitResume, setLimitResume] = useState<LimitResume>();
  const [limitResumeRevision, reviseLimitResume] = useReducer((revision: number) => revision + 1, 0);
  // Any of these can end the continue, so what was read before no longer holds.
  const limitResumeKey = JSON.stringify([conversation?.id, state.turns.findLast((turn) => turn.status === "failed")?.id, currentConversationBusy, restoring, limitProvider, selectedProfileId]);
  useEffect(() => setLimitResume(undefined), [limitResumeKey]);
  useEffect(() => {
    let disposed = false;
    void currentContextUsage(true).then((usage) => { if (!disposed) setLimitResume(usage?.limitResume); }).catch(() => {});
    return () => { disposed = true; };
  }, [limitResumeKey, limitResumeRevision]);

  const changeLimitResume = useCallback((change: Promise<unknown>): void => {
    void change.then(reviseLimitResume).catch((error) => dispatch({ type: "notice", message: errorMessage(error) }));
  }, []);
  const onLimitResumeChange = useCallback((on: boolean): void => {
    if (isAgentRuntimeId(limitProvider)) changeLimitResume(updateAgentRuntime(limitProvider, { autoContinue: on }));
  }, [limitProvider, changeLimitResume]);

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

  async function respondToQuestionnaire(answers: QuestionnaireResponse[], cancelled = false): Promise<boolean> {
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

  async function conversationAction(action: (projectId: string, conversationId: string) => Promise<void>): Promise<boolean> {
    if (!project || !conversation) return false;
    try {
      await action(project.id, conversation.id);
      return true;
    } catch (error) {
      dispatch({ type: "notice", message: errorMessage(error) });
      return false;
    }
  }

  function removeFollowUp(turnId: string): Promise<boolean> {
    return conversationAction((projectId, conversationId) => removePendingPrompt(projectId, conversationId, turnId));
  }

  function steerFollowUp(turnId: string): Promise<boolean> {
    return conversationAction((projectId, conversationId) => steerPendingPrompt(projectId, conversationId, turnId));
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
      const publication = publicationOf(result.game);
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

  const branchChat = useCallback(async (entryId: string) => {
    if (!project || !conversation || creatingConversation || !window.confirm(t("timeline.branchConfirm"))) return;
    setCreatingConversation(true);
    dispatch({ type: "notice", message: undefined });
    try {
      const created = await branchConversation(project.id, conversation.id, entryId);
      onOpenConversation(created.id);
    } catch (error) {
      dispatch({ type: "notice", message: errorMessage(error) });
    } finally { setCreatingConversation(false); }
  }, [project?.id, conversation?.id, creatingConversation, onOpenConversation]);

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
  useLeaveGuard(leave);

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
    const name = input.trim();
    if (!project || !name || name === project.name) return;
    try {
      const updated = await renameProject(project.id, name);
      dispatch({ type: "project-updated", project: updated });
      refreshSidebarProject(updated);
    } catch (cause) {
      dispatch({ type: "notice", message: errorMessage(cause) });
    }
  }
  /**
   * Runs a plugin command where its manifest says: the chat, a panel, a page,
   * a link, or the plugin's code. Resolves to what its code returned, or why
   * it failed, which it has already shown.
   */
  async function runProjectPluginCommand(command: ProjectPluginCommand, target?: PluginCommandTarget): Promise<{ result?: unknown; error?: string }> {
    if (!project) return {};
    const run = command.run;
    if ("prompt" in run) {
      const prompt = commandPrompt(run);
      if (run.insert) requestPrompt(prompt);
      else if (await submitPrompt(prompt, [], [], "normal")) revealPanel("chat");
      else return { error: "The message wasn't sent" };
      return {};
    }
    if ("openPanel" in run) {
      openPluginPanel(command.plugin, run.openPanel, run.state);
      return {};
    }
    if ("openSettings" in run) {
      window.location.hash = pluginHash(command.plugin);
      return {};
    }
    if ("url" in run) {
      // The manifest only checks that it starts with https://.
      const url = URL.canParse(run.url) ? new URL(run.url) : undefined;
      if (url) setPluginLink({ url });
      else {
        toast({ title: command.title, description: t("pluginCommands.badLink"), tone: "danger" });
        return { error: "The command's link isn't a valid web address" };
      }
      return {};
    }
    try {
      await saveBeforeBuild(command);
      const input = "native" in run && run.input ? target?.input : undefined;
      const { result, change } = await runPluginCommand(project.id, command.id, input);
      showPluginChange(command.title, change);
      return { result };
    } catch (cause) {
      const error = errorMessage(cause);
      toast({ title: command.title, description: t("pluginLog.commandFailed", { plugin: command.plugin, error }), tone: "danger",
        action: { label: t("pluginLog.viewLog"), onClick: () => setPluginLog(command.plugin) } });
      return { error };
    }
  }
  /** Turns a plugin off in this project, as from a panel that stopped responding. */
  function turnPluginOff(plugin: string): void {
    void setProjectPlugin(projectId, plugin, false).then(
      () => setCapabilitiesRevision((value) => value + 1),
      (cause: unknown) => toast({ title: plugin, description: errorMessage(cause), tone: "danger" }),
    );
  }
  /** A build is read from disk, so pending edits are saved first, as for Export web build. */
  async function saveBeforeBuild(command: ProjectPluginCommand | undefined): Promise<void> {
    if (!command || !("native" in command.run) || command.run.build !== "web") return;
    await saveDesign.current?.();
    await desktopSave.flush();
  }
  /** Answers a plugin page's question, and lets another be asked. */
  function answerPluginConfirm(yes: boolean): void {
    pluginConfirmOpen.current = false;
    pluginConfirm?.answer(yes);
    setPluginConfirm(undefined);
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
  /** Refreshes the views of the project's files once a page's change to them lands. */
  async function changedFiles<T>(change: Promise<T>): Promise<T> {
    const result = await change;
    setWorkspaceRevision((value) => value + 1);
    return result;
  }
  /** A plugin's page in its panel, talking to the app through its frame. */
  function pluginPanelContent(panel: PluginPanel, shown: boolean) {
    const current = project!;
    // A draft is previewed where it is made, so it has none of an installed plugin's controls.
    const draft = panel.draft === true;
    // A draft's files are the workspace's playground, so the workspace's changed paths aren't its own; it hears only that files changed.
    const id = pluginPanelId(panel);
    return <PluginFrame url={panel.url!} title={panel.title} visible={shown} progress={pluginProgress}
      open={panelOpens[id]} onOpenHeard={(heard) => setPanelOpens((opens) => {
        if (opens[id] !== heard) return opens;
        const { [id]: _heard, ...rest } = opens;
        return rest;
      })} filesRevision={workspaceRevision} fileChange={draft ? undefined : pluginFileChange} onToolbarRun={onPluginToolbarRun}
      // Only an installed plugin's tools are called; a draft's run where it is made.
      onTools={draft ? undefined : (host) => { if (host) pageToolHosts.set(id, host); else pageToolHosts.delete(id); }}
      context={{
      plugin: { id: panel.plugin, version: panel.version, panel: panel.id },
      browserQuotaProject: draft ? undefined : current.id,
      ...(panel.accent ? { accent: panel.accent } : {}),
      // Under the plugin's id, which it can't choose as it can a panel's title.
      toast: (message, tone) => toast({ title: draft ? t("pluginBuilder.previewPanel", { title: panel.title }) : panel.plugin, description: message, ...(tone ? { tone } : {}) }),
      reportError: (message) => {
        // A plugin the project carries keeps its page's errors in the project too, where its agent reads them;
        // one the project made for itself has no plugin log to show.
        if (panel.copy) {
          void reportProjectPluginError(current.id, panel.plugin, message).catch(() => {});
          if (panel.plugin.startsWith("project/")) return;
        }
        void reportPluginPanelError(panel.plugin, `${panel.title}: ${message}`).catch(() => {});
        // A draft's errors go to its log, where the workspace's agent reads them.
        if (draft || pluginErrorsShown.current.has(panel.plugin)) return;
        pluginErrorsShown.current.add(panel.plugin);
        toast({ title: panel.plugin, description: t("pluginLog.panelError", { plugin: panel.plugin }), tone: "danger",
          action: { label: t("pluginLog.viewLog"), onClick: () => setPluginLog(panel.plugin) } });
      },
      // The type's own plugin can't be turned off in its project; Reload is left.
      ...(panel.capabilities.net?.length ? { fetch: (request: Parameters<typeof pluginNetFetch>[2]) => pluginNetFetch(current.id, panel.plugin, request) } : {}),
      ...(draft || panel.plugin === current.pluginType?.plugin ? {} : { turnOff: () => turnPluginOff(panel.plugin) }),
      confirm: (request) => new Promise<boolean>((resolve, reject) => {
        if (pluginConfirmOpen.current) {
          reject(new Error("Another question is waiting for an answer"));
          return;
        }
        pluginConfirmOpen.current = true;
        setPluginConfirm({ panel: pluginPanelId(panel), plugin: draft ? t("pluginBuilder.previewPanel", { title: panel.title }) : panel.plugin, request, answer: resolve });
      }),
      ...(browserProjectId ? { openBrowser: openInBrowserPanel } : {}),
      // Its own plugin's panels only, as this project shows them.
      panelIds: plugins.panels.filter((item) => item.plugin === panel.plugin && item.draft === panel.draft).map((item) => item.id),
      openPanel: (target, opened) => {
        if (!latestPanels.current.some((item) => item.plugin === panel.plugin && item.id === target && item.draft === panel.draft))
          throw new Error(`${panel.plugin} has no panel named ${target} in this project`);
        openPluginPanel(panel.plugin, target, opened);
      },
      locale: language,
      capabilities: panel.capabilities,
      commands: panel.commands,
      project: () => ({ name: current.name, type: current.pluginType?.id ?? current.type }),
      fillComposer: (text, files) => {
        if (!state.conversation) throw new Error("There is no conversation to fill");
        // Checked before anything goes in, so a page's files that don't fit leave the composer as it was.
        const draft = composerDrafts.get({ projectId, conversationId: state.conversation.id });
        const attachments = files.length ? appendAttachments(draft.getSnapshot().attachments, attachmentFiles(files)) : undefined;
        if (attachments) draft.update({ attachments });
        if (text) requestPrompt(text);
        else revealPanel("chat");
      },
      setContext: (value) => setPanelContexts((contexts) => {
        const next = new Map(contexts);
        if (value) next.set(id, value);
        else next.delete(id);
        return next;
      }),
      history: (limit) => getPluginHistory(current.id, panel.plugin, limit),
      usage: () => getPluginUsage(current.id, panel.plugin),
      // The Library is the person's, beyond this project, so each file a page adds says so.
      // A draft's preview doesn't add to it.
      ...(draft ? {} : { library: {
        add: async (name: string, contents: Blob, prompt?: string) => {
          const asset = await addPluginLibraryAsset(current.id, panel.plugin, name, contents, prompt);
          toast({ title: panel.plugin, description: t("pluginLibrary.added", { name: asset.name }), tone: "success" });
          return asset;
        },
      } }),
      models: {
        list: () => listPluginModels(current.id, panel.plugin),
        complete: (body, signal) => completePluginModel(current.id, panel.plugin, body, signal),
      },
      media: {
        models: (media, kind) => listPluginGenerationModels(current.id, panel.plugin, media, kind),
        generate: (body, signal) => generatePluginMedia(current.id, panel.plugin, body, signal),
      },
      // The daemon runs it with the plugin's tools and keeps its conversation, which a draft doesn't have.
      ...(draft ? {} : { assistant: {
        run: (body: Record<string, unknown>, onEvent: Parameters<typeof runPluginAssistant>[4], signal: AbortSignal) => runPluginAssistant(current.id, panel.plugin, panel.id, body, onEvent, signal),
        history: () => getPluginAssistantHistory(current.id, panel.plugin, panel.id),
        clear: () => clearPluginAssistant(current.id, panel.plugin, panel.id),
      } }),
      storage: {
        get: (key) => getPluginPageValue(current.id, panel.plugin, key),
        set: (key, value) => setPluginPageValue(current.id, panel.plugin, key, value),
      },
      files: {
        list: (options) => listPluginFiles(current.id, panel.plugin, options, panel.id),
        read: (filePath) => readPluginFile(current.id, panel.plugin, filePath, panel.id),
        // What a page changes shows in the app's views and history like any other change.
        write: (filePath, contents) => changedFiles(writePluginFile(current.id, panel.plugin, filePath, contents, panel.id)),
        createFolder: (folderPath) => changedFiles(createPluginFolder(current.id, panel.plugin, folderPath, panel.id)),
        move: (from, to) => changedFiles(movePluginFile(current.id, panel.plugin, from, to, panel.id)),
        delete: (filePath) => changedFiles(deletePluginFile(current.id, panel.plugin, filePath, panel.id)),
      },
      runCommand: async (command, input) => {
        const id = `${panel.plugin}:${command}`;
        // A draft isn't installed, so its commands come with its panel, and its code runs in its workspace.
        if (draft) return runDraftCommand(panel, command, input);
        const found = plugins.commands.find((item) => item.id === id);
        // Commands that run in the app run here; the page only gets back that they did.
        const action = pageCommand(panel, found);
        if (input !== undefined && action.kind !== "plugin") throw new Error(`${id} runs in the app and takes no input`);
        if (action.kind === "fill") requestPrompt(action.text);
        else if (action.kind === "app") await runProjectPluginCommand(action.command);
        if (action.kind !== "plugin") return null;
        await saveBeforeBuild(found);
        const { result, change } = await runPluginCommand(current.id, id, input);
        if (change?.changed.length) showPluginChange(found?.title ?? command, change);
        return result;
      },
    }} />;
  }
  /**
   * A Plugin Builder draft's page runs one of the draft's commands, as an
   * installed plugin's page runs its own: the app's kinds here, its code in
   * the draft's workspace, once the person allowed it there.
   */
  async function runDraftCommand(panel: PluginPanel, command: string, input: unknown): Promise<unknown> {
    const setupId = draftSetupId(panel.plugin);
    const found = panel.draftCommands?.find((item) => item.id === `${panel.plugin}:${command}`);
    if (!setupId || !found) throw new Error(`${panel.plugin} has no command ${command}`);
    const action = pageCommand(panel, found);
    if (input !== undefined && action.kind !== "plugin") throw new Error(`${command} runs in the app and takes no input`);
    if (action.kind === "fill") requestPrompt(action.text);
    else if (action.kind === "app") {
      if ("openSettings" in found.run) throw new Error("A draft's settings are filled in once it is installed");
      await runProjectPluginCommand(action.command);
    }
    if (action.kind !== "plugin") return null;
    const { result, change } = await runDraftPageCommand(setupId, command, input);
    if (change?.changed.length) showPluginChange(found.title, change);
    return result;
  }
  /** A plugin panel's commands in its toolbar; the page hears how each one went. */
  function pluginPanelToolbar(panel: PluginPanel) {
    const commands = commandsForSlot(plugins.commands, "panel.toolbar", plugins.when).filter((command) => command.plugin === panel.plugin);
    const toolbar = <PluginPanelToolbar commands={commands} onRun={async (command) => {
      const outcome = await runProjectPluginCommand(command);
      for (const listener of pluginToolbarRuns) listener({ command: command.id, ...outcome });
    }} />;
    // A plugin the project made for itself can become a plugin for every project.
    if (!panel.plugin.startsWith("project/")) return toolbar;
    return <>
      <IconButton size="sm" label={t("projectPlugins.makeShared")} onClick={() => void makeSharedPlugin(panel.plugin)}><Package size={14} /></IconButton>
      {toolbar}
    </>;
  }
  /** Starts a Plugin Builder workspace from a plugin the project made for itself, with a request for its agent waiting; once, however often it is clicked. */
  async function makeSharedPlugin(plugin: string): Promise<void> {
    if (!project || makingPlugin.current) return;
    makingPlugin.current = true;
    try {
      const { id, prompt } = await makeProjectPluginShared(project.id, plugin);
      openPluginWorkspace(id, prompt);
    } catch (cause) {
      toast({ title: t("projectPlugins.makeShared"), description: errorMessage(cause), tone: "danger" });
    } finally {
      makingPlugin.current = false;
    }
  }
  // Stories and web projects add a tab of their own to the project's settings.
  const workspaceSettingsTab = story ? t("projectSettings.tab.screen")
    : project && coding && project.pluginType?.preview !== "native" && isWebRuntimeProjectType(project.type) ? t("projectSettings.tab.preview") : undefined;
  const projectMenu: MenuEntry[] = [
    { label: t("projectShell.settings"), icon: <Settings size={14} />, disabled: !project, onSelect: () => setSettingsTab("general") },
    { label: t("projectPlugins.menu"), icon: <Plug size={14} />, disabled: !project, onSelect: () => setPluginsOpen(true) },
    "separator",
    ...(openProjectFile && project ? [{ label: t("projectCard.openFolder"), icon: <FolderOpen size={14} />, onSelect: () => {
      void openProjectFile(project.id, ".", "default").catch((cause: unknown) => dispatch({ type: "notice", message: errorMessage(cause) }));
    } }] : []),
    { label: exporting === "project" ? t("projectCard.exporting") : t("projectCard.export"), icon: <Download size={14} />, disabled: !project || !!exporting, onSelect: () => void exportFile("project") },
    ...pluginCommandEntries("project.menu"),
  ];
  const publishCommands = project ? commandsForSlot(plugins.commands, "project.publish", plugins.when) : [];
  // The game's toolbar and the canvas show their own slots, deep in the workspace.
  const runCommandRef = useRef(runProjectPluginCommand);
  runCommandRef.current = runProjectPluginCommand;
  const pluginSlots = useMemo(() => ({
    commands: project ? plugins.commands : [], when: plugins.when,
    run: (command: ProjectPluginCommand, target?: PluginCommandTarget) => runCommandRef.current(command, target),
    waiting: project ? plugins.waiting : [],
    // Allowing it here is the person's choice in this project, as in its Plugins sheet.
    allow: async (id: string) => {
      await setProjectPlugin(projectId, id, true);
      setCapabilitiesRevision((value) => value + 1);
    },
  }), [!!project, plugins.commands, plugins.when, plugins.waiting, projectId]);
  const publishButton = project ? publishAction(project, { publishing, agentBusy, plugins: publishCommands.length }) : undefined;

  // The code panel opens the file, and comes back if it was closed. A game's
  // workspace brings it forward itself.
  const openWorkspaceFile = useCallback((path: string): void => {
    if (story || codeBeside) revealPanel("code");
    setOpenFileRequest((current) => ({ path, id: (current?.id ?? 0) + 1 }));
  }, [story, codeBeside]);
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
    // Before a conversation is open, the text waits for one.
    if (!state.conversation) {
      waitingPrompt.current = text;
      return;
    }
    composerDrafts.get({ projectId, conversationId: state.conversation.id }).insertPrompt(text);
  }
  /** Captures for agents run one at a time, so each puts back the layout it found. */
  const captureQueue = useRef<Promise<unknown>>(Promise.resolve());
  /**
   * Shows a plugin panel, waits until its page (`frame`, a selector) has
   * loaded and drawn, and captures it for an agent. Showing it for the agent
   * isn't the person's choice of layout, so it is put back after, unless
   * something else changed the layout meanwhile, as the person may have. The
   * image, or why there is none, before `deadline` (epoch milliseconds).
   */
  const capturePanel = (target: Pick<PluginPanel, "plugin" | "id">, frame: string, deadline: number, signal?: AbortSignal): Promise<{ image: PanelCapture } | { error: string }> => {
    const run = async (): Promise<{ image: PanelCapture } | { error: string }> => {
      if (signal?.aborted) return { error: "Cancelled" };
      const id = pluginPanelId(target);
      const before = latestLayout.current.current;
      revealPanel(id);
      const shown = latestLayout.current.current;
      try {
        // The panel's page loads once it is placed; it is captured once it has shown.
        const loaded = await waitFor(() => signal?.aborted ? null : pluginNodes.get(id)?.body.querySelector<HTMLIFrameElement>(frame) ?? undefined, deadline);
        if (signal?.aborted) return { error: "Cancelled" };
        if (!loaded) return { error: "The panel didn't finish loading in time." };
        await nextPaint();
        await new Promise((resolve) => setTimeout(resolve, PANEL_CAPTURE_SETTLE_MS));
        if (signal?.aborted) return { error: "Cancelled" };
        const image = await captureElement(pluginNodes.get(id)!.body, PANEL_CAPTURE_MAX_WIDTH);
        if (!image) return { error: "The panel has no size to capture. Ask the person to show it." };
        return { image: {
          panel: target.id, mediaType: image.blob.type === "image/png" ? "image/png" : "image/webp", data: await blobBase64(image.blob),
          width: image.width, height: image.height, theme: currentTheme().appearance,
        } };
      } catch (cause) {
        return { error: `The panel couldn't be captured: ${errorMessage(cause)}` };
      } finally {
        if (before && shown !== before && latestLayout.current.current === shown) {
          latestLayout.current = { ...latestLayout.current, current: before };
          setSaved(before);
          saveLayout(before);
        }
      }
    };
    const result = captureQueue.current.then(run);
    captureQueue.current = result.catch(() => {});
    return result;
  };
  /**
   * Captures a Plugin Builder draft's panel for the workspace's agent, once
   * the preview shows the draft the daemon checked. Only a window that can
   * capture answers, so a browser build open beside the app never answers
   * first; a request past its time, as a replayed one is, is left alone.
   * The latest render's, so it sees the panels and layout as they are.
   */
  const draftCapture = useRef<((request: RuntimeEventData["plugin.draft.capture"]) => Promise<void>) | undefined>(undefined);
  const panelCapture = useRef<((request: RuntimeEventData["plugin.panel.capture"]) => Promise<void>) | undefined>(undefined);
  const pageToolCall = useRef<((request: RuntimeEventData["plugin.page.tool"]) => Promise<void>) | undefined>(undefined);
  const latestPanels = useRef(plugins.panels);
  latestPanels.current = plugins.panels;
  draftCapture.current = async ({ setupId, request, panel, revision, expires }) => {
    if (!window.ohMyGameDesktop?.capturePage || Date.now() > expires) return;
    const answer = (value: Parameters<typeof answerDraftCapture>[2]) => answerDraftCapture(setupId, request, value).catch(() => {});
    // Answered before the daemon stops waiting, so a slow capture says why rather than nothing.
    const deadline = expires - PANEL_CAPTURE_ANSWER_MARGIN_MS;
    const listed = () => latestPanels.current.find((item) => item.draft && (!panel || item.id === panel) && item.url?.includes(`revision=${revision}`));
    if (!listed()) setCapabilitiesRevision((value) => value + 1);
    const target = await waitFor(listed, deadline);
    if (!target) return void await answer({ error: "The workspace's preview hasn't loaded this draft yet. Try again in a moment." });
    await answer(await capturePanel(target, `iframe[data-ready][src*="revision=${revision}"]`, deadline));
  };
  /**
   * Captures a plugin panel of the project for an agent's `panel_screenshot`.
   * A window that can't capture, or doesn't show the panel once it has read
   * its panels again, says why; one that can claims the request first, so
   * only one window shows it.
   */
  panelCapture.current = async ({ request, plugin, panel, expires }) => {
    if (Date.now() > expires || !state.project) return;
    const projectId = state.project.id;
    const answer = (value: Parameters<typeof answerPluginPanelCapture>[2]) => answerPluginPanelCapture(projectId, request, value);
    if (!window.ohMyGameDesktop?.capturePage)
      return void await answer({ declined: "Panels can only be captured in the desktop app; this window is a browser." }).catch(() => {});
    // The daemon may know of a panel this window hasn't read yet, as one a plugin just installed adds.
    const listed = () => latestPanels.current.find((item) => item.plugin === plugin && item.id === panel);
    if (!listed()) setCapabilitiesRevision((value) => value + 1);
    const target = await waitFor(listed, Math.min(expires - PANEL_CAPTURE_ANSWER_MARGIN_MS, Date.now() + PANEL_CAPTURE_LIST_MS));
    if (!target)
      return void await answer({ declined: `${plugin}'s panel ${panel} isn't available in this project's window: the plugin may be off here, or the panel hidden by its \`when\`.` }).catch(() => {});
    if (!await answer({ started: true }).catch(() => false)) return;
    const controller = new AbortController();
    panelCaptures.set(request, controller);
    try {
      const result = await capturePanel(target, "iframe[data-ready]", Date.now() + PANEL_SCREENSHOT_CAPTURE_MS - PANEL_CAPTURE_ANSWER_MARGIN_MS, controller.signal);
      if (controller.signal.aborted) return;
      // An image that couldn't be sent is still an answer, so the agent hears why rather than waiting.
      await answer(result).catch((cause: unknown) => answer({ error: `The capture couldn't be sent: ${errorMessage(cause)}` }).catch(() => {}));
    } finally {
      panelCaptures.delete(request);
    }
  };
  /**
   * A tool a plugin's panel page answers: shows the panel, hands its page
   * the call once it has connected, and answers the daemon. Another window
   * of the project may take the call first; then this one lets it go.
   */
  pageToolCall.current = async ({ request, plugin, version, panel, tool, input, expires }) => {
    if (Date.now() > expires || !state.project) return;
    const projectId = state.project.id;
    const answer = (value: Parameters<typeof answerPluginPageTool>[2]) => answerPluginPageTool(projectId, request, value);
    const id = pluginPanelId({ plugin, id: panel });
    const listed = latestPanels.current.find((item) => pluginPanelId(item) === id && !item.draft);
    // Another window of the project may still take it; the call fails once every window has said why.
    if (!listed) return void await answer({ declined: `${plugin}'s panel ${panel} isn't available in this project: the plugin may be off here, or the panel hidden by its \`when\`.` }).catch(() => {});
    if (listed.version !== version) return void await answer({ declined: `${plugin} is now ${listed.version} in this project; the call was for ${version}. Try again.` }).catch(() => {});
    // Claimed before the page hears of it, so only one window runs it, and the page's changes are the call's from the start.
    if (!await answer({ started: true }).catch(() => false)) return;
    const controller = new AbortController();
    pageToolCalls.set(request, controller);
    let outcome: { result: unknown } | { error: string };
    try {
      revealPanel(id);
      const host = await waitFor(() => pageToolHosts.get(id), Date.now() + PAGE_TOOL_LOAD_MS);
      if (!host) throw new Error(`${plugin}'s panel ${panel} didn't load in time.`);
      const result = await host.call(tool, input, {
        onAccepted: () => {},
        onProgress: (message) => void answer({ progress: message }).catch(() => {}),
      }, controller.signal);
      const json = JSON.stringify(result ?? null);
      if (json === undefined) throw new Error(`${plugin}'s ${tool} returned something that isn't JSON`);
      outcome = json.length > PAGE_TOOL_RESULT_MAX_CHARS
        ? { error: `${plugin}'s ${tool} returned ${json.length.toLocaleString("en")} characters of JSON; a page tool's result is at most ${PAGE_TOOL_RESULT_MAX_CHARS.toLocaleString("en")}.` }
        : { result: JSON.parse(json) as unknown };
    } catch (cause) {
      outcome = { error: cause instanceof TypeError ? `${plugin}'s ${tool} returned something that isn't JSON` : errorMessage(cause) };
    } finally {
      pageToolCalls.delete(request);
    }
    // The caller gave up, so nothing waits for the answer.
    if (controller.signal.aborted) return;
    try {
      await answer(outcome);
    } catch (cause) {
      // Said rather than left to time out, such as for an answer the daemon refused.
      await answer({ error: `${plugin}'s ${tool} answered, but its answer couldn't be delivered: ${errorMessage(cause)}` }).catch(() => {});
    }
  };
  const waitingPrompt = useRef<string | undefined>(undefined);
  const makingPlugin = useRef(false);
  useEffect(() => {
    const text = waitingPrompt.current;
    if (!text || !state.conversation) return;
    waitingPrompt.current = undefined;
    composerDrafts.get({ projectId, conversationId: state.conversation.id }).insertPrompt(text);
  }, [state.conversation?.id]);

  // The command menu shows this project's panels and applies its layouts.
  useCommands(() => offered.length ? [
    ...listed.map((id): Command => {
      const { title, icon: Icon } = panelInfo(id);
      return { id: `panel-${id}`, group: t("commandMenu.panels"), label: t("commandMenu.showPanel", { panel: title }), keywords: id, icon: <Icon size={16} />, run: () => revealPanel(id) };
    }),
    ...presetsFor(offered).map((preset): Command => ({
      id: `layout-${preset}`, group: t("commandMenu.panels"), label: t("commandMenu.layout", { preset: t(`panels.preset.${preset}`) }), keywords: `layout ${preset}`, icon: <LayoutGrid size={16} />,
      run: () => changeLayout(presetLayout(preset, offered, homes, onRequest)),
    })),
    // Plugins' layouts, which open the panels they need.
    ...commandsForSlot(plugins.commands, "project.layout", plugins.when).map((command): Command => ({
      id: `plugin-layout-${command.id}`, group: t("commandMenu.panels"), label: command.title, keywords: `layout ${command.plugin}`, icon: <LayoutGrid size={16} />,
      run: () => void runProjectPluginCommand(command),
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
        onInteract={async () => {
          if (!project || !conversation) return false;
          try { await holdQuestionnaire(project.id, conversation.id, questionnaire.requestId); return true; }
          catch (error) { dispatch({ type: "notice", message: errorMessage(error) }); return false; }
        }}
        onSubmit={(answers) => respondToQuestionnaire(answers)}
        onSkip={() => respondToQuestionnaire([], true)}
      />
    ) : null}

    {unfinishedRestore ? <UnfinishedRestoreBanner
      projectId={projectId}
      disabled={agentBusy || state.connection !== "open"}
      workspaceRevision={workspaceRevision}
      onClose={() => setUnfinishedRestore(false)}
    /> : null}
    {!questionnaire || questionnaire.blocking === false ? <Composer
      key={conversation?.id}
      projectId={project?.id}
      conversationId={conversation?.id}
      supportsDesign={project?.type !== "asset-canvas" && !workspace}
      placeholder={workspace?.placeholder}
      conversationReady={Boolean(conversation) && state.connection === "open"}
      running={currentConversationBusy}
      stopping={state.agent.status === "cancelling" || sendingInitialPrompt}
      pendingPrompts={state.pendingPrompts}
      scheduledMessages={state.scheduledMessages}
      plan={activePlan}
      notice={state.connection === "reconnecting" ? t("projectShell.reconnecting") : state.notice}
      status={initialPromptReturned}
      limitResumeArmed={limitResume?.state === "armed"}
      onSkipLimitResume={() => { if (project && conversation) changeLimitResume(skipLimitResume(project.id, conversation.id)); }}
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
        else if (shownPanelContexts.some((item) => item.key === key)) setDismissedPanelContexts((current) => new Set(current).add(key));
        else if (previewPicks.some((item) => item.key === key)) setPreviewPicks((current) => current.filter((item) => item.key !== key));
        else if (key === playableChat?.surface?.key) setDismissedSurface(key);
        else playableChat?.removeAttachment(key);
      }}
      onCompact={compactCurrentConversation}
      onContextUsage={currentContextUsage}
      onModelChange={(model) => void changeModel(model)}
      onReasoningChange={(level) => void changeReasoning(level)}
      onNativeReasoningChange={(level) => void changeNativeReasoning(level)}
      onStop={() => void stopAgent()}
      onRemovePending={removeFollowUp}
      onSteerPending={steerFollowUp}
      onEditPending={editFollowUp}
      onScheduleMessage={(prompt, at) => conversationAction((projectId, conversationId) => scheduleMessage(projectId, conversationId, { prompt, at }))}
      onRemoveScheduled={(id) => conversationAction((projectId, conversationId) => removeScheduledMessage(projectId, conversationId, id))}
      canPublish={Boolean(project && (isWebRuntimeProjectType(project.type) || project.type === "interactive-story") && !publishing && !agentBusy)}
      onPublish={project ? () => setPublishDialog({ projectId: project.id, status: "open" }) : undefined}
      pluginCommands={{ slash: slashCommands(plugins.commands, plugins.when), add: commandsForSlot(plugins.commands, "composer.add", plugins.when) }}
      onTurnOnPlugin={turnOnMentionedPlugin}
      onPluginCommand={(command) => void runProjectPluginCommand(command)}
    /> : null}
  </>, chatInputNode);
  const codingVisible = new Set(visible.flatMap((id): CodingView[] => id === "game" ? ["preview"] : id === "design" || id === "canvas" || id === "code" || id === "assets" ? [id] : []));
  const storyVisible = new Set(visible.filter((id): id is StoryView => id === "story" || id === "design" || id === "canvas" || id === "code" || id === "assets"));

  // After every hook, so a project that fails to load renders the same hooks.
  if (state.phase === "fatal") {
    return <FatalState message={state.notice ?? t("projectShell.runtimeUnreachable")} onHome={onHome} homeLabel={homeLabel} />;
  }
  const railConversations: RailConversations = {
    items: conversations,
    current: conversation?.id,
    onOpen: (id) => onOpenConversation(id),
    onNew: () => void newConversation(),
  };

  return (
    <PluginSlotsContext.Provider value={pluginSlots}>
    {chatInput}
    {pluginLink ? <Dialog open title={t("pluginCommands.openLinkTitle")} onClose={() => setPluginLink(undefined)} footer={<>
      <Button variant="ghost" onClick={() => setPluginLink(undefined)}>{t("common.cancel")}</Button>
      <Button variant="primary" onClick={() => { openExternalLink(pluginLink.url.href); setPluginLink(undefined); }}>{t("pluginCommands.openLink")}</Button>
    </>}>
      {pluginLink.message ? <p>{pluginLink.message}</p> : null}
      <p>{t("pluginCommands.openLinkHint", { host: pluginLink.url.host })}</p>
    </Dialog> : null}
    {pluginConfirm ? <Dialog open size="sm" title={pluginConfirm.request.title} onClose={() => answerPluginConfirm(false)} footer={<>
      <Button variant="ghost" onClick={() => answerPluginConfirm(false)}>{t("common.cancel")}</Button>
      <Button variant="primary" onClick={() => answerPluginConfirm(true)}>{pluginConfirm.request.confirmLabel ?? t("pluginCommands.confirm")}</Button>
    </>}>
      {pluginConfirm.request.message ? <p className="plugin-confirm-message">{pluginConfirm.request.message}</p> : null}
      <p className="plugin-confirm-source">{t("pluginCommands.askedBy", { plugin: pluginConfirm.plugin })}</p>
    </Dialog> : null}
    {pluginLog ? <PluginLogDialog plugin={pluginLog} displayName={pluginLog} onClose={() => setPluginLog(undefined)}
      onChanged={() => setCapabilitiesRevision((value) => value + 1)} /> : null}
    {project && settingsTab ? <ProjectSettings project={project} initialTab={settingsTab} workspaceTab={workspaceSettingsTab} workspaceRef={setSettingsNode} busy={settingsBusy}
      onRename={(name) => void renameTo(name)} onClose={closeSettings} /> : null}
    {project ? <ProjectPluginsSheet projectId={project.id} open={pluginsOpen} busy={agentBusy} onClose={() => setPluginsOpen(false)} onChanged={() => setCapabilitiesRevision((value) => value + 1)}
      onUndone={() => setWorkspaceRevision((value) => value + 1)} onOpenPlugins={() => onNavigate("plugins")} /> : null}
    <ProjectFrame
      rail={workspace ? workspace.rail(railConversations) : <ProjectRail projectId={projectId} project={project} onNavigate={onNavigate} onLeave={leave} conversations={railConversations} />}
      top={workspace ? <span className="project-top-slot" ref={setWorkspaceTop} /> : <ProjectTop name={project?.name ?? ""} menu={projectMenu}>
        {project ? <PluginPanelToolbar commands={commandsForSlot(plugins.commands, "project.toolbar", plugins.when)} onRun={runProjectPluginCommand} /> : null}
        {/* Play stays in place from every view. A Web preview or a story fills
            the slot with Play in its own window; an external preview can only be shown. */}
        {project && story ? <span className="project-top-play" ref={setPlaySlot} />
          : project && offered.includes("game") && !gameAddable ? previewSupported ? <span className="project-top-play" ref={setPlaySlot} />
          : <Button size="sm" variant="ghost" icon={<Play size={14} />} onClick={() => revealPanel("game")}>{t("workspace.play")}</Button> : null}
        {project && publishButton ? <DropdownMenu placement="bottom-end" items={[
          ...(publishButton.builtIn ? [
            { label: t("workspace.publishToCommunity"), icon: <Globe2 size={14} />, disabled: exporting === "web", onSelect: () => setPublishDialog({ projectId: project.id, status: "open" }) },
            "separator",
            { label: exporting === "web" ? t("workspace.exportingWebBuild") : t("workspace.exportWebBuild"), icon: <Upload size={14} />, disabled: !!exporting, onSelect: () => void exportFile("web") },
          ] satisfies MenuEntry[] : []),
          // Plugins' ways to publish; one that builds the game waits for an export.
          ...(publishButton.builtIn && publishCommands.length ? ["separator" as const] : []),
          ...publishCommands.map((command): MenuEntry => ({
            label: command.title,
            icon: <Plug size={14} />,
            disabled: "native" in command.run && command.run.build === "web" && !!exporting,
            // Plugin code shows as publishing until it ends; the rest only opens or fills something.
            onSelect: () => void ("native" in command.run || "tool" in command.run
              ? (setPublishing(true), runProjectPluginCommand(command).finally(() => setPublishing(false)))
              : runProjectPluginCommand(command)),
          })),
        ]} trigger={(props) => (
          <Button {...props} size="sm" variant="primary" icon={publishing || exporting === "web" ? <LoaderCircle className="spin" size={14} /> : <Share2 size={14} />}
            disabled={publishButton.disabled} title={publishButton.label}>{t("workspace.publish")}</Button>
        )} /> : null}
      </ProjectTop>}>
    {layout || !project ? <PanelLayout layout={layout ?? loadingLayout()} onChange={changeLayoutOrAddGame} onReset={project ? () => changeLayout(presetLayout("default", offered, homes, onRequest)) : undefined}
      panels={(project ? listed : ["chat" as const]).map((id) => {
        const { title, icon: Icon, source } = panelInfo(id);
        // A draft's panel names no plugin, but its page is a plugin page all the same.
        const target = pluginPanels.has(id) ? pluginNodes.get(id) : nodes[id as WorkspacePanel];
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
              onOpenInBrowser={browserProjectId ? openInBrowserPanel : undefined}
              waitingForInput={Boolean((questionnaire && questionnaire.blocking !== false) || approval)}
              changeControls={turnChanges}
              workspaceRevision={workspaceRevision}
              plugins={capabilities.plugins}
              limitResume={limitResume}
              onLimitResumeChange={onLimitResumeChange}
            />
          </ErrorBoundary>
        )}
        running={currentConversationBusy}
        attention={Boolean(approval || questionnaire)}
        onExpand={() => revealPanel("chat")}
        input={chatInputNode}
      /> : undefined}
      empty={project ? <Empty title={t("panels.empty")} action={<Button onClick={() => changeLayout(presetLayout("default", offered, homes, onRequest))}>{t("panels.reset")}</Button>} /> : null} /> : null}
    {createPortal(<div className="pane-header-actions chat-header-actions">
            <span className="chat-header-spacer" />
            {accountRuntime && accountProfiles.length > 1 ? <div className="chat-account-selector">
              <AgentAccountMenu runtime={accountRuntime} profiles={accountProfiles} value={selectedProfileId}
                disabled={agentBusy || modelChanging || state.connection !== "open"} onChange={(profileId) => void changeAccountProfile(profileId)}
                // Checking again clears the daemon's cache; the usual reload then reads the fresh accounts and models.
                onRefresh={async () => { await listAccountProfiles(accountRuntime, true); window.dispatchEvent(new Event(MODELS_CHANGED_EVENT)); }} />
            </div> : null}
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
              onShowInstructions={() => setInstructionsOpen(true)}
            />
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
    {instructionsOpen && projectId && conversation ? <ConversationInstructionsDialog projectId={projectId} conversationId={conversation.id} onClose={() => setInstructionsOpen(false)} /> : null}
    {createPortal(<section className="agent-pane" aria-label={t("workspace.agent")}>
      <div className="agent-body" ref={timeline} onScroll={(event) => {
        const element = event.currentTarget;
        followTimeline.current = element.scrollHeight - element.scrollTop - element.clientHeight < 80;
        viewResult();
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
                onOpenInBrowser={browserProjectId ? openInBrowserPanel : undefined}
                revisionDisabled={agentBusy || restoring || unfinishedRestore || state.pendingPrompts.length > 0 || state.connection !== "open"}
                waitingForInput={Boolean((questionnaire && questionnaire.blocking !== false) || approval)}
                onRevise={revisePrompt}
                changeControls={turnChanges}
                workspaceRevision={workspaceRevision}
                onAddToChat={addToChat}
                onBranch={branchChat}
                branchDisabled={creatingConversation || state.connection !== "open"}
                plugins={capabilities.plugins}
                limitResume={limitResume}
                onLimitResumeChange={onLimitResumeChange}
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
          workspaceRevision={workspaceRevision}
          gameTuning={gameTuning}
          previewPaused={previewPaused}
          openFileRequest={openFileRequest}
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
          onGameRenamed={(renamed) => dispatch({ type: "game-renamed", projectId: project.id, renamed })}
          referencedDocument={referencedDocument}
          onReferenceDocument={referenceDocument}
          onQuoteDocument={quoteDocument}
          pickingClient={pickingClient}
          onPickingChange={setPickingClient}
          previewDevices={plugins.previewDevices}
          settingsSlot={settingsSlot}
          onOpenSettings={() => setSettingsTab("workspace")}
          previewFilters={plugins.previewFilters}
          inputMaps={plugins.inputMaps}
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
          onGameRenamed={(renamed) => dispatch({ type: "game-renamed", projectId: project.id, renamed })}
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
        settingsSlot={settingsSlot}
        panels={{
          nodes: { story: nodes.story, design: nodes.design, canvas: nodes.canvas, code: nodes.code, assets: nodes.assets },
          visible: storyVisible,
          onShow: revealPanel,
          play: playSlot,
        }}
      /> : canvasOnly ? createPortal(<ErrorBoundary label={panelTitle("canvas")} resetKey={project.id}><Suspense fallback={<div className="design-loading"><LoaderCircle className="spin" size={18} /></div>}><CanvasWorkspace
        project={project}
        onProjectUpdated={(updated) => dispatch({ type: "project-updated", project: updated })}
        onSaveReady={registerDesignSave}
        onContextChange={setDesignContext}
        headerActionsTarget={nodes.canvas.toolbar}
        initialNodeId={initialCanvasNodeId}
        onInitialNodeHandled={onInitialCanvasNodeHandled}
      /></Suspense></ErrorBoundary>, nodes.canvas.body) : null}
      {project ? [...pluginNodes].flatMap(([id, target]) => {
        const panel = pluginPanels.get(id);
        return panel ? [createPortal(pluginPanelContent(panel, visible.includes(id)), target.body, id), createPortal(pluginPanelToolbar(panel), target.toolbar, `${id}:toolbar`)] : [];
      }) : null}
      {project && browserOpenedIn === project.id && window.ohMyGameDesktop?.browser ? createPortal(<ErrorBoundary label={panelTitle("browser")} resetKey={project.id}>
        <BrowserPanel key={project.id} bridge={window.ohMyGameDesktop.browser} projectId={project.id} visible={visible.includes("browser")} pluginsRevision={capabilitiesRevision} openRequests={browserOpenRequests.filter((request) => request.projectId === project.id)} onOpened={(opened) => setBrowserOpenRequests((requests) => requests.filter((request) => request !== opened))} />
      </ErrorBoundary>, nodes.browser.body) : null}
      {project && workspace && workspaceTop ? workspace.render({
        busy: agentBusy, revision: workspaceRevision, ask: requestPrompt, openFile: openWorkspaceFile, top: workspaceTop, panel: nodes.plugin,
      }) : null}
      {project && codeBeside && visible.includes("code") ? createPortal(<main className="story-code-view" aria-label={panelTitle("code")}>
        <ErrorBoundary label={panelTitle("code")} resetKey={project.id}>
          <WorkspaceCodeView projectId={project.id} revision={workspaceRevision + canvasCodeRevision} openFileRequest={openFileRequest} />
        </ErrorBoundary>
      </main>, nodes.code.body) : null}
      </ErrorBoundary>
    </ProjectFrame>
    </PluginSlotsContext.Provider>
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

/** Two batches of changed files as one, with no more paths than one event carries. */
export function mergeFileChanges(
  earlier: { paths: string[]; truncated?: boolean } | undefined,
  later: { paths: string[]; truncated?: boolean },
): { paths: string[]; truncated?: boolean } {
  if (!earlier) return { ...later };
  const all = [...new Set([...earlier.paths, ...later.paths])].sort();
  const truncated = earlier.truncated || later.truncated || all.length > HOOK_FILES_MAX;
  return { paths: all.slice(0, HOOK_FILES_MAX), ...(truncated ? { truncated: true } : {}) };
}
