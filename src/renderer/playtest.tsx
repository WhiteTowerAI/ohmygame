import { Pause, Play, RotateCcw } from "./icons.js";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { StoryChapter, StoryHotspotRegion, StoryNode, StoryOverlay, StoryOverlayComponent, StoryPlayerConfig, StorySceneEvent, StoryVariable, StoryVariableValue } from "../shared/contracts.js";
import { advanceSceneTime, chooseOption, completeSceneClip, continueSceneEvent, createPlayerState, createStoryCheckpoint, DEFAULT_STORY_PLAYER_CONFIG, matchesStoryCondition, resolveSceneInteraction, resolveStoryVideoClipAssetId, restartGame, shouldCreateStoryCheckpoint, validatePlayableChapter, type PlayerRuntimeState, type PlayingRuntimeState } from "../shared/story.js";
import { getStory, listLibraryAssets } from "./api.js";
import { clearStoryProgress, loadStoryProgress, saveStoryProgress, storyProgressKey, storySignature } from "./story-progress.js";
import { useWorkspaceAssetUrl } from "./use-workspace-asset-url.js";

export function PlaytestPage({ projectId, chapterId }: { projectId: string; chapterId: string }) {
  const [chapter, setChapter] = useState<StoryChapter>();
  const [variables, setVariables] = useState<StoryVariable[]>([]);
  const [config, setConfig] = useState<StoryPlayerConfig>(DEFAULT_STORY_PLAYER_CONFIG);
  const [overlays, setOverlays] = useState<StoryOverlay[]>([]);
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
      const selected = story.chapters.find((candidate) => candidate.id === chapterId);
      if (!selected) throw new Error("Chapter not found");
      const issue = validatePlayableChapter(selected, {
        availableAssetIds: new Set(assets.filter((asset) => asset.mediaType === "video").map((asset) => asset.id)),
        assetDurationsMs: new Map(assets.flatMap((asset) => asset.mediaType === "video" && asset.duration !== undefined ? [[asset.id, asset.duration * 1_000] as const] : [])),
      });
      if (issue) throw new Error(issue.message);
      if (story.player?.backgroundAssetId && !assets.some((asset) => asset.id === story.player?.backgroundAssetId && asset.mediaType === "image")) {
        throw new Error("The Player background is missing from Library or is not an image.");
      }
      const missingOverlayImage = story.overlays?.flatMap((overlay) => overlay.components).find((component) => component.type === "image" && !assets.some((asset) => asset.id === component.assetId && asset.mediaType === "image"));
      if (missingOverlayImage) throw new Error("An Overlay image is missing from Library or is not an image.");
      const definitions = story.variables ?? [];
      const storyHash = await storySignature(story);
      if (disposed) return;
      const key = storyProgressKey(`project:${projectId}`, selected.id);
      const saved = loadStoryProgress(window.localStorage, key, storyHash, selected, definitions, story.overlays ?? []);
      progress.current = { key, signature: storyHash };
      checkpointRef.current = saved;
      setChapter(selected);
      setVariables(definitions);
      setConfig(story.player ?? { ...DEFAULT_STORY_PLAYER_CONFIG, title: selected.title });
      setOverlays(story.overlays ?? []);
      setHasCheckpoint(Boolean(saved));
      setRuntime(createPlayerState(selected.id, definitions));
      document.title = `${story.player?.title || selected.title} - Playtest`;
    }).catch((cause) => {
      if (!disposed) setError(errorMessage(cause));
    });
    return () => { disposed = true; };
  }, [chapterId, projectId]);

  useEffect(() => {
    const storage = progress.current;
    if (!storage || !runtime || !shouldCreateStoryCheckpoint(checkpointRef.current, runtime)) return;
    const save = createStoryCheckpoint(storage.signature, runtime);
    checkpointRef.current = save.checkpoint;
    setHasCheckpoint(true);
    try {
      saveStoryProgress(window.localStorage, storage.key, save);
      setSaveStatus("saved");
    } catch {
      setSaveStatus("error");
    }
  }, [runtime]);

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
    setRuntime(createPlayerState(chapter.id, variables));
    setPaused(false);
    setPlaybackStep((step) => step + 1);
  }, [chapter, variables]);

  const updateSceneTime = useCallback((clipId: string, timeMs: number) => {
    if (!chapter) return;
    setRuntime((current) => current ? advanceSceneTime(chapter, current, clipId, timeMs) : current);
  }, [chapter]);

  const completeCurrentClip = useCallback((clipId: string, durationMs: number) => {
    if (!chapter) return;
    setRuntime((current) => current ? completeSceneClip(chapter, current, clipId, durationMs) : current);
  }, [chapter]);

  const continueCurrentScene = useCallback((clipEnded: boolean, durationMs: number) => {
    if (!chapter) return;
    setRuntime((current) => {
      if (!current || current.mode !== "playing") return current;
      const resolved = continueSceneEvent(chapter, current);
      return clipEnded && resolved.scenePlayback ? completeSceneClip(chapter, resolved, resolved.scenePlayback.clipId, durationMs) : resolved;
    });
  }, [chapter]);

  const resolveCurrentInteraction = useCallback((eventId: string, result: "success" | "timeout", clipEnded: boolean, durationMs: number) => {
    if (!chapter) return;
    setRuntime((current) => {
      if (!current || current.mode !== "playing") return current;
      const nodeId = current.nodeId;
      const clipId = current.scenePlayback?.clipId;
      const resolved = resolveSceneInteraction(chapter, current, eventId, result);
      return clipEnded && clipId && resolved.nodeId === nodeId && resolved.scenePlayback?.clipId === clipId
        ? completeSceneClip(chapter, resolved, clipId, durationMs)
        : resolved;
    });
  }, [chapter]);

  const selectChoice = useCallback((optionId: string) => {
    if (!chapter) return;
    setRuntime((current) => current ? chooseOption(chapter, current, optionId) : current);
    setPlaybackStep((step) => step + 1);
  }, [chapter]);

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
        config={config}
        overlays={overlays}
        node={node}
        runtime={runtime}
        paused={paused}
        hasCheckpoint={hasCheckpoint}
        saveStatus={saveStatus}
        onStart={startNewGame}
        onContinueGame={continueGame}
        onPause={() => setPaused(true)}
        onResume={() => setPaused(false)}
        onRestartCheckpoint={restartCheckpoint}
        onRestartGame={startNewGame}
        onMenu={returnToMenu}
        onSceneTime={updateSceneTime}
        onClipComplete={completeCurrentClip}
        onContinue={continueCurrentScene}
        onInteraction={resolveCurrentInteraction}
        onChoice={selectChoice}
      />
    ) : null}
  </main>;
}

