import {
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type {
  PlayableAssetTransfer,
  PlayableFrameMessage,
  PlayablePreviewOptions,
  PlayablePreviewTool,
  PlayableTextEdit,
  NodePlayerDefinition,
} from "../shared/playable-player-protocol.js";
import { isPlayableFrameMessage } from "../shared/playable-player-protocol.js";
import type { PlayablePickResult } from "../shared/playable-picker.js";
import type { NodeRuntimeSnapshot } from "../shared/playable-runtime.js";
import { PLAYABLE_IFRAME_SANDBOX } from "../shared/playable-sandbox.js";
import "./playable-player.css";

export interface NodePlayerProps {
  definition: NodePlayerDefinition;
  assets: Readonly<Record<string, Blob>>;
  saveKey: string;
  title?: string;
  frameUrl?: string;
  storage?: Storage;
  /** Authoring preview options; omit in the Published Player. */
  preview?: PlayablePreviewOptions;
  /** Hands the preview's input to an authoring tool; requires `preview`. */
  tool?: PlayablePreviewTool;
  /** `additive` asks to add the element to the selection instead of replacing it. */
  onPick?: (pick: PlayablePickResult, additive: boolean) => void;
  onTextEdit?: (edit: PlayableTextEdit) => void;
  /** Called when the author leaves the tool (Escape in the frame). */
  onPickCancel?: () => void;
  onSnapshot?: (snapshot: NodeRuntimeSnapshot) => void;
  onDiagnostic?: (error: string) => void;
}

export function NodePlayer({
  definition,
  assets,
  saveKey,
  title = definition.graph.title,
  frameUrl = "./playable-sandbox.html",
  storage = window.localStorage,
  preview,
  tool,
  onPick,
  onTextEdit,
  onPickCancel,
  onSnapshot,
  onDiagnostic = reportDiagnostic,
}: NodePlayerProps) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const player = useRef<HTMLElement>(null);
  const frameLoaded = useRef(false);
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
      if (message.kind === "ohmygame:playable:save") {
        respondToSave(iframe.current, storage, saveKey, message);
      } else if (message.kind === "ohmygame:playable:snapshot") {
        setReady(true);
        onSnapshot?.(message.snapshot);
      } else if (message.kind === "ohmygame:playable:error") {
        setError(message.error);
      } else if (message.kind === "ohmygame:playable:picked") {
        onPick?.(message.pick, message.additive);
      } else if (message.kind === "ohmygame:playable:text-edited") {
        onTextEdit?.(message.edit);
      } else if (message.kind === "ohmygame:playable:pick-cancelled") {
        onPickCancel?.();
      } else {
        onDiagnostic(message.error);
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [instanceId, onDiagnostic, onPick, onTextEdit, onPickCancel, onSnapshot, saveKey, storage]);

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

  const initialize = async () => {
    const target = iframe.current?.contentWindow;
    if (!target) return;
    setError(undefined);
    setReady(false);
    try {
      const transferredAssets: Record<string, PlayableAssetTransfer> = {};
      const transfer: Transferable[] = [];
      for (const [id, blob] of Object.entries(assets)) {
        const bytes = await blob.arrayBuffer();
        transferredAssets[id] = {
          contentType: blob.type || "application/octet-stream",
          bytes,
        };
        transfer.push(bytes);
      }
      let save: unknown;
      const saved = storage.getItem(saveKey);
      if (saved !== null) {
        try {
          save = JSON.parse(saved) as unknown;
        } catch {
          storage.removeItem(saveKey);
        }
      }
      target.postMessage(
        {
          kind: "ohmygame:playable:init",
          instanceId,
          definition,
          assets: transferredAssets,
          save,
          ...(preview ? { preview } : {}),
        },
        "*",
        transfer,
      );
    } catch (cause) {
      setError(errorMessage(cause));
    }
  };

  // A new instance (changed definition or preview options) restarts the
  // session in the already-loaded frame.
  useEffect(() => {
    if (frameLoaded.current) void initialize();
  }, [instanceId]);

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
            src={frameUrl}
            sandbox={PLAYABLE_IFRAME_SANDBOX}
            title={title}
            onLoad={() => {
              frameLoaded.current = true;
              void initialize();
            }}
          />
        </div>
        {!ready && !error ? (
          <div className="playable-player-status">Loading...</div>
        ) : null}
        {error ? (
          <div className="playable-player-status is-error" role="alert">
            {error}
          </div>
        ) : null}
      </div>
    </main>
  );
}

function respondToSave(
  iframe: HTMLIFrameElement | null,
  storage: Storage,
  saveKey: string,
  message: Extract<PlayableFrameMessage, { kind: "ohmygame:playable:save" }>,
): void {
  let error: string | undefined;
  try {
    storage.setItem(saveKey, JSON.stringify(message.save));
  } catch (cause) {
    error = errorMessage(cause);
  }
  iframe?.contentWindow?.postMessage(
    {
      kind: "ohmygame:playable:save-result",
      instanceId: message.instanceId,
      requestId: message.requestId,
      error,
    },
    "*",
  );
}

function errorMessage(value: unknown): string {
  return value instanceof Error ? value.message : String(value);
}

function reportDiagnostic(error: string): void {
  console.error(`[Node Runtime] ${error}`);
}

/** Preview saves live in memory so a preview never touches the Playtest save. */
export function createMemoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => { values.delete(key); },
    setItem: (key, value) => { values.set(key, String(value)); },
  };
}
