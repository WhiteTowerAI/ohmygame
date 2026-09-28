import { Play, RotateCcw } from "./icons.js";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { StoryChapter, StoryInteractionCommand, StoryNode, StoryPlayerConfig, StoryScreenAction, StorySurfaceLayoutOffset, StoryVariable } from "../shared/contracts.js";
import { advanceOpenUi, advanceSceneTime, chooseOption, completeSceneMedia, createStorySave, DEFAULT_STORY_PLAYER_CONFIG, getNextNode, getSettingsNode, getStoryMapNode, matchesStoryCondition, openUiRuntimeContent, previewStoryNode, resolveInteractionNode, resolveStoryAssetId, restartGame, sceneStillDurationMs, shouldCreateStoryCheckpoint, shouldPersistStoryCheckpoint, storyDiscoveries, storyNodePresentation, validatePlayableChapter, type PlayerRuntimeState, type PlayingRuntimeState } from "../shared/story.js";
import { getLibraryAsset, getPlayableProjectRuntime, getStory, getWorkspaceAsset, listLibraryAssets } from "./api.js";
import { loadStoryProgress, saveStoryProgress, storyProgressKey, storySignature } from "./story-progress.js";
import { useWorkspaceAssetUrl } from "./use-workspace-asset-url.js";
import { StoryInteractionSurface, type StoryCompletionSource } from "./story-interaction-surface.js";
import { StoryScreenSurface } from "./story-screen-surface.js";
import { StorySettings } from "./story-settings.js";
import { StorySceneSurface, type StoryNodeSurfaceAction } from "./story-scene-surface.js";
import { StoryPlayerControls, StoryPlayerPauseLayer } from "./story-player-controls.js";
import { WindowDragRegion } from "./window-drag-region.js";
import { SceneTimerClock } from "./scene-timer-clock.js";
import { StoryMap } from "./story-map.js";
import { StoryPlayerViewport } from "./story-player-viewport.js";
import { PlayablePlayer } from "./playable-player.js";
import type { PlayablePlayerDefinition } from "../shared/playable-player-protocol.js";

export function PlaytestPage({ projectId, chapterId }: { projectId: string; chapterId: string }) {
  const [playable, setPlayable] = useState<
    | { status: "loading" }
    | { status: "legacy" }
    | { status: "ready"; definition: PlayablePlayerDefinition; assets: Record<string, Blob> }
    | { status: "error"; error: string }
  >({ status: "loading" });

  useEffect(() => {
    let disposed = false;
    setPlayable({ status: "loading" });
    void getPlayableProjectRuntime(projectId).then(async (result) => {
      if (!result.available) {
        if (!disposed) setPlayable({ status: "legacy" });
        return;
      }
      const assets = Object.fromEntries(await Promise.all(
        Object.entries(result.definition.graph.assets).map(async ([id, asset]) => {
          const blob = asset.source.kind === "library"
            ? await getLibraryAsset(asset.source.assetId)
            : await getWorkspaceAsset(projectId, asset.source.path);
          return [id, blob] as const;
        }),
      ));
      if (disposed) return;
      document.title = `${result.definition.graph.title} - Playtest`;
      setPlayable({ status: "ready", definition: result.definition, assets });
    }).catch((cause) => {
      if (!disposed) setPlayable({ status: "error", error: errorMessage(cause) });
    });
    return () => { disposed = true; };
  }, [projectId]);

  if (playable.status === "legacy") return <LegacyPlaytestPage projectId={projectId} chapterId={chapterId} />;
  if (playable.status === "ready") return (
    <>
      <WindowDragRegion />
      <PlayablePlayer
        definition={playable.definition}
        assets={playable.assets}
        saveKey={`ohmygame:playable:project:${projectId}`}
      />
    </>
  );
  return (
    <main className="story-playtest-page">
      <WindowDragRegion />
      <div className="story-playtest-state" role={playable.status === "error" ? "alert" : undefined}>
        {playable.status === "error" ? playable.error : "Loading playtest..."}
      </div>
    </main>
  );
}

