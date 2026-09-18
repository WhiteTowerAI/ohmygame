import { StrictMode, useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import type { StoryDocument, StoryInteractionCommand } from "../shared/contracts.js";
import {
  advanceSceneTime,
  advanceOpenUi,
  chooseOption,
  completeSceneMedia,
  createStoryCheckpoint,
  resolveInteractionNode,
  restartGame,
  shouldCreateStoryCheckpoint,
  type PlayerRuntimeState,
  type PlayingRuntimeState,
} from "../shared/story.js";
import { InteractiveDramaPlayer } from "./playtest.js";
import { clearStoryProgress, loadStoryProgress, saveStoryProgress, storyProgressKey, storySignature } from "./story-progress.js";
import "./story-player.css";

interface PublishedStoryManifest {
  version: 1;
  story: string;
  scope: string;
  assets: Record<string, string>;
}

function PublishedPlayer() {
  const [story, setStory] = useState<StoryDocument>();
  const [runtime, setRuntime] = useState<PlayerRuntimeState>();
  const [paused, setPaused] = useState(false);
  const [playerKey, setPlayerKey] = useState(0);
  const [hasCheckpoint, setHasCheckpoint] = useState(false);
  const [saveStatus, setSaveStatus] = useState<"saved" | "error">();
  const [manifest, setManifest] = useState<PublishedStoryManifest>();
  const [error, setError] = useState<string>();
  const progress = useRef<{ key: string; signature: string } | undefined>(undefined);
  const checkpoint = useRef<PlayingRuntimeState | undefined>(undefined);
  const chapter = story?.chapters[0];
  const variables = useMemo(() => story?.variables ?? [], [story]);

  useEffect(() => {
    let disposed = false;
    void Promise.all([
      fetch("./manifest.json").then(requireJson),
      fetch("./story.json").then(requireJson),
    ]).then(async ([manifestValue, storyValue]) => {
      const loadedManifest = manifestValue as PublishedStoryManifest;
      const loadedStory = storyValue as StoryDocument;
      if (loadedManifest.version !== 1 || loadedManifest.story !== "story.json" || !loadedStory.chapters[0]) throw new Error("The published game is invalid.");
      const signature = await storySignature(loadedStory);
      if (disposed) return;
      const chapter = loadedStory.chapters[0];
      const key = storyProgressKey(loadedManifest.scope, chapter.id);
      const saved = loadStoryProgress(localStorage, key, signature, chapter, loadedStory.variables ?? []);
      progress.current = { key, signature };
      checkpoint.current = saved;
      setManifest(loadedManifest);
      setStory(loadedStory);
      setHasCheckpoint(Boolean(saved));
      setRuntime(restartGame(chapter, loadedStory.variables ?? []));
      document.title = loadedStory.player.title || chapter.title;
    }).catch((cause) => { if (!disposed) setError(errorMessage(cause)); });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    const storage = progress.current;
    const runtimeNode = chapter?.nodes.find((candidate) => candidate.id === runtime?.nodeId);
    if (!storage || !runtime || runtimeNode?.type === "open-ui" || !shouldCreateStoryCheckpoint(checkpoint.current, runtime)) return;
    const save = createStoryCheckpoint(storage.signature, runtime);
    checkpoint.current = save.checkpoint;
    setHasCheckpoint(true);
    try {
      saveStoryProgress(localStorage, storage.key, save);
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

  const resetPlayer = useCallback(() => setPlayerKey((value) => value + 1), []);
  const startNewGame = useCallback(() => {
    if (!chapter) return;
    if (checkpoint.current && !window.confirm("Start a new game? Your current progress will be replaced.")) return;
    if (progress.current) clearStoryProgress(localStorage, progress.current.key);
    checkpoint.current = undefined;
    setHasCheckpoint(false);
    setRuntime(restartGame(chapter, variables));
    setPaused(false);
    resetPlayer();
  }, [chapter, resetPlayer, variables]);
  const restore = useCallback(() => {
    if (!checkpoint.current) return;
    setRuntime(checkpoint.current);
    setPaused(false);
    resetPlayer();
  }, [resetPlayer]);
  const menu = useCallback(() => {
    if (!chapter) return;
    setRuntime(restartGame(chapter, variables));
    setPaused(false);
    resetPlayer();
  }, [chapter, resetPlayer, variables]);
  const advanceUi = useCallback(() => {
    if (!chapter) return;
    setRuntime((current) => current ? advanceOpenUi(chapter, current) : current);
    setPaused(false);
    resetPlayer();
  }, [chapter, resetPlayer]);
  const onSceneTime = useCallback((mediaId: string, timeMs: number) => {
    if (chapter) setRuntime((current) => current ? advanceSceneTime(chapter, current, mediaId, timeMs) : current);
  }, [chapter]);
  const onMediaComplete = useCallback((mediaId: string, durationMs: number) => {
    if (chapter) setRuntime((current) => current ? completeSceneMedia(chapter, current, mediaId, durationMs) : current);
  }, [chapter]);
  const onChoice = useCallback((optionId: string) => {
    if (!chapter) return;
    setRuntime((current) => current ? chooseOption(chapter, current, optionId) : current);
    resetPlayer();
  }, [chapter, resetPlayer]);
  const onInteraction = useCallback((result: string, commands: StoryInteractionCommand[]) => {
    if (!chapter) return;
    setRuntime((current) => current ? resolveInteractionNode(chapter, current, result, commands, variables) : current);
    resetPlayer();
  }, [chapter, resetPlayer, variables]);

  if (error) return <main className="story-playtest-page"><div className="story-playtest-state" role="alert">{error}</div></main>;
  if (!story || !chapter || !runtime || !manifest) return <main className="story-playtest-page"><div className="story-playtest-state">Loading game...</div></main>;
  const config = story.player;
  const style = {
    "--story-player-accent": config.theme.accentColor,
    "--story-player-text": config.theme.textColor,
    "--story-player-font": config.theme.font === "serif" ? "Georgia, 'Times New Roman', serif" : "Inter, system-ui, sans-serif",
  } as CSSProperties;
  const node = chapter.nodes.find((candidate) => candidate.id === runtime.nodeId);
  return <main className="story-playtest-page" style={style}><InteractiveDramaPlayer
    key={playerKey}
    chapter={chapter}
    variables={variables}
    config={config}
    node={node}
    runtime={runtime}
    progressFacts={checkpoint.current?.progress}
    paused={paused}
    hasCheckpoint={hasCheckpoint}
    saveStatus={saveStatus}
    assetUrls={manifest.assets}
    onAdvanceOpenUi={advanceUi}
    onContinueGame={restore}
    onPause={() => setPaused(true)}
    onResume={() => setPaused(false)}
    onRestartCheckpoint={restore}
    onRestartGame={startNewGame}
    onMenu={menu}
    onSceneTime={onSceneTime}
    onMediaComplete={onMediaComplete}
    onInteraction={onInteraction}
    onChoice={onChoice}
  /></main>;
}

async function requireJson(response: Response): Promise<unknown> {
  if (!response.ok) throw new Error("The published game could not be loaded.");
  return response.json();
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

createRoot(document.getElementById("root")!).render(<StrictMode><PublishedPlayer /></StrictMode>);
