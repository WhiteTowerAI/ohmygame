import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type RefObject,
} from "react";
import type {
  PlayableMediaCommand,
  PlayableMediaState,
  PlayableMove,
  PlayablePreviewOptions,
  PlayablePreviewTool,
  PlayableTextEdit,
  NodePlayerDefinition,
} from "../shared/playable-player-protocol.js";
import { isPlayableFrameMessage } from "../shared/playable-player-protocol.js";
import type { PlayablePickResult } from "../shared/playable-picker.js";
import type { NodeRuntimeSnapshot } from "../shared/playable-runtime.js";
import "./playable-player.css";

export interface NodePlayerProps {
  definition: NodePlayerDefinition;
  /**
   * The story's own page in the project preview. It keeps its saves on the
   * preview's origin, and the preview's editor bridge reports to the player.
   */
  page: string;
  title?: string;
  /** Authoring preview options; omit to play the story as a game. */
  preview?: PlayablePreviewOptions;
  /** Hands the preview's input to an authoring tool; requires `preview`. */
  tool?: PlayablePreviewTool;
  /** `additive` asks to add the element to the selection instead of replacing it. */
  onPick?: (pick: PlayablePickResult, additive: boolean) => void;
  onTextEdit?: (edit: PlayableTextEdit) => void;
  onMove?: (move: PlayableMove) => void;
  /** Called when the author leaves the tool (Escape in the frame). */
  onPickCancel?: () => void;
  onSnapshot?: (snapshot: NodeRuntimeSnapshot) => void;
  onDiagnostic?: (error: string) => void;
  /**
   * Called when the game cannot start. The caller then shows the error
   * itself; without it, the player shows the message over the stage.
   */
  onError?: (error: string) => void;
  /** Shown until the game starts. */
  loadingLabel?: string;
  /** The Node's background video as it plays, or undefined when it has none; requires `preview`. */
  onMedia?: (media: PlayableMediaState | undefined) => void;
  /** Set to a function that sends commands to the background video while the preview runs. */
  mediaControl?: RefObject<((command: PlayableMediaCommand) => void) | null>;
}

export function NodePlayer({
  definition,
  title = definition.graph.title,
  preview,
  page,
  tool,
  onPick,
  onTextEdit,
  onMove,
  onPickCancel,
  onSnapshot,
  onDiagnostic = reportDiagnostic,
  onError,
  loadingLabel = "Loading...",
  onMedia,
  mediaControl,
}: NodePlayerProps) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const player = useRef<HTMLElement>(null);
  const [scale, setScale] = useState<number>();
  // Keyed on content so callers need not memoize the preview object.
  const previewKey = JSON.stringify(preview ?? null);
  const instanceId = useMemo(
    () => `playable-${Date.now()}-${Math.random().toString(36).slice(2)}`,
    [definition, previewKey],
  );
  const [error, setError] = useState<string>();
  const [ready, setReady] = useState(false);

  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      if (
        event.source !== iframe.current?.contentWindow ||
        !isPlayableFrameMessage(event.data)
      )
        return;
      const message = event.data;
      if (message.instanceId !== instanceId) return;
      if (message.kind === "ohmygame:playable:snapshot") {
        setReady(true);
        onSnapshot?.(message.snapshot);
      } else if (message.kind === "ohmygame:playable:error") {
        setError(message.error);
      } else if (message.kind === "ohmygame:playable:picked") {
        onPick?.(message.pick, message.additive);
      } else if (message.kind === "ohmygame:playable:text-edited") {
        onTextEdit?.(message.edit);
      } else if (message.kind === "ohmygame:playable:moved") {
        onMove?.(message.move);
      } else if (message.kind === "ohmygame:playable:pick-cancelled") {
        onPickCancel?.();
      } else if (message.kind === "ohmygame:playable:media") {
        onMedia?.(message.media);
      } else if (message.kind === "ohmygame:playable:diagnostic") {
        onDiagnostic(message.error);
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [instanceId, onDiagnostic, onPick, onTextEdit, onMove, onPickCancel, onSnapshot, onMedia]);

  useEffect(() => {
    if (error !== undefined) onError?.(error);
  }, [error]);

  // A new session starts with no video until the frame reports one.
  useEffect(() => {
    if (preview === undefined) return;
    onMedia?.(undefined);
  }, [instanceId]);

  useEffect(() => {
    if (!mediaControl || preview === undefined) return;
    mediaControl.current = (command) => iframe.current?.contentWindow?.postMessage(
      { kind: "ohmygame:playable:media-control", instanceId, command },
      "*",
    );
    return () => { mediaControl.current = null; };
  }, [instanceId, mediaControl, previewKey]);

  const activeTool = preview !== undefined ? tool : undefined;
  useEffect(() => {
    if (!ready) return;
    iframe.current?.contentWindow?.postMessage(
      activeTool
        ? { kind: "ohmygame:playable:pick-start", instanceId, tool: activeTool }
        : { kind: "ohmygame:playable:pick-cancel", instanceId },
      "*",
    );
  }, [instanceId, activeTool, ready]);

  // Each instance (changed definition or preview options) loads the page afresh.
  const pageUrl = useMemo(() => {
    const url = new URL(page);
    url.searchParams.set("ohmygame-instance", instanceId);
    if (preview?.startNodeId) url.searchParams.set("scene", preview.startNodeId);
    if (preview?.policy === "report") url.searchParams.set("ohmygame-policy", "report");
    if (preview?.silent) url.searchParams.set("ohmygame-silent", "1");
    return url.href;
  }, [page, instanceId, previewKey]);

  // Nodes are always laid out at the project viewport and scaled to fit, so
  // a Node looks the same in the Workbench, a thumbnail, and any window.
  const { width, height } = definition.graph.viewport;
  useLayoutEffect(() => {
    const container = player.current;
    if (!container) return;
    const update = () => setScale(Math.min(container.clientWidth / width, container.clientHeight / height));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container);
    return () => observer.disconnect();
  }, [width, height]);

  const stageStyle: CSSProperties = scale === undefined
    ? { visibility: "hidden" }
    : { width: width * scale, height: height * scale };
  const canvasStyle: CSSProperties = { width, height, transform: `scale(${scale ?? 1})` };
  return (
    <main ref={player} className="playable-player">
      <div className="playable-player-stage" style={stageStyle}>
        <div className="playable-player-canvas" style={canvasStyle}>
          <iframe
            ref={iframe}
            className="playable-player-frame"
            src={pageUrl}
            // The page has its own preview origin and keeps its saves there.
            sandbox="allow-scripts allow-same-origin allow-pointer-lock"
            title={title}
          />
        </div>
        {!ready && !error ? (
          <div className="playable-player-status">{loadingLabel}</div>
        ) : null}
        {error && !onError ? (
          <div className="playable-player-status is-error" role="alert">
            {error}
          </div>
        ) : null}
      </div>
    </main>
  );
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function reportDiagnostic(error: string): void {
  console.error(`[Node Runtime] ${error}`);
}