function LegacyPlaytestPage({ projectId, chapterId }: { projectId: string; chapterId: string }) {
  const [chapter, setChapter] = useState<StoryChapter>();
  const [variables, setVariables] = useState<StoryVariable[]>([]);
  const [config, setConfig] = useState<StoryPlayerConfig>(DEFAULT_STORY_PLAYER_CONFIG);
  const [runtime, setRuntime] = useState<PlayerRuntimeState>();
  const [paused, setPaused] = useState(false);
  const [playbackStep, setPlaybackStep] = useState(0);
  const [hasCheckpoint, setHasCheckpoint] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"saved" | "error">();
  const [error, setError] = useState<string>();
  const progress = useRef<{ key: string; signature: string } | undefined>(undefined);
  const checkpointRef = useRef<PlayingRuntimeState | undefined>(undefined);

  useEffect(() => {
    let disposed = false;
    progress.current = undefined;
    checkpointRef.current = undefined;
    setHasCheckpoint(false);
    setRuntime(undefined);
    setSaveStatus(undefined);
    setError(undefined);
    void Promise.all([getStory(projectId), listLibraryAssets()]).then(async ([story, assets]) => {
      if (disposed) return;
      const selected = story.chapter;
      if (selected.id !== chapterId) throw new Error("Chapter not found");
      const issue = validatePlayableChapter(selected, {
        availableAssets: new Map(assets.flatMap((asset) => asset.mediaType === "model" ? [] : [[asset.id, asset.mediaType] as const])),
      });
      if (issue) throw new Error(issue.message);
      const definitions = story.variables;
      const storyHash = await storySignature(story);
      if (disposed) return;
      const key = storyProgressKey(`project:${projectId}`, selected.id);
      const saved = loadStoryProgress(window.localStorage, key, storyHash, selected, definitions);
      progress.current = { key, signature: storyHash };
      checkpointRef.current = saved?.checkpoint;
      setChapter(selected);
      setVariables(definitions);
      setConfig(story.player);
      setHasCheckpoint(Boolean(saved?.checkpoint));
      setRuntime(restartGame(selected, definitions, saved?.discoveries));
      document.title = `${story.player.title || selected.title} - Playtest`;
    }).catch((cause) => {
      if (!disposed) setError(errorMessage(cause));
    });
    return () => { disposed = true; };
  }, [chapterId, projectId]);

  useEffect(() => {
    const storage = progress.current;
    const runtimeNode = chapter?.nodes.find((candidate) => candidate.id === runtime?.nodeId);
    if (!storage || !runtime || runtimeNode?.type === "open-ui") return;
    const showSaved = shouldCreateStoryCheckpoint(checkpointRef.current, runtime);
    if (!shouldPersistStoryCheckpoint(checkpointRef.current, runtime)) return;
    const save = createStorySave(storage.signature, runtime.progress, runtime);
    checkpointRef.current = save.checkpoint;
    setHasCheckpoint(true);
    try {
      saveStoryProgress(window.localStorage, storage.key, save);
      if (showSaved) setSaveStatus("saved");
    } catch {
      setSaveStatus("error");
    }
  }, [chapter, runtime]);

  useEffect(() => {
    if (saveStatus !== "saved") return;
    const timeout = window.setTimeout(() => setSaveStatus(undefined), 1_600);
    return () => window.clearTimeout(timeout);
  }, [saveStatus]);

  const startNewGame = useCallback(() => {
    if (!chapter) return;
    if (checkpointRef.current && !window.confirm("Start a new game? Your checkpoint will be replaced. Discovered routes will stay unlocked.")) return;
    const storage = progress.current;
    const discoveries = storyDiscoveries(runtime?.progress ?? checkpointRef.current?.progress);
    if (storage) {
      try {
        saveStoryProgress(window.localStorage, storage.key, createStorySave(storage.signature, discoveries));
      } catch {
        setSaveStatus("error");
      }
    }
    checkpointRef.current = undefined;
    setHasCheckpoint(false);
    setRuntime(advanceOpenUi(chapter, restartGame(chapter, variables, discoveries)));
    setPaused(false);
    setPlaybackStep((step) => step + 1);
  }, [chapter, runtime?.progress, variables]);

  const continueGame = useCallback(() => {
    const saved = checkpointRef.current;
    if (!saved) return;
    setRuntime(saved);
    setPaused(false);
    setPlaybackStep((step) => step + 1);
  }, []);

  const restartCheckpoint = useCallback(() => {
    const saved = checkpointRef.current;
    if (!saved) return;
    setRuntime(saved);
    setPaused(false);
    setPlaybackStep((step) => step + 1);
  }, []);

  const returnToMenu = useCallback(() => {
    if (!chapter) return;
    setRuntime((current) => restartGame(chapter, variables, storyDiscoveries(current?.progress)));
    setPaused(false);
    setPlaybackStep((step) => step + 1);
  }, [chapter, variables]);

  const enterOpenUi = useCallback((sourceHandle?: string) => {
    if (!chapter) return;
    setRuntime((current) => current ? advanceOpenUi(chapter, current, sourceHandle) : current);
    setPlaybackStep((step) => step + 1);
  }, [chapter]);

  const updateSceneTime = useCallback((mediaId: string, timeMs: number) => {
    if (!chapter) return;
    setRuntime((current) => current ? advanceSceneTime(chapter, current, mediaId, timeMs) : current);
  }, [chapter]);

  const completeCurrentMedia = useCallback((mediaId: string, durationMs: number) => {
    if (!chapter) return;
    setRuntime((current) => current ? completeSceneMedia(chapter, current, mediaId, durationMs) : current);
    setPlaybackStep((step) => step + 1);
  }, [chapter]);

  const selectChoice = useCallback((optionId: string) => {
    if (!chapter) return;
    setRuntime((current) => current ? chooseOption(chapter, current, optionId) : current);
    setPlaybackStep((step) => step + 1);
  }, [chapter]);
  const resolveInteraction = useCallback((result: string, commands: StoryInteractionCommand[]) => {
    if (!chapter) return;
    setRuntime((current) => current ? resolveInteractionNode(chapter, current, result, commands, variables) : current);
    setPlaybackStep((step) => step + 1);
  }, [chapter, variables]);

  const node = chapter?.nodes.find((candidate) => candidate.id === runtime?.nodeId);
  const style = {
    "--story-player-accent": config.theme.accentColor,
    "--story-player-text": config.theme.textColor,
    "--story-player-font": config.theme.font === "serif" ? "Georgia, 'Times New Roman', serif" : "Inter, system-ui, sans-serif",
  } as CSSProperties;

  return <main className="story-playtest-page" style={style}>
    <WindowDragRegion />
    {error ? <div className="story-playtest-state" role="alert">{error}</div> : null}
    {!error && (!chapter || !runtime) ? <div className="story-playtest-state">Loading playtest...</div> : null}
    {chapter && runtime ? (
      <InteractiveDramaPlayer
        chapter={chapter}
        variables={variables}
        config={config}
        node={node}
        runtime={runtime}
        playbackKey={playbackStep}
        paused={paused}
        hasCheckpoint={hasCheckpoint}
        saveStatus={saveStatus}
        onAdvanceOpenUi={enterOpenUi}
        onContinueGame={continueGame}
        onPause={() => setPaused(true)}
        onResume={() => setPaused(false)}
        onRestartCheckpoint={restartCheckpoint}
        onRestartGame={startNewGame}
        onMenu={returnToMenu}
        onSceneTime={updateSceneTime}
        onMediaComplete={completeCurrentMedia}
        onInteraction={resolveInteraction}
        onChoice={selectChoice}
      />
    ) : null}
  </main>;
}

export interface StoryPreviewSessionState {
  runtime: PlayingRuntimeState;
  checkpoint?: PlayingRuntimeState;
}

export function updateStoryPreviewSession(current: StoryPreviewSessionState, runtime: PlayingRuntimeState, checkpoint: "auto" | "preserve" | "clear" = "auto"): StoryPreviewSessionState {
  if (checkpoint === "clear") return { runtime };
  if (checkpoint === "preserve") return { runtime, checkpoint: current.checkpoint };
  return { runtime, checkpoint: shouldPersistStoryCheckpoint(current.checkpoint, runtime) ? runtime : current.checkpoint };
}

export function createStoryPreviewSession(chapter: StoryChapter, variables: StoryVariable[], initialNodeId: string, initialSession?: StoryPreviewSessionState): StoryPreviewSessionState {
  if (initialSession?.runtime.nodeId === initialNodeId) return initialSession;
  const runtime = previewStoryNode(chapter, variables, initialNodeId);
  const node = chapter.nodes.find((candidate) => candidate.id === initialNodeId);
  return { runtime, ...(node?.type === "open-ui" ? {} : { checkpoint: runtime }) };
}

