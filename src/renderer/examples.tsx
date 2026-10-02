import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ExampleSummary } from "../shared/examples.js";
import { createProject, getExampleCover, listExamples, playExample, waitForRuntime } from "./api.js";
import { LoaderCircle, Maximize, Pencil, Play, X } from "./icons.js";
import { projectTypeLabel } from "./project-types.js";

/** Packaged examples and object URLs for their covers, revoked on unmount. */
export function useExamples(): { examples: ExampleSummary[]; covers: Record<string, string> } {
  const [examples, setExamples] = useState<ExampleSummary[]>([]);
  const [covers, setCovers] = useState<Record<string, string>>({});

  useEffect(() => {
    let disposed = false;
    const coverUrls: string[] = [];
    void waitForRuntime().then(listExamples).then(async (list) => {
      if (disposed) return;
      setExamples(list);
      for (const example of list) {
        const cover = await getExampleCover(example.id).catch(() => undefined);
        if (disposed || !cover) continue;
        const url = URL.createObjectURL(cover);
        coverUrls.push(url);
        setCovers((current) => ({ ...current, [example.id]: url }));
      }
    }).catch(() => undefined);
    return () => {
      disposed = true;
      for (const url of coverUrls) URL.revokeObjectURL(url);
    };
  }, []);

  return { examples, covers };
}

/**
 * A row of example cards: clicking a card plays the example, Remix copies it
 * into a new project and opens it. `children` are extra cards for the row.
 */
export function ExampleShelf({ examples, covers, onOpenProject, children }: {
  examples: readonly ExampleSummary[];
  covers: Record<string, string>;
  onOpenProject: (projectId: string) => void;
  children?: ReactNode;
}) {
  const [playing, setPlaying] = useState<ExampleSummary>();
  const [remixingId, setRemixingId] = useState<string>();
  const [remixError, setRemixError] = useState<string>();

  async function remix(example: ExampleSummary) {
    if (remixingId) return;
    setRemixingId(example.id);
    setRemixError(undefined);
    try {
      const project = await createProject({ type: example.type, exampleId: example.id, name: example.name });
      onOpenProject(project.id);
    } catch (cause) {
      setRemixError(cause instanceof Error ? cause.message : String(cause));
      setRemixingId(undefined);
    }
  }

  return (
    <>
      <div className="home-whats-new-grid">
        {examples.map((example) => (
          <div className="home-explore-card" key={example.id}>
            <button className="home-whats-new-item" type="button" onClick={() => { setRemixError(undefined); setPlaying(example); }} aria-label={`Play ${example.name}`} title={example.description}>
              <span className="home-whats-new-icon home-explore-cover" aria-hidden="true">
                {covers[example.id] ? <img src={covers[example.id]} alt="" /> : null}
                <span className="home-explore-play"><Play size={14} />Play</span>
              </span>
              <span className="home-whats-new-copy">
                <strong>{example.name}</strong>
                <small>Example</small>
              </span>
            </button>
            <button className="home-explore-remix" type="button" disabled={remixingId !== undefined} onClick={() => void remix(example)} title="Copy this example into a new project you can change">
              <Pencil size={13} />Remix
            </button>
          </div>
        ))}
        {children}
      </div>
      {remixError && !playing ? <p className="home-notice" role="alert">{remixError}</p> : null}
      {playing ? (
        <ExamplePlayer
          example={playing}
          coverUrl={covers[playing.id]}
          remixing={remixingId === playing.id}
          error={remixError}
          onRemix={() => void remix(playing)}
          onClose={() => setPlaying(undefined)}
        />
      ) : null}
    </>
  );
}

/** Plays an example's static build in place, with a way to remix it into a project. */
export function ExamplePlayer({ example, coverUrl, remixing, error, onRemix, onClose }: {
  example: ExampleSummary;
  coverUrl?: string;
  remixing: boolean;
  error?: string;
  onRemix: () => void;
  onClose: () => void;
}) {
  const playerRef = useRef<HTMLDivElement>(null);
  const [url, setUrl] = useState<string>();
  const [loadError, setLoadError] = useState<string>();

  useEffect(() => {
    let disposed = false;
    void playExample(example.id)
      .then((result) => { if (!disposed) setUrl(result.url); })
      .catch((cause) => { if (!disposed) setLoadError(cause instanceof Error ? cause.message : String(cause)); });
    return () => { disposed = true; };
  }, [example.id]);

  useEffect(() => {
    const handleKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !document.fullscreenElement) onClose();
    };
    window.addEventListener("keydown", handleKeyboard);
    return () => window.removeEventListener("keydown", handleKeyboard);
  }, [onClose]);

  async function toggleFullscreen() {
    if (document.fullscreenElement) await document.exitFullscreen();
    else await playerRef.current?.requestFullscreen();
  }

  return (
    <div className="example-player-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose(); }}>
      <section className="example-player" ref={playerRef} role="dialog" aria-modal="true" aria-label={`Play ${example.name}`}>
        <div className="example-player-stage">
          {url ? (
            <iframe
              src={url}
              title={example.name}
              sandbox="allow-forms allow-modals allow-pointer-lock allow-same-origin allow-scripts"
              allow="autoplay; fullscreen"
            />
          ) : (
            <div className="example-player-status" role="status">
              {loadError ?? <><LoaderCircle className="spin" size={16} /><span>Loading {example.name}</span></>}
            </div>
          )}
        </div>
        <div className="example-player-toolbar">
          <div className="example-player-summary">
            {coverUrl ? <img src={coverUrl} alt="" /> : null}
            <div>
              <strong>{example.name}</strong>
              <span>Example · {projectTypeLabel(example.type)}</span>
              {error ? <p className="example-player-error" role="alert">{error}</p> : <p>{example.description}</p>}
            </div>
          </div>
          <div className="example-player-actions">
            <button className="example-player-remix" type="button" disabled={remixing} onClick={onRemix} title="Copy this example into a new project you can change">
              {remixing ? <LoaderCircle className="spin" size={15} /> : <Pencil size={15} />}
              Remix
            </button>
            <button type="button" onClick={() => void toggleFullscreen()} title="Fullscreen" aria-label="Fullscreen"><Maximize size={17} /></button>
            <button type="button" onClick={onClose} title="Close" aria-label="Close"><X size={17} /></button>
          </div>
        </div>
      </section>
    </div>
  );
}
