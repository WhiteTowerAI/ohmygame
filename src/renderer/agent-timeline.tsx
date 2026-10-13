import {
  Check,
  ChevronRight,
  Copy,
  Diskette,
  FilePenLine,
  FileText,
  Gamepad2,
  Image,
  LoaderCircle,
  Pencil,
  Plug,
  Search,
  Terminal,
  Wrench,
  WandSparkles,
  Wifi,
  WifiOff,
  X,
  type IconComponent,
} from "./icons.js";
import { createContext, memo, useCallback, useContext, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react";
import type { ConversationAttachment, PromptContextLabel, PromptImage, ThreadItem, ThreadItemError, ToolArtifact, Turn as ThreadTurn } from "../shared/contracts.js";
import { getWorkspaceAsset } from "./api.js";
import { ConversationImage } from "./image-attachments.js";
import { useNearViewport } from "./asset-gallery.js";
import { mcpToolBrand, mcpToolLabel } from "./mcp-tool-presentation.js";
import { ModelPreview } from "./model-preview.js";
import { formatBytes } from "./format-bytes.js";
import { toolGroupSummary, type ToolItem } from "./work-items.js";
import { mergeCompletedCompactionTurns, projectTurnDisplay, type TurnDisplay } from "./turn-display.js";
import { SelectedTextMenu } from "./selected-text-menu.js";
import { PromptContextIcon } from "./chat-reference.js";
import { GodotIcon } from "./godot-icon.js";
import { MarkdownContent } from "./markdown-content.js";
import { LazyDetails } from "./lazy-details.js";
import { agentErrorDiagnosticRows, agentErrorDiagnosticText, agentErrorPresentation } from "./agent-error-presentation.js";
import { language, t } from "./i18n.js";

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
const completedDisplays = new WeakMap<ThreadTurn, TurnDisplay>();

function turnDisplay(turn: ThreadTurn): TurnDisplay {
  if (turn.status === "inProgress") return projectTurnDisplay(turn);
  let display = completedDisplays.get(turn);
  if (!display) { display = projectTurnDisplay(turn); completedDisplays.set(turn, display); }
  return display;
}

export const AgentTimeline = memo(function AgentTimeline({ turns: sourceTurns, projectId = "", workspacePath, onOpenWorkspaceFile, revisionDisabled, onRevise, onAddToChat, waitingForInput = false }: AgentTimelineProps) {
  const [selectionRoot, setSelectionRoot] = useState<HTMLDivElement | null>(null);
  const [editingItemId, setEditingItemId] = useState<string>();
  const [draft, setDraft] = useState("");
  const [copiedItemId, setCopiedItemId] = useState<string>();
  const [copiedAssistantId, setCopiedAssistantId] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const turns = useMemo(() => mergeCompletedCompactionTurns(sourceTurns), [sourceTurns]);
  const displays = useMemo(() => turns.map(turnDisplay), [turns]);
  const workspaceLinks = useMemo(() => ({ workspacePath, onOpenWorkspaceFile }), [workspacePath, onOpenWorkspaceFile]);
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

  const copy = useCallback(async (item: Extract<ThreadItem, { type: "userMessage" }>) => {
    if (!item.text) return;
    try {
      await navigator.clipboard.writeText(item.text);
    } catch {
      return;
    }
    setCopiedItemId(item.id);
    window.setTimeout(() => setCopiedItemId((current) => current === item.id ? undefined : current), 1_500);
  }, []);

  const copyAssistant = useCallback(async (id: string, text: string) => {
    if (!text) return;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      return;
    }
    setCopiedAssistantId(id);
    window.setTimeout(() => setCopiedAssistantId((current) => current === id ? undefined : current), 1_500);
  }, []);

  const edit = useCallback((item: Extract<ThreadItem, { type: "userMessage" }>) => {
    setEditingItemId(item.id);
    setDraft(item.text);
  }, []);
  const cancelEdit = useCallback(() => setEditingItemId(undefined), []);

  const submitRevision = useCallback(async () => {
    if (!onRevise || submitting || revisionDisabled || !draft.trim()) return;
    setSubmitting(true);
    try {
      if (await onRevise(draft)) setEditingItemId(undefined);
    } finally {
      setSubmitting(false);
    }
  }, [onRevise, submitting, revisionDisabled, draft]);

  return (
    <WorkspaceLinkContext.Provider value={workspaceLinks}>
      <div className="agent-timeline-selection-root" ref={setSelectionRoot}>
        {turns.map((turn, index) => (
          <Turn
            key={turn.id}
            projectId={projectId}
            turn={turn}
            waitingForInput={turn.status === "inProgress" && waitingForInput}
            steeringPending={steeringPending && index === latestSteeringIndex}
            assistantControls={{
              copiedItemId: copiedAssistantId,
              latestItemId: latestAssistantId,
              onCopy: copyAssistant,
            }}
            userControls={{
              editing: displays[index].user?.id === editingItemId && editingItemId === latestUserId,
              draft: displays[index].user?.id === editingItemId ? draft : "",
              copied: displays[index].user?.id === copiedItemId,
              canEdit: Boolean(onRevise && displays[index].user?.text && displays[index].user?.id === latestUserId),
              disabled: Boolean(revisionDisabled || submitting),
              onCopy: copy,
              onEdit: edit,
              onDraftChange: setDraft,
              onCancel: cancelEdit,
              onSubmit: submitRevision,
            }}
          />
        ))}
        {onAddToChat ? <SelectedTextMenu root={selectionRoot} onAdd={onAddToChat} /> : null}
      </div>
    </WorkspaceLinkContext.Provider>
  );
});

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

