import { useEffect, useRef, useState } from "react";
import type { StoryInteractionCommand, StorySurfaceFiles, StoryVariableValue } from "../shared/contracts.js";
import { transparentStorySurfaceFiles } from "../shared/story.js";
import { StorySurfaceViewport } from "./story-surface-viewport.js";

export interface StoryInteractionRuntimeContext {
  variables: Record<string, StoryVariableValue>;
  variableDefinitions: Array<{ id: string; name: string; type: "boolean" | "number" | "text" }>;
}

type EventSurfaceMessage =
  | { channel: "ohmygame:interaction-surface"; instanceId: string; type: "ready" }
  | { channel: "ohmygame:interaction-surface"; instanceId: string; type: "complete"; result: string; commands: StoryInteractionCommand[] }
  | { channel: "ohmygame:interaction-surface"; instanceId: string; type: "error"; message: string };

export function StoryInteractionSurface({ files, outcomes, mode, context, active = true, paused = false, title, className, viewport, onReady, onComplete, onError }: {
  files: StorySurfaceFiles;
  outcomes: string[];
  mode: "preview" | "runtime";
  context?: StoryInteractionRuntimeContext;
  active?: boolean;
  paused?: boolean;
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
      else if (event.data.type === "complete") onCompleteRef.current?.(event.data.result, event.data.commands);
      else {
        onErrorRef.current?.(event.data.message);
        onReadyRef.current?.();
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [instanceId]);
  useEffect(() => {
    if (!loaded) return;
    iframe.current?.contentWindow?.postMessage({ channel: "ohmygame:interaction-surface", instanceId, type: "init", files: surfaceFiles, outcomes, mode, context, active, paused }, "*");
  }, [context, instanceId, loaded, mode, outcomes, surfaceFiles.css, surfaceFiles.html, surfaceFiles.javascript]);
  useEffect(() => {
    if (!loaded) return;
    iframe.current?.contentWindow?.postMessage({ channel: "ohmygame:interaction-surface", instanceId, type: "lifecycle", active, paused }, "*");
  }, [active, instanceId, loaded, paused]);
  return <StorySurfaceViewport iframeRef={iframe} viewport={viewport} className={className} title={title} src="interaction-surface.html" onLoad={() => setLoaded(true)} />;
}

function isSurfaceMessage(value: unknown): value is EventSurfaceMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<EventSurfaceMessage>;
  if (message.channel !== "ohmygame:interaction-surface" || typeof message.instanceId !== "string") return false;
  if (message.type === "ready") return true;
  if (message.type === "error") return typeof message.message === "string";
  return message.type === "complete" && typeof message.result === "string" && Array.isArray(message.commands);
}
