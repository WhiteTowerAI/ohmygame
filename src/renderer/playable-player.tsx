import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import type {
  PlayableAssetTransfer,
  PlayableFrameMessage,
  PlayablePreviewOptions,
  NodePlayerDefinition,
} from "../shared/playable-player-protocol.js";
import { isPlayableFrameMessage } from "../shared/playable-player-protocol.js";
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
  onSnapshot,
  onDiagnostic = reportDiagnostic,
}: NodePlayerProps) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const frameLoaded = useRef(false);
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
      } else {
        onDiagnostic(message.error);
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [instanceId, onDiagnostic, onSnapshot, saveKey, storage]);

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

  const ratio =
    definition.graph.viewport.width / definition.graph.viewport.height;
  const style = { "--playable-aspect-ratio": String(ratio) } as CSSProperties;
  return (
    <main className="playable-player" style={style}>
      <div className="playable-player-stage">
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
