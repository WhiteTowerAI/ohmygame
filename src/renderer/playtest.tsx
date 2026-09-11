import { Pause, Play, RotateCcw } from "./icons.js";
import { useCallback, useEffect, useRef, useState, type CSSProperties } from "react";
import type { StoryChapter, StoryNode, StoryPlayerConfig, StoryVariable, StoryVariableValue } from "../shared/contracts.js";
import { advanceSceneTime, chooseOption, completeSceneClip, continueSceneEvent, createPlayerState, DEFAULT_STORY_PLAYER_CONFIG, matchesStoryCondition, resolveStoryVideoClipAssetId, restartGame, startGame, validatePlayableChapter, type PlayerRuntimeState } from "../shared/story.js";
import { getStory, listLibraryAssets } from "./api.js";
import { useWorkspaceAssetUrl } from "./use-workspace-asset-url.js";

export function PlaytestPage({ projectId, chapterId }: { projectId: string; chapterId: string }) {
  const [chapter, setChapter] = useState<StoryChapter>();
  const [variables, setVariables] = useState<StoryVariable[]>([]);
  const [config, setConfig] = useState<StoryPlayerConfig>(DEFAULT_STORY_PLAYER_CONFIG);
  const [runtime, setRuntime] = useState<PlayerRuntimeState>();
  const [paused, setPaused] = useState(false);
  const [playbackStep, setPlaybackStep] = useState(0);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let disposed = false;
    void Promise.all([getStory(projectId), listLibraryAssets()]).then(([story, assets]) => {
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
      const definitions = story.variables ?? [];
      setChapter(selected);
      setVariables(definitions);
      setConfig(story.player ?? { ...DEFAULT_STORY_PLAYER_CONFIG, title: selected.title });
      setRuntime(createPlayerState(selected.id, definitions));
      document.title = `${story.player?.title || selected.title} - Playtest`;
    }).catch((cause) => {
      if (!disposed) setError(errorMessage(cause));
    });
    return () => { disposed = true; };
  }, [chapterId, projectId]);

  const start = useCallback(() => {
    if (!chapter) return;
    setRuntime((current) => startGame(chapter, current ?? createPlayerState(chapter.id, variables)));
    setPaused(false);
    setPlaybackStep((step) => step + 1);
  }, [chapter, variables]);

  const restart = useCallback(() => {
    if (!chapter) return;
    setRuntime(restartGame(chapter, variables));
    setPaused(false);
    setPlaybackStep((step) => step + 1);
  }, [chapter, variables]);

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
      if (!current) return current;
      const resolved = continueSceneEvent(chapter, current);
      return clipEnded && resolved.scenePlayback ? completeSceneClip(chapter, resolved, resolved.scenePlayback.clipId, durationMs) : resolved;
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
        node={node}
        runtime={runtime}
        paused={paused}
        onStart={start}
        onPause={() => setPaused(true)}
        onResume={() => setPaused(false)}
        onRestart={restart}
        onMenu={returnToMenu}
        onSceneTime={updateSceneTime}
        onClipComplete={completeCurrentClip}
        onContinue={continueCurrentScene}
        onChoice={selectChoice}
      />
    ) : null}
  </main>;
}

function InteractiveDramaPlayer({ chapter, config, node, runtime, paused, onStart, onPause, onResume, onRestart, onMenu, onSceneTime, onClipComplete, onContinue, onChoice }: {
  chapter: StoryChapter;
  config: StoryPlayerConfig;
  node?: StoryNode;
  runtime: PlayerRuntimeState;
  paused: boolean;
  onStart: () => void;
  onPause: () => void;
  onResume: () => void;
  onRestart: () => void;
  onMenu: () => void;
  onSceneTime: (clipId: string, timeMs: number) => void;
  onClipComplete: (clipId: string, durationMs: number) => void;
  onContinue: (clipEnded: boolean, durationMs: number) => void;
  onChoice: (optionId: string) => void;
}) {
  const background = useWorkspaceAssetUrl(undefined, "", 0, config.backgroundAssetId);
  const backgroundStyle = background.url ? { backgroundImage: `linear-gradient(rgb(0 0 0 / 38%), rgb(0 0 0 / 62%)), url("${background.url}")` } : undefined;
  if (runtime.mode === "menu") return (
    <section className="story-player story-player-menu" aria-label="Game menu" style={backgroundStyle}>
      <div className="story-player-menu-content">
        <span>Interactive Drama</span>
        <h1>{config.title || chapter.title}</h1>
        <button type="button" onClick={onStart}><Play size={16} fill="currentColor" />Start game</button>
      </div>
    </section>
  );

  return <section className={`story-player story-player-${config.choicePosition}`} aria-label="Story player">
    <div className="story-player-stage">
      {node?.type === "scene" ? <StoryScenePlayer chapter={chapter} node={node} runtime={runtime} fit={config.videoFit} paused={paused} onTime={onSceneTime} onComplete={onClipComplete} onContinue={onContinue} /> : null}
      {node?.type === "choice" ? <StoryChoicePlayer node={node} variables={runtime.variables} paused={paused} onSelect={onChoice} /> : null}
      {node?.type === "ending" ? <StoryEnding node={node} onRestart={onRestart} onMenu={onMenu} /> : null}
      {!node ? <div className="story-playtest-state" role="alert">The current story node is missing.</div> : null}
      {node?.type !== "ending" ? <button className="story-player-pause" type="button" title="Pause" aria-label="Pause" onClick={onPause}><Pause size={16} fill="currentColor" /></button> : null}
      {paused ? <PauseMenu onResume={onResume} onRestart={onRestart} onMenu={onMenu} /> : null}
    </div>
  </section>;
}