export function InteractiveDramaPlayer({ chapter, config, overlays, node, runtime, paused, hasCheckpoint, saveStatus, assetUrls, onStart, onContinueGame, onPause, onResume, onRestartCheckpoint, onRestartGame, onMenu, onSceneTime, onClipComplete, onContinue, onInteraction, onChoice }: {
  chapter: StoryChapter;
  config: StoryPlayerConfig;
  overlays: StoryOverlay[];
  node?: StoryNode;
  runtime: PlayerRuntimeState;
  paused: boolean;
  hasCheckpoint: boolean;
  saveStatus?: "saved" | "error";
  assetUrls?: Readonly<Record<string, string>>;
  onStart: () => void;
  onContinueGame: () => void;
  onPause: () => void;
  onResume: () => void;
  onRestartCheckpoint: () => void;
  onRestartGame: () => void;
  onMenu: () => void;
  onSceneTime: (clipId: string, timeMs: number) => void;
  onClipComplete: (clipId: string, durationMs: number) => void;
  onContinue: (clipEnded: boolean, durationMs: number) => void;
  onInteraction: (eventId: string, result: "success" | "timeout", clipEnded: boolean, durationMs: number) => void;
  onChoice: (optionId: string) => void;
}) {
  const background = useStoryAssetUrl(config.backgroundAssetId, assetUrls);
  const backgroundStyle = background.url ? { backgroundImage: `linear-gradient(rgb(0 0 0 / 38%), rgb(0 0 0 / 62%)), url("${background.url}")` } : undefined;
  if (runtime.mode === "menu") return (
    <section className="story-player story-player-menu" aria-label="Game menu" style={backgroundStyle}>
      <div className="story-player-menu-content">
        <span>Interactive Drama</span>
        <h1>{config.title || chapter.title}</h1>
        <div className="story-player-menu-actions">
          {hasCheckpoint ? <button type="button" onClick={onContinueGame}><Play size={16} fill="currentColor" />Continue</button> : null}
          <button className={hasCheckpoint ? "is-secondary" : undefined} type="button" onClick={onStart}>{hasCheckpoint ? <RotateCcw size={15} /> : <Play size={16} fill="currentColor" />}{hasCheckpoint ? "New game" : "Start game"}</button>
        </div>
      </div>
    </section>
  );

  return <section className={`story-player story-player-${config.choicePosition}`} aria-label="Story player">
    <div className="story-player-stage">
      {node?.type === "scene" ? <StoryScenePlayer chapter={chapter} node={node} runtime={runtime} fit={config.videoFit} paused={paused} assetUrls={assetUrls} onTime={onSceneTime} onComplete={onClipComplete} onContinue={onContinue} onInteraction={onInteraction} /> : null}
      {node?.type === "choice" ? <StoryChoicePlayer node={node} variables={runtime.variables} paused={paused} onSelect={onChoice} /> : null}
      {node?.type !== "ending" ? <StoryOverlays overlays={overlays} visibleIds={runtime.visibleOverlayIds} variables={runtime.variables} assetUrls={assetUrls} /> : null}
      {node?.type === "ending" ? <StoryEnding node={node} onRestart={onRestartGame} onMenu={onMenu} /> : null}
      {!node ? <div className="story-playtest-state" role="alert">The current story node is missing.</div> : null}
      {saveStatus ? <div className={`story-player-save-status${saveStatus === "error" ? " is-error" : ""}`} role={saveStatus === "error" ? "alert" : "status"}>{saveStatus === "error" ? "Progress could not be saved" : "Saved"}</div> : null}
      {node?.type !== "ending" ? <button className="story-player-pause" type="button" title="Pause" aria-label="Pause" onClick={onPause}><Pause size={16} fill="currentColor" /></button> : null}
      {paused ? <PauseMenu canRestartCheckpoint={hasCheckpoint} onResume={onResume} onRestartCheckpoint={onRestartCheckpoint} onRestartGame={onRestartGame} onMenu={onMenu} /> : null}
    </div>
  </section>;
}

