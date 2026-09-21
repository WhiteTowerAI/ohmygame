import { Play, RotateCcw } from "./icons.js";
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties, type ReactNode } from "react";
import type { StoryChapter, StoryInteractionCommand, StoryNode, StoryOpenUiAction, StoryPlayerConfig, StoryVariable } from "../shared/contracts.js";
import { advanceOpenUi, advanceSceneTime, chooseOption, completeSceneMedia, createStoryCheckpoint, DEFAULT_STORY_PLAYER_CONFIG, isEntryOpenUiNode, matchesStoryCondition, openUiRuntimeContent, previewStoryNode, resolveInteractionNode, resolveStoryAssetId, restartGame, sceneStillDurationMs, shouldCreateStoryCheckpoint, shouldPersistStoryCheckpoint, storyNodePresentation, validatePlayableChapter, type PlayerRuntimeState, type PlayingRuntimeState } from "../shared/story.js";
import { getStory, listLibraryAssets } from "./api.js";
import { clearStoryProgress, loadStoryProgress, saveStoryProgress, storyProgressKey, storySignature } from "./story-progress.js";
import { useWorkspaceAssetUrl } from "./use-workspace-asset-url.js";
import { StoryInteractionSurface } from "./story-interaction-surface.js";
import { StoryScreenSurface } from "./story-screen-surface.js";
import { StorySceneSurface, type StoryNodeSurfaceAction } from "./story-scene-surface.js";
import { StoryPlayerControls, StoryPlayerPauseLayer } from "./story-player-controls.js";
import { WindowDragRegion } from "./window-drag-region.js";
import { SceneTimerClock } from "./scene-timer-clock.js";

