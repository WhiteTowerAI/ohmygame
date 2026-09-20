import { useEffect, useRef, useState } from "react";
import type { StoryInteractionCommand, StorySurfaceFiles, StoryVariableValue } from "../shared/contracts.js";
import { transparentStorySurfaceFiles } from "../shared/story.js";
import { StorySurfaceViewport } from "./story-surface-viewport.js";

export interface StoryInteractionRuntimeContext {
  variables: Record<string, StoryVariableValue>;
}

interface EventSurfaceMessage {
  channel: "ohmygame:interaction-surface";
  instanceId: string;
  type: "ready" | "complete" | "error";
  result?: string;
  commands?: StoryInteractionCommand[];
  message?: string;
}

export function StoryInteractionSurface({ files, mode, context, title, className, viewport, onReady, onComplete, onError }: {
  files: StorySurfaceFiles;
  mode: "preview" | "runtime";
  context?: StoryInteractionRuntimeContext;
  title: string;
  className?: string;
  viewport: { width: number; height: number };
  onReady?: () => void;
  onComplete?: (result: string, commands: StoryInteractionCommand[]) => void;
  onError?: (message: string) => void;
}) {
  const surfaceFiles = transparentStorySurfaceFiles(files);
  const iframe = useRef<HTMLIFrameElement>(null);
  const [instanceId] = useState(() => crypto.randomUUID());
  const [loaded, setLoaded] = useState(false);
  const onReadyRef = useRef(onReady);
  const onCompleteRef = useRef(onComplete);
  const onErrorRef = useRef(onError);
  onReadyRef.current = onReady;
  onCompleteRef.current = onComplete;
  onErrorRef.current = onError;
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      if (event.source !== iframe.current?.contentWindow || !isSurfaceMessage(event.data) || event.data.instanceId !== instanceId) return;
      if (event.data.type === "ready") onReadyRef.current?.();
      else if (event.data.type === "complete") onCompleteRef.current?.(event.data.result ?? "continue", event.data.commands ?? []);
      else {
        onErrorRef.current?.(event.data.message ?? "Interaction code failed");
        onReadyRef.current?.();
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [instanceId]);
  useEffect(() => {
    if (!loaded) return;
    iframe.current?.contentWindow?.postMessage({ channel: "ohmygame:interaction-surface", instanceId, type: "init", files: surfaceFiles, mode, context }, "*");
  }, [context, instanceId, loaded, mode, surfaceFiles.css, surfaceFiles.html, surfaceFiles.javascript]);
  return <StorySurfaceViewport iframeRef={iframe} viewport={viewport} className={className} title={title} src="interaction-surface.html" onLoad={() => setLoaded(true)} />;
}

function isSurfaceMessage(value: unknown): value is EventSurfaceMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<EventSurfaceMessage>;
  return message.channel === "ohmygame:interaction-surface" && typeof message.instanceId === "string" && (message.type === "ready" || message.type === "complete" || message.type === "error");
}
