import { useEffect, useRef, useState } from "react";
import type { StorySurfaceFiles, StoryVariableValue } from "../shared/contracts.js";

export interface StorySceneSurfaceContext {
  node?: Record<string, unknown>;
  scene?: {
    id: string;
    title: string;
    mediaId?: string;
    mediaIndex: number;
    mediaCount: number;
    timeMs: number;
    durationMs: number;
    playing: boolean;
  };
  variables: Record<string, StoryVariableValue>;
}

export type StoryNodeSurfaceAction =
  | { type: "continue" }
  | { type: "choose"; optionId: string }
  | { type: "resolve"; result: string }
  | { type: "restart" }
  | { type: "menu" };

interface SceneSurfaceMessage {
  channel: "open-game:scene-surface";
  instanceId: string;
  type: "ready" | "error" | "action";
  action?: StoryNodeSurfaceAction;
  message?: string;
}

export function StorySceneSurface({ files, context, mode, title, className, onAction, onError }: {
  files: StorySurfaceFiles;
  context: StorySceneSurfaceContext;
  mode: "preview" | "runtime";
  title: string;
  className?: string;
  onAction?: (action: StoryNodeSurfaceAction) => void;
  onError?: (message?: string) => void;
}) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const [instanceId] = useState(() => crypto.randomUUID());
  const [loaded, setLoaded] = useState(false);
  const [ready, setReady] = useState(false);
  const onErrorRef = useRef(onError);
  const onActionRef = useRef(onAction);
  const contextRef = useRef(context);
  contextRef.current = context;
  useEffect(() => { onErrorRef.current = onError; }, [onError]);
  useEffect(() => { onActionRef.current = onAction; }, [onAction]);
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      if (event.source !== iframe.current?.contentWindow || !isSceneSurfaceMessage(event.data) || event.data.instanceId !== instanceId) return;
      if (event.data.type === "ready") {
        setReady(true);
        onErrorRef.current?.(undefined);
      } else if (event.data.type === "action" && event.data.action) {
        onActionRef.current?.(event.data.action);
      } else {
        onErrorRef.current?.(event.data.message ?? "Scene code failed");
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [instanceId]);
  useEffect(() => {
    if (!loaded) return;
    setReady(false);
    iframe.current?.contentWindow?.postMessage({ channel: "open-game:scene-surface", instanceId, type: "init", files, context: contextRef.current, mode }, "*");
  }, [files.css, files.html, files.javascript, instanceId, loaded, mode]);
  useEffect(() => {
    if (!loaded || !ready) return;
    iframe.current?.contentWindow?.postMessage({ channel: "open-game:scene-surface", instanceId, type: "update", context, mode }, "*");
  }, [context, instanceId, loaded, mode, ready]);
  return <iframe ref={iframe} className={className} title={title} sandbox="allow-scripts" src="scene-surface.html" onLoad={() => setLoaded(true)} />;
}

function isSceneSurfaceMessage(value: unknown): value is SceneSurfaceMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<SceneSurfaceMessage>;
  return message.channel === "open-game:scene-surface" && typeof message.instanceId === "string" && (message.type === "ready" || message.type === "error" || message.type === "action");
}
