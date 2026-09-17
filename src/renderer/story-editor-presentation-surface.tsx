import { useEffect, useRef, useState } from "react";

export interface StoryEditorPresentationNode {
  id: string;
  type: string;
  data: Record<string, unknown>;
  editor?: { kind: string; properties?: Record<string, unknown> };
}

export type StoryEditorPresentationRegion = "workspace" | "toolbar" | "node" | "inspector" | "preview" | "timeline";

export interface StoryEditorCommand {
  id: string;
  type: "replace-story" | "set-view" | "set-layout-state" | "open-node" | "close-node" | "playtest" | "undo" | "redo" | "use-default-editor";
  payload?: unknown;
}

interface PresentationSurfaceMessage {
  channel: "open-game:editor-presentation";
  instanceId: string;
  type: "result" | "error" | "command";
  rendered?: boolean;
  replace?: boolean;
  height?: number;
  message?: string;
  command?: StoryEditorCommand;
  regions?: StoryEditorPresentationRegion[];
}

export function StoryEditorPresentationSurface({ source, styles, region, node, context, className, interactive = false, onResult, onCommand, onError }: {
  source?: string;
  styles?: string;
  region: StoryEditorPresentationRegion;
  node: StoryEditorPresentationNode;
  context?: Record<string, unknown>;
  className?: string;
  interactive?: boolean;
  onResult: (result: { rendered: boolean; replace: boolean; regions?: StoryEditorPresentationRegion[] }) => void;
  onCommand?: (command: StoryEditorCommand) => Promise<unknown> | unknown;
  onError?: (message: string) => void;
}) {
  const iframe = useRef<HTMLIFrameElement>(null);
  const [instanceId] = useState(() => crypto.randomUUID());
  const [loaded, setLoaded] = useState(false);
  const [height, setHeight] = useState(1);
  const onResultRef = useRef(onResult);
  const onErrorRef = useRef(onError);
  const onCommandRef = useRef(onCommand);
  useEffect(() => { onResultRef.current = onResult; }, [onResult]);
  useEffect(() => { onErrorRef.current = onError; }, [onError]);
  useEffect(() => { onCommandRef.current = onCommand; }, [onCommand]);
  useEffect(() => {
    const receive = (event: MessageEvent<unknown>) => {
      if (event.source !== iframe.current?.contentWindow || !isPresentationMessage(event.data) || event.data.instanceId !== instanceId) return;
      if (event.data.type === "error") {
        onResultRef.current({ rendered: false, replace: false });
        onErrorRef.current?.(event.data.message ?? "Editor presentation failed");
        return;
      }
      if (event.data.type === "command" && event.data.command) {
        const command = event.data.command;
        void Promise.resolve(onCommandRef.current?.(command)).then(
          (result) => iframe.current?.contentWindow?.postMessage({ channel: "open-game:editor-presentation", instanceId, type: "command-result", commandId: command.id, ok: true, result }, "*"),
          (cause) => iframe.current?.contentWindow?.postMessage({ channel: "open-game:editor-presentation", instanceId, type: "command-result", commandId: command.id, ok: false, message: cause instanceof Error ? cause.message : String(cause) }, "*"),
        );
        return;
      }
      setHeight(Math.max(1, Math.min(region === "node" ? 720 : 2_000, event.data.height ?? 1)));
      onResultRef.current({ rendered: Boolean(event.data.rendered), replace: Boolean(event.data.replace), regions: event.data.regions });
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [instanceId, region]);
  useEffect(() => {
    if (!loaded || !source) return;
    iframe.current?.contentWindow?.postMessage({ channel: "open-game:editor-presentation", instanceId, type: "render", source, styles, region, node, context }, "*");
  }, [context, instanceId, loaded, node, region, source, styles]);
  if (!source) return null;
  return <iframe
    ref={iframe}
    className={className}
    data-interactive={interactive ? "true" : "false"}
    title={`Custom ${region} presentation`}
    sandbox="allow-scripts"
    src="editor-presentation-surface.html"
    style={{ height }}
    onLoad={() => setLoaded(true)}
  />;
}

function isPresentationMessage(value: unknown): value is PresentationSurfaceMessage {
  if (!value || typeof value !== "object") return false;
  const message = value as Partial<PresentationSurfaceMessage>;
  return message.channel === "open-game:editor-presentation" && typeof message.instanceId === "string" && (message.type === "result" || message.type === "error" || message.type === "command");
}
