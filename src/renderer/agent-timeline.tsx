import {
  Check,
  ChevronRight,
  Copy,
  FilePenLine,
  FileText,
  Gamepad2,
  Image,
  Layers3,
  LoaderCircle,
  Pencil,
  Plug,
  Search,
  Terminal,
  Wrench,
  Wifi,
  WifiOff,
  X,
  type IconComponent,
} from "./icons.js";
import { createContext, useContext, useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import type { ConversationAttachment, PromptImage, ThreadItem, ThreadItemError, ToolArtifact, Turn as ThreadTurn } from "../shared/contracts.js";
import { getWorkspaceAsset } from "./api.js";
import { imageSource } from "./image-attachments.js";
import { mcpToolBrand, mcpToolLabel } from "./mcp-tool-presentation.js";
import { ModelPreview } from "./model-preview.js";
import { formatBytes } from "./format-bytes.js";
import { toolGroupSummary, type ToolItem } from "./work-items.js";
import { projectTurnDisplay, type TurnDisplay } from "./turn-display.js";
import { SelectedTextMenu } from "./selected-text-menu.js";
import { GodotIcon } from "./godot-icon.js";
import { MarkdownContent } from "./markdown-content.js";

type ToolCallItem = Extract<ThreadItem, { type: "dynamicToolCall" | "mcpToolCall" }>;

interface AgentTimelineProps {
  turns: ThreadTurn[];
  projectId?: string;
  workspacePath?: string;
  onOpenWorkspaceFile?: (path: string) => void;
  revisionDisabled?: boolean;
  onRevise?: (prompt: string) => Promise<boolean>;
  onAddToChat?: (text: string) => void;
  waitingForInput?: boolean;
}

const WorkspaceLinkContext = createContext<{ workspacePath?: string; onOpenWorkspaceFile?: (path: string) => void }>({});

export function AgentTimeline({ turns, projectId = "", workspacePath, onOpenWorkspaceFile, revisionDisabled, onRevise, onAddToChat, waitingForInput = false }: AgentTimelineProps) {
  const [selectionRoot, setSelectionRoot] = useState<HTMLDivElement | null>(null);
  const [now, setNow] = useState(Date.now());
  const [editingItemId, setEditingItemId] = useState<string>();
  const [draft, setDraft] = useState("");
  const [copiedItemId, setCopiedItemId] = useState<string>();
  const [copiedAssistantId, setCopiedAssistantId] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const active = turns.some((turn) => turn.status === "inProgress");
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);

  const displays = turns.map((turn) => projectTurnDisplay(turn, now, waitingForInput));
  const activeIndex = turns.findIndex((turn) => turn.status === "inProgress");
  const latestSteeringIndex = turns.findLastIndex((turn) => turn.steering);
  const steeringPending = activeIndex >= 0 && latestSteeringIndex > activeIndex;
  const latestUserId = [...turns].reverse().flatMap((turn) => turn.items).find((item) => item.type === "userMessage")?.id;
  const latestAssistantId = displays
    .flatMap((display) => display.finalMessages)
    .findLast((item) => item.status === "completed" && Boolean(item.text.trim()))
    ?.id;
  useEffect(() => {
    if (editingItemId && editingItemId !== latestUserId) setEditingItemId(undefined);
  }, [editingItemId, latestUserId]);

  async function copy(item: Extract<ThreadItem, { type: "userMessage" }>) {
    if (!item.text) return;
    try {
      await navigator.clipboard.writeText(item.text);
    } catch {
      return;
    }
    setCopiedItemId(item.id);
    window.setTimeout(() => setCopiedItemId((current) => current === item.id ? undefined : current), 1_500);
  }

  async function copyAssistant(id: string, text: string) {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setCopiedAssistantId(id);
    window.setTimeout(() => setCopiedAssistantId((current) => current === id ? undefined : current), 1_500);
  }

  function edit(item: Extract<ThreadItem, { type: "userMessage" }>) {
    setEditingItemId(item.id);
    setDraft(item.text);
  }

  async function submitRevision() {
    if (!onRevise || submitting || revisionDisabled || !draft.trim()) return;
    setSubmitting(true);
    try {
      if (await onRevise(draft)) setEditingItemId(undefined);
    } finally {
      setSubmitting(false);
    }
  }

  return (
    <WorkspaceLinkContext.Provider value={{ workspacePath, onOpenWorkspaceFile }}>
      <div className="agent-timeline-selection-root" ref={setSelectionRoot}>
        {turns.map((turn, index) => (
          <Turn
            key={turn.id}
            projectId={projectId}
            display={displays[index]}
            now={now}
            steeringPending={steeringPending && index === latestSteeringIndex}
            assistantControls={{
              copiedItemId: copiedAssistantId,
              latestItemId: latestAssistantId,
              onCopy: copyAssistant,
            }}
            userControls={{
              editing: displays[index].user?.id === editingItemId && editingItemId === latestUserId,
              draft,
              copied: displays[index].user?.id === copiedItemId,
              canEdit: Boolean(onRevise && displays[index].user?.text && displays[index].user?.id === latestUserId),
              disabled: Boolean(revisionDisabled || submitting),
              onCopy: copy,
              onEdit: edit,
              onDraftChange: setDraft,
              onCancel: () => setEditingItemId(undefined),
              onSubmit: submitRevision,
            }}
          />
        ))}
        {onAddToChat ? <SelectedTextMenu root={selectionRoot} onAdd={onAddToChat} /> : null}
      </div>
    </WorkspaceLinkContext.Provider>
  );
}

