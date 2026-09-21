import { useEffect, useRef, useState } from "react";
import type { StoryOpenUiAction, StorySurfaceFiles, StorySurfaceLayout, StorySurfaceLayoutOffset } from "../shared/contracts.js";
import { transparentStorySurfaceFiles } from "../shared/story.js";
import { StorySurfaceViewport } from "./story-surface-viewport.js";

type ScreenSurfaceMessage =
  | { channel: "ohmygame:screen-surface"; instanceId: string; type: "ready" }
  | { channel: "ohmygame:screen-surface"; instanceId: string; type: "action"; action: StoryOpenUiAction }
  | { channel: "ohmygame:screen-surface"; instanceId: string; type: "error"; message: string }
  | { channel: "ohmygame:screen-surface"; instanceId: string; type: "layout-select"; elementId: string | null }
  | { channel: "ohmygame:screen-surface"; instanceId: string; type: "layout-change"; elementId: string; offset: StorySurfaceLayoutOffset };

export function StoryScreenSurface({ files, content, mode, layout, layoutEditable = false, title, className, onReady, onAction, onError, onLayoutSelect, onLayoutChange }: {
  files: StorySurfaceFiles;
  content: unknown;
  mode: "preview" | "runtime";
  layout?: StorySurfaceLayout;
  layoutEditable?: boolean;
  title: string;
  className?: string;
  onReady?: () => void;
  onAction?: (action: StoryOpenUiAction) => void;
  onError?: (message: string) => void;
  onLayoutSelect?: (elementId?: string) => void;
  onLayoutChange?: (elementId: string, offset: StorySurfaceLayoutOffset) => void;
}) {
  const surfaceFiles = transparentStorySurfaceFiles(files, ".open-ui");
  const iframe = useRef<HTMLIFrameElement>(null);
  const [instanceId] = useState(() => crypto.randomUUID());
  const [loadRevision, setLoadRevision] = useState(0);
  const onReadyRef = useRef(onReady);
  const onActionRef = useRef(onAction);
  const onErrorRef = useRef(onError);
  const onLayoutSelectRef = useRef(onLayoutSelect);
  const onLayoutChangeRef = useRef(onLayoutChange);
  onReadyRef.current = onReady;
  onActionRef.current = onAction;
  onErrorRef.current = onError;
  onLayoutSelectRef.current = onLayoutSelect;
  onLayoutChangeRef.current = onLayoutChange;
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      if (event.source !== iframe.current?.contentWindow || !isScreenSurfaceMessage(event.data) || event.data.instanceId !== instanceId) return;
      if (event.data.type === "ready") onReadyRef.current?.();
      else if (event.data.type === "action") onActionRef.current?.(event.data.action);
      else if (event.data.type === "layout-select") onLayoutSelectRef.current?.(event.data.elementId ?? undefined);
      else if (event.data.type === "layout-change") onLayoutChangeRef.current?.(event.data.elementId, event.data.offset);
      else {
        onErrorRef.current?.(event.data.message);
        onReadyRef.current?.();
      }
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [instanceId]);
  useEffect(() => {
    if (!loadRevision) return;
    iframe.current?.contentWindow?.postMessage({ channel: "ohmygame:screen-surface", instanceId, type: "init", files: surfaceFiles, content, mode, layout: layout ?? {}, layoutEditable }, "*");
  }, [content, instanceId, loadRevision, mode, surfaceFiles.css, surfaceFiles.html, surfaceFiles.javascript]);
  useEffect(() => {
    if (!loadRevision) return;
    iframe.current?.contentWindow?.postMessage({ channel: "ohmygame:screen-surface", instanceId, type: "layout", layout: layout ?? {} }, "*");
  }, [instanceId, layout, loadRevision]);
  useEffect(() => {
    if (!loadRevision) return;
    iframe.current?.contentWindow?.postMessage({ channel: "ohmygame:screen-surface", instanceId, type: "layout-editing", editable: layoutEditable }, "*");
  }, [instanceId, layoutEditable, loadRevision]);
  return <StorySurfaceViewport iframeRef={iframe} className={className} title={title} src="screen-surface.html" onLoad={() => setLoadRevision((current) => current + 1)} />;
}

function isScreenSurfaceMessage(value: unknown): value is ScreenSurfaceMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<ScreenSurfaceMessage>;
  if (message.channel !== "ohmygame:screen-surface" || typeof message.instanceId !== "string") return false;
  if (message.type === "ready") return true;
  if (message.type === "action") return message.action === "enter-game";
  if (message.type === "error") return typeof message.message === "string";
  if (message.type === "layout-select") return message.elementId === null || isLayoutElementId(message.elementId);
  return message.type === "layout-change" && isLayoutElementId(message.elementId) && isLayoutOffset(message.offset);
}

function isLayoutElementId(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0 && value.length <= 120;
}

function isLayoutOffset(value: unknown): value is StorySurfaceLayoutOffset {
  if (!value || typeof value !== "object") return false;
  const offset = value as Partial<StorySurfaceLayoutOffset>;
  return typeof offset.offsetX === "number" && Number.isFinite(offset.offsetX) && typeof offset.offsetY === "number" && Number.isFinite(offset.offsetY);
}
