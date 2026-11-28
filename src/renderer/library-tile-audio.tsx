import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from "react";
import { Spinner, Pause, Play } from "./icons.js";
import { t } from "./i18n.js";

export type TileAudioState = "loading" | "playing" | "paused";

/** Where a tile's sound plays from; a `blob:` URL made for it is revoked when it stops. */
export interface TileAudioSource {
  url: string;
  revoke: boolean;
}

interface TilePlayer {
  id: string;
  element: HTMLAudioElement;
  source?: TileAudioSource;
}

/**
 * One audio tile of the Library plays at a time, in Local or a plugin's
 * source; its sound loads on the first play.
 */
export function useTileAudio() {
  const [playing, setPlaying] = useState<{
    id: string;
    state: TileAudioState;
  }>();
  const player = useRef<TilePlayer>(undefined);
  const stop = useCallback(() => {
    const current = player.current;
    player.current = undefined;
    if (current) {
      current.element.pause();
      current.element.removeAttribute("src");
      if (current.source?.revoke) URL.revokeObjectURL(current.source.url);
    }
    setPlaying(undefined);
  }, []);
  useEffect(() => stop, [stop]);
  const toggle = useCallback(
    (id: string, load: () => Promise<TileAudioSource>) => {
      const current = player.current;
      if (current?.id === id) {
        if (!current.source) return;
        if (current.element.paused)
          void current.element.play().catch(() => undefined);
        else current.element.pause();
        return;
      }
      stop();
      const element = new Audio();
      const next: TilePlayer = { id, element };
      player.current = next;
      const update = (state: TileAudioState) => {
        if (player.current === next) setPlaying({ id, state });
      };
      element.addEventListener("play", () => update("playing"));
      element.addEventListener("pause", () => update("paused"));
      update("loading");
      void load()
        .then((source) => {
          if (player.current !== next) {
            if (source.revoke) URL.revokeObjectURL(source.url);
            return;
          }
          next.source = source;
          element.src = source.url;
          return element.play();
        })
        .catch(() => {
          if (player.current === next) stop();
        });
    },
    [stop],
  );
  return { playing, toggle, stop };
}

/** A tile whose button, in its preview's corner, plays its sound; the rest of it opens the details. */
export function AudioTile({
  name,
  state,
  onToggle,
  children,
}: {
  name: string;
  state?: TileAudioState | undefined;
  onToggle: () => void;
  children: ReactNode;
}) {
  return (
    <div className={`library-audio-tile${state ? ` is-${state}` : ""}`}>
      {children}
      <span className="library-audio-controls">
        <button
          type="button"
          className="library-audio-play"
          aria-label={
            state === "playing"
              ? t("assets.pauseAudio", { name })
              : t("assets.playAudio", { name })
          }
          onClick={onToggle}
        >
          {state === "loading" ? (
            <Spinner size="md" />
          ) : state === "playing" ? (
            <Pause size="md" />
          ) : (
            <Play size="md" />
          )}
        </button>
      </span>
    </div>
  );
}

/**
 * A source's `preview` as something the page may play: an `https:` URL as it
 * is, and a `data:` URL, which the page's policy doesn't let media load, as a
 * `blob:` URL.
 */
export function sourcePreviewAudio(preview: string): TileAudioSource {
  if (preview.startsWith("https://")) return { url: preview, revoke: false };
  const comma = preview.indexOf(",");
  const type = preview.slice(5, preview.indexOf(";"));
  const binary = atob(preview.slice(comma + 1));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++)
    bytes[index] = binary.charCodeAt(index);
  return {
    url: URL.createObjectURL(new Blob([bytes], { type })),
    revoke: true,
  };
}