function StoryOverlays({ overlays, visibleIds, variables, assetUrls }: { overlays: StoryOverlay[]; visibleIds: readonly string[]; variables: Readonly<Record<string, StoryVariableValue>>; assetUrls?: Readonly<Record<string, string>> }) {
  const visible = new Set(visibleIds);
  const active = overlays.filter((overlay) => visible.has(overlay.id) && matchesStoryCondition(overlay.condition, variables));
  const placements = ["top-left", "top-center", "top-right", "bottom-left", "bottom-center", "bottom-right"] as const;
  return <div className="story-player-overlays" aria-live="polite">
    {placements.map((placement) => {
      const placed = active.filter((overlay) => overlay.placement === placement);
      return placed.length ? <div className={`story-player-overlay-stack story-player-overlay-${placement}`} key={placement}>{placed.map((overlay) => (
        <section className="story-player-overlay" key={overlay.id} aria-label={overlay.name || "Game information"}>
          {overlay.components.map((component) => <StoryOverlayItem key={component.id} component={component} variables={variables} assetUrls={assetUrls} />)}
        </section>
      ))}</div> : null;
    })}
  </div>;
}

function StoryOverlayItem({ component, variables, assetUrls }: { component: StoryOverlayComponent; variables: Readonly<Record<string, StoryVariableValue>>; assetUrls?: Readonly<Record<string, string>> }) {
  if (component.type === "text") return <p>{component.text}</p>;
  if (component.type === "image") return <StoryOverlayImage component={component} assetUrls={assetUrls} />;
  const value = variables[component.variableId];
  if (component.type === "value") return <div className="story-player-overlay-value"><span>{component.label}</span><strong>{String(value ?? "")}</strong></div>;
  const numericValue = typeof value === "number" ? value : component.min;
  const progress = Math.max(0, Math.min(1, (numericValue - component.min) / (component.max - component.min)));
  const meterValue = Math.max(component.min, Math.min(component.max, numericValue));
  return <div className="story-player-overlay-meter">
    <div><span>{component.label}</span><strong>{numericValue}</strong></div>
    <div role="meter" aria-label={component.label || "Value"} aria-valuemin={component.min} aria-valuemax={component.max} aria-valuenow={meterValue}><span style={{ transform: `scaleX(${progress})` }} /></div>
  </div>;
}