export function PlaytestPage({ projectId, chapterId }: { projectId: string; chapterId: string }) {
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
      checkpointRef.current = saved;
      setChapter(selected);
      setVariables(definitions);
      setConfig(story.player);
      setHasCheckpoint(Boolean(saved));
      setRuntime(restartGame(selected, definitions));
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
    const save = createStoryCheckpoint(storage.signature, runtime);
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
    if (checkpointRef.current && !window.confirm("Start a new game? Your current progress will be replaced.")) return;
    const storage = progress.current;
    if (storage) clearStoryProgress(window.localStorage, storage.key);
    checkpointRef.current = undefined;
    setHasCheckpoint(false);
    setRuntime(restartGame(chapter, variables));
    setPaused(false);
    setPlaybackStep((step) => step + 1);
  }, [chapter, variables]);

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
    setRuntime(restartGame(chapter, variables));
    setPaused(false);
    setPlaybackStep((step) => step + 1);
  }, [chapter, variables]);

  const enterOpenUi = useCallback(() => {
    if (!chapter) return;
    setRuntime((current) => current ? advanceOpenUi(chapter, current) : current);
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

export function StoryPlayerPreviewSession({ chapter, variables, config, initialNodeId, onChoice }: {
  chapter: StoryChapter;
  variables: StoryVariable[];
  config: StoryPlayerConfig;
  initialNodeId: string;
  onChoice?: (optionId: string) => void;
}) {
  const initial = useMemo(() => previewStoryNode(chapter, variables, initialNodeId), [chapter, initialNodeId, variables]);
  const [runtime, setRuntime] = useState<PlayerRuntimeState>(initial);
  const runtimeRef = useRef<PlayerRuntimeState>(initial);
  const startsAtOpenUi = chapter.nodes.find((candidate) => candidate.id === initialNodeId)?.type === "open-ui";
  const [checkpoint, setCheckpoint] = useState<PlayingRuntimeState | undefined>(startsAtOpenUi ? undefined : initial);
  const [paused, setPaused] = useState(false);
  const [playbackStep, setPlaybackStep] = useState(0);
  const [error, setError] = useState<string>();

  useEffect(() => {
    runtimeRef.current = initial;
    setRuntime(initial);
    setCheckpoint(startsAtOpenUi ? undefined : initial);
    setPaused(false);
    setPlaybackStep((step) => step + 1);
    setError(undefined);
  }, [initial, startsAtOpenUi]);

  useEffect(() => {
    const runtimeNode = chapter.nodes.find((candidate) => candidate.id === runtime.nodeId);
    if (runtime.mode === "playing" && runtimeNode?.type !== "open-ui" && shouldCreateStoryCheckpoint(checkpoint, runtime)) setCheckpoint(runtime);
  }, [chapter.nodes, checkpoint, runtime]);

  const transition = useCallback((next: (current: PlayerRuntimeState) => PlayerRuntimeState, advanceFrame = true) => {
    try {
      const nextRuntime = next(runtimeRef.current);
      runtimeRef.current = nextRuntime;
      setRuntime(nextRuntime);
      if (advanceFrame) setPlaybackStep((step) => step + 1);
      setError(undefined);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, []);
  const restart = useCallback((clearCheckpoint: boolean) => {
    try {
      const nextRuntime = restartGame(chapter, variables);
      runtimeRef.current = nextRuntime;
      setRuntime(nextRuntime);
      if (clearCheckpoint) setCheckpoint(undefined);
      setPaused(false);
      setPlaybackStep((step) => step + 1);
      setError(undefined);
    } catch (cause) {
      setError(errorMessage(cause));
    }
  }, [chapter, variables]);
  const restartCheckpoint = useCallback(() => {
    if (!checkpoint) return;
    runtimeRef.current = checkpoint;
    setRuntime(checkpoint);
    setPaused(false);
    setPlaybackStep((step) => step + 1);
    setError(undefined);
  }, [checkpoint]);
  const node = chapter.nodes.find((candidate) => candidate.id === runtime.nodeId);

  return <>
    <InteractiveDramaPlayer
      chapter={chapter}
      variables={variables}
      config={config}
      node={node}
      runtime={runtime}
      playbackKey={playbackStep}
      paused={paused}
      hasCheckpoint={Boolean(checkpoint)}
      onAdvanceOpenUi={() => transition((current) => advanceOpenUi(chapter, current))}
      onContinueGame={restartCheckpoint}
      onPause={() => setPaused(true)}
      onResume={() => setPaused(false)}
      onRestartCheckpoint={restartCheckpoint}
      onRestartGame={() => restart(true)}
      onMenu={() => restart(false)}
      onSceneTime={(mediaId, timeMs) => transition((current) => advanceSceneTime(chapter, current, mediaId, timeMs), false)}
      onMediaComplete={(mediaId, durationMs) => transition((current) => completeSceneMedia(chapter, current, mediaId, durationMs))}
      onInteraction={(result, commands) => transition((current) => resolveInteractionNode(chapter, current, result, commands, variables))}
      onChoice={(optionId) => {
        onChoice?.(optionId);
        transition((current) => chooseOption(chapter, current, optionId));
      }}
    />
    {error ? <div className="story-player-preview-error" role="alert">{error}</div> : null}
  </>;
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

export function InteractiveDramaPlayer({ chapter, variables, config, node, runtime, playbackKey = 0, paused, playbackPaused = false, hasCheckpoint, saveStatus, assetUrls, onAdvanceOpenUi, onContinueGame, onPause, onResume, onRestartCheckpoint, onRestartGame, onMenu, onSceneTime, onMediaComplete, onInteraction, onChoice }: {
  chapter: StoryChapter;
  variables: StoryVariable[];
  config: StoryPlayerConfig;
  node?: StoryNode;
  runtime: PlayerRuntimeState;
  playbackKey?: number;
  paused: boolean;
  playbackPaused?: boolean;
  hasCheckpoint: boolean;
  saveStatus?: "saved" | "error";
  assetUrls?: Readonly<Record<string, string>>;
  onAdvanceOpenUi: () => void;
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
}) {
  if (runtime.mode === "menu") return <div className="story-playtest-state" role="alert">The story has not started.</div>;
  const frameKey = `${node?.id ?? "missing"}:${runtime.scenePlayback?.mediaId ?? ""}:${playbackKey}`;
  const frame = { chapter, variables, config, node, runtime, hasCheckpoint, assetUrls } satisfies StoryPlayerFrameData;
  const canPause = node?.type === "scene" || node?.type === "interaction" || node?.type === "choice";

  return <section className={`story-player story-player-${config.choicePosition}`} aria-label="Story player">
    <StoryPlayerViewport viewport={config.viewport}>
      <StoryFrameTransition frameKey={frameKey} frame={frame} paused={paused || playbackPaused} onAdvanceOpenUi={onAdvanceOpenUi} onContinueGame={onContinueGame} onRestartGame={onRestartGame} onMenu={onMenu} onSceneTime={onSceneTime} onMediaComplete={onMediaComplete} onInteraction={onInteraction} onChoice={onChoice} />
      {saveStatus ? <div className={`story-player-save-status${saveStatus === "error" ? " is-error" : ""}`} role={saveStatus === "error" ? "alert" : "status"}>{saveStatus === "error" ? "Progress could not be saved" : "Saved"}</div> : null}
      <StoryPlayerControls pause={config.controls.pause && canPause} mode="runtime" onPause={onPause} />
      {paused ? <PauseMenu canRestartCheckpoint={hasCheckpoint} onResume={onResume} onRestartCheckpoint={onRestartCheckpoint} onRestartGame={onRestartGame} onMenu={onMenu} /> : null}
    </StoryPlayerViewport>
  </section>;
}

function StoryPlayerViewport({ viewport, children }: { viewport: StoryPlayerConfig["viewport"]; children: ReactNode }) {
  const container = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const update = () => setScale(Math.min(element.clientWidth / viewport.width, element.clientHeight / viewport.height));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [viewport.height, viewport.width]);

  return <div ref={container} className="story-player-viewport">
    <div className="story-player-stage" style={{ width: viewport.width, height: viewport.height, transform: `translate(-50%, -50%) scale(${scale})` }}>
      {children}
    </div>
  </div>;
}

interface StoryPlayerFrameData {
  chapter: StoryChapter;
  variables: StoryVariable[];
  config: StoryPlayerConfig;
  node?: StoryNode;
  runtime: PlayingRuntimeState;
  hasCheckpoint: boolean;
  assetUrls?: Readonly<Record<string, string>>;
}

interface PreviousStoryPlayerFrame {
  key: string;
  frame: StoryPlayerFrameData;
}

function StoryFrameTransition({ frameKey, frame, paused, onAdvanceOpenUi, onContinueGame, onRestartGame, onMenu, onSceneTime, onMediaComplete, onInteraction, onChoice }: {
  frameKey: string;
  frame: StoryPlayerFrameData;
  paused: boolean;
  onAdvanceOpenUi: () => void;
  onContinueGame: () => void;
  onRestartGame: () => void;
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
    {transition.previous ? <div key={transition.previous.key} className="story-player-frame is-previous" aria-hidden="true" inert><StoryPlayerFrame frame={transition.previous.frame} active={false} paused onReady={NOOP} onAdvanceOpenUi={NOOP} onContinueGame={NOOP} onRestartGame={NOOP} onMenu={NOOP} onSceneTime={NOOP_SCENE_TIME} onMediaComplete={NOOP_MEDIA_COMPLETE} onInteraction={NOOP_INTERACTION} onChoice={NOOP_CHOICE} /></div> : null}
    <div key={frameKey} className={`story-player-frame${transition.ready ? " is-ready" : ""}`} aria-hidden={!transition.ready} inert={!transition.ready}>
      <StoryPlayerFrame frame={frame} active={transition.ready} paused={paused} onReady={showFrame} onAdvanceOpenUi={onAdvanceOpenUi} onContinueGame={onContinueGame} onRestartGame={onRestartGame} onMenu={onMenu} onSceneTime={onSceneTime} onMediaComplete={onMediaComplete} onInteraction={onInteraction} onChoice={onChoice} />
    </div>
  </>;
}

function StoryPlayerFrame({ frame, active, paused, onReady, onAdvanceOpenUi, onContinueGame, onRestartGame, onMenu, onSceneTime, onMediaComplete, onInteraction, onChoice }: {
  frame: StoryPlayerFrameData;
  active: boolean;
  paused: boolean;
  onReady: () => void;
  onAdvanceOpenUi: () => void;
  onContinueGame: () => void;
  onRestartGame: () => void;
  onMenu: () => void;
  onSceneTime: (mediaId: string, timeMs: number) => void;
  onMediaComplete: (mediaId: string, durationMs: number) => void;
  onInteraction: (result: string, commands: StoryInteractionCommand[]) => void;
  onChoice: (optionId: string) => void;
}) {
  const { chapter, variables, config, node, runtime, hasCheckpoint, assetUrls } = frame;
  const inactive = paused || !active;
  const activeSceneTime = active ? onSceneTime : NOOP_SCENE_TIME;
  const activeMediaComplete = active ? onMediaComplete : NOOP_MEDIA_COMPLETE;
  const activeInteraction = active ? onInteraction : NOOP_INTERACTION;
  const activeChoice = active ? onChoice : NOOP_CHOICE;
  const handlePlayerUiAction = (action: StoryOpenUiAction) => {
    if (active && action === "enter-game") (node && isEntryOpenUiNode(chapter, node.id) && hasCheckpoint ? onContinueGame : onAdvanceOpenUi)();
  };
  if (node?.type === "open-ui") return <StoryOpenUiPlayer chapter={chapter} node={node} hasCheckpoint={hasCheckpoint} paused={inactive} assetUrls={assetUrls} onReady={onReady} onAction={handlePlayerUiAction} />;
  if (node?.type === "scene") return <StoryScenePlayer chapter={chapter} variables={variables} node={node} runtime={runtime} fit={config.videoFit} paused={inactive} assetUrls={assetUrls} onReady={onReady} onTime={activeSceneTime} onComplete={activeMediaComplete} />;
  if (node?.type === "interaction") return <StoryInteractionPlayer chapter={chapter} node={node} variables={variables} runtime={runtime} fit={config.videoFit} active={active} paused={paused} assetUrls={assetUrls} onReady={onReady} onComplete={activeInteraction} />;
  if (node?.type === "choice") return <StoryChoicePlayer chapter={chapter} node={node} variables={variables} runtime={runtime} fit={config.videoFit} paused={inactive} assetUrls={assetUrls} onReady={onReady} onSelect={activeChoice} />;
  if (node?.type === "ending") return <StoryEnding chapter={chapter} node={node} variables={variables} runtime={runtime} fit={config.videoFit} assetUrls={assetUrls} onReady={onReady} onRestart={active ? onRestartGame : NOOP} onMenu={active ? onMenu : NOOP} />;
  return <><ReadyEffect onReady={onReady} /><div className="story-playtest-state" role="alert">The current story node is missing.</div></>;
}

const NOOP = () => {};
const NOOP_SCENE_TIME = (_mediaId: string, _timeMs: number) => {};
const NOOP_MEDIA_COMPLETE = (_mediaId: string, _durationMs: number) => {};
const NOOP_INTERACTION = (_result: string, _commands: StoryInteractionCommand[]) => {};
const NOOP_CHOICE = (_optionId: string) => {};

function StoryOpenUiPlayer({ chapter, node, hasCheckpoint, paused, assetUrls, onReady, onAction }: { chapter: StoryChapter; node: Extract<StoryNode, { type: "open-ui" }>; hasCheckpoint: boolean; paused: boolean; assetUrls?: Readonly<Record<string, string>>; onReady: () => void; onAction: (action: StoryOpenUiAction) => void }) {
  const item = node.data.presentation.media.items[0];
  const assetId = item ? resolveStoryAssetId(chapter, item.source) : undefined;
  const media = useStoryAssetUrl(assetId, assetUrls);
  const ready = useReadyParts(onReady, 2);
  useEffect(() => { if (!item || !assetId || media.error) ready("media"); }, [assetId, item, media.error, ready]);
  return <div className="story-player-menu-stage">
    {media.url && item?.type === "image" ? <img src={media.url} alt="" onLoad={() => ready("media")} onError={() => ready("media")} /> : null}
    {media.url && item?.type === "video" ? <video className="story-player-menu-video" src={media.url} autoPlay={!paused} muted loop playsInline onLoadedData={() => ready("media")} onError={() => ready("media")} /> : null}
    <StoryScreenSurface files={node.data.presentation.surface.files} content={openUiRuntimeContent(node.data.content, hasCheckpoint)} mode="runtime" title={node.data.title || "Open UI"} className="story-player-menu-screen" onReady={() => ready("surface")} onAction={onAction} />
  </div>;
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
  onComplete: (result: string, commands: StoryInteractionCommand[]) => void;
}) {
  const [error, setError] = useState<string>();
  const ready = useReadyParts(onReady, 2);
  const resolved = useRef(false);
  const pending = useRef<{ result: string; commands: StoryInteractionCommand[] } | undefined>(undefined);
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
    onComplete(completion.result, completion.commands);
  }, [active, onComplete, paused]);
  return <div className="story-player-node story-player-interaction-node">
    <StoryPresentationMediaLayer chapter={chapter} node={node} fit={fit} assetUrls={assetUrls} onReady={() => ready("media")} />
    <StoryInteractionSurface files={storyNodePresentation(node).surface.files} outcomes={node.data.outcomes} timeout={node.data.timeout} mode="runtime" context={context} active={active} paused={paused} title={node.data.title || "Interaction"} className="story-player-interaction-surface" onReady={() => ready("surface")} onComplete={(result, commands) => { if (resolved.current) return; if (!activeRef.current || pausedRef.current) { pending.current = { result, commands }; return; } resolved.current = true; onComplete(result, commands); }} onError={setError} />
    {error ? <div className="story-player-interaction-error" role="alert">Interaction failed: {error}</div> : null}
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
  return <div className="story-player-node story-player-presentation-node">
    <StoryPresentationMediaLayer chapter={chapter} node={node} fit={fit} assetUrls={assetUrls} onReady={() => ready("media")} />
    <StorySceneSurface files={storyNodePresentation(node).surface.files} context={context} mode="runtime" title={`${node.data.title || "Ending"} code`} className="story-player-scene-surface" onReady={() => ready("surface")} onAction={(action) => {
      if (action.type === "restart") onRestart();
      if (action.type === "menu") onMenu();
    }} />
  </div>;
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
  onSelect: (optionId: string) => void;
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
      const selected = visibleOptions.find((option) => option.id === timeout.defaultOptionId) ?? visibleOptions[0];
      if (selected) onSelect(selected.id);
    }, remaining.current);
    return () => { tick(); window.clearInterval(interval); window.clearTimeout(timer); };
  }, [node.data.timeout, onSelect, paused, visibleOptions.length]);

  function select(optionId: string): void {
    if (resolved.current || paused) return;
    resolved.current = true;
    onSelect(optionId);
  }

  const context = storyPresentationContext(node, variables, runtime, { options: visibleOptions.map(({ id, label }) => ({ id, label })), remainingMs: node.data.timeout ? remainingMs : undefined, durationMs: node.data.timeout?.durationMs });
  return <div className="story-player-node story-player-presentation-node">
    <StoryPresentationMediaLayer chapter={chapter} node={node} fit={fit} assetUrls={assetUrls} onReady={() => ready("media")} />
    <StorySceneSurface files={storyNodePresentation(node).surface.files} context={context} mode="runtime" title={`${node.data.title || "Choice"} code`} className="story-player-scene-surface" onReady={() => ready("surface")} onAction={(action) => { if (action.type === "choose") select(action.optionId); }} />
  </div>;
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
  if (!item) return <div className="story-player-node">
    <ReadyEffect onReady={() => ready("media")} />
    {playback ? <StorySceneTimer key={playback.mediaId} mediaId={playback.mediaId} initialTimeMs={playback.timeMs} durationMs={durationMs} paused={paused} onTime={onTime} onComplete={onComplete} /> : null}
    <StorySceneSurface key={node.id} files={storyNodePresentation(node).surface.files} context={sceneSurfaceContext} mode="runtime" title={`${node.data.title || "Untitled scene"} code`} className="story-player-scene-surface" onReady={() => ready("surface")} onError={setSurfaceError} />
  </div>;
  return <div className="story-player-node">
    {item.type === "video" ? <StoryVideoPlayer key={item.id} assetId={assetId} fit={fit} paused={paused} initialTimeMs={playback?.timeMs ?? 0} assetUrls={assetUrls} onReady={() => ready("media")} onTime={(time) => onTime(item.id, time)} onDuration={setVideoDurationMs} onEnded={(duration) => onComplete(item.id, duration)} /> : <article className="story-player-video">{asset.url ? <img src={asset.url} alt="" style={{ objectFit: fit }} onLoad={() => ready("media")} onError={() => ready("media")} /> : null}{playback ? <StorySceneTimer key={playback.mediaId} mediaId={playback.mediaId} initialTimeMs={playback.timeMs} durationMs={durationMs} paused={paused} onTime={onTime} onComplete={onComplete} /> : null}</article>}
    <StorySceneSurface key={node.id} files={storyNodePresentation(node).surface.files} context={sceneSurfaceContext} mode="runtime" title={`${node.data.title || "Untitled scene"} code`} className="story-player-scene-surface" onReady={() => ready("surface")} onError={setSurfaceError} />
    {surfaceError ? <div className="story-player-scene-error" role="alert">Scene code failed: {surfaceError}</div> : null}
  </div>;
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
