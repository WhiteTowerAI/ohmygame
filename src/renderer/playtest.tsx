import { RotateCcw } from "./icons.js";
import { useEffect, useState } from "react";
import type { StoryChapter, StoryNode, StoryVideoClip } from "../shared/contracts.js";
import { getNextNode, getStartNode, validatePlayableChapter } from "../shared/story.js";
import { getStory, listLibraryAssets } from "./api.js";
import { useWorkspaceAssetUrl } from "./use-workspace-asset-url.js";

export function PlaytestPage({ projectId, chapterId }: { projectId: string; chapterId: string }) {
  const [chapter, setChapter] = useState<StoryChapter>();
  const [currentNodeId, setCurrentNodeId] = useState<string>();
  const [playbackStep, setPlaybackStep] = useState(0);
  const [error, setError] = useState<string>();

  useEffect(() => {
    let disposed = false;
    void Promise.all([getStory(projectId), listLibraryAssets()]).then(([story, assets]) => {
      if (disposed) return;
      const selected = story.chapters.find((candidate) => candidate.id === chapterId);
      if (!selected) throw new Error("Chapter not found");
      const issue = validatePlayableChapter(selected, new Set(assets.filter((asset) => asset.mediaType === "video").map((asset) => asset.id)));
      if (issue) throw new Error(issue.message);
      const start = getStartNode(selected);
      const first = start ? getNextNode(selected, start.id) : undefined;
      if (!first) throw new Error("The chapter has no opening scene");
      setChapter(selected);
      setCurrentNodeId(first.id);
      document.title = `${selected.title} - Playtest`;
    }).catch((cause) => {
      if (!disposed) setError(errorMessage(cause));
    });
    return () => { disposed = true; };
  }, [chapterId, projectId]);

  const node = chapter?.nodes.find((candidate) => candidate.id === currentNodeId);

  function restart(): void {
    if (!chapter) return;
    const start = getStartNode(chapter);
    const first = start ? getNextNode(chapter, start.id) : undefined;
    if (first) {
      setCurrentNodeId(first.id);
      setPlaybackStep((step) => step + 1);
    }
  }

  function advance(sourceHandle = "out"): void {
    if (!chapter || !node) return;
    const next = getNextNode(chapter, node.id, sourceHandle);
    if (next) {
      setCurrentNodeId(next.id);
      setPlaybackStep((step) => step + 1);
    }
  }

  return (
    <main className="story-playtest-page">
      <header className="story-playtest-header window-drag-handle">
        <strong>{chapter?.title ?? "Playtest"}</strong>
        {chapter ? <button type="button" onClick={restart}><RotateCcw size={14} />Restart</button> : null}
      </header>
      {error ? <div className="story-playtest-state" role="alert">{error}</div> : null}
      {!error && !node ? <div className="story-playtest-state">Loading playtest...</div> : null}
      {node ? <StoryPlayer key={`${node.id}:${playbackStep}`} node={node} onAdvance={advance} onRestart={restart} /> : null}
    </main>
  );
}

function StoryPlayer({
  node,
  onAdvance,
  onRestart,
}: {
  node: StoryNode;
  onAdvance: (sourceHandle?: string) => void;
  onRestart: () => void;
}) {
  return (
    <section className="story-player" aria-label="Story playtest">
      <div className="story-player-stage">
        {node.type === "scene" ? <StoryScenePlayer node={node} onComplete={() => onAdvance()} /> : null}
        {node.type === "choice" ? (
          <article className="story-player-content story-player-choice">
            <span>Choice</span>
            <h2>{node.data.title || "Make a choice"}</h2>
            <div>
              {node.data.options.map((option, index) => (
                <button type="button" key={option.id} onClick={() => onAdvance(option.id)}>
                  <span>{index + 1}</span>{option.label || `Option ${index + 1}`}
                </button>
              ))}
            </div>
          </article>
        ) : null}
        {node.type === "ending" ? (
          <article className="story-player-content story-player-ending">
            <span>Ending</span>
            <h2>{node.data.title || "Untitled ending"}</h2>
            {node.data.description ? <p>{node.data.description}</p> : null}
            <button className="story-player-continue" type="button" onClick={onRestart}><RotateCcw size={14} />Play again</button>
          </article>
        ) : null}
      </div>
    </section>
  );
}

function StoryScenePlayer({ node, onComplete }: {
  node: Extract<StoryNode, { type: "scene" }>;
  onComplete: () => void;
}) {
  const [clipIndex, setClipIndex] = useState(0);
  const clip = node.data.clips[clipIndex];

  if (!clip) return <div className="story-player-content"><p>This scene has no video clips.</p></div>;
  return <StoryVideoPlayer
    key={clip.id}
    clip={clip}
    index={clipIndex}
    count={node.data.clips.length}
    title={node.data.title}
    onEnded={() => {
      if (clipIndex + 1 < node.data.clips.length) setClipIndex(clipIndex + 1);
      else onComplete();
    }}
  />;
}

function StoryVideoPlayer({ clip, index, count, title, onEnded }: {
  clip: StoryVideoClip;
  index: number;
  count: number;
  title: string;
  onEnded: () => void;
}) {
  const media = useWorkspaceAssetUrl(undefined, "", 0, clip.assetId);
  const [playbackError, setPlaybackError] = useState(false);
  const error = media.error ?? (playbackError ? "The video could not be played." : undefined);
  return (
    <article className="story-player-video">
      {media.url && !playbackError ? <video src={media.url} autoPlay controls playsInline onError={() => setPlaybackError(true)} onEnded={onEnded} /> : null}
      {!media.url && !error ? <span>Loading video...</span> : null}
      {error ? <div role="alert"><strong>Could not load video</strong><span>{error}</span><button type="button" onClick={onEnded}>Skip clip</button></div> : null}
      <footer><strong>{title || "Untitled scene"}</strong><span>{index + 1} / {count}</span></footer>
    </article>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