function StoryOverlayImage({ component, assetUrls }: { component: Extract<StoryOverlayComponent, { type: "image" }>; assetUrls?: Readonly<Record<string, string>> }) {
  const image = useStoryAssetUrl(component.assetId, assetUrls);
  return image.url ? <img src={image.url} alt={component.alt} /> : null;
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

function StoryEnding({ node, onRestart, onMenu }: { node: Extract<StoryNode, { type: "ending" }>; onRestart: () => void; onMenu: () => void }) {
  return <article className="story-player-content story-player-ending">
    <span>Ending</span>
    <h2>{node.data.title || "Untitled ending"}</h2>
    {node.data.description ? <p>{node.data.description}</p> : null}
    <div className="story-player-ending-actions">
      <button type="button" onClick={onRestart}><RotateCcw size={14} />Play again</button>
      <button type="button" onClick={onMenu}>Main menu</button>
    </div>
  </article>;
}

function StoryChoicePlayer({ node, variables, paused, onSelect }: {
  node: Extract<StoryNode, { type: "choice" }>;
  variables: Readonly<Record<string, StoryVariableValue>>;
  paused: boolean;
  onSelect: (optionId: string) => void;
}) {
  const visibleOptions = node.data.options.filter((option) => matchesStoryCondition(option.condition, variables));
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

  return <article className="story-player-content story-player-choice">
    <span>Choice</span>
    <h2>{node.data.title || "Make a choice"}</h2>
    {node.data.timeout && visibleOptions.length ? <div className="story-choice-countdown" role="timer" aria-label="Time remaining">
      <span className="story-choice-countdown-value">{Math.max(0, Math.ceil(remainingMs / 1_000))}s</span>
      <span className="story-choice-countdown-bar" aria-hidden="true" style={{ transform: `scaleX(${Math.max(0, remainingMs / node.data.timeout.durationMs)})` }} />
    </div> : null}
    <div className="story-player-choice-options">
      {visibleOptions.map((option, index) => <button type="button" key={option.id} onClick={() => select(option.id)}><span>{index + 1}</span>{option.label || `Option ${index + 1}`}</button>)}
      {!visibleOptions.length ? <p>No choices are available for the current story state.</p> : null}
    </div>
  </article>;
}

function StoryScenePlayer({ chapter, node, runtime, fit, paused, assetUrls, onTime, onComplete, onContinue, onInteraction }: {
  chapter: StoryChapter;
  node: Extract<StoryNode, { type: "scene" }>;
  runtime: Extract<PlayerRuntimeState, { mode: "playing" }>;
  fit: StoryPlayerConfig["videoFit"];
  paused: boolean;
  assetUrls?: Readonly<Record<string, string>>;
  onTime: (clipId: string, timeMs: number) => void;
  onComplete: (clipId: string, durationMs: number) => void;
  onContinue: (clipEnded: boolean, durationMs: number) => void;
  onInteraction: (eventId: string, result: "success" | "timeout", clipEnded: boolean, durationMs: number) => void;
}) {
  const playback = runtime.scenePlayback;
  const clipIndex = node.data.clips.findIndex((candidate) => candidate.id === playback?.clipId);
  const clip = node.data.clips[clipIndex];
  const clipStatus = useRef({ clipId: "", ended: false, durationMs: 0 });
  const [videoMetrics, setVideoMetrics] = useState<VideoMetrics>();
  if (clip && clipStatus.current.clipId !== clip.id) clipStatus.current = { clipId: clip.id, ended: false, durationMs: 0 };
  if (!clip) return <div className="story-player-content"><p>This scene has no video clips.</p></div>;
  const waitingEvent = playback?.waitingEventId ? node.data.events.find((event) => event.id === playback.waitingEventId) : undefined;
  return <div className="story-player-scene">
    <StoryVideoPlayer key={clip.id} assetId={resolveStoryVideoClipAssetId(chapter, clip)} index={clipIndex} count={node.data.clips.length} title={node.data.title} fit={fit} paused={paused || Boolean(waitingEvent)} initialTimeMs={playback?.timeMs ?? 0} assetUrls={assetUrls} onTime={(time) => onTime(clip.id, time)} onDuration={(durationMs) => { clipStatus.current.durationMs = durationMs; }} onMetrics={setVideoMetrics} onEnded={(duration) => {
      clipStatus.current.ended = true;
      clipStatus.current.durationMs = duration;
      onComplete(clip.id, duration);
    }} />
    {waitingEvent?.type === "continue" ? <button className="story-player-continue" type="button" onClick={() => onContinue(clipStatus.current.ended, clipStatus.current.durationMs)}>{waitingEvent.label || "Continue"}</button> : null}
    {waitingEvent?.type === "hotspot" || waitingEvent?.type === "qte" ? <StorySceneInteraction
      key={waitingEvent.id}
      event={waitingEvent}
      fit={fit}
      metrics={videoMetrics}
      paused={paused}
      onResolve={(result) => onInteraction(waitingEvent.id, result, clipStatus.current.ended, clipStatus.current.durationMs)}
    /> : null}
  </div>;
}

interface VideoMetrics {
  boxWidth: number;
  boxHeight: number;
  videoWidth: number;
  videoHeight: number;
}

function StoryVideoPlayer({ assetId, index, count, title, fit, paused, initialTimeMs, assetUrls, onTime, onDuration, onMetrics, onEnded }: {
  assetId?: string; index: number; count: number; title: string; fit: StoryPlayerConfig["videoFit"]; paused: boolean; initialTimeMs: number; assetUrls?: Readonly<Record<string, string>>;
  onTime: (timeMs: number) => void; onDuration: (durationMs: number) => void; onMetrics: (metrics: VideoMetrics) => void; onEnded: (durationMs: number) => void;
}) {
  const media = useStoryAssetUrl(assetId, assetUrls);
  const video = useRef<HTMLVideoElement>(null);
  const [playbackError, setPlaybackError] = useState(false);
  useEffect(() => { if (paused) video.current?.pause(); else void video.current?.play().catch(() => {}); }, [paused]);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    const measure = () => onMetrics({ boxWidth: element.clientWidth, boxHeight: element.clientHeight, videoWidth: element.videoWidth, videoHeight: element.videoHeight });
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    measure();
    return () => observer.disconnect();
  }, [media.url, onMetrics]);
  const error = media.error ?? (playbackError ? "The video could not be played." : undefined);
  return <article className="story-player-video">
    {media.url && !playbackError ? <video ref={video} src={media.url} autoPlay playsInline style={{ objectFit: fit }} onError={() => setPlaybackError(true)} onLoadedMetadata={(event) => {
      const durationMs = Math.round(event.currentTarget.duration * 1_000);
      if (initialTimeMs > 0) event.currentTarget.currentTime = Math.min(initialTimeMs, durationMs) / 1_000;
      onDuration(durationMs);
      onMetrics({ boxWidth: event.currentTarget.clientWidth, boxHeight: event.currentTarget.clientHeight, videoWidth: event.currentTarget.videoWidth, videoHeight: event.currentTarget.videoHeight });
    }} onTimeUpdate={(event) => onTime(Math.round(event.currentTarget.currentTime * 1_000))} onEnded={(event) => onEnded(Math.round(event.currentTarget.duration * 1_000))} /> : null}
    {!media.url && !error ? <span>Loading video...</span> : null}
    {error ? <div role="alert"><strong>Could not load video</strong><span>{error}</span><button type="button" onClick={() => onEnded(0)}>Skip clip</button></div> : null}
    <footer><strong>{title || "Untitled scene"}</strong><span>{index + 1} / {count}</span></footer>
  </article>;
}

