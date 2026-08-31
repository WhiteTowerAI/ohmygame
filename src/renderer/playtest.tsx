import { RotateCcw } from "./icons.js";
import { useEffect, useState } from "react";
import type { StoryChapter, StoryNode } from "../shared/contracts.js";
import { getNextNode, getStartNode, validatePlayableChapter } from "../shared/story.js";
import { getStory } from "./api.js";

export function PlaytestPage({ projectId, chapterId }: { projectId: string; chapterId: string }) {
  const [chapter, setChapter] = useState<StoryChapter>();
  const [currentNodeId, setCurrentNodeId] = useState<string>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    let disposed = false;
    void getStory(projectId).then((story) => {
      if (disposed) return;
      const selected = story.chapters.find((candidate) => candidate.id === chapterId);
      if (!selected) throw new Error("Chapter not found");
      const issue = validatePlayableChapter(selected);
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
    if (first) setCurrentNodeId(first.id);
  }

  function advance(sourceHandle = "out"): void {
    if (!chapter || !node) return;
    const next = getNextNode(chapter, node.id, sourceHandle);
    if (next) setCurrentNodeId(next.id);
  }

  return (
    <main className="story-playtest-page">
      <header className="story-playtest-header window-drag-handle">
        <strong>{chapter?.title ?? "Playtest"}</strong>
        {chapter ? <button type="button" onClick={restart}><RotateCcw size={14} />Restart</button> : null}
      </header>
      {error ? <div className="story-playtest-state" role="alert">{error}</div> : null}
      {!error && !node ? <div className="story-playtest-state">Loading playtest...</div> : null}
      {node ? <StoryPlayer node={node} onAdvance={advance} onRestart={restart} /> : null}
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
        {node.type === "scene" ? (
          <article className="story-player-content">
            <span>Scene</span>
            <h2>{node.data.title || "Untitled scene"}</h2>
            <p>{node.data.description || "This scene has no script yet."}</p>
            <button className="story-player-continue" type="button" onClick={() => onAdvance()}>Continue</button>
          </article>
        ) : null}
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

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