export function StoryPlayerPreviewSession({ chapter, variables, config, initialNodeId, initialSession, onChoice, onNavigateNode, onSurfaceLayoutSelect, onSurfaceLayoutChange }: {
  chapter: StoryChapter;
  variables: StoryVariable[];
  config: StoryPlayerConfig;
  initialNodeId: string;
  initialSession?: StoryPreviewSessionState;
  onChoice?: (optionId: string) => void;
  onNavigateNode?: (session: StoryPreviewSessionState) => void;
  onSurfaceLayoutSelect?: (nodeId: string, elementId?: string) => void;
  onSurfaceLayoutChange?: (nodeId: string, elementId: string, offset: StorySurfaceLayoutOffset) => void;
}) {
  const nextInitial = useMemo(() => createStoryPreviewSession(chapter, variables, initialNodeId, initialSession), [chapter, initialNodeId, initialSession, variables]);
  const resetKey = JSON.stringify(nextInitial);
  const nextInitialRef = useRef(nextInitial);
  nextInitialRef.current = nextInitial;
  const [session, setSession] = useState(nextInitial);
  const sessionRef = useRef(nextInitial);
  const [paused, setPaused] = useState(false);
  const [playbackStep, setPlaybackStep] = useState(0);
  const [error, setError] = useState<string>();

  useEffect(() => {
    const initial = nextInitialRef.current;
    sessionRef.current = initial;
    setSession(initial);
    setPaused(false);
    setPlaybackStep((step) => step + 1);
    setError(undefined);
  }, [resetKey]);

  const transition = useCallback((next: (current: PlayingRuntimeState) => PlayingRuntimeState, options: { advanceFrame?: boolean; checkpoint?: "auto" | "preserve" | "clear"; navigate?: boolean; resume?: boolean } = {}) => {
    try {
      const nextSession = updateStoryPreviewSession(sessionRef.current, next(sessionRef.current.runtime), options.checkpoint);
      sessionRef.current = nextSession;
      setSession(nextSession);
      if (options.resume) setPaused(false);
      if (options.advanceFrame !== false) setPlaybackStep((step) => step + 1);
      setError(undefined);
      if (options.navigate && nextSession.runtime.nodeId !== initialNodeId) onNavigateNode?.(nextSession);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [initialNodeId, onNavigateNode]);
  const node = chapter.nodes.find((candidate) => candidate.id === session.runtime.nodeId);

  return <>
    <InteractiveDramaPlayer
      chapter={chapter}
      variables={variables}
      config={config}
      node={node}
      runtime={session.runtime}
      playbackKey={playbackStep}
      paused={paused}
      holdTimeoutTransitions
      onSurfaceLayoutSelect={onSurfaceLayoutSelect}
      onSurfaceLayoutChange={onSurfaceLayoutChange}
      hasCheckpoint={Boolean(session.checkpoint)}
      onAdvanceOpenUi={(sourceHandle) => transition((current) => advanceOpenUi(chapter, current, sourceHandle), { navigate: true, resume: true })}
      onContinueGame={() => { const checkpoint = sessionRef.current.checkpoint; if (checkpoint) transition(() => checkpoint, { checkpoint: "preserve", navigate: true, resume: true }); }}
      onPause={() => setPaused(true)}
      onResume={() => setPaused(false)}
      onRestartCheckpoint={() => { const checkpoint = sessionRef.current.checkpoint; if (checkpoint) transition(() => checkpoint, { checkpoint: "preserve", resume: true }); }}
      onRestartGame={() => transition((current) => advanceOpenUi(chapter, restartGame(chapter, variables, storyDiscoveries(current.progress))), { checkpoint: "clear", navigate: true, resume: true })}
      onMenu={() => transition(
        (current) => restartGame(chapter, variables, storyDiscoveries(current.progress)),
        { checkpoint: "preserve", navigate: true, resume: true },
      )}
      onSceneTime={(mediaId, timeMs) => transition((current) => advanceSceneTime(chapter, current, mediaId, timeMs), { advanceFrame: false })}
      onMediaComplete={(mediaId, durationMs) => transition((current) => completePreviewSceneMedia(chapter, current, mediaId, durationMs), { advanceFrame: false })}
      onInteraction={(result, commands) => transition((current) => resolveInteractionNode(chapter, current, result, commands, variables), { navigate: true })}
      onChoice={(optionId) => {
        onChoice?.(optionId);
        transition((current) => chooseOption(chapter, current, optionId), { navigate: true });
      }}
    />
    {error ? <div className="story-player-preview-error" role="alert">{error}</div> : null}
  </>;
}

export function completePreviewSceneMedia(chapter: StoryChapter, state: PlayerRuntimeState, mediaId: string, durationMs: number): PlayingRuntimeState {
  const advanced = advanceSceneTime(chapter, state, mediaId, durationMs);
  const node = chapter.nodes.find((candidate) => candidate.id === advanced.nodeId);
  if (node?.type !== "scene") throw new Error("The current story node is not a scene");
  const items = node.data.presentation.media.items;
  const next = items[items.findIndex((item) => item.id === mediaId) + 1];
  return next ? { ...advanced, scenePlayback: { mediaId: next.id, timeMs: 0 } } : advanced;
}

export function StoryPlayerSnapshot({ chapter, variables, config, nodeId }: { chapter: StoryChapter; variables: StoryVariable[]; config: StoryPlayerConfig; nodeId: string }) {
  const runtime = useMemo(() => previewStoryNode(chapter, variables, nodeId), [chapter, nodeId, variables]);
  const node = chapter.nodes.find((candidate) => candidate.id === runtime.nodeId);
  return <InteractiveDramaPlayer
    chapter={chapter}
    variables={variables}
    config={config}
    node={node}
    runtime={runtime}
    paused={false}
    playbackPaused
    hasCheckpoint={node?.type !== "open-ui"}
    onAdvanceOpenUi={NOOP}
    onContinueGame={NOOP}
    onPause={NOOP}
    onResume={NOOP}
    onRestartCheckpoint={NOOP}
    onRestartGame={NOOP}
    onMenu={NOOP}
    onSceneTime={NOOP_SCENE_TIME}
    onMediaComplete={NOOP_MEDIA_COMPLETE}
    onInteraction={NOOP_INTERACTION}
    onChoice={NOOP_CHOICE}
  />;
}

export function InteractiveDramaPlayer({ chapter, variables, config, node, runtime, playbackKey = 0, paused, playbackPaused = false, holdTimeoutTransitions = false, hasCheckpoint, saveStatus, assetUrls, onAdvanceOpenUi, onContinueGame, onPause, onResume, onRestartCheckpoint, onRestartGame, onMenu, onSceneTime, onMediaComplete, onInteraction, onChoice, onSurfaceLayoutSelect, onSurfaceLayoutChange }: {
  chapter: StoryChapter;
  variables: StoryVariable[];
  config: StoryPlayerConfig;
  node?: StoryNode;
  runtime: PlayerRuntimeState;
  playbackKey?: number;
  paused: boolean;
  playbackPaused?: boolean;
  holdTimeoutTransitions?: boolean;
  hasCheckpoint: boolean;
  saveStatus?: "saved" | "error";
  assetUrls?: Readonly<Record<string, string>>;
  onAdvanceOpenUi: (sourceHandle?: string) => void;
  onContinueGame: () => void;
  onPause: () => void;
  onResume: () => void;
  onRestartCheckpoint: () => void;
  onRestartGame: () => void;
  onMenu: () => void;
  onSceneTime: (mediaId: string, timeMs: number) => void;
  onMediaComplete: (mediaId: string, durationMs: number) => void;
  onInteraction: (result: string, commands: StoryInteractionCommand[]) => void;
  onChoice: (optionId: string) => void;
  onSurfaceLayoutSelect?: (nodeId: string, elementId?: string) => void;
  onSurfaceLayoutChange?: (nodeId: string, elementId: string, offset: StorySurfaceLayoutOffset) => void;
}) {
  const [storyMapOpen, setStoryMapOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [fullscreen, setFullscreen] = useState(() => Boolean(document.fullscreenElement));
  const storyMapNode = runtime.mode !== "menu" && node?.type === "open-ui" ? getStoryMapNode(chapter, node.id) : undefined;
  const settingsNode = runtime.mode !== "menu" && node?.type === "open-ui" ? getSettingsNode(chapter, node.id) : undefined;
  const storyMapVisible = storyMapOpen && Boolean(storyMapNode);
  const settingsVisible = settingsOpen && Boolean(settingsNode);
  useEffect(() => {
    if (storyMapOpen && !storyMapNode) setStoryMapOpen(false);
  }, [storyMapNode, storyMapOpen]);
  useEffect(() => {
    if (settingsOpen && !settingsNode) setSettingsOpen(false);
  }, [settingsNode, settingsOpen]);
  useEffect(() => {
    const update = () => setFullscreen(Boolean(document.fullscreenElement));
    document.addEventListener("fullscreenchange", update);
    return () => document.removeEventListener("fullscreenchange", update);
  }, []);
  const toggleFullscreen = useCallback(() => {
    void (document.fullscreenElement ? document.exitFullscreen() : document.documentElement.requestFullscreen()).catch(() => {});
  }, []);
  if (runtime.mode === "menu") return <div className="story-playtest-state" role="alert">The story has not started.</div>;
  const frameKey = `${node?.id ?? "missing"}:${runtime.scenePlayback?.mediaId ?? ""}:${playbackKey}`;
  const frame = { chapter, variables, config, node, runtime, holdTimeoutTransitions, hasCheckpoint, assetUrls, onSurfaceLayoutSelect, onSurfaceLayoutChange } satisfies StoryPlayerFrameData;
  const canPause = node?.type === "scene" || node?.type === "interaction" || node?.type === "choice";

  return <section className={`story-player story-player-${config.choicePosition}`} aria-label="Story player">
    <StoryPlayerViewport viewport={config.viewport}>
      <StoryFrameTransition frameKey={frameKey} frame={frame} paused={paused || playbackPaused || storyMapVisible || settingsVisible} onAdvanceOpenUi={onAdvanceOpenUi} onContinueGame={onContinueGame} onRestartGame={onRestartGame} onOpenStoryMap={() => { if (storyMapNode) setStoryMapOpen(true); }} onOpenSettings={() => { if (settingsNode) setSettingsOpen(true); }} onMenu={onMenu} onSceneTime={onSceneTime} onMediaComplete={onMediaComplete} onInteraction={onInteraction} onChoice={onChoice} />
      {saveStatus ? <div className={`story-player-save-status${saveStatus === "error" ? " is-error" : ""}`} role={saveStatus === "error" ? "alert" : "status"}>{saveStatus === "error" ? "Progress could not be saved" : "Saved"}</div> : null}
      {canPause ? <StoryPlayerControls onPause={onPause} /> : null}
      {paused ? <PauseMenu canRestartCheckpoint={hasCheckpoint} onResume={onResume} onRestartCheckpoint={onRestartCheckpoint} onRestartGame={onRestartGame} onMenu={onMenu} /> : null}
      {storyMapVisible && storyMapNode ? <StoryMap chapter={chapter} node={storyMapNode} progress={runtime.progress} currentNodeId={runtime.nodeId} viewport={config.viewport} accentColor={config.theme.accentColor} onClose={() => setStoryMapOpen(false)} /> : null}
      {settingsVisible && settingsNode ? <StorySettings node={settingsNode} accentColor={config.theme.accentColor} fullscreen={fullscreen} onClose={() => setSettingsOpen(false)} onToggleFullscreen={toggleFullscreen} /> : null}
    </StoryPlayerViewport>
  </section>;
}

interface StoryPlayerFrameData {
  chapter: StoryChapter;
  variables: StoryVariable[];
  config: StoryPlayerConfig;
  node?: StoryNode;
  runtime: PlayingRuntimeState;
  holdTimeoutTransitions: boolean;
  hasCheckpoint: boolean;
  assetUrls?: Readonly<Record<string, string>>;
  onSurfaceLayoutSelect?: (nodeId: string, elementId?: string) => void;
  onSurfaceLayoutChange?: (nodeId: string, elementId: string, offset: StorySurfaceLayoutOffset) => void;
}

interface PreviousStoryPlayerFrame {
  key: string;
  frame: StoryPlayerFrameData;
}

function StoryFrameTransition({ frameKey, frame, paused, onAdvanceOpenUi, onContinueGame, onRestartGame, onOpenStoryMap, onOpenSettings, onMenu, onSceneTime, onMediaComplete, onInteraction, onChoice }: {
  frameKey: string;
  frame: StoryPlayerFrameData;
  paused: boolean;
  onAdvanceOpenUi: (sourceHandle?: string) => void;
  onContinueGame: () => void;
  onRestartGame: () => void;
  onOpenStoryMap: () => void;
  onOpenSettings?: () => void;
  onMenu: () => void;
  onSceneTime: (mediaId: string, timeMs: number) => void;
  onMediaComplete: (mediaId: string, durationMs: number) => void;
  onInteraction: (result: string, commands: StoryInteractionCommand[]) => void;
  onChoice: (optionId: string) => void;
}) {
  const committedFrame = useRef(frame);
  const [transition, setTransition] = useState<{ key: string; ready: boolean; previous?: PreviousStoryPlayerFrame }>(() => ({ key: frameKey, ready: false }));
  if (transition.key !== frameKey) {
    const previous = transition.ready ? { key: transition.key, frame: committedFrame.current } : transition.previous;
    setTransition({ key: frameKey, ready: false, previous });
  }
  useLayoutEffect(() => { committedFrame.current = frame; });
  const showFrame = useCallback(() => {
    setTransition((current) => current.key === frameKey && !current.ready ? { key: current.key, ready: true } : current);
  }, [frameKey]);
  return <>
    {transition.previous ? <div key={transition.previous.key} className="story-player-frame is-previous" aria-hidden="true" inert><StoryPlayerFrame frame={transition.previous.frame} active={false} paused onReady={NOOP} onAdvanceOpenUi={NOOP} onContinueGame={NOOP} onRestartGame={NOOP} onOpenStoryMap={NOOP} onOpenSettings={NOOP} onMenu={NOOP} onSceneTime={NOOP_SCENE_TIME} onMediaComplete={NOOP_MEDIA_COMPLETE} onInteraction={NOOP_INTERACTION} onChoice={NOOP_CHOICE} /></div> : null}
    <div key={frameKey} className={`story-player-frame${transition.ready ? " is-ready" : ""}`} aria-hidden={!transition.ready} inert={!transition.ready}>
      <StoryPlayerFrame frame={frame} active={transition.ready} paused={paused} onReady={showFrame} onAdvanceOpenUi={onAdvanceOpenUi} onContinueGame={onContinueGame} onRestartGame={onRestartGame} onOpenStoryMap={onOpenStoryMap} onOpenSettings={onOpenSettings} onMenu={onMenu} onSceneTime={onSceneTime} onMediaComplete={onMediaComplete} onInteraction={onInteraction} onChoice={onChoice} />
    </div>
  </>;
}

function StoryPlayerFrame({ frame, active, paused, onReady, onAdvanceOpenUi, onContinueGame, onRestartGame, onOpenStoryMap, onOpenSettings, onMenu, onSceneTime, onMediaComplete, onInteraction, onChoice }: {
  frame: StoryPlayerFrameData;
  active: boolean;
  paused: boolean;
  onReady: () => void;
  onAdvanceOpenUi: (sourceHandle?: string) => void;
  onContinueGame: () => void;
  onRestartGame: () => void;
  onOpenStoryMap: () => void;
  onOpenSettings?: () => void;
  onMenu: () => void;
  onSceneTime: (mediaId: string, timeMs: number) => void;
  onMediaComplete: (mediaId: string, durationMs: number) => void;
  onInteraction: (result: string, commands: StoryInteractionCommand[]) => void;
  onChoice: (optionId: string) => void;
}) {
  const { chapter, variables, config, node, runtime, holdTimeoutTransitions, hasCheckpoint, assetUrls, onSurfaceLayoutSelect, onSurfaceLayoutChange } = frame;
  const inactive = paused || !active;
  const activeSceneTime = active ? onSceneTime : NOOP_SCENE_TIME;
  const activeMediaComplete = active ? onMediaComplete : NOOP_MEDIA_COMPLETE;
  const activeInteraction = active ? onInteraction : NOOP_INTERACTION;
  const activeChoice = active ? onChoice : NOOP_CHOICE;
  const handlePlayerUiAction = (action: StoryScreenAction) => {
    if (!active) return;
    if (action === "start-game") onAdvanceOpenUi();
    else if (action === "continue-game") onContinueGame();
    else if (action === "new-game") onRestartGame();
    else if (action === "open-story-map") onOpenStoryMap();
    else if (action === "open-settings") onOpenSettings?.();
    else if (typeof action === "object" && action.type === "exit") {
      const exitHandle = `exit:${action.exitId}`;
      const target = node?.type === "open-ui" ? getNextNode(chapter, node.id, exitHandle) : undefined;
      if (target?.type === "story-map") onOpenStoryMap();
      else if (target?.type === "settings") onOpenSettings?.();
      else onAdvanceOpenUi(exitHandle);
    }
  };
  if (node?.type === "open-ui") return <StoryOpenUiPlayer chapter={chapter} node={node} hasCheckpoint={hasCheckpoint} paused={inactive} layoutEditable={active && Boolean(onSurfaceLayoutChange)} assetUrls={assetUrls} onReady={onReady} onAction={handlePlayerUiAction} onLayoutSelect={(elementId) => { if (active) onSurfaceLayoutSelect?.(node.id, elementId); }} onLayoutChange={(elementId, offset) => { if (active) onSurfaceLayoutChange?.(node.id, elementId, offset); }} />;
  if (node?.type === "scene") return <StoryScenePlayer chapter={chapter} variables={variables} node={node} runtime={runtime} fit={config.videoFit} paused={inactive} assetUrls={assetUrls} onReady={onReady} onTime={activeSceneTime} onComplete={activeMediaComplete} />;
  if (node?.type === "interaction") return <StoryInteractionPlayer chapter={chapter} node={node} variables={variables} runtime={runtime} fit={config.videoFit} active={active} paused={paused} assetUrls={assetUrls} onReady={onReady} onComplete={(result, commands, source) => { if (!holdTimeoutTransitions || source === "behavior") activeInteraction(result, commands); }} />;
  if (node?.type === "choice") return <StoryChoicePlayer chapter={chapter} node={node} variables={variables} runtime={runtime} fit={config.videoFit} paused={inactive} assetUrls={assetUrls} onReady={onReady} onSelect={(optionId, source) => { if (!holdTimeoutTransitions || source === "behavior") activeChoice(optionId); }} />;
  if (node?.type === "ending") return <StoryEnding chapter={chapter} node={node} variables={variables} runtime={runtime} fit={config.videoFit} assetUrls={assetUrls} onReady={onReady} onRestart={active ? onRestartGame : NOOP} onMenu={active ? onMenu : NOOP} />;
  return <><ReadyEffect onReady={onReady} /><div className="story-playtest-state" role="alert">The current story node is missing.</div></>;
}

const NOOP = () => {};
const NOOP_SCENE_TIME = (_mediaId: string, _timeMs: number) => {};
const NOOP_MEDIA_COMPLETE = (_mediaId: string, _durationMs: number) => {};
const NOOP_INTERACTION = (_result: string, _commands: StoryInteractionCommand[]) => {};
const NOOP_CHOICE = (_optionId: string) => {};

function StoryOpenUiPlayer({ chapter, node, hasCheckpoint, paused, layoutEditable, assetUrls, onReady, onAction, onLayoutSelect, onLayoutChange }: { chapter: StoryChapter; node: Extract<StoryNode, { type: "open-ui" }>; hasCheckpoint: boolean; paused: boolean; layoutEditable: boolean; assetUrls?: Readonly<Record<string, string>>; onReady: () => void; onAction: (action: StoryScreenAction) => void; onLayoutSelect: (elementId?: string) => void; onLayoutChange: (elementId: string, offset: StorySurfaceLayoutOffset) => void }) {
  const item = node.data.presentation.media.items[0];
  const assetId = item ? resolveStoryAssetId(chapter, item.source) : undefined;
  const media = useStoryAssetUrl(assetId, assetUrls);
  const content = useMemo(() => {
    const runtimeContent = openUiRuntimeContent(node.data.content, hasCheckpoint);
    const settingsNode = getSettingsNode(chapter, node.id);
    const buttons = runtimeContent.buttons.filter((button) => settingsNode || button.action !== "open-settings");
    if (!settingsNode || buttons.some((button) => button.action === "open-settings")) return { ...runtimeContent, buttons };
    return { ...runtimeContent, buttons: [...buttons, { id: "settings", label: "Settings", action: "open-settings" as const }] };
  }, [chapter, hasCheckpoint, node.data.content, node.id]);
  const ready = useReadyParts(onReady, 2);
  useEffect(() => { if (!item || !assetId || media.error) ready("media"); }, [assetId, item, media.error, ready]);
  const background = <>
    {media.url && item?.type === "image" ? <img src={media.url} alt="" onLoad={() => ready("media")} onError={() => ready("media")} /> : null}
    {media.url && item?.type === "video" ? <video className="story-player-menu-video" src={media.url} autoPlay={!paused} muted loop playsInline onLoadedData={() => ready("media")} onError={() => ready("media")} /> : null}
  </>;
  const surface = <StoryScreenSurface files={node.data.presentation.surface.files} content={content} mode="runtime" layout={node.data.presentation.surface.layout} layoutEditable={layoutEditable} title={node.data.title || "Open UI"} className="story-player-menu-screen" onReady={() => ready("surface")} onAction={onAction} onLayoutSelect={onLayoutSelect} onLayoutChange={onLayoutChange} />;
  return <StoryPresentationFrame className="story-player-menu-stage" background={background} surface={surface} />;
}

function StoryInteractionPlayer({ chapter, node, variables, runtime, fit, active, paused, assetUrls, onReady, onComplete }: {
  chapter: StoryChapter;
  node: Extract<StoryNode, { type: "interaction" }>;
  variables: StoryVariable[];
  runtime: Extract<PlayerRuntimeState, { mode: "playing" }>;
  fit: StoryPlayerConfig["videoFit"];
  active: boolean;
  paused: boolean;
  assetUrls?: Readonly<Record<string, string>>;
  onReady: () => void;
  onComplete: (result: string, commands: StoryInteractionCommand[], source: StoryCompletionSource) => void;
}) {
  const [error, setError] = useState<string>();
  const ready = useReadyParts(onReady, 2);
  const resolved = useRef(false);
  const pending = useRef<{ result: string; commands: StoryInteractionCommand[]; source: StoryCompletionSource } | undefined>(undefined);
  const activeRef = useRef(active);
  const pausedRef = useRef(paused);
  activeRef.current = active;
  pausedRef.current = paused;
  const context = useMemo(() => ({
    variables: Object.fromEntries(variables.map((variable) => [variable.id, runtime.variables[variable.id]])),
    variableDefinitions: variables.map(({ id, name, type }) => ({ id, name, type })),
  }), [runtime.variables, variables]);
  useEffect(() => {
    if (!active || paused || resolved.current || !pending.current) return;
    const completion = pending.current;
    pending.current = undefined;
    resolved.current = true;
    onComplete(completion.result, completion.commands, completion.source);
  }, [active, onComplete, paused]);
  const background = <StoryPresentationMediaLayer chapter={chapter} node={node} fit={fit} assetUrls={assetUrls} onReady={() => ready("media")} />;
  const surface = <StoryInteractionSurface files={storyNodePresentation(node).surface.files} outcomes={node.data.outcomes} timeout={node.data.timeout} mode="runtime" context={context} active={active} paused={paused} title={node.data.title || "Interaction"} className="story-player-interaction-surface" onReady={() => ready("surface")} onComplete={(result, commands, source) => { if (resolved.current) return; if (!activeRef.current || pausedRef.current) { pending.current = { result, commands, source }; return; } resolved.current = true; onComplete(result, commands, source); }} onError={setError} />;
  const overlay = error ? <div className="story-player-interaction-error" role="alert">Interaction failed: {error}</div> : null;
  return <StoryPresentationFrame className="story-player-interaction-node" background={background} surface={surface} overlay={overlay} />;
}

function StoryPresentationFrame({ className, background, surface, overlay }: { className?: string; background?: ReactNode; surface: ReactNode; overlay?: ReactNode }) {
  return <div className={`story-player-node${className ? ` ${className}` : ""}`}>
    {background}
    {surface}
    {overlay}
  </div>;
}

function resolvedPresentationMedia(chapter: StoryChapter, node: Extract<StoryNode, { type: "open-ui" | "scene" | "interaction" | "choice" | "ending" }>): { assetId?: string; type: "image" | "video" } | undefined {
  const item = node.data.presentation.media.items[0];
  return item ? { assetId: resolveStoryAssetId(chapter, item.source), type: item.type } : undefined;
}

function StoryPresentationMediaLayer({ chapter, node, fit, assetUrls, onReady }: { chapter: StoryChapter; node: Extract<StoryNode, { type: "open-ui" | "scene" | "interaction" | "choice" | "ending" }>; fit: StoryPlayerConfig["videoFit"]; assetUrls?: Readonly<Record<string, string>>; onReady: () => void }) {
  const resolved = resolvedPresentationMedia(chapter, node);
  const media = useStoryAssetUrl(resolved?.assetId, assetUrls);
  useEffect(() => { if (!resolved?.assetId || media.error) onReady(); }, [media.error, onReady, resolved?.assetId]);
  return <div className="story-player-video story-player-interaction-background">
    {media.url && resolved?.type === "image" ? <img src={media.url} alt="" style={{ objectFit: fit }} onLoad={onReady} onError={onReady} /> : null}
    {media.url && resolved?.type === "video" ? <video src={media.url} muted playsInline style={{ objectFit: fit }} onLoadedMetadata={(event) => { event.currentTarget.currentTime = Math.max(0, event.currentTarget.duration - 0.04); }} onLoadedData={onReady} onSeeked={onReady} onError={onReady} /> : null}
  </div>;
}

function PauseMenu({ canRestartCheckpoint, onResume, onRestartCheckpoint, onRestartGame, onMenu }: { canRestartCheckpoint: boolean; onResume: () => void; onRestartCheckpoint: () => void; onRestartGame: () => void; onMenu: () => void }) {
  return <StoryPlayerPauseLayer modal>
    <button type="button" onClick={onResume}><Play size={15} fill="currentColor" />Resume</button>
    <button type="button" disabled={!canRestartCheckpoint} onClick={onRestartCheckpoint}><RotateCcw size={15} />Restart checkpoint</button>
    <button type="button" onClick={onRestartGame}>Restart game</button>
    <button type="button" onClick={onMenu}>Main menu</button>
  </StoryPlayerPauseLayer>;
}

function StoryEnding({ chapter, node, variables, runtime, fit, assetUrls, onReady, onRestart, onMenu }: { chapter: StoryChapter; node: Extract<StoryNode, { type: "ending" }>; variables: StoryVariable[]; runtime: Extract<PlayerRuntimeState, { mode: "playing" }>; fit: StoryPlayerConfig["videoFit"]; assetUrls?: Readonly<Record<string, string>>; onReady: () => void; onRestart: () => void; onMenu: () => void }) {
  const context = storyPresentationContext(node, variables, runtime);
  const ready = useReadyParts(onReady, 2);
  const background = <StoryPresentationMediaLayer chapter={chapter} node={node} fit={fit} assetUrls={assetUrls} onReady={() => ready("media")} />;
  const surface = <StorySceneSurface files={storyNodePresentation(node).surface.files} context={context} mode="runtime" title={`${node.data.title || "Ending"} code`} className="story-player-scene-surface" onReady={() => ready("surface")} onAction={(action) => {
      if (action.type === "restart") onRestart();
      if (action.type === "menu") onMenu();
    }} />;
  return <StoryPresentationFrame className="story-player-presentation-node" background={background} surface={surface} />;
}

function StoryChoicePlayer({ chapter, node, variables, runtime, fit, paused, assetUrls, onReady, onSelect }: {
  chapter: StoryChapter;
  node: Extract<StoryNode, { type: "choice" }>;
  variables: StoryVariable[];
  runtime: Extract<PlayerRuntimeState, { mode: "playing" }>;
  fit: StoryPlayerConfig["videoFit"];
  paused: boolean;
  assetUrls?: Readonly<Record<string, string>>;
  onReady: () => void;
  onSelect: (optionId: string, source: StoryCompletionSource) => void;
}) {
  const visibleOptions = node.data.options.filter((option) => matchesStoryCondition(option.condition, runtime.variables));
  const [remainingMs, setRemainingMs] = useState(node.data.timeout?.durationMs ?? 0);
  const remaining = useRef(remainingMs);
  const resolved = useRef(false);
  const ready = useReadyParts(onReady, 2);

  useEffect(() => {
    const timeout = node.data.timeout;
    if (!timeout || !visibleOptions.length || paused) return;
    const deadline = performance.now() + remaining.current;
    const tick = () => {
      remaining.current = Math.max(0, deadline - performance.now());
      setRemainingMs(remaining.current);
    };
    const interval = window.setInterval(tick, 100);
    const timer = window.setTimeout(() => {
      if (resolved.current) return;
      resolved.current = true;
      remaining.current = 0;
      setRemainingMs(0);
      const selected = visibleOptions.find((option) => option.id === timeout.defaultOptionId) ?? visibleOptions[0];
      if (selected) onSelect(selected.id, "timeout");
    }, remaining.current);
    return () => { tick(); window.clearInterval(interval); window.clearTimeout(timer); };
  }, [node.data.timeout, onSelect, paused, visibleOptions.length]);

  function select(optionId: string): void {
    if (resolved.current || paused) return;
    resolved.current = true;
    onSelect(optionId, "behavior");
  }

  const context = storyPresentationContext(node, variables, runtime, { options: visibleOptions.map(({ id, label }) => ({ id, label })), remainingMs: node.data.timeout ? remainingMs : undefined, durationMs: node.data.timeout?.durationMs });
  const background = <StoryPresentationMediaLayer chapter={chapter} node={node} fit={fit} assetUrls={assetUrls} onReady={() => ready("media")} />;
  const surface = <StorySceneSurface files={storyNodePresentation(node).surface.files} context={context} mode="runtime" title={`${node.data.title || "Choice"} code`} className="story-player-scene-surface" onReady={() => ready("surface")} onAction={(action) => { if (action.type === "choose") select(action.optionId); }} />;
  return <StoryPresentationFrame className="story-player-presentation-node" background={background} surface={surface} />;
}

function storyPresentationContext(node: Extract<StoryNode, { type: "scene" | "interaction" | "choice" | "ending" }>, variables: StoryVariable[], runtime: Extract<PlayerRuntimeState, { mode: "playing" }>, extra: Record<string, unknown> = {}) {
  return {
    node: {
      id: node.id,
      type: node.type,
      title: node.data.title,
      ...(node.type === "ending" ? { description: node.data.description } : {}),
      ...extra,
    },
    variables: Object.fromEntries(variables.flatMap((variable) => [[variable.id, runtime.variables[variable.id]], [variable.name, runtime.variables[variable.id]]])),
  };
}

function StoryScenePlayer({ chapter, variables, node, runtime, fit, paused, assetUrls, onReady, onTime, onComplete }: {
  chapter: StoryChapter;
  variables: StoryVariable[];
  node: Extract<StoryNode, { type: "scene" }>;
  runtime: Extract<PlayerRuntimeState, { mode: "playing" }>;
  fit: StoryPlayerConfig["videoFit"];
  paused: boolean;
  assetUrls?: Readonly<Record<string, string>>;
  onReady: () => void;
  onTime: (mediaId: string, timeMs: number) => void;
  onComplete: (mediaId: string, durationMs: number) => void;
}) {
  const playback = runtime.scenePlayback;
  const [surfaceError, setSurfaceError] = useState<string>();
  const media = node.data.presentation.media;
  const items = media.items;
  const mediaIndex = items.findIndex((candidate) => candidate.id === playback?.mediaId);
  const item = items[mediaIndex];
  const assetId = item ? resolveStoryAssetId(chapter, item.source) : undefined;
  const asset = useStoryAssetUrl(assetId, assetUrls);
  const ready = useReadyParts(onReady, 2);
  const [videoDurationMs, setVideoDurationMs] = useState(0);
  const timed = !item || item.type === "image";
  const durationMs = timed ? sceneStillDurationMs(items, node.data.durationMs) : videoDurationMs;
  useEffect(() => { if (item?.type === "image" && (!assetId || asset.error)) ready("media"); }, [asset.error, assetId, item?.type, ready]);
  const sceneSurfaceContext = useMemo(() => {
    return {
      node: { id: node.id, type: node.type, title: node.data.title },
      scene: {
        id: node.id,
        title: node.data.title,
        ...(playback?.mediaId ? { mediaId: playback.mediaId } : {}),
        mediaIndex,
        mediaCount: items.length,
        timeMs: playback?.timeMs ?? 0,
        durationMs,
        playing: !paused,
      },
      variables: Object.fromEntries(variables.flatMap((variable) => [[variable.id, runtime.variables[variable.id]], [variable.name, runtime.variables[variable.id]]])),
    };
  }, [durationMs, items.length, mediaIndex, node.data.title, node.id, paused, playback?.mediaId, playback?.timeMs, runtime.variables, variables]);
  const surface = <StorySceneSurface key={node.id} files={storyNodePresentation(node).surface.files} context={sceneSurfaceContext} mode="runtime" title={`${node.data.title || "Untitled scene"} code`} className="story-player-scene-surface" onReady={() => ready("surface")} onError={setSurfaceError} />;
  if (!item) {
    const background = <><ReadyEffect onReady={() => ready("media")} />{playback ? <StorySceneTimer key={playback.mediaId} mediaId={playback.mediaId} initialTimeMs={playback.timeMs} durationMs={durationMs} paused={paused} onTime={onTime} onComplete={onComplete} /> : null}</>;
    return <StoryPresentationFrame background={background} surface={surface} />;
  }
  const background = item.type === "video"
    ? <StoryVideoPlayer key={item.id} assetId={assetId} fit={fit} paused={paused} initialTimeMs={playback?.timeMs ?? 0} assetUrls={assetUrls} onReady={() => ready("media")} onTime={(time) => onTime(item.id, time)} onDuration={setVideoDurationMs} onEnded={(duration) => onComplete(item.id, duration)} />
    : <article className="story-player-video">{asset.url ? <img src={asset.url} alt="" style={{ objectFit: fit }} onLoad={() => ready("media")} onError={() => ready("media")} /> : null}{playback ? <StorySceneTimer key={playback.mediaId} mediaId={playback.mediaId} initialTimeMs={playback.timeMs} durationMs={durationMs} paused={paused} onTime={onTime} onComplete={onComplete} /> : null}</article>;
  const overlay = surfaceError ? <div className="story-player-scene-error" role="alert">Scene code failed: {surfaceError}</div> : null;
  return <StoryPresentationFrame background={background} surface={surface} overlay={overlay} />;
}

function StorySceneTimer({ mediaId, initialTimeMs, durationMs, paused, onTime, onComplete }: {
  mediaId: string;
  initialTimeMs: number;
  durationMs: number;
  paused: boolean;
  onTime: (mediaId: string, timeMs: number) => void;
  onComplete: (mediaId: string, durationMs: number) => void;
}) {
  const clock = useRef(new SceneTimerClock(initialTimeMs, durationMs));
  const completed = useRef(false);
  const onTimeRef = useRef(onTime);
  const onCompleteRef = useRef(onComplete);
  onTimeRef.current = onTime;
  onCompleteRef.current = onComplete;

  useEffect(() => {
    if (paused || completed.current) return;
    clock.current.setDuration(durationMs);
    clock.current.resume(performance.now());
    const sync = () => {
      onTimeRef.current(mediaId, Math.round(clock.current.elapsed(performance.now())));
    };
    const finish = () => {
      if (completed.current) return;
      completed.current = true;
      onTimeRef.current(mediaId, durationMs);
      onCompleteRef.current(mediaId, durationMs);
    };
    const interval = window.setInterval(sync, 250);
    const timeout = window.setTimeout(finish, clock.current.remaining(performance.now()));
    return () => {
      window.clearInterval(interval);
      window.clearTimeout(timeout);
      if (!completed.current) clock.current.pause(performance.now());
    };
  }, [durationMs, mediaId, paused]);

  return null;
}

function StoryVideoPlayer({ assetId, fit, paused, initialTimeMs, assetUrls, onReady, onTime, onDuration, onEnded }: {
  assetId?: string; fit: StoryPlayerConfig["videoFit"]; paused: boolean; initialTimeMs: number; assetUrls?: Readonly<Record<string, string>>;
  onReady: () => void;
  onTime: (timeMs: number) => void; onDuration: (durationMs: number) => void; onEnded: (durationMs: number) => void;
}) {
  const media = useStoryAssetUrl(assetId, assetUrls);
  const video = useRef<HTMLVideoElement>(null);
  const [playbackError, setPlaybackError] = useState(false);
  useEffect(() => { if (paused) video.current?.pause(); else void video.current?.play().catch(() => {}); }, [paused]);
  useEffect(() => { if (!assetId || media.error) onReady(); }, [assetId, media.error, onReady]);
  const error = media.error ?? (playbackError ? "The video could not be played." : undefined);
  return <article className="story-player-video">
    {media.url && !playbackError ? <video ref={video} src={media.url} autoPlay playsInline style={{ objectFit: fit }} onError={() => { setPlaybackError(true); onReady(); }} onCanPlay={onReady} onLoadedMetadata={(event) => {
      const durationMs = Math.round(event.currentTarget.duration * 1_000);
      if (initialTimeMs > 0) event.currentTarget.currentTime = Math.min(initialTimeMs, durationMs) / 1_000;
      onDuration(durationMs);
    }} onTimeUpdate={(event) => onTime(Math.round(event.currentTarget.currentTime * 1_000))} onEnded={(event) => onEnded(Math.round(event.currentTarget.duration * 1_000))} /> : null}
    {!media.url && !error ? <span>Loading video...</span> : null}
    {error ? <div role="alert"><strong>Could not load video</strong><span>{error}</span><button type="button" onClick={() => onEnded(0)}>Skip media</button></div> : null}
  </article>;
}

function ReadyEffect({ onReady }: { onReady: () => void }) {
  useEffect(onReady, [onReady]);
  return null;
}

function useReadyParts(onReady: () => void, count: number): (part: string) => void {
  const onReadyRef = useRef(onReady);
  const ready = useRef(new Set<string>());
  onReadyRef.current = onReady;
  return useCallback((part: string) => {
    ready.current.add(part);
    if (ready.current.size >= count) onReadyRef.current();
  }, [count]);
}

function useStoryAssetUrl(assetId: string | undefined, assetUrls?: Readonly<Record<string, string>>): { url?: string; error?: string } {
  const library = useWorkspaceAssetUrl(undefined, "", 0, assetUrls ? undefined : assetId);
  return assetUrls && assetId ? { url: assetUrls[assetId], ...(assetUrls[assetId] ? {} : { error: "The published asset is missing." }) } : library;
}

function qteKeyLabel(code: string): string {
  if (code === "Space") return "Space";
  if (code.startsWith("Key")) return code.slice(3);
  if (code.startsWith("Digit")) return code.slice(5);
  return code.replace("Arrow", "Arrow ");
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