const Turn = memo(function Turn({ turn, projectId, waitingForInput, steeringPending = false, userControls, assistantControls }: {
  turn: ThreadTurn;
  projectId: string;
  waitingForInput: boolean;
  steeringPending?: boolean;
  userControls: UserControls;
  assistantControls: AssistantControls;
}) {
  const [now, setNow] = useState(Date.now());
  const active = turn.status === "inProgress";
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [active]);
  const display = useMemo(() => active ? projectTurnDisplay(turn, now, waitingForInput) : turnDisplay(turn), [turn, active, now, waitingForInput]);
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
}, (previous, next) => previous.turn === next.turn && previous.projectId === next.projectId &&
  previous.waitingForInput === next.waitingForInput && previous.steeringPending === next.steeringPending &&
  equalControls(previous.userControls, next.userControls) && equalControls(previous.assistantControls, next.assistantControls));

function equalControls<T extends object>(previous: T, next: T): boolean {
  return (Object.keys(previous) as (keyof T)[]).every((key) => previous[key] === next[key]);
}

function SteeringActivity() {
  return (
    <div className="thinking-activity" role="status">
      <ShimmerText text={t("timeline.waitingToSteer")} />
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
          <button type="button" aria-label={t("timeline.copyResponse")} title={t("common.copy")} onClick={() => controls.onCopy(responseId, text)}>
            {responseId === controls.copiedItemId ? <Check size={13} /> : <Copy size={13} />}
          </button>
          {timestamp ? <time dateTime={new Date(timestamp).toISOString()}>{formatResponseTime(timestamp)}</time> : null}
        </div>
      ) : null}
    </div>
  );
}

function formatResponseTime(timestamp: number): string {
  return new Intl.DateTimeFormat(language, {
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
          {item.images.map((image, index) => <ConversationImage key={`${image.mediaType}:${index}`} image={image} alt={t("timeline.attachedImage", { number: index + 1 })} />)}
        </div>
      ) : null}
      {attachments.length ? <UserAttachments attachments={attachments} /> : null}
      {item.contexts?.length ? <UserContexts contexts={item.contexts} /> : null}
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
            aria-label={t("timeline.editMessage")}
          />
          <div className="user-message-editor-actions">
            <button type="button" onClick={controls.onCancel} disabled={controls.disabled}>{t("common.cancel")}</button>
            <button className="primary" type="button" onClick={controls.onSubmit} disabled={controls.disabled || !controls.draft.trim()}>{t("common.send")}</button>
          </div>
        </div>
      ) : item.text ? (
        <>
          <div className="user-message">{item.text}</div>
          <div className="user-message-actions">
            <button type="button" aria-label={t("timeline.copyMessage")} title={t("common.copy")} onClick={() => controls.onCopy(item)}>
              {controls.copied ? <Check size={13} /> : <Copy size={13} />}
            </button>
            {controls.canEdit ? (
              <button type="button" aria-label={t("timeline.editMessage")} title={t("common.edit")} onClick={() => controls.onEdit(item)} disabled={controls.disabled}>
                <Pencil size={13} />
              </button>
            ) : null}
          </div>
        </>
      ) : null}
    </div>
  );
}

