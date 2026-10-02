import { useEffect, useRef, useState } from "react";
import type { ExampleSummary } from "../shared/examples.js";
import { getExampleCover, listExamples, playExample, waitForRuntime } from "./api.js";
import { LoaderCircle, Maximize, Pencil, X } from "./icons.js";
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
