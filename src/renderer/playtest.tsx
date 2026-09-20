import { Pause, Play, RotateCcw } from "./icons.js";
import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { StoryChapter, StoryInteractionCommand, StoryNode, StoryOpenUiAction, StoryPlayerConfig, StoryVariable } from "../shared/contracts.js";
import { advanceOpenUi, advanceSceneTime, chooseOption, completeSceneMedia, createStoryCheckpoint, DEFAULT_STORY_PLAYER_CONFIG, isEntryOpenUiNode, matchesStoryCondition, openUiRuntimeContent, openUiSurfaceFiles, resolveInteractionNode, resolvePresentationMedia, resolveStoryAssetId, restartGame, shouldCreateStoryCheckpoint, storyNodePresentation, validatePlayableChapter, type PlayerRuntimeState, type PlayingRuntimeState, type StoryProgressFacts } from "../shared/story.js";
import { getStory, listLibraryAssets } from "./api.js";
import { clearStoryProgress, loadStoryProgress, saveStoryProgress, storyProgressKey, storySignature } from "./story-progress.js";
import { useWorkspaceAssetUrl } from "./use-workspace-asset-url.js";
import { StoryInteractionSurface } from "./story-interaction-surface.js";
import { StoryScreenSurface } from "./story-screen-surface.js";
import { StorySceneSurface, type StoryNodeSurfaceAction } from "./story-scene-surface.js";

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
    if (!storage || !runtime || runtimeNode?.type === "open-ui" || !shouldCreateStoryCheckpoint(checkpointRef.current, runtime)) return;
    const save = createStoryCheckpoint(storage.signature, runtime);
    checkpointRef.current = save.checkpoint;
    setHasCheckpoint(true);
    try {
      saveStoryProgress(window.localStorage, storage.key, save);
      setSaveStatus("saved");
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
    {error ? <div className="story-playtest-state" role="alert">{error}</div> : null}
    {!error && (!chapter || !runtime) ? <div className="story-playtest-state">Loading playtest...</div> : null}
    {chapter && runtime ? (
    <InteractiveDramaPlayer
        key={playbackStep}
        chapter={chapter}
        variables={variables}
    config={config}
        node={node}
        runtime={runtime}
        progressFacts={checkpointRef.current?.progress}
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

export function InteractiveDramaPlayer({ chapter, variables, config, node, runtime, paused, hasCheckpoint, saveStatus, assetUrls, onAdvanceOpenUi, onContinueGame, onPause, onResume, onRestartCheckpoint, onRestartGame, onMenu, onSceneTime, onMediaComplete, onInteraction, onChoice }: {
  chapter: StoryChapter;
  variables: StoryVariable[];
  config: StoryPlayerConfig;
  node?: StoryNode;
  runtime: PlayerRuntimeState;
  progressFacts?: StoryProgressFacts;
  paused: boolean;
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
  const viewportStyle = {
    "--story-viewport-ratio": `${config.viewport.width} / ${config.viewport.height}`,
    "--story-viewport-aspect": config.viewport.width / config.viewport.height,
    "--story-viewport-max-width": `${(config.viewport.width / config.viewport.height) * 100}dvh`,
  } as CSSProperties;
  const handlePlayerUiAction = (action: StoryOpenUiAction) => {
    if (action === "enter-game") (node && isEntryOpenUiNode(chapter, node.id) && hasCheckpoint ? onContinueGame : onAdvanceOpenUi)();
  };
  if (runtime.mode === "menu") return <div className="story-playtest-state" role="alert">The story has not started.</div>;

  return <section className={`story-player story-player-${config.choicePosition}`} aria-label="Story player" style={viewportStyle}>
    <div className="story-player-stage">
      {node?.type === "open-ui" ? <StoryOpenUiPlayer chapter={chapter} node={node} config={config} hasCheckpoint={hasCheckpoint} assetUrls={assetUrls} onAction={handlePlayerUiAction} /> : null}
      {node?.type === "scene" ? <StoryScenePlayer chapter={chapter} variables={variables} node={node} runtime={runtime} viewport={config.viewport} fit={config.videoFit} paused={paused} assetUrls={assetUrls} onTime={onSceneTime} onComplete={onMediaComplete} /> : null}
      {node?.type === "interaction" ? <StoryInteractionPlayer chapter={chapter} node={node} variables={variables} runtime={runtime} viewport={config.viewport} fit={config.videoFit} paused={paused} assetUrls={assetUrls} onComplete={onInteraction} /> : null}
      {node?.type === "choice" ? <StoryChoicePlayer chapter={chapter} node={node} variables={variables} runtime={runtime} viewport={config.viewport} fit={config.videoFit} paused={paused} assetUrls={assetUrls} onSelect={onChoice} /> : null}
      {node?.type === "ending" ? <StoryEnding chapter={chapter} node={node} variables={variables} runtime={runtime} viewport={config.viewport} fit={config.videoFit} assetUrls={assetUrls} onRestart={onRestartGame} onMenu={onMenu} /> : null}
      {!node ? <div className="story-playtest-state" role="alert">The current story node is missing.</div> : null}
      {saveStatus ? <div className={`story-player-save-status${saveStatus === "error" ? " is-error" : ""}`} role={saveStatus === "error" ? "alert" : "status"}>{saveStatus === "error" ? "Progress could not be saved" : "Saved"}</div> : null}
      {node?.type !== "ending" ? <button className="story-player-pause" type="button" title="Pause" aria-label="Pause" onClick={onPause}><Pause size={16} fill="currentColor" /></button> : null}
      {paused ? <PauseMenu canRestartCheckpoint={hasCheckpoint} onResume={onResume} onRestartCheckpoint={onRestartCheckpoint} onRestartGame={onRestartGame} onMenu={onMenu} /> : null}
    </div>
  </section>;
}

function StoryOpenUiPlayer({ chapter, node, config, hasCheckpoint, assetUrls, onAction }: { chapter: StoryChapter; node: Extract<StoryNode, { type: "open-ui" }>; config: StoryPlayerConfig; hasCheckpoint: boolean; assetUrls?: Readonly<Record<string, string>>; onAction: (action: StoryOpenUiAction) => void }) {
  const item = node.data.presentation.media.mode === "own" ? node.data.presentation.media.items[0] : undefined;
  const assetId = item ? resolveStoryAssetId(chapter, item.source) : undefined;
  const media = useStoryAssetUrl(assetId, assetUrls);
  return <div className="story-player-menu-stage">
    {media.url && item?.type === "image" ? <img src={media.url} alt="" /> : null}
    {media.url && item?.type === "video" ? <video className="story-player-menu-video" src={media.url} autoPlay muted loop playsInline /> : null}
    <StoryScreenSurface files={openUiSurfaceFiles(node.data.presentation, Boolean(media.url))} content={openUiRuntimeContent(node.data.content, hasCheckpoint)} mode="runtime" title={node.data.title || "Open UI"} className="story-player-menu-screen" viewport={config.viewport} onAction={onAction} />
  </div>;
}

function StoryInteractionPlayer({ chapter, node, variables, runtime, viewport, fit, paused, assetUrls, onComplete }: {
  chapter: StoryChapter;
  node: Extract<StoryNode, { type: "interaction" }>;
  variables: StoryVariable[];
  runtime: Extract<PlayerRuntimeState, { mode: "playing" }>;
  viewport: StoryPlayerConfig["viewport"];
  fit: StoryPlayerConfig["videoFit"];
  paused: boolean;
  assetUrls?: Readonly<Record<string, string>>;
  onComplete: (result: string, commands: StoryInteractionCommand[]) => void;
}) {
  const [error, setError] = useState<string>();
  const resolved = useRef(false);
  const remaining = useRef(node.data.behavior.type === "qte" || node.data.behavior.type === "hotspot" ? node.data.behavior.durationMs : 0);
  const context = useMemo(() => ({
    variables: Object.fromEntries(variables.flatMap((variable) => [[variable.id, runtime.variables[variable.id]], [variable.name, runtime.variables[variable.id]]])),
  }), [runtime.variables, variables]);
  useEffect(() => {
    if (paused || resolved.current || remaining.current <= 0 || (node.data.behavior.type !== "qte" && node.data.behavior.type !== "hotspot")) return;
    const startedAt = performance.now();
    const timer = window.setTimeout(() => {
      if (resolved.current) return;
      resolved.current = true;
      onComplete("timeout", []);
    }, remaining.current);
    return () => {
      remaining.current = Math.max(0, remaining.current - (performance.now() - startedAt));
      window.clearTimeout(timer);
    };
  }, [node.data.behavior, onComplete, paused]);
  if (paused) return null;
  return <div className="story-player-scene story-player-interaction-node">
    <StoryInteractionBackground chapter={chapter} node={node} runtime={runtime} fit={fit} assetUrls={assetUrls} />
    <StoryInteractionSurface files={storyNodePresentation(node).surface.files} mode="runtime" context={context} viewport={viewport} title={node.data.title || "Interaction"} className="story-player-interaction-surface" onComplete={(result, commands) => { if (resolved.current) return; resolved.current = true; onComplete(result, commands); }} onError={setError} />
    {error ? <div className="story-player-interaction-error" role="alert">Interaction failed: {error}</div> : null}
  </div>;
}

function StoryInteractionBackground({ chapter, node, runtime, fit, assetUrls }: { chapter: StoryChapter; node: Extract<StoryNode, { type: "interaction" }>; runtime: PlayingRuntimeState; fit: StoryPlayerConfig["videoFit"]; assetUrls?: Readonly<Record<string, string>> }) {
  return <StoryPresentationMediaLayer chapter={chapter} runtime={runtime} fit={fit} assetUrls={assetUrls} fallback={node.data.title || "Interaction"} />;
}

function resolvedPresentationMedia(chapter: StoryChapter, runtime: PlayingRuntimeState): { assetId?: string; type: "image" | "video" } | undefined {
  const item = resolvePresentationMedia(chapter, runtime);
  return item ? { assetId: resolveStoryAssetId(chapter, item.source), type: item.type } : undefined;
}

function StoryPresentationMediaLayer({ chapter, runtime, fit, assetUrls, fallback }: { chapter: StoryChapter; runtime: PlayingRuntimeState; fit: StoryPlayerConfig["videoFit"]; assetUrls?: Readonly<Record<string, string>>; fallback?: string }) {
  const resolved = resolvedPresentationMedia(chapter, runtime);
  const media = useStoryAssetUrl(resolved?.assetId, assetUrls);
  return <div className="story-player-video story-player-interaction-background">
    {media.url && resolved?.type === "image" ? <img src={media.url} alt="" style={{ objectFit: fit }} /> : null}
    {media.url && resolved?.type === "video" ? <video src={media.url} muted playsInline style={{ objectFit: fit }} onLoadedMetadata={(event) => { event.currentTarget.currentTime = Math.max(0, event.currentTarget.duration - 0.04); }} /> : null}
    {!media.url && fallback ? <span>{fallback}</span> : null}
  </div>;
}

function PauseMenu({ canRestartCheckpoint, onResume, onRestartCheckpoint, onRestartGame, onMenu }: { canRestartCheckpoint: boolean; onResume: () => void; onRestartCheckpoint: () => void; onRestartGame: () => void; onMenu: () => void }) {
  return <div className="story-player-pause-layer" role="dialog" aria-modal="true" aria-label="Game paused">
    <div>
      <span>Paused</span>
      <button type="button" onClick={onResume}><Play size={15} fill="currentColor" />Resume</button>
      <button type="button" disabled={!canRestartCheckpoint} onClick={onRestartCheckpoint}><RotateCcw size={15} />Restart checkpoint</button>
      <button type="button" onClick={onRestartGame}>Restart game</button>
      <button type="button" onClick={onMenu}>Main menu</button>
    </div>
  </div>;
}

function StoryEnding({ chapter, node, variables, runtime, viewport, fit, assetUrls, onRestart, onMenu }: { chapter: StoryChapter; node: Extract<StoryNode, { type: "ending" }>; variables: StoryVariable[]; runtime: Extract<PlayerRuntimeState, { mode: "playing" }>; viewport: StoryPlayerConfig["viewport"]; fit: StoryPlayerConfig["videoFit"]; assetUrls?: Readonly<Record<string, string>>; onRestart: () => void; onMenu: () => void }) {
  const context = storyPresentationContext(node, variables, runtime);
  return <div className="story-player-scene story-player-presentation-node">
    <StoryPresentationMediaLayer chapter={chapter} runtime={runtime} fit={fit} assetUrls={assetUrls} fallback={node.data.title || "Ending"} />
    <StorySceneSurface files={storyNodePresentation(node).surface.files} context={context} mode="runtime" viewport={viewport} title={`${node.data.title || "Ending"} code`} className="story-player-scene-surface" onAction={(action) => {
      if (action.type === "restart") onRestart();
      if (action.type === "menu") onMenu();
    }} />
  </div>;
}

function StoryChoicePlayer({ chapter, node, variables, runtime, viewport, fit, paused, assetUrls, onSelect }: {
  chapter: StoryChapter;
  node: Extract<StoryNode, { type: "choice" }>;
  variables: StoryVariable[];
  runtime: Extract<PlayerRuntimeState, { mode: "playing" }>;
  viewport: StoryPlayerConfig["viewport"];
  fit: StoryPlayerConfig["videoFit"];
  paused: boolean;
  assetUrls?: Readonly<Record<string, string>>;
  onSelect: (optionId: string) => void;
}) {
  const visibleOptions = node.data.options.filter((option) => matchesStoryCondition(option.condition, runtime.variables));
  const [remainingMs, setRemainingMs] = useState(node.data.timeout?.durationMs ?? 0);
  const remaining = useRef(remainingMs);
  const resolved = useRef(false);

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
  return <div className="story-player-scene story-player-presentation-node">
    <StoryPresentationMediaLayer chapter={chapter} runtime={runtime} fit={fit} assetUrls={assetUrls} fallback={node.data.title || "Choice"} />
    <StorySceneSurface files={storyNodePresentation(node).surface.files} context={context} mode="runtime" viewport={viewport} title={`${node.data.title || "Choice"} code`} className="story-player-scene-surface" onAction={(action) => { if (action.type === "choose") select(action.optionId); }} />
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

function StoryScenePlayer({ chapter, variables, node, runtime, viewport, fit, paused, assetUrls, onTime, onComplete }: {
  chapter: StoryChapter;
  variables: StoryVariable[];
  node: Extract<StoryNode, { type: "scene" }>;
  runtime: Extract<PlayerRuntimeState, { mode: "playing" }>;
  viewport: StoryPlayerConfig["viewport"];
  fit: StoryPlayerConfig["videoFit"];
  paused: boolean;
  assetUrls?: Readonly<Record<string, string>>;
  onTime: (mediaId: string, timeMs: number) => void;
  onComplete: (mediaId: string, durationMs: number) => void;
}) {
  const playback = runtime.scenePlayback;
  const [surfaceError, setSurfaceError] = useState<string>();
  const media = node.data.presentation.media;
  const items = media.mode === "own" ? media.items : [];
  const mediaIndex = items.findIndex((candidate) => candidate.id === playback?.mediaId);
  const item = items[mediaIndex];
  const assetId = item ? resolveStoryAssetId(chapter, item.source) : undefined;
  const asset = useStoryAssetUrl(assetId, assetUrls);
  const duration = useRef(0);
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
        durationMs: duration.current,
        playing: !paused,
      },
      variables: Object.fromEntries(variables.flatMap((variable) => [[variable.id, runtime.variables[variable.id]], [variable.name, runtime.variables[variable.id]]])),
    };
  }, [items.length, mediaIndex, node.data.title, node.id, paused, playback?.mediaId, playback?.timeMs, runtime.variables, variables]);
  if (!item) return <div className="story-player-scene">
    {media.mode === "inherit" ? <StoryPresentationMediaLayer chapter={chapter} runtime={runtime} fit={fit} assetUrls={assetUrls} /> : null}
    <StorySceneSurface key={node.id} files={storyNodePresentation(node).surface.files} context={sceneSurfaceContext} mode="runtime" viewport={viewport} title={`${node.data.title || "Untitled scene"} code`} className="story-player-scene-surface" onError={setSurfaceError} />
    <button className="story-player-scene-continue" type="button" onClick={() => onComplete("scene", 0)}>Continue</button>
  </div>;
  return <div className="story-player-scene">
    {item.type === "video" ? <StoryVideoPlayer key={item.id} assetId={assetId} index={mediaIndex} count={items.length} title={node.data.title} fit={fit} paused={paused} initialTimeMs={playback?.timeMs ?? 0} assetUrls={assetUrls} onTime={(time) => onTime(item.id, time)} onDuration={(durationMs) => { duration.current = durationMs; }} onEnded={(durationMs) => onComplete(item.id, durationMs)} /> : <article className="story-player-video">{asset.url ? <img src={asset.url} alt="" style={{ objectFit: fit }} /> : null}<button className="story-player-scene-continue" type="button" onClick={() => onComplete(item.id, 0)}>Continue</button></article>}
    <StorySceneSurface key={node.id} files={storyNodePresentation(node).surface.files} context={sceneSurfaceContext} mode="runtime" viewport={viewport} title={`${node.data.title || "Untitled scene"} code`} className="story-player-scene-surface" onError={setSurfaceError} />
    {surfaceError ? <div className="story-player-scene-error" role="alert">Scene code failed: {surfaceError}</div> : null}
  </div>;
}

function StoryVideoPlayer({ assetId, index, count, title, fit, paused, initialTimeMs, assetUrls, onTime, onDuration, onEnded }: {
  assetId?: string; index: number; count: number; title: string; fit: StoryPlayerConfig["videoFit"]; paused: boolean; initialTimeMs: number; assetUrls?: Readonly<Record<string, string>>;
  onTime: (timeMs: number) => void; onDuration: (durationMs: number) => void; onEnded: (durationMs: number) => void;
}) {
  const media = useStoryAssetUrl(assetId, assetUrls);
  const video = useRef<HTMLVideoElement>(null);
  const [playbackError, setPlaybackError] = useState(false);
  useEffect(() => { if (paused) video.current?.pause(); else void video.current?.play().catch(() => {}); }, [paused]);
  const error = media.error ?? (playbackError ? "The video could not be played." : undefined);
  return <article className="story-player-video">
    {media.url && !playbackError ? <video ref={video} src={media.url} autoPlay playsInline style={{ objectFit: fit }} onError={() => setPlaybackError(true)} onLoadedMetadata={(event) => {
      const durationMs = Math.round(event.currentTarget.duration * 1_000);
      if (initialTimeMs > 0) event.currentTarget.currentTime = Math.min(initialTimeMs, durationMs) / 1_000;
      onDuration(durationMs);
    }} onTimeUpdate={(event) => onTime(Math.round(event.currentTarget.currentTime * 1_000))} onEnded={(event) => onEnded(Math.round(event.currentTarget.duration * 1_000))} /> : null}
    {!media.url && !error ? <span>Loading video...</span> : null}
    {error ? <div role="alert"><strong>Could not load video</strong><span>{error}</span><button type="button" onClick={() => onEnded(0)}>Skip media</button></div> : null}
    <footer><strong>{title || "Untitled scene"}</strong><span>{index + 1} / {count}</span></footer>
  </article>;
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