function UserContexts({ contexts }: { contexts: PromptContextLabel[] }) {
  return <div className="user-message-contexts" aria-label={t("timeline.editorContext")}>
    {contexts.map((context, index) => <div className="user-message-context" key={`${context.kind}:${index}`} title={context.label}>
      <PromptContextIcon kind={context.kind} />
      <span>{context.label}</span>
    </div>)}
  </div>;
}

function UserAttachments({ attachments }: { attachments: ConversationAttachment[] }) {
  return <div className="user-message-attachments" aria-label={t("attachments.files")}>
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
  role?: "status" | "alert";
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
  const label = display.working ? t("timeline.workingFor", { duration: activeTurnDuration(display, now) }) : t("timeline.thinking");
  return (
    <section className="work-activity work-activity-active">
      <div className={`work-summary work-summary-active${display.working ? "" : " work-summary-thinking"}`}>
        <ShimmerText text={label} active={!display.working} />
      </div>
      {display.work.length > 0 ? (
        <div className="active-work-items">
          <WorkItems items={display.work} images={display.user?.images} activeRetryId={display.activeRetryId} />
        </div>
      ) : null}
    </section>
  );
}

function CompletedWork({ display }: { display: TurnDisplay }) {
  if (display.status === "completed" && !display.user && display.finalMessages.length === 0 && display.messages.length === 0 && display.work.length > 0 &&
    display.work.every((item) => item.kind === "item" && item.item.type === "contextCompaction")) {
    return <WorkItems items={display.work} />;
  }
  const content = <div className="work-items">
    <WorkItems items={display.work} images={display.user?.images} failed={display.status === "failed"} />
    {display.status === "cancelled" && display.work.length === 0 ? (
      <div className="stopped-work-note">{display.hadThinking ? t("timeline.stoppedThinking") : t("timeline.stoppedBefore")}</div>
    ) : null}
  </div>;
  if (display.status === "cancelled" || display.status === "failed") {
    return (
      <section className={`work-activity ${display.status === "cancelled" ? "work-activity-stopped" : "work-activity-failed"}`}>
        <div className={`work-summary ${display.status === "cancelled" ? "work-summary-stopped" : "work-summary-failed"}`}>
          <span>{display.status === "cancelled" ? t("timeline.stoppedAfter", { duration: turnDuration(display) }) : t("timeline.workedFor", { duration: turnDuration(display) })}</span>
        </div>
        {content}
      </section>
    );
  }
  return (
    <LazyDetails className="work-activity" summary={
      <summary className="work-summary">
        <span>{t("timeline.workedFor", { duration: turnDuration(display) })}</span>
        <ChevronRight className="work-chevron" size={13} />
      </summary>}>
      {content}
    </LazyDetails>
  );
}

