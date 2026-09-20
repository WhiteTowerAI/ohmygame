import { useEffect, useRef, useState } from "react";
import type { StoryInteractionCommand, StorySurfaceFiles, StoryVariableValue } from "../shared/contracts.js";
import { StorySurfaceViewport } from "./story-surface-viewport.js";

export interface StoryInteractionRuntimeContext {
  variables: Record<string, StoryVariableValue>;
}

interface EventSurfaceMessage {
  channel: "ohmygame:interaction-surface";
  instanceId: string;
  type: "complete" | "error";
  result?: string;
  commands?: StoryInteractionCommand[];
  message?: string;
}

export function StoryInteractionSurface({ files, mode, context, title, className, viewport, onComplete, onError }: {
  files: StorySurfaceFiles;
  mode: "preview" | "runtime";
  context?: StoryInteractionRuntimeContext;
  title: string;
  className?: string;
  viewport: { width: number; height: number };
  onComplete?: (result: string, commands: StoryInteractionCommand[]) => void;
  onError?: (message: string) => void;
}) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const [instanceId] = useState(() => crypto.randomUUID());
  const [loaded, setLoaded] = useState(false);
  const onCompleteRef = useRef(onComplete);
  const onErrorRef = useRef(onError);
  useEffect(() => { onCompleteRef.current = onComplete; }, [onComplete]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      if (event.source !== iframe.current?.contentWindow || !isSurfaceMessage(event.data) || event.data.instanceId !== instanceId) return;
      if (event.data.type === "complete") onCompleteRef.current?.(event.data.result ?? "continue", event.data.commands ?? []);
      else onErrorRef.current?.(event.data.message ?? "Interaction code failed");
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [instanceId]);
  useEffect(() => {
    if (!loaded) return;
    iframe.current?.contentWindow?.postMessage({ channel: "ohmygame:interaction-surface", instanceId, type: "init", files, mode, context }, "*");
  }, [context, files.css, files.html, files.javascript, instanceId, loaded, mode]);
  return <StorySurfaceViewport iframeRef={iframe} viewport={viewport} className={className} title={title} src="interaction-surface.html" onLoad={() => setLoaded(true)} />;
}

function isSurfaceMessage(value: unknown): value is EventSurfaceMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<EventSurfaceMessage>;
  return message.channel === "ohmygame:interaction-surface" && typeof message.instanceId === "string" && (message.type === "complete" || message.type === "error");
}