function useStoryAssetUrl(assetId: string | undefined, assetUrls?: Readonly<Record<string, string>>): { url?: string; error?: string } {
  const library = useWorkspaceAssetUrl(undefined, "", 0, assetUrls ? undefined : assetId);
  return assetUrls && assetId ? { url: assetUrls[assetId], ...(assetUrls[assetId] ? {} : { error: "The published asset is missing." }) } : library;
}

function StorySceneInteraction({ event, fit, metrics, paused, onResolve }: {
  event: Extract<StorySceneEvent, { type: "hotspot" | "qte" }>;
  fit: StoryPlayerConfig["videoFit"];
  metrics?: VideoMetrics;
  paused: boolean;
  onResolve: (result: "success" | "timeout") => void;
}) {
  const [remainingMs, setRemainingMs] = useState(event.durationMs);
  const remaining = useRef(event.durationMs);
  const resolved = useRef(false);

  useEffect(() => {
    if (paused || resolved.current) return;
    const deadline = performance.now() + remaining.current;
    const tick = () => {
      remaining.current = Math.max(0, deadline - performance.now());
      setRemainingMs(remaining.current);
    };
    const interval = window.setInterval(tick, 50);
    const timer = window.setTimeout(() => resolve("timeout"), remaining.current);
    return () => { tick(); window.clearInterval(interval); window.clearTimeout(timer); };
  }, [paused]);

  useEffect(() => {
    if (event.type !== "qte" || paused) return;
    const keydown = (keyEvent: KeyboardEvent) => {
      if (keyEvent.code !== event.key || keyEvent.repeat) return;
      keyEvent.preventDefault();
      resolve("success");
    };
    window.addEventListener("keydown", keydown);
    return () => window.removeEventListener("keydown", keydown);
  }, [event, paused]);

  function resolve(result: "success" | "timeout"): void {
    if (resolved.current || paused) return;
    resolved.current = true;
    onResolve(result);
  }

  const progress = Math.max(0, remainingMs / event.durationMs);
  return <div className="story-player-interaction" aria-live="polite">
    {event.type === "hotspot" ? <button
      className="story-player-hotspot"
      type="button"
      aria-label={event.label || "Hotspot"}
      style={hotspotStyle(event.region, fit, metrics)}
      onClick={() => resolve("success")}
    ><span>{event.label || "Hotspot"}</span></button> : <div className="story-player-qte">
      <span>{event.prompt || "Act now"}</span>
      <button type="button" onClick={() => resolve("success")}><kbd>{qteKeyLabel(event.key)}</kbd></button>
    </div>}
    <div className="story-player-interaction-timer" role="timer" aria-label="Time remaining"><span style={{ transform: `scaleX(${progress})` }} /></div>
  </div>;
}

function hotspotStyle(region: StoryHotspotRegion, fit: StoryPlayerConfig["videoFit"], metrics?: VideoMetrics): CSSProperties {
  if (!metrics || !metrics.videoWidth || !metrics.videoHeight) return { visibility: "hidden" };
  const scale = fit === "contain"
    ? Math.min(metrics.boxWidth / metrics.videoWidth, metrics.boxHeight / metrics.videoHeight)
    : Math.max(metrics.boxWidth / metrics.videoWidth, metrics.boxHeight / metrics.videoHeight);
  const width = metrics.videoWidth * scale;
  const height = metrics.videoHeight * scale;
  const left = (metrics.boxWidth - width) / 2 + region.x * width;
  const top = (metrics.boxHeight - height) / 2 + region.y * height;
  return { left, top, width: region.width * width, height: region.height * height };
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