function WorkItems({ items, images, failed = false, activeRetryId }: { items: TurnDisplay["work"]; images?: PromptImage[]; failed?: boolean; activeRetryId?: string }) {
  const rendered = items.map((item) => {
    if (item.kind === "tool-group") return <ToolActivityGroup key={item.id} tools={item.tools} thinking={item.thinking} />;
    if (item.kind === "thinking") return <ThinkingActivity key={item.id} />;
    if (item.item.type === "retry") return <AgentErrorActivity key={item.item.id} error={item.item.error} retry={item.item} active={item.item.id === activeRetryId} />;
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
      rendered.push(<AgentErrorActivity key="turn-connection-error" error={error.error} />);
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
  const summaryLabel = showThinking ? t("timeline.thinking") : runningLabel ?? toolGroupSummary(tools);
  return (
    <LazyDetails className="tool-activity-group" summary={
      <summary className={`tool-group-summary${showThinking ? " tool-group-summary-thinking" : ""}`}>
        {showThinking ? null : <Icon size={13} aria-hidden="true" />}
        <ShimmerText text={summaryLabel} active={Boolean(runningTool || showThinking)} className="tool-label" title={summaryLabel} role={showThinking ? "status" : undefined} />
        <ChevronRight className="tool-group-chevron" size={13} aria-hidden="true" />
      </summary>}>
      <div className="tool-group-items">
        {tools.map((tool) => <ToolActivity key={tool.id} item={tool} completed={tool.status === "completed" || tool.status === "failed"} />)}
      </div>
    </LazyDetails>
  );
}

type ToolIcon = IconComponent | typeof GodotIcon;

function toolGroupIcon(tools: ToolItem[]): ToolIcon {
  if (tools.some((tool) => tool.type === "dynamicToolCall" && tool.tool === "generate_image")) return WandSparkles;
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
  if (milliseconds < 1_000) return t("timeline.duration.seconds", { seconds: 0 });
  const seconds = Math.max(1, Math.round(milliseconds / 1_000));
  return durationLabel(seconds);
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
  const formatter = new Intl.NumberFormat(language);
  const before = formatter.format(tokensBefore);
  return estimatedTokensAfter === undefined
    ? t("timeline.compactedFrom", { before })
    : t("timeline.compactedFromTo", { before, after: formatter.format(estimatedTokensAfter) });
}

function compactionLabel(item: Extract<ThreadItem, { type: "contextCompaction" }>): string {
  if (item.error) return item.error.message;
  if (item.status === "completed") return t("timeline.compaction.completed");
  if (item.status === "cancelled") return t("timeline.compaction.cancelled");
  if (item.status === "failed") return t("timeline.compaction.failed");
  return t("timeline.compaction.running");
}

function formatDuration(milliseconds: number): string {
  return durationLabel(Math.floor(milliseconds / 1_000));
}

function durationLabel(seconds: number): string {
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? t("timeline.duration.minutes", { minutes, seconds: seconds % 60 }) : t("timeline.duration.seconds", { seconds });
}

function ThinkingActivity() {
  return (
    <div className="thinking-activity" role="status">
      <ShimmerText text={t("timeline.thinking")} />
    </div>
  );
}

function TimelineItem({ item, images, hideError = false }: { item: ThreadItem; images?: PromptImage[]; hideError?: boolean }) {
  const workspaceLinks = useContext(WorkspaceLinkContext);
  if (item.type === "reasoning") return null;
  if (item.type === "modelChange") {
    return (
      <div className="model-change-event" role="status">
        <span>{t("timeline.switchedTo", { model: item.name ?? item.model.id })}</span>
      </div>
    );
  }
  if (item.type === "imageRead") {
    const label = item.count === 1 ? t("timeline.viewedImage") : t("timeline.viewedImages", { count: item.count });
    if (images?.length) {
      return (
        <LazyDetails className="image-read-details" summary={
          <summary className="timeline-event timeline-event-expandable">
            <Image size={13} aria-hidden="true" />
            <span>{label}</span>
            <ChevronRight className="tool-detail-chevron" size={12} aria-hidden="true" />
          </summary>}>
          <div className="image-read-previews">
            {images.map((image, index) => (
              <ConversationImage
                key={`${image.mediaType}:${index}`}
                image={image}
                alt={image.name ?? t("timeline.viewedImageName", { number: index + 1 })}
              />
            ))}
          </div>
        </LazyDetails>
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
  if (item.type === "contextCompaction") {
    const label = compactionLabel(item);
    const icon = <Diskette size={13} aria-hidden="true" />;
    const shimmering = item.status === "inProgress";
    if (item.status === "completed" && item.summary) {
      return (
        <LazyDetails className="compaction-details" summary={
          <summary className="timeline-event timeline-event-expandable">
            {icon}
            <ShimmerText text={label} active={shimmering} />
            <ChevronRight className="tool-detail-chevron" size={12} aria-hidden="true" />
          </summary>}>
          <div className="compaction-content">
            {item.tokensBefore !== undefined ? <p className="compaction-stats">{compactionStats(item.tokensBefore, item.estimatedTokensAfter)}</p> : null}
            <MarkdownContent text={item.summary} {...workspaceLinks} />
          </div>
        </LazyDetails>
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
        {item.status === "cancelled" && !item.text ? <span className="muted-text">{t("timeline.stopped")}</span> : null}
        {item.status === "interrupted" && !item.text ? <span className="muted-text">{t("timeline.interrupted")}</span> : null}
      </div>
    );
    if (!item.error || hideError) return message;
    return (
      <>
        {message}
        <AgentErrorActivity error={item.error} />
      </>
    );
  }
  return null;
}

function AgentErrorActivity({ error, retry, active = false }: { error: ThreadItemError; retry?: Extract<ThreadItem, { type: "retry" }>; active?: boolean }) {
  const failed = !retry || retry.status === "failed";
  const shimmering = active && retry?.status === "inProgress";
  const presentation = agentErrorPresentation(error);
  const label = failed ? presentation.title : t("timeline.reconnecting", { attempt: retry.attempt, max: retry.maxAttempts });
  const preview = failed && !error.code ? error.message.replace(/\s+/g, " ").trim() : "";
  const summary = preview ? `${label} — ${preview}` : label;
  const Icon = failed ? (["dns_error", "connection_refused", "connection_reset", "timeout", "tls_error", "stream_error", "network_error"].includes(error.code ?? "") ? WifiOff : X) : Wifi;
  return (
    <LazyDetails className={`connection-activity-details${failed ? " connection-activity-failed" : ""}`} summary={
      <summary className="tool-activity tool-row timeline-activity connection-activity">
        <Icon size={13} aria-hidden="true" />
        <ShimmerText text={summary} active={shimmering} className="tool-label" title={summary} role={failed ? "alert" : shimmering ? "status" : undefined} />
        <ChevronRight className="tool-detail-chevron" size={12} aria-hidden="true" />
      </summary>}>
      <AgentErrorDetails error={error} guidance={failed ? presentation.message : undefined} />
    </LazyDetails>
  );
}

function AgentErrorDetails({ error, guidance }: { error: ThreadItemError; guidance?: string }) {
  const [copyStatus, setCopyStatus] = useState<"idle" | "copied" | "failed">("idle");
  const copied = copyStatus === "copied";
  useEffect(() => { setCopyStatus("idle"); }, [error]);
  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopyStatus("idle"), 1_500);
    return () => window.clearTimeout(timer);
  }, [copied]);
  const rows = agentErrorDiagnosticRows(error);
  async function copyDiagnostics() {
    try {
      await navigator.clipboard.writeText(agentErrorDiagnosticText(error));
      setCopyStatus("copied");
    } catch { setCopyStatus("failed"); }
  }
  return (
    <div className="connection-activity-diagnostics">
      {guidance ? <p className="connection-activity-guidance">{guidance}</p> : null}
      <dl className="connection-activity-error">{rows.map(([label, value], index) => <div key={`${label}:${index}`}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      {copyStatus === "failed" ? <p className="connection-activity-guidance" role="status">{t("timeline.copyFailed")}</p> : null}
      <button type="button" className="connection-activity-copy" aria-label={copied ? t("timeline.diagnosticsCopied") : t("timeline.copyDiagnostics")} title={copied ? t("common.copied") : t("timeline.copyDiagnostics")} onClick={() => void copyDiagnostics()}>
        {copied ? <Check size={13} aria-hidden="true" /> : <Copy size={13} aria-hidden="true" />}
      </button>
    </div>
  );
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
    <LazyDetails className="tool-activity-details" summary={<summary>{row}</summary>}>
      <ToolDetails item={item} />
    </LazyDetails>
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
    {query ? <ToolDetailBlock label={t("timeline.detail.query")}><code>{query}</code></ToolDetailBlock> : null}
    {item.webSearch ? <ToolDetailBlock label={t("timeline.detail.provider")}><code>{item.webSearch.providerName}</code></ToolDetailBlock> : null}
    {item.webSearch?.fallbackFrom ? <p className="tool-details-truncated">{t("timeline.detail.fallback", { provider: providerLabel(item.webSearch.fallbackFrom) })}</p> : null}
    {item.output ? <ToolDetailBlock label={t("timeline.detail.results")}><pre>{item.output}</pre></ToolDetailBlock> : null}
    {item.truncated ? <p className="tool-details-truncated">{t("timeline.detail.resultsTruncated")}</p> : null}
    {!item.output && item.status === "failed" ? <p className="tool-details-error">{t("timeline.detail.webSearchFailed")}</p> : null}
  </div>;
}

function ShellDetails({ item, command }: { item: ToolCallItem; command: string }) {
  return <div className="tool-details tool-shell-details">
    <ToolDetailBlock label={t("timeline.detail.shell")}><pre className="tool-shell-command"><span className="tool-shell-prompt">$</span> {command || t("timeline.detail.command")}</pre></ToolDetailBlock>
    {item.output ? <pre className="tool-shell-output">{item.output}</pre> : null}
    {item.truncated ? <p className="tool-details-truncated">{t("timeline.detail.outputTruncated")}</p> : null}
    {!item.output && item.status === "failed" ? <p className="tool-details-error">{t("timeline.detail.commandFailed")}</p> : null}
  </div>;
}

function FileOperationDetails({ item, args }: { item: ToolCallItem; args: Record<string, unknown> | undefined }) {
  return <div className="tool-details">
    {fileOperationContext(item.tool, args)}
    {item.output ? <ToolDetailBlock label={t("timeline.detail.result")}><pre>{item.output}</pre></ToolDetailBlock> : null}
    {item.truncated ? <p className="tool-details-truncated">{t("timeline.detail.resultTruncated")}</p> : null}
    {!item.output && item.status === "failed" ? <p className="tool-details-error">{t("timeline.detail.operationFailed")}</p> : null}
  </div>;
}

function FileChangeDetails({ item, args }: { item: ToolCallItem; args: Record<string, unknown> | undefined }) {
  return <div className="tool-details">
    <ToolDetailBlock label={t("timeline.detail.file")}><code>{text(args?.path) || text(args?.file_path) || t("timeline.detail.unknownFile")}</code></ToolDetailBlock>
    {item.output ? <ToolDetailBlock label={t("timeline.detail.result")}><pre>{item.output}</pre></ToolDetailBlock> : null}
    {item.truncated ? <p className="tool-details-truncated">{t("timeline.detail.resultTruncated")}</p> : null}
    {!item.output && item.status === "failed" ? <p className="tool-details-error">{t("timeline.detail.fileChangeFailed")}</p> : null}
  </div>;
}

function StructuredToolDetails({ item }: { item: ToolCallItem }) {
  return (
    <div className="tool-details">
      {item.images?.length ? <ToolImagePreviews images={item.images} /> : null}
      {item.arguments !== undefined ? <ToolDetailBlock label={t("timeline.detail.input")}><pre>{formatToolValue(item.arguments)}</pre></ToolDetailBlock> : null}
      {item.output ? <ToolDetailBlock label={t("timeline.detail.output")}><pre>{item.output}</pre></ToolDetailBlock> : null}
      {item.truncated ? <p className="tool-details-truncated">{t("timeline.detail.outputTruncated")}</p> : null}
      {!item.output && item.status === "failed" ? <p className="tool-details-error">{t("timeline.detail.toolFailed")}</p> : null}
    </div>
  );
}

function ToolImagePreviews({ images }: { images: PromptImage[] }) {
  return <div className="tool-result-images">
    {images.map((image, index) => (
      <ConversationImage
        key={`${image.mediaType}:${index}`}
        image={image}
        alt={image.name ?? (images.length === 1 ? t("timeline.detail.toolImage") : t("timeline.detail.toolImageNumber", { number: index + 1 }))}
      />
    ))}
  </div>;
}

function fileOperationContext(tool: string, args: Record<string, unknown> | undefined): ReactNode {
  const path = text(args?.path) || text(args?.file_path);
  const query = text(args?.pattern) || text(args?.query);
  if (tool === "read") return path ? <ToolDetailBlock label={t("timeline.detail.file")}><code>{path}</code></ToolDetailBlock> : null;
  if (query && path) return <ToolDetailBlock label={t("timeline.detail.search")}><code>{t("timeline.detail.queryIn", { query, path })}</code></ToolDetailBlock>;
  if (query) return <ToolDetailBlock label={t("timeline.detail.search")}><code>{query}</code></ToolDetailBlock>;
  return path ? <ToolDetailBlock label={t("timeline.detail.path")}><code>{path}</code></ToolDetailBlock> : null;
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
  const [target, visible] = useNearViewport<HTMLDivElement>();
  useEffect(() => {
    if (!visible) return;
    let disposed = false;
    let objectUrl: string | undefined;
    setUrl(undefined);
    void getWorkspaceAsset(projectId, artifact.path).then((blob) => {
      if (disposed) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch(() => undefined);
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [artifact.path, projectId, visible]);
  return <div ref={target} className="tool-artifact-preview">{!url ? null : artifact.type === "model"
    ? <ModelPreview source={url} label={t("timeline.generated3d")} minHeight={320} />
    : artifact.type === "video"
      ? <video className="tool-artifact-video" src={url} controls preload="metadata" />
    : <img className="tool-artifact-image" src={url} alt={t("timeline.generatedImage")} />}</div>;
}

function preparingToolLabel(toolName: string): string {
  switch (toolName) {
    case "bash":
    case "read":
    case "write":
    case "edit":
    case "web_search":
    case "mcp":
    case "game_use":
    case "tool": return t(`timeline.preparing.${toolName}`);
    default: return t("timeline.preparing.other", { tool: toolName });
  }
}

function runningToolGroupLabel(item: ToolCallItem, label: string): string {
  if (item.type === "mcpToolCall") return label;
  switch (item.tool) {
    case "edit":
    case "write": return t("timeline.group.edit");
    case "read": return t("timeline.group.read");
    case "grep":
    case "find": return t("timeline.group.search");
    case "ls": return t("timeline.group.list");
    case "web_search": return t("timeline.group.web");
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
    case "bash": return { icon: Terminal, label: t("timeline.running", { command: text(values?.command) || t("timeline.detail.command") }) };
    case "edit": return { icon: FilePenLine, label: withTarget("editing", values) };
    case "write": return { icon: FileText, label: withTarget("writing", values) };
    case "read": return { icon: FileText, label: withTarget("reading", values) };
    case "grep": return { icon: Search, label: searchLabel("searchingFor", values) };
    case "find": return { icon: Search, label: searchLabel("finding", values) };
    case "ls": return { icon: FileText, label: withTarget("listing", values) };
    case "web_search": return { icon: Search, label: searchLabel("searchingWeb", values) };
    case "game_use": return { icon: Gamepad2, label: playtestLabel(values, false) };
    case "generate_image": return { icon: WandSparkles, label: t("timeline.generatingImage") };
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
    case "bash": return { icon: Terminal, label: t("timeline.ran", { command: text(values?.command) || t("timeline.detail.command") }) };
    case "edit":
    case "write": return { icon: FilePenLine, label: withTarget("edited", values) };
    case "read": return { icon: FileText, label: withTarget("read", values) };
    case "grep": return { icon: Search, label: searchLabel("searchedFor", values) };
    case "find": return { icon: Search, label: searchLabel("searchedFor", values) };
    case "ls": return { icon: FileText, label: withTarget("listed", values) };
    case "web_search": return { icon: Search, label: searchLabel("searchedWeb", values) };
    case "game_use": return { icon: Gamepad2, label: playtestLabel(values, true) };
    case "generate_image": return { icon: WandSparkles, label: t("timeline.generatedImage") };
    default: return { icon: Wrench, label: t("timeline.used", { tool: toolName }) };
  }
}

function playtestLabel(values: Record<string, unknown> | undefined, completed: boolean): string {
  const operation = text(values?.operation);
  switch (operation) {
    case "open":
    case "inspect":
    case "capture":
    case "close": return t(`timeline.playtest.${operation}.${completed ? "done" : "running"}`);
    case "act": {
      const count = Array.isArray(values?.actions) ? values.actions.length : 0;
      return t(`timeline.playtest.${count === 1 ? "action" : "actions"}.${completed ? "done" : "running"}`);
    }
    default: return t(`timeline.playtest.other.${completed ? "done" : "running"}`);
  }
}

function providerLabel(provider: "exa" | "parallel" | "custom"): string {
  return provider === "exa" ? "Exa" : provider === "parallel" ? "Parallel" : t("timeline.detail.customProvider");
}

function searchLabel(action: "searchingFor" | "finding" | "searchingWeb" | "searchedFor" | "searchedWeb", values: Record<string, unknown> | undefined): string {
  const query = text(values?.pattern) || text(values?.query);
  const target = text(values?.path) || text(values?.file_path);
  if (query && target) return t(`timeline.search.${action}.queryIn`, { query, target });
  if (query) return t(`timeline.search.${action}.query`, { query });
  return target ? t(`timeline.search.${action}.filesIn`, { target }) : t(`timeline.search.${action}.files`);
}

function withTarget(action: "editing" | "writing" | "reading" | "listing" | "edited" | "read" | "listed", values: Record<string, unknown> | undefined): string {
  const target = text(values?.path) || text(values?.file_path);
  return target ? t(`timeline.target.${action}.with`, { target }) : t(`timeline.target.${action}.without`);
}

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function text(value: unknown): string {
  return typeof value === "string" ? value : "";
}
