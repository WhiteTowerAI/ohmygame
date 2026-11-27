import { useReadyRuntimeGeneration } from "./runtime-connection.js";
import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ExampleSummary } from "../shared/examples.js";
import { EXAMPLE_DOWNLOAD_UNAVAILABLE } from "../shared/examples.js";
import { ApiError, createProject, getExampleCover, listExamples, playExample, waitForRuntime } from "./api.js";
import { Spinner, Maximize, Pencil, Play, X } from "./icons.js";
import { projectTypeLabel } from "./project-types.js";
import { t } from "./i18n.js";
import { Button } from "./ui/index.js";

function exampleActionError(cause: unknown): string {
  if (cause instanceof ApiError && cause.code === EXAMPLE_DOWNLOAD_UNAVAILABLE) {
    return t("examples.downloadFailed");
  }
  return cause instanceof Error ? cause.message : String(cause);
}

/** Packaged examples and object URLs for their covers, revoked on unmount. */
export function useExamples(): { examples: ExampleSummary[]; covers: Record<string, string> } {
  const serviceGeneration = useReadyRuntimeGeneration();
  const [examples, setExamples] = useState<ExampleSummary[]>([]);
  const [covers, setCovers] = useState<Record<string, string>>({});

  useEffect(() => {
    let disposed = false;
    const coverUrls: string[] = [];
    setCovers({});
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
  }, [serviceGeneration]);

  return { examples, covers };
}

/**
 * A row of example cards: clicking a card plays the example, Remix copies it
 * into a new project and opens it. `children` are extra cards for the row.
 * Cards show the example's name; `showType` adds its project type, for rows that mix types.
 */
export function ExampleShelf({ examples, covers, showType = false, onOpenProject, children }: {
  examples: readonly ExampleSummary[];
  covers: Record<string, string>;
  showType?: boolean;
  onOpenProject: (projectId: string) => void;
  children?: ReactNode;
}) {
  const [playing, setPlaying] = useState<ExampleSummary>();
  const playTrigger = useRef<HTMLButtonElement>(null);
  const [remixingId, setRemixingId] = useState<string>();
  const [remixError, setRemixError] = useState<{ id: string; message: string }>();

  async function remix(example: ExampleSummary) {
    if (remixingId) return;
    setRemixingId(example.id);
    setRemixError(undefined);
    try {
      const project = await createProject({ type: example.type, exampleId: example.id, name: example.name });
      onOpenProject(project.id);
    } catch (cause) {
      setRemixError({ id: example.id, message: exampleActionError(cause) });
    } finally {
      setRemixingId(undefined);
    }
  }

  return (
    <>
      <div className="home-whats-new-grid">
        {examples.map((example) => (
          <div className="home-explore-card" key={example.id}>
            <button className="home-whats-new-item" type="button" onClick={(event) => {
              playTrigger.current = event.currentTarget;
              setPlaying(example);
            }} aria-label={t("examples.playName", { name: example.name })} title={example.description}>
              <span className="home-whats-new-icon home-explore-cover" aria-hidden="true">
                {covers[example.id] ? <img src={covers[example.id]} alt="" /> : null}
                <span className="home-explore-play"><Play size="sm" />{t("examples.play")}</span>
              </span>
              <span className="home-whats-new-copy">
                <strong>{example.name}</strong>
                {showType ? <small>{projectTypeLabel(example.type)}</small> : null}
              </span>
            </button>
            <button className="home-explore-remix" type="button" disabled={remixingId !== undefined} aria-busy={remixingId === example.id} onClick={() => void remix(example)} title={t("examples.remixTitle")}>
              {remixingId === example.id ? <Spinner size="sm" /> : <Pencil size="sm" />}
              {t(remixingId === example.id ? "examples.preparingRemix" : "examples.remix")}
            </button>
          </div>
        ))}
        {children}
      </div>
      {remixError && remixError.id !== playing?.id ? <p className="home-notice" role="alert">{remixError.message}</p> : null}
      {playing ? (
        <ExamplePlayer
          example={playing}
          coverUrl={covers[playing.id]}
          remixingId={remixingId}
          error={remixError?.id === playing.id ? remixError.message : undefined}
          onRemix={() => void remix(playing)}
          onClose={() => { setPlaying(undefined); playTrigger.current?.focus(); }}
        />
      ) : null}
    </>
  );
}

/** Plays an example's static build in place, with a way to remix it into a project. */
function ExamplePlayer({ example, coverUrl, remixingId, error, onRemix, onClose }: {
  example: ExampleSummary;
  coverUrl?: string;
  remixingId?: string;
  error?: string;
  onRemix: () => void;
  onClose: () => void;
}) {
  const preparingRemix = remixingId === example.id;
  const playerRef = useRef<HTMLDivElement>(null);
  const closeButton = useRef<HTMLButtonElement>(null);
  const [url, setUrl] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
  const [attempt, setAttempt] = useState(0);

  useEffect(() => { closeButton.current?.focus(); }, []);

  useEffect(() => {
    let disposed = false;
    void playExample(example.id)
      .then((result) => { if (!disposed) setUrl(result.url); })
      .catch((cause) => { if (!disposed) setLoadError(exampleActionError(cause)); });
    return () => { disposed = true; };
  }, [attempt, example.id]);

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
      <section className="example-player" ref={playerRef} role="dialog" aria-modal="true" aria-label={t("examples.playName", { name: example.name })}>
        <div className="example-player-stage">
          {url ? (
            <iframe
              src={url}
              title={example.name}
              sandbox="allow-forms allow-modals allow-pointer-lock allow-same-origin allow-scripts"
              allow="autoplay; fullscreen"
            />
          ) : loadError ? (
            <div className="example-player-status">
              <span role="alert">{loadError}</span>
              <Button size="sm" onClick={() => {
                closeButton.current?.focus();
                setLoadError(undefined);
                setAttempt((current) => current + 1);
              }}>{t("common.retry")}</Button>
            </div>
          ) : (
            <div className="example-player-status" role="status">
              <Spinner size="md" /><span>{t("examples.loadingName", { name: example.name })}</span>
            </div>
          )}
        </div>
        <div className="example-player-toolbar">
          <div className="example-player-summary">
            {coverUrl ? <img src={coverUrl} alt="" /> : null}
            <div>
              <strong>{example.name}</strong>
              <span>{t("examples.exampleType", { type: projectTypeLabel(example.type) })}</span>
              {error ? <p className="example-player-error" role="alert">{error}</p> : <p>{example.description}</p>}
            </div>
          </div>
          <div className="example-player-actions">
            <button className="example-player-remix" type="button" disabled={remixingId !== undefined} aria-busy={preparingRemix} onClick={onRemix} title={t("examples.remixTitle")}>
              {preparingRemix ? <Spinner size="sm" /> : <Pencil size="sm" />}
              {t(preparingRemix ? "examples.preparingRemix" : "examples.remix")}
            </button>
            <button type="button" onClick={() => void toggleFullscreen()} title={t("common.fullscreen")} aria-label={t("common.fullscreen")}><Maximize size="md" /></button>
            <button type="button" ref={closeButton} onClick={onClose} title={t("common.close")} aria-label={t("common.close")}><X size="md" /></button>
          </div>
        </div>
      </section>
    </div>
  );
}
