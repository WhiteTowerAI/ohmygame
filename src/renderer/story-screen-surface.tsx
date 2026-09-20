import { useEffect, useRef, useState } from "react";
import type { StorySurfaceFiles, StoryOpenUiAction } from "../shared/contracts.js";
import { transparentStorySurfaceFiles } from "../shared/story.js";
import { StorySurfaceViewport } from "./story-surface-viewport.js";

interface ScreenSurfaceMessage {
  channel: "ohmygame:screen-surface";
  instanceId: string;
  type: "ready" | "action" | "error";
  action?: StoryOpenUiAction;
  message?: string;
}

export function StoryScreenSurface({ files, content, mode, title, className, viewport, onReady, onAction, onError }: {
  files: StorySurfaceFiles;
  content: unknown;
  mode: "preview" | "runtime";
  title: string;
  className?: string;
  viewport: { width: number; height: number };
  onReady?: () => void;
  onAction?: (action: StoryOpenUiAction) => void;
  onError?: (message: string) => void;
}) {
  const surfaceFiles = transparentStorySurfaceFiles(files, ".open-ui");
  const iframe = useRef<HTMLIFrameElement>(null);
  const [instanceId] = useState(() => crypto.randomUUID());
  const [loadRevision, setLoadRevision] = useState(0);
  const onReadyRef = useRef(onReady);
  const onActionRef = useRef(onAction);
  const onErrorRef = useRef(onError);
  onReadyRef.current = onReady;
  onActionRef.current = onAction;
  onErrorRef.current = onError;
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      if (event.source !== iframe.current?.contentWindow || !isScreenSurfaceMessage(event.data) || event.data.instanceId !== instanceId) return;
      if (event.data.type === "ready") onReadyRef.current?.();
      else if (event.data.type === "action" && event.data.action) onActionRef.current?.(event.data.action);
      else if (event.data.type === "error") {
        onErrorRef.current?.(event.data.message ?? "Screen code failed");
        onReadyRef.current?.();
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [instanceId]);
  useEffect(() => {
    if (!loadRevision) return;
    iframe.current?.contentWindow?.postMessage({ channel: "ohmygame:screen-surface", instanceId, type: "init", files: surfaceFiles, content, mode }, "*");
  }, [content, instanceId, loadRevision, mode, surfaceFiles.css, surfaceFiles.html, surfaceFiles.javascript]);
  return <StorySurfaceViewport iframeRef={iframe} viewport={viewport} className={className} title={title} src="screen-surface.html" onLoad={() => setLoadRevision((current) => current + 1)} />;
}

function isScreenSurfaceMessage(value: unknown): value is ScreenSurfaceMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<ScreenSurfaceMessage>;
  return message.channel === "ohmygame:screen-surface" && typeof message.instanceId === "string" && (message.type === "ready" || message.type === "action" || message.type === "error");
}