function PauseMenu({ onResume, onRestart, onMenu }: { onResume: () => void; onRestart: () => void; onMenu: () => void }) {
  return <div className="story-player-pause-layer" role="dialog" aria-modal="true" aria-label="Game paused">
    <div>
      <span>Paused</span>
      <button type="button" onClick={onResume}><Play size={15} fill="currentColor" />Resume</button>
      <button type="button" onClick={onRestart}><RotateCcw size={15} />Restart</button>
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

function StoryScenePlayer({ chapter, node, runtime, fit, paused, onTime, onComplete, onContinue }: {
  chapter: StoryChapter;
  node: Extract<StoryNode, { type: "scene" }>;
  runtime: Extract<PlayerRuntimeState, { mode: "playing" }>;
  fit: StoryPlayerConfig["videoFit"];
  paused: boolean;
  onTime: (clipId: string, timeMs: number) => void;
  onComplete: (clipId: string, durationMs: number) => void;
  onContinue: (clipEnded: boolean, durationMs: number) => void;
}) {
  const playback = runtime.scenePlayback;
  const clipIndex = node.data.clips.findIndex((candidate) => candidate.id === playback?.clipId);
  const clip = node.data.clips[clipIndex];
  const clipStatus = useRef({ clipId: "", ended: false, durationMs: 0 });
  if (clip && clipStatus.current.clipId !== clip.id) clipStatus.current = { clipId: clip.id, ended: false, durationMs: 0 };
  if (!clip) return <div className="story-player-content"><p>This scene has no video clips.</p></div>;
  const waitingEvent = playback?.waitingEventId ? node.data.events.find((event) => event.id === playback.waitingEventId) : undefined;
  return <div className="story-player-scene">
    <StoryVideoPlayer key={clip.id} assetId={resolveStoryVideoClipAssetId(chapter, clip)} index={clipIndex} count={node.data.clips.length} title={node.data.title} fit={fit} paused={paused || Boolean(waitingEvent)} onTime={(time) => onTime(clip.id, time)} onDuration={(durationMs) => { clipStatus.current.durationMs = durationMs; }} onEnded={(duration) => {
      clipStatus.current.ended = true;
      clipStatus.current.durationMs = duration;
      onComplete(clip.id, duration);
    }} />
    {waitingEvent?.type === "continue" ? <button className="story-player-continue" type="button" onClick={() => onContinue(clipStatus.current.ended, clipStatus.current.durationMs)}>{waitingEvent.label || "Continue"}</button> : null}
  </div>;
}

function StoryVideoPlayer({ assetId, index, count, title, fit, paused, onTime, onDuration, onEnded }: {
  assetId?: string; index: number; count: number; title: string; fit: StoryPlayerConfig["videoFit"]; paused: boolean;
  onTime: (timeMs: number) => void; onDuration: (durationMs: number) => void; onEnded: (durationMs: number) => void;
}) {
  const media = useWorkspaceAssetUrl(undefined, "", 0, assetId);
  const video = useRef<HTMLVideoElement>(null);
  const [playbackError, setPlaybackError] = useState(false);
  useEffect(() => { if (paused) video.current?.pause(); else void video.current?.play().catch(() => {}); }, [paused]);
  const error = media.error ?? (playbackError ? "The video could not be played." : undefined);
  return <article className="story-player-video">
    {media.url && !playbackError ? <video ref={video} src={media.url} autoPlay playsInline style={{ objectFit: fit }} onError={() => setPlaybackError(true)} onLoadedMetadata={(event) => onDuration(Math.round(event.currentTarget.duration * 1_000))} onTimeUpdate={(event) => onTime(Math.round(event.currentTarget.currentTime * 1_000))} onEnded={(event) => onEnded(Math.round(event.currentTarget.duration * 1_000))} /> : null}
    {!media.url && !error ? <span>Loading video...</span> : null}
    {error ? <div role="alert"><strong>Could not load video</strong><span>{error}</span><button type="button" onClick={() => onEnded(0)}>Skip clip</button></div> : null}
    <footer><strong>{title || "Untitled scene"}</strong><span>{index + 1} / {count}</span></footer>
  </article>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
