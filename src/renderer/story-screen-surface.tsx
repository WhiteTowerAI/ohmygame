import { useEffect, useRef, useState } from "react";
import type { StorySurfaceFiles, StoryOpenUiAction } from "../shared/contracts.js";
import { StorySurfaceViewport } from "./story-surface-viewport.js";

interface ScreenSurfaceMessage {
  channel: "ohmygame:screen-surface";
  instanceId: string;
  type: "action" | "error";
  action?: StoryOpenUiAction;
  message?: string;
}

export function StoryScreenSurface({ files, content, mode, title, className, viewport, onAction, onError }: {
  files: StorySurfaceFiles;
  content: unknown;
  mode: "preview" | "runtime";
  title: string;
  className?: string;
  viewport: { width: number; height: number };
  onAction?: (action: StoryOpenUiAction) => void;
  onError?: (message: string) => void;
}) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const [instanceId] = useState(() => crypto.randomUUID());
  const [loaded, setLoaded] = useState(false);
  const onActionRef = useRef(onAction);
  const onErrorRef = useRef(onError);
  useEffect(() => { onActionRef.current = onAction; }, [onAction]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      if (event.source !== iframe.current?.contentWindow || !isScreenSurfaceMessage(event.data) || event.data.instanceId !== instanceId) return;
      if (event.data.type === "action" && event.data.action) onActionRef.current?.(event.data.action);
      else if (event.data.type === "error") onErrorRef.current?.(event.data.message ?? "Screen code failed");
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [instanceId]);
  useEffect(() => {
    if (!loaded) return;
    iframe.current?.contentWindow?.postMessage({ channel: "ohmygame:screen-surface", instanceId, type: "init", files, content, mode }, "*");
  }, [content, files.css, files.html, files.javascript, instanceId, loaded, mode]);
  return <StorySurfaceViewport iframeRef={iframe} viewport={viewport} className={className} title={title} src="screen-surface.html" onLoad={() => setLoaded(true)} />;
}

function isScreenSurfaceMessage(value: unknown): value is ScreenSurfaceMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<ScreenSurfaceMessage>;
  return message.channel === "ohmygame:screen-surface" && typeof message.instanceId === "string" && (message.type === "action" || message.type === "error");
}