interface UserControls {
  editing: boolean;
  copied: boolean;
  canEdit: boolean;
  disabled: boolean;
  draft: string;
  onCopy: (item: Extract<ThreadItem, { type: "userMessage" }>) => void;
  onEdit: (item: Extract<ThreadItem, { type: "userMessage" }>) => void;
  onDraftChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

interface AssistantControls {
  copiedItemId?: string;
  latestItemId?: string;
  onCopy: (id: string, text: string) => void;
}

function Turn({ display, projectId, now, steeringPending = false, userControls, assistantControls }: {
  display: TurnDisplay;
  projectId: string;
  now: number;
  steeringPending?: boolean;
  userControls: UserControls;
  assistantControls: AssistantControls;
}) {
  return (
    <article className="agent-turn">
      <UserInput item={display.user} controls={userControls} />
      {display.status === "inProgress" ? <ActiveWork display={display} now={now} /> : null}
      {display.status !== "inProgress" && (display.work.length > 0 || display.status === "cancelled") ? <CompletedWork display={display} /> : null}
      {display.messages.map((item) => <TimelineItem key={item.id} item={item} />)}
      {display.finalMessages.length > 0
        ? <FinalResponse projectId={projectId} items={display.finalMessages} artifacts={display.artifacts} controls={assistantControls} />
        : display.artifacts.length > 0 ? <ArtifactPreviews projectId={projectId} artifacts={display.artifacts} /> : null}
      {steeringPending ? <SteeringActivity /> : null}
    </article>
  );
}

function SteeringActivity() {
  return (
    <div className="thinking-activity" role="status">
      <ShimmerText text="Waiting to steer" />
    </div>
  );
}

function FinalResponse({ projectId, items, artifacts, controls }: {
  projectId: string;
  items: Extract<ThreadItem, { type: "agentMessage" }>[];
  artifacts: ToolArtifact[];
  controls: AssistantControls;
}) {
  const copyable = items.filter((item) => item.status === "completed" && Boolean(item.text.trim()));
  const responseId = copyable.at(-1)?.id;
  const text = copyable.map((item) => item.text).join("\n\n");
  const timestamp = copyable.at(-1)?.timestamp;
  return (
    <div className={`assistant-response${responseId === controls.latestItemId ? " assistant-response-latest" : ""}`}>
      {items.map((item) => <TimelineItem key={item.id} item={item} />)}
      {artifacts.length > 0 ? <ArtifactPreviews projectId={projectId} artifacts={artifacts} /> : null}
      {responseId ? (
        <div className="assistant-response-footer">
          <button type="button" aria-label="Copy response" title="Copy" onClick={() => controls.onCopy(responseId, text)}>
            {responseId === controls.copiedItemId ? <Check size={13} /> : <Copy size={13} />}
          </button>
          {timestamp ? <time dateTime={new Date(timestamp).toISOString()}>{formatResponseTime(timestamp)}</time> : null}
        </div>
      ) : null}
    </div>
  );
}

function formatResponseTime(timestamp: number): string {
  return new Intl.DateTimeFormat(undefined, {
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
  }).format(timestamp);
}

function UserInput({ item, controls }: { item: Extract<ThreadItem, { type: "userMessage" }> | undefined; controls: UserControls }) {
  if (!item) return null;
  const visualAttachmentNames = new Set(item.images?.map((image) => image.name).filter((name): name is string => Boolean(name)) ?? []);
  const attachments = item.attachments?.filter((attachment) => !visualAttachmentNames.has(attachment.relativePath)) ?? [];
  function keyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    controls.onSubmit();
  }
  return (
    <div className="user-input">
      {item.images?.length ? (
        <div className="user-message-images">
          {item.images.map((image, index) => <img key={`${image.mediaType}:${index}`} src={imageSource(image)} alt={`Attached image ${index + 1}`} />)}
        </div>
      ) : null}
      {attachments.length ? <UserAttachments attachments={attachments} /> : null}
      {controls.editing ? (
        <div className="user-message-editor">
          <textarea
            autoFocus
            value={controls.draft}
            onChange={(event) => controls.onDraftChange(event.target.value)}
            onFocus={(event) => {
              const end = event.currentTarget.value.length;
              event.currentTarget.setSelectionRange(end, end);
            }}
            onKeyDown={keyDown}
            disabled={controls.disabled}
            aria-label="Edit message"
          />
          <div className="user-message-editor-actions">
            <button type="button" onClick={controls.onCancel} disabled={controls.disabled}>Cancel</button>
            <button className="primary" type="button" onClick={controls.onSubmit} disabled={controls.disabled || !controls.draft.trim()}>Send</button>
          </div>
        </div>
      ) : item.text ? (
        <>
          <div className="user-message">{item.text}</div>
          <div className="user-message-actions">
            <button type="button" aria-label="Copy message" title="Copy" onClick={() => controls.onCopy(item)}>
              {controls.copied ? <Check size={13} /> : <Copy size={13} />}
            </button>
            {controls.canEdit ? (
              <button type="button" aria-label="Edit message" title="Edit" onClick={() => controls.onEdit(item)} disabled={controls.disabled}>
                <Pencil size={13} />
              </button>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

function UserAttachments({ attachments }: { attachments: ConversationAttachment[] }) {
  return <div className="user-message-attachments" aria-label="Attached files">
    {attachments.map((attachment, index) => <div className="user-message-attachment" key={`${attachment.relativePath}:${index}`} title={`${attachment.relativePath} · ${formatBytes(attachment.size)}`}>
      <FileText size={13} />
      <span>{attachment.relativePath}</span>
      <small>{attachment.kind}</small>
    </div>)}
  </div>;
}

function ShimmerText({ text, active = true, className, title, role }: {
  text: string;
  active?: boolean;
  className?: string;
  title?: string;
  role?: "status";
}) {
  const classes = [className, active ? "activity-shimmer" : undefined].filter(Boolean).join(" ") || undefined;
  return (
    <span className={classes} title={title} role={role}>
      {text}
      {active ? <span className="activity-shimmer-highlight" aria-hidden="true">{text}</span> : null}
    </span>
  );
}

function ActiveWork({ display, now }: { display: TurnDisplay; now: number }) {
  const label = display.working ? `Working for ${activeTurnDuration(display, now)}` : "Thinking";
  return (
    <section className="work-activity work-activity-active">
      <div className={`work-summary work-summary-active${display.working ? "" : " work-summary-thinking"}`}>
        <ShimmerText text={label} active={!display.working} />
      </div>
      {display.work.length > 0 ? (
        <div className="active-work-items">
          <WorkItems items={display.work} images={display.user?.images} />
        </div>
      ) : null}
    </section>
  );
}

function CompletedWork({ display }: { display: TurnDisplay }) {
  const content = <div className="work-items">
    <WorkItems items={display.work} images={display.user?.images} failed={display.status === "failed"} />
    {display.status === "cancelled" && display.work.length === 0 ? (
      <div className="stopped-work-note">{display.hadThinking ? "Stopped while thinking" : "Stopped before work began"}</div>
    ) : null}
  </div>;
  if (display.status === "cancelled" || display.status === "failed") {
    return (
      <section className={`work-activity ${display.status === "cancelled" ? "work-activity-stopped" : "work-activity-failed"}`}>
        <div className={`work-summary ${display.status === "cancelled" ? "work-summary-stopped" : "work-summary-failed"}`}>
          <span>{display.status === "cancelled" ? `You stopped after ${turnDuration(display)}` : `Worked for ${turnDuration(display)}`}</span>
        </div>
        {content}
      </section>
    );
  }
  return (
    <details className="work-activity">
      <summary className="work-summary">
        <span>Worked for {turnDuration(display)}</span>
        <ChevronRight className="work-chevron" size={13} />
      </summary>
      {content}
    </details>
  );
}

function WorkItems({ items, images, failed = false }: { items: TurnDisplay["work"]; images?: PromptImage[]; failed?: boolean }) {
  const rendered = items.map((item) => {
    if (item.kind === "tool-group") return <ToolActivityGroup key={item.id} tools={item.tools} thinking={item.thinking} />;
    if (item.kind === "thinking") return <ThinkingActivity key={item.id} />;
    return <TimelineItem
      key={item.item.id}
      item={item.item}
      images={item.item.type === "imageRead" ? images : undefined}
      hideError={item.item.type === "agentMessage" && Boolean(item.item.error)}
    />;
  });
  if (failed) {
    const hasFailedRetry = items.some((item) => item.kind === "item" && item.item.type === "retry" && item.item.status === "failed");
    const error = items.flatMap((item) => item.kind === "item" && item.item.type === "agentMessage" && item.item.error ? [item.item] : []).at(-1);
    if (!hasFailedRetry && error?.type === "agentMessage" && error.error) {
      rendered.push(<ConnectionActivity key="turn-connection-error" title="Connection error" error={error.error} failed />);
    }
  }
  return rendered;
}

function ToolActivityGroup({ tools, thinking }: { tools: ToolItem[]; thinking: boolean }) {
  const runningTool = tools.findLast((tool) => tool.status === "preparing" || tool.status === "inProgress");
  const runningPresentation = runningTool ? toolPresentation(runningTool) : undefined;
  const Icon = runningPresentation?.icon ?? toolGroupIcon(tools);
  const runningLabel = runningTool && runningPresentation ? runningToolGroupLabel(runningTool, runningPresentation.label) : undefined;
  const showThinking = thinking && !runningTool;
  const summaryLabel = showThinking ? "Thinking" : runningLabel ?? toolGroupSummary(tools);
  return (
    <details className="tool-activity-group">
      <summary className={`tool-group-summary${showThinking ? " tool-group-summary-thinking" : ""}`}>
        {showThinking ? null : <Icon size={13} aria-hidden="true" />}
        <ShimmerText text={summaryLabel} active={Boolean(runningTool || showThinking)} className="tool-label" title={summaryLabel} role={showThinking ? "status" : undefined} />
        <ChevronRight className="tool-group-chevron" size={13} aria-hidden="true" />
      </summary>
      <div className="tool-group-items">
        {tools.map((tool) => <ToolActivity key={tool.id} item={tool} completed={tool.status === "completed" || tool.status === "failed"} />)}
      </div>
    </details>
  );
}

type ToolIcon = IconComponent | typeof GodotIcon;

function toolGroupIcon(tools: ToolItem[]): ToolIcon {
  if (tools.some((tool) => tool.type === "dynamicToolCall" && (tool.tool === "edit" || tool.tool === "write"))) return FilePenLine;
  if (tools.some((tool) => tool.type === "dynamicToolCall" && (tool.tool === "read" || tool.tool === "ls"))) return FileText;
  if (tools.some((tool) => tool.type === "dynamicToolCall" && (tool.tool === "grep" || tool.tool === "find"))) return Search;
  if (tools.some((tool) => tool.type === "dynamicToolCall" && tool.tool === "bash")) return Terminal;
  if (tools.some((tool) => tool.type === "dynamicToolCall" && tool.tool === "game_use")) return Gamepad2;
  const mcpCalls = tools.filter((tool): tool is Extract<ToolItem, { type: "mcpToolCall" }> => tool.type === "mcpToolCall");
  if (mcpCalls.some((call) => mcpToolBrand(call) === "godot")) return GodotIcon;
  if (mcpCalls.length > 0) return Plug;
  return Wrench;
}

function turnDuration(display: TurnDisplay): string {
  return formatRoundedDuration(display.durationMs);
}

function formatRoundedDuration(milliseconds: number): string {
  if (milliseconds < 1_000) return "0s";
  const seconds = Math.max(1, Math.round(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function activeTurnDuration(display: TurnDisplay, now: number): string {
  const workTimestamps = display.work.flatMap((item) => {
    if (item.kind === "item") return [item.item.timestamp];
    if (item.kind === "tool-group") return item.tools.map((tool) => tool.timestamp);
    return [];
  });
  const startedAt = [display.user?.timestamp, ...workTimestamps]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value))
    .reduce((earliest, value) => Math.min(earliest, value), now);
  return formatDuration(Math.max(0, now - startedAt));
}

function compactionStats(tokensBefore: number, estimatedTokensAfter?: number): string {
  const formatter = new Intl.NumberFormat();
  const before = formatter.format(tokensBefore);
  return estimatedTokensAfter === undefined
    ? `Compacted from ${before} tokens`
    : `Compacted from ${before} to approximately ${formatter.format(estimatedTokensAfter)} tokens`;
}

function compactionLabel(item: Extract<ThreadItem, { type: "contextCompaction" }>): string {
  if (item.error) return item.error.message;
  if (item.status === "completed") return "Context compacted";
  if (item.status === "cancelled") return "Context compaction stopped";
  if (item.status === "failed") return "Context compaction failed";
  return "Compacting context";
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function ThinkingActivity() {
  return (
    <div className="thinking-activity" role="status">
      <ShimmerText text="Thinking" />
    </div>
  );
}

function TimelineItem({ item, images, hideError = false }: { item: ThreadItem; images?: PromptImage[]; hideError?: boolean }) {
  const workspaceLinks = useContext(WorkspaceLinkContext);
  if (item.type === "reasoning") return null;
  if (item.type === "modelChange") {
    return (
      <div className="model-change-event" role="status">
        <span>Switched to {item.name ?? item.model.id}</span>
      </div>
    );
  }
  if (item.type === "imageRead") {
    const label = item.count === 1 ? "Viewed an image" : `Viewed ${item.count} images`;
    if (images?.length) {
      return (
        <details className="image-read-details">
          <summary className="timeline-event timeline-event-expandable">
            <Image size={13} aria-hidden="true" />
            <span>{label}</span>
            <ChevronRight className="tool-detail-chevron" size={12} aria-hidden="true" />
          </summary>
          <div className="image-read-previews">
            {images.map((image, index) => (
              <img
                key={`${image.mediaType}:${index}`}
                src={imageSource(image)}
                alt={image.name ?? `Viewed image ${index + 1}`}
              />
            ))}
          </div>
        </details>
      );
    }
    return (
      <div className="timeline-event">
        <Image size={13} aria-hidden="true" />
        <span>{label}</span>
      </div>
    );
  }
  if (item.type === "dynamicToolCall" || item.type === "mcpToolCall") return <ToolActivity item={item} />;
  if (item.type === "retry") {
    return <ConnectionActivity
      title={item.status === "failed" ? "Connection error" : `Reconnecting ${item.attempt}/${item.maxAttempts}`}
      error={item.error}
      failed={item.status === "failed"}
    />;
  }
  if (item.type === "contextCompaction") {
    const label = compactionLabel(item);
    const icon = item.status === "inProgress" ? <LoaderCircle className="spin" size={13} /> : item.status === "completed" ? <Check size={13} /> : <X size={13} />;
    const shimmering = item.status === "inProgress";
    if (item.status === "completed" && item.summary) {
      return (
        <details className="compaction-details">
          <summary className="timeline-event timeline-event-expandable">
            {icon}
            <ShimmerText text={label} active={shimmering} />
            <ChevronRight className="tool-detail-chevron" size={12} aria-hidden="true" />
          </summary>
          <div className="compaction-content">
            {item.tokensBefore !== undefined ? <p className="compaction-stats">{compactionStats(item.tokensBefore, item.estimatedTokensAfter)}</p> : null}
            <MarkdownContent text={item.summary} {...workspaceLinks} />
          </div>
        </details>
      );
    }
    return (
      <div className={`timeline-event${item.status === "failed" ? " timeline-event-error" : ""}`}>
        {icon}
        <ShimmerText text={label} active={shimmering} />
      </div>
    );
  }
  if (item.type === "agentMessage") {
    if (!item.text && item.status === "completed") return null;
    if (!item.text.trim() && hideError) return null;
    const message = (
      <div className={`assistant-message assistant-${item.status}`}>
        {item.text ? <MarkdownContent text={item.text} {...workspaceLinks} /> : null}
        {item.status === "cancelled" && !item.text ? <span className="muted-text">Stopped</span> : null}
        {item.status === "interrupted" && !item.text ? <span className="muted-text">Interrupted</span> : null}
      </div>
    );
    if (!item.error || hideError) return message;
    return (
      <>
        {message}
        <ConnectionActivity title="Connection error" error={item.error} failed />
      </>
    );
  }
  return null;
}

function ConnectionActivity({ title, error, failed = false }: { title: string; error: ThreadItemError; failed?: boolean }) {
  const Icon = failed ? WifiOff : Wifi;
  const presentation = connectionErrorPresentation(title, error);
  return (
    <details className={`connection-activity-details${failed ? " connection-activity-failed" : ""}`}>
      <summary className="tool-activity tool-row tool-row-expandable timeline-activity connection-activity" role={failed ? "alert" : undefined}>
        <Icon size={13} aria-hidden="true" />
        <span className="tool-label">{presentation.title}</span>
        <ChevronRight className="tool-detail-chevron" size={12} aria-hidden="true" />
      </summary>
      <div className="connection-activity-error">{presentation.message}</div>
    </details>
  );
}

function connectionErrorPresentation(title: string, error: ThreadItemError): { title: string; message: string } {
  if (error.code === "model_not_configured") {
    return {
      title: "Model setup required",
      message: "The selected model isn't configured. Choose an available model or connect its provider in Settings, then try again.",
    };
  }
  return { title, message: error.message };
}

function ToolActivity({ item, completed = false }: { item: Extract<ThreadItem, { type: "dynamicToolCall" | "mcpToolCall" }>; completed?: boolean }) {
  const presentation = completed ? completedToolPresentation(item) : toolPresentation(item);
  const Icon = presentation.icon;
  const label = item.status === "preparing" && item.type === "dynamicToolCall"
    ? preparingToolLabel(item.tool)
    : presentation.label;
  const expandable = hasToolDetails(item);
  const row = (
    <div className={`tool-activity tool-row${expandable ? " tool-row-expandable" : ""} timeline-activity tool-${item.status}`}>
      <Icon size={13} aria-hidden="true" />
      <span className="tool-label" title={label}>{label}</span>
      {expandable ? <ChevronRight className="tool-detail-chevron" size={12} aria-hidden="true" /> : null}
      <span className="tool-result" aria-label={item.status}>
        {item.status === "failed" ? <X size={12} /> : null}
      </span>
    </div>
  );
  if (!expandable) return row;
  return (
    <details className="tool-activity-details">
      <summary>{row}</summary>
      <ToolDetails item={item} />
    </details>
  );
}

function ToolDetails({ item }: { item: ToolCallItem }) {
  const args = record(item.arguments);
  if (item.type === "dynamicToolCall" && item.tool === "web_search") return <WebSearchDetails item={item} args={args} />;
  if (item.type === "dynamicToolCall" && item.tool === "bash") return <ShellDetails item={item} command={text(args?.command)} />;
  if (item.type === "dynamicToolCall" && ["read", "grep", "find", "ls"].includes(item.tool)) return <FileOperationDetails item={item} args={args} />;
  if (item.type === "dynamicToolCall" && ["edit", "write"].includes(item.tool)) return <FileChangeDetails item={item} args={args} />;
  return <StructuredToolDetails item={item} />;
}

function WebSearchDetails({ item, args }: { item: Extract<ThreadItem, { type: "dynamicToolCall" }>; args: Record<string, unknown> | undefined }) {
  const query = text(args?.query);
  return <div className="tool-details">
    {query ? <ToolDetailBlock label="Query"><code>{query}</code></ToolDetailBlock> : null}
    {item.webSearch ? <ToolDetailBlock label="Provider"><code>{item.webSearch.providerName}</code></ToolDetailBlock> : null}
    {item.webSearch?.fallbackFrom ? <p className="tool-details-truncated">Fallback used after {providerLabel(item.webSearch.fallbackFrom)} was unavailable.</p> : null}
    {item.output ? <ToolDetailBlock label="Results"><pre>{item.output}</pre></ToolDetailBlock> : null}
    {item.truncated ? <p className="tool-details-truncated">Results truncated</p> : null}
    {!item.output && item.status === "failed" ? <p className="tool-details-error">Web search failed without output.</p> : null}
  </div>;
}

function ShellDetails({ item, command }: { item: ToolCallItem; command: string }) {
  return <div className="tool-details tool-shell-details">
    <ToolDetailBlock label="Shell"><pre className="tool-shell-command"><span className="tool-shell-prompt">$</span> {command || "command"}</pre></ToolDetailBlock>
    {item.output ? <pre className="tool-shell-output">{item.output}</pre> : null}
    {item.truncated ? <p className="tool-details-truncated">Output truncated</p> : null}
    {!item.output && item.status === "failed" ? <p className="tool-details-error">Command failed without output.</p> : null}
  </div>;
}

function FileOperationDetails({ item, args }: { item: ToolCallItem; args: Record<string, unknown> | undefined }) {
  return <div className="tool-details">
    {fileOperationContext(item.tool, args)}
    {item.output ? <ToolDetailBlock label="Result"><pre>{item.output}</pre></ToolDetailBlock> : null}
    {item.truncated ? <p className="tool-details-truncated">Result truncated</p> : null}
    {!item.output && item.status === "failed" ? <p className="tool-details-error">Operation failed without output.</p> : null}
  </div>;
}

function FileChangeDetails({ item, args }: { item: ToolCallItem; args: Record<string, unknown> | undefined }) {
  return <div className="tool-details">
    <ToolDetailBlock label="File"><code>{text(args?.path) || text(args?.file_path) || "Unknown file"}</code></ToolDetailBlock>
    {item.output ? <ToolDetailBlock label="Result"><pre>{item.output}</pre></ToolDetailBlock> : null}
    {item.truncated ? <p className="tool-details-truncated">Result truncated</p> : null}
    {!item.output && item.status === "failed" ? <p className="tool-details-error">File change failed without output.</p> : null}
  </div>;
}

function StructuredToolDetails({ item }: { item: ToolCallItem }) {
  return (
    <div className="tool-details">
      {item.images?.length ? <ToolImagePreviews images={item.images} /> : null}
      {item.arguments !== undefined ? <ToolDetailBlock label="Input"><pre>{formatToolValue(item.arguments)}</pre></ToolDetailBlock> : null}
      {item.output ? <ToolDetailBlock label="Output"><pre>{item.output}</pre></ToolDetailBlock> : null}
      {item.truncated ? <p className="tool-details-truncated">Output truncated</p> : null}
      {!item.output && item.status === "failed" ? <p className="tool-details-error">The tool call failed without output.</p> : null}
    </div>
  );
}

function ToolImagePreviews({ images }: { images: PromptImage[] }) {
  return <div className="tool-result-images">
    {images.map((image, index) => (
      <img
        key={`${image.mediaType}:${index}`}
        src={imageSource(image)}
        alt={image.name ?? (images.length === 1 ? "Tool result image" : `Tool result image ${index + 1}`)}
      />
    ))}
  </div>;
}

function fileOperationContext(tool: string, args: Record<string, unknown> | undefined): ReactNode {
  const path = text(args?.path) || text(args?.file_path);
  const query = text(args?.pattern) || text(args?.query);
  if (tool === "read") return path ? <ToolDetailBlock label="File"><code>{path}</code></ToolDetailBlock> : null;
  if (query && path) return <ToolDetailBlock label="Search"><code>{query} in {path}</code></ToolDetailBlock>;
  if (query) return <ToolDetailBlock label="Search"><code>{query}</code></ToolDetailBlock>;
  return path ? <ToolDetailBlock label="Path"><code>{path}</code></ToolDetailBlock> : null;
}

function ToolDetailBlock({ label, children }: { label: string; children: ReactNode }) {
  return <div className="tool-detail-block"><span className="tool-detail-label">{label}</span>{children}</div>;
}

function hasToolDetails(item: ToolCallItem): boolean {
  if (item.status === "failed" || item.truncated) return true;
  if (item.type === "mcpToolCall") return item.arguments !== undefined || Boolean(item.output) || Boolean(item.images?.length);
  if (item.tool === "bash") return Boolean(text(record(item.arguments)?.command) || item.output);
  if (["read", "grep", "find", "ls", "edit", "write"].includes(item.tool)) return Boolean(item.output);
  return item.arguments !== undefined || Boolean(item.output) || Boolean(item.images?.length);
}

function formatToolValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2) ?? String(value);
  } catch {
    return String(value);
  }
}

function ArtifactPreviews({ projectId, artifacts }: { projectId: string; artifacts: ToolArtifact[] }) {
  return <div className="tool-artifacts">{artifacts.map((artifact) => <ArtifactPreview key={artifact.path} projectId={projectId} artifact={artifact} />)}</div>;
}

function ArtifactPreview({ projectId, artifact }: { projectId: string; artifact: ToolArtifact }) {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    let disposed = false;
    let objectUrl: string | undefined;
    void getWorkspaceAsset(projectId, artifact.path).then((blob) => {
      if (disposed) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch(() => undefined);
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [artifact.path, projectId]);
  if (!url) return null;
  return artifact.type === "model"
    ? <ModelPreview source={url} label="Generated 3D model" minHeight={320} />
    : artifact.type === "video"
      ? <video className="tool-artifact-video" src={url} controls preload="metadata" />
    : <img className="tool-artifact-image" src={url} alt="Generated image" />;
}

function preparingToolLabel(toolName: string): string {
  switch (toolName) {
    case "bash": return "Preparing command";
    case "read": return "Preparing read";
    case "write": return "Preparing file";
    case "edit": return "Preparing edit";
    case "web_search": return "Preparing web search";
    case "mcp": return "Preparing MCP";
    case "game_use": return "Preparing game use";
    case "tool": return "Preparing";
    default: return `Preparing ${toolName}`;
  }
}

function runningToolGroupLabel(item: ToolCallItem, label: string): string {
  if (item.type === "mcpToolCall") return label;
  switch (item.tool) {
    case "edit":
    case "write": return "Edit Files";
    case "read": return "Read Files";
    case "grep":
    case "find": return "Search Files";
    case "ls": return "List Files";
    case "web_search": return "Search Web";
    default: return item.status === "preparing" ? preparingToolLabel(item.tool) : label;
  }
}

function toolPresentation(item: Extract<ThreadItem, { type: "dynamicToolCall" | "mcpToolCall" }>): { icon: ToolIcon; label: string } {
  if (item.type === "mcpToolCall") {
    return { icon: mcpToolBrand(item) === "godot" ? GodotIcon : Plug, label: mcpToolLabel(item) };
  }
  const toolName = item.tool;
  const args = item.arguments;
  const values = record(args);
  switch (toolName) {
    case "bash": return { icon: Terminal, label: `Running ${text(values?.command) || "command"}` };
    case "edit": return { icon: FilePenLine, label: withTarget("Editing", values) };
    case "write": return { icon: FileText, label: withTarget("Writing", values) };
    case "read": return { icon: FileText, label: withTarget("Reading", values) };
    case "grep": return { icon: Search, label: searchLabel("Searching for", values) };
    case "find": return { icon: Search, label: searchLabel("Finding", values) };
    case "ls": return { icon: FileText, label: withTarget("Listing", values) };
    case "web_search": return { icon: Search, label: searchLabel("Searching the web for", values) };
    case "game_use": return { icon: Gamepad2, label: playtestLabel(values, false) };
    default: return { icon: Wrench, label: toolName };
  }
}

function completedToolPresentation(item: Extract<ThreadItem, { type: "dynamicToolCall" | "mcpToolCall" }>): { icon: ToolIcon; label: string } {
  if (item.type === "mcpToolCall") {
    return { icon: mcpToolBrand(item) === "godot" ? GodotIcon : Plug, label: mcpToolLabel(item) };
  }
  const toolName = item.tool;
  const args = item.arguments;
  const values = record(args);
  switch (toolName) {
    case "bash": return { icon: Terminal, label: `Ran ${text(values?.command) || "command"}` };
    case "edit":
    case "write": return { icon: FilePenLine, label: withTarget("Edited", values) };
    case "read": return { icon: FileText, label: withTarget("Read", values) };
    case "grep": return { icon: Search, label: searchLabel("Searched for", values) };
    case "find": return { icon: Search, label: searchLabel("Searched for", values) };
    case "ls": return { icon: FileText, label: withTarget("Listed", values) };
    case "web_search": return { icon: Search, label: searchLabel("Searched the web for", values) };
    case "game_use": return { icon: Gamepad2, label: playtestLabel(values, true) };
    default: return { icon: Wrench, label: `Used ${toolName}` };
  }
}

function playtestLabel(values: Record<string, unknown> | undefined, completed: boolean): string {
  switch (text(values?.operation)) {
    case "open": return completed ? "Opened game preview" : "Opening game preview";
    case "inspect": return completed ? "Inspected game state" : "Inspecting game state";
    case "act": {
      const count = Array.isArray(values?.actions) ? values.actions.length : 0;
      const target = count === 1 ? "a playtest action" : "playtest actions";
      return completed ? `Ran ${target}` : `Running ${target}`;
    }
    case "capture": return completed ? "Captured game screenshot" : "Capturing game screenshot";
    case "close": return completed ? "Closed game preview" : "Closing game preview";
    default: return completed ? "Used game playtest" : "Running game playtest";
  }
}

function providerLabel(provider: "exa" | "parallel" | "custom"): string {
  return provider === "exa" ? "Exa" : provider === "parallel" ? "Parallel" : "the custom provider";
}

function searchLabel(action: string, values: Record<string, unknown> | undefined): string {
  const query = text(values?.pattern) || text(values?.query);
  const target = text(values?.path) || text(values?.file_path);
  if (query && target) return `${action} ${query} in ${target}`;
  if (query) return `${action} ${query}`;
  return target ? `${action} files in ${target}` : `${action} files`;
}

function withTarget(action: string, values: Record<string, unknown> | undefined): string {
  const target = text(values?.path) || text(values?.file_path);
  return target ? `${action} ${target}` : `${action} file`;
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
