import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties } from "react";
import type { StorySurfaceFiles, StoryOpenUiAction } from "../shared/contracts.js";

interface ScreenSurfaceMessage {
  channel: "ohmygame:screen-surface";
  instanceId: string;
  type: "action" | "error";
  action?: StoryOpenUiAction;
  message?: string;
}

export function StoryScreenSurface({ files, content, mode, title, className, designViewport, onAction, onError }: {
  files: StorySurfaceFiles;
  content: unknown;
  mode: "preview" | "runtime";
  title: string;
  className?: string;
  designViewport?: { width: number; height: number };
  onAction?: (action: StoryOpenUiAction) => void;
  onError?: (message: string) => void;
}) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const container = useRef<HTMLDivElement>(null);
  const [instanceId] = useState(() => crypto.randomUUID());
  const [loaded, setLoaded] = useState(false);
  const [scale, setScale] = useState(1);
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
  useLayoutEffect(() => {
    if (!designViewport || !container.current) return;
    const update = () => {
      const element = container.current;
      if (element) setScale(Math.min(element.clientWidth / designViewport.width, element.clientHeight / designViewport.height));
    };
    update();
    const observer = new ResizeObserver(update);
    observer.observe(container.current);
    return () => observer.disconnect();
  }, [designViewport?.height, designViewport?.width]);
  const frameStyle = designViewport ? {
    position: "absolute",
    top: "50%",
    left: "50%",
    width: designViewport.width,
    height: designViewport.height,
    border: 0,
    background: "transparent",
    transform: `translate(-50%, -50%) scale(${scale})`,
    transformOrigin: "center",
  } satisfies CSSProperties : undefined;
  const frame = <iframe ref={iframe} title={title} sandbox="allow-scripts" src="screen-surface.html" style={frameStyle} onLoad={() => setLoaded(true)} />;
  return designViewport
    ? <div ref={container} className={className} style={{ overflow: "hidden" }}>{frame}</div>
    : <iframe ref={iframe} className={className} title={title} sandbox="allow-scripts" src="screen-surface.html" onLoad={() => setLoaded(true)} />;
}

function isScreenSurfaceMessage(value: unknown): value is ScreenSurfaceMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<ScreenSurfaceMessage>;
  return message.channel === "ohmygame:screen-surface" && typeof message.instanceId === "string" && (message.type === "action" || message.type === "error");
}
