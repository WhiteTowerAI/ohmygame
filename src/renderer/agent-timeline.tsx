import {
  Check,
  ChevronRight,
  Copy,
  FilePenLine,
  FileText,
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
import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import type { ThreadItem, ToolArtifact, Turn as ThreadTurn } from "../shared/contracts.js";
import { getWorkspaceAsset } from "./api.js";
import { imageSource } from "./image-attachments.js";
import { mcpToolBrand, mcpToolLabel } from "./mcp-tool-presentation.js";
import { ModelPreview } from "./model-preview.js";
import { toolGroupSummary, type ToolItem } from "./work-items.js";
import { projectTurnDisplay, type TurnDisplay } from "./turn-display.js";
import { SelectedTextMenu } from "./selected-text-menu.js";
import { GodotIcon } from "./godot-icon.js";
import { MarkdownContent } from "./markdown-content.js";

type ToolCallItem = Extract<ThreadItem, { type: "dynamicToolCall" | "mcpToolCall" }>;

interface AgentTimelineProps {
  turns: ThreadTurn[];
  projectId?: string;
  revisionDisabled?: boolean;
  onRevise?: (prompt: string) => Promise<boolean>;
  onAddToChat?: (text: string) => void;
  waitingForInput?: boolean;
}

export function AgentTimeline({ turns, projectId = "", revisionDisabled, onRevise, onAddToChat, waitingForInput = false }: AgentTimelineProps) {
  const [selectionRoot, setSelectionRoot] = useState<HTMLDivElement | null>(null);
  const [now, setNow] = useState(Date.now());
  const [editingItemId, setEditingItemId] = useState<string>();
  const [draft, setDraft] = useState("");
  const [copiedItemId, setCopiedItemId] = useState<string>();
  const [copiedAssistantId, setCopiedAssistantId] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    if (!turns.some((turn) => turn.status === "inProgress")) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [turns]);

  const displays = turns.map((turn) => projectTurnDisplay(turn, now, waitingForInput));
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

  return <div className="agent-timeline-selection-root" ref={setSelectionRoot}>
    {turns.map((turn, index) => (
      <Turn
        key={turn.id}
        projectId={projectId}
        display={displays[index]}
        now={now}
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
  </div>;
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

function Turn({ display, projectId, now, userControls, assistantControls }: { display: TurnDisplay; projectId: string; now: number; userControls: UserControls; assistantControls: AssistantControls }) {
  return (
    <article className="agent-turn">
      <UserInput item={display.user} controls={userControls} />
      {display.active ? <ActiveWork display={display} now={now} /> : null}
      {!display.active && display.work.length > 0 ? <CompletedWork display={display} /> : null}
      {display.messages.map((item) => <TimelineItem key={item.id} item={item} />)}
      {display.finalMessages.length > 0
        ? <FinalResponse projectId={projectId} items={display.finalMessages} artifacts={display.artifacts} controls={assistantControls} />
        : display.artifacts.length > 0 ? <ArtifactPreviews projectId={projectId} artifacts={display.artifacts} /> : null}
    </article>
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

function ActiveWork({ display, now }: { display: TurnDisplay; now: number }) {
  const hasContent = display.work.length > 0 || display.waiting;
  return (
    <section className="work-activity work-activity-active">
      <div className={`work-summary work-summary-active${display.working ? "" : " work-summary-thinking"}`}>
        {display.working ? null : <LoaderCircle className="spin" size={12} aria-hidden="true" />}
        <span>{display.working ? `Working for ${activeTurnDuration(display, now)}` : thinkingLabel(display.thinkingText)}</span>
      </div>
      {hasContent ? (
        <div className="active-work-items">
          <WorkItems items={display.work} active />
          {display.waiting ? <ThinkingActivity /> : null}
        </div>
      ) : null}
    </section>
  );
}

function CompletedWork({ display }: { display: TurnDisplay }) {
  return (
    <details className="work-activity">
      <summary className="work-summary">
        <span>Worked for {turnDuration(display)}</span>
        <ChevronRight className="work-chevron" size={13} />
      </summary>
      <div className="work-items">
        <WorkItems items={display.work} failed={display.failed} />
      </div>
    </details>
  );
}

function WorkItems({ items, active = false, failed = false }: { items: TurnDisplay["work"]; active?: boolean; failed?: boolean }) {
  const rendered = items.map((item, index) => {
    if (item.kind === "tool-group") return <ToolActivityGroup key={item.id} tools={item.tools} current={item.current} thinking={item.thinking} />;
    return <TimelineItem
      key={item.item.id}
      item={item.item}
      hideError={item.item.type === "agentMessage" && Boolean(item.item.error)}
      retrying={active && item.item.type === "retry" && item.item.status === "inProgress" && index === items.length - 1}
    />;
  });
  if (failed) {
    const hasFailedRetry = items.some((item) => item.kind === "item" && item.item.type === "retry" && item.item.status === "failed");
    const error = items.flatMap((item) => item.kind === "item" && item.item.type === "agentMessage" && item.item.error ? [item.item] : []).at(-1);
    if (!hasFailedRetry && error?.type === "agentMessage" && error.error) {
      rendered.push(<ConnectionActivity key="turn-connection-error" title="Connection error" error={error.error.message} failed />);
    }
  }
  return rendered;
}

function ToolActivityGroup({ tools, current, thinking }: { tools: ToolItem[]; current: boolean; thinking?: Extract<ThreadItem, { type: "reasoning" }> }) {
  if (!current && tools.length === 1) return <ToolActivity item={tools[0]} completed />;
  if (tools.length === 0) return thinking ? <ThinkingActivity text={thinking.text} /> : null;
  if (!current && tools.length > 1) {
    const Icon = toolGroupIcon(tools);
    return (
      <details className="tool-activity-group">
        <summary className="tool-group-summary">
          <Icon size={13} aria-hidden="true" />
          <span className="tool-label">{toolGroupSummary(tools)}</span>
          <ChevronRight className="tool-group-chevron" size={13} aria-hidden="true" />
        </summary>
        <div className="tool-group-items">
          {tools.map((tool) => <ToolActivity key={tool.id} item={tool} completed />)}
        </div>
      </details>
    );
  }
  return (
    <div className="tool-group-items tool-group-items-current">
      {tools.map((tool) => <ToolActivity key={tool.id} item={tool} completed={tool.status === "completed" || tool.status === "failed"} />)}
      {thinking ? <ThinkingActivity text={thinking.text} /> : null}
    </div>
  );
}

type ToolIcon = IconComponent | typeof GodotIcon;

function toolGroupIcon(tools: ToolItem[]): ToolIcon {
  if (tools.some((tool) => tool.type === "dynamicToolCall" && (tool.tool === "edit" || tool.tool === "write"))) return FilePenLine;
  if (tools.some((tool) => tool.type === "dynamicToolCall" && (tool.tool === "grep" || tool.tool === "find" || tool.tool === "read" || tool.tool === "ls"))) return Search;
  if (tools.some((tool) => tool.type === "dynamicToolCall" && tool.tool === "bash")) return Terminal;
  const mcpCalls = tools.filter((tool): tool is Extract<ToolItem, { type: "mcpToolCall" }> => tool.type === "mcpToolCall");
  if (mcpCalls.some((call) => mcpToolBrand(call) === "godot")) return GodotIcon;
  if (mcpCalls.length > 0) return Plug;
  return Wrench;
}

function turnDuration(display: TurnDisplay): string {
  const timestamps = [
    display.user?.timestamp,
    ...display.work.flatMap((item) => item.kind === "item" ? [item.item.timestamp] : item.tools.map((tool) => tool.timestamp)),
    ...display.messages.map((item) => item.timestamp),
    ...display.finalMessages.map((item) => item.timestamp),
  ]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (timestamps.length < 2) return "<1s";
  const seconds = Math.max(1, Math.round((Math.max(...timestamps) - Math.min(...timestamps)) / 1_000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function activeTurnDuration(display: TurnDisplay, now: number): string {
  const startedAt = display.user?.timestamp ?? now;
  return formatDuration(Math.max(0, now - startedAt));
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function ThinkingActivity({ text }: { text?: string } = {}) {
  return (
    <div className="tool-activity tool-row timeline-activity thinking-activity" role="status">
      <LoaderCircle className="spin" size={13} aria-hidden="true" />
      <span className="tool-label">{thinkingLabel(text)}</span>
      <span />
    </div>
  );
}

function thinkingLabel(text?: string): string {
  let label = text?.trim();
  if (!label) return "Thinking";
  if (label.startsWith("**")) label = label.slice(2);
  if (label.endsWith("**")) label = label.slice(0, -2);
  return label.trim() || "Thinking";
}

function TimelineItem({ item, hideError = false, retrying = false }: { item: ThreadItem; hideError?: boolean; retrying?: boolean }) {
  if (item.type === "reasoning") return null;
  if (item.type === "dynamicToolCall" || item.type === "mcpToolCall") return <ToolActivity item={item} />;
  if (item.type === "retry") {
    return <ConnectionActivity
      title={item.status === "failed" ? "Connection error" : `Reconnecting ${item.attempt}/${item.maxAttempts}`}
      error={item.error.message}
      retrying={retrying}
      failed={item.status === "failed"}
    />;
  }
  if (item.type === "contextCompaction") {
    return (
      <div className={`timeline-event${item.status === "failed" ? " timeline-event-error" : ""}`}>
        {item.status === "inProgress" ? <LoaderCircle className="spin" size={13} /> : <X size={13} />}
        <span>{item.error?.message ?? "Compacting context"}</span>
      </div>
    );
  }
  if (item.type === "agentMessage") {
    if (!item.text && item.status === "completed") return null;
    if (!item.text.trim() && hideError) return null;
    const message = (
      <div className={`assistant-message assistant-${item.status}`}>
        {item.text ? <MarkdownContent text={item.text} /> : null}
        {item.status === "cancelled" && !item.text ? <span className="muted-text">Stopped</span> : null}
        {item.status === "interrupted" && !item.text ? <span className="muted-text">Interrupted</span> : null}
      </div>
    );
    if (!item.error || hideError) return message;
    return (
      <>
        {message}
        <ConnectionActivity title="Connection error" error={item.error.message} failed />
      </>
    );
  }
  return null;
}

function ConnectionActivity({ title, error, retrying = false, failed = false }: { title: string; error: string; retrying?: boolean; failed?: boolean }) {
  const Icon = failed ? WifiOff : Wifi;
  return (
    <details className={`connection-activity-details${failed ? " connection-activity-failed" : ""}`}>
      <summary className="tool-activity tool-row tool-row-expandable timeline-activity connection-activity" role={failed ? "alert" : undefined}>
        <Icon size={13} aria-hidden="true" />
        <span className="tool-label">{title}</span>
        <ChevronRight className="tool-detail-chevron" size={12} aria-hidden="true" />
        <span className="tool-result">{retrying ? <LoaderCircle className="spin" size={12} aria-hidden="true" /> : null}</span>
      </summary>
      <div className="connection-activity-error">{error}</div>
    </details>
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
        {item.status === "preparing" || item.status === "inProgress" ? <LoaderCircle className="spin" size={12} /> : null}
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
  if (item.type === "dynamicToolCall" && item.tool === "bash") return <ShellDetails item={item} command={text(args?.command)} />;
  if (item.type === "dynamicToolCall" && ["read", "grep", "find", "ls"].includes(item.tool)) return <FileOperationDetails item={item} args={args} />;
  if (item.type === "dynamicToolCall" && ["edit", "write"].includes(item.tool)) return <FileChangeDetails item={item} args={args} />;
  return <StructuredToolDetails item={item} />;
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
      {item.arguments !== undefined ? <ToolDetailBlock label="Input"><pre>{formatToolValue(item.arguments)}</pre></ToolDetailBlock> : null}
      {item.output ? <ToolDetailBlock label="Output"><pre>{item.output}</pre></ToolDetailBlock> : null}
      {item.truncated ? <p className="tool-details-truncated">Output truncated</p> : null}
      {!item.output && item.status === "failed" ? <p className="tool-details-error">The tool call failed without output.</p> : null}
    </div>
  );
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
  if (item.type === "mcpToolCall") return item.arguments !== undefined || Boolean(item.output);
  if (item.tool === "bash") return Boolean(text(record(item.arguments)?.command) || item.output);
  if (["read", "grep", "find", "ls", "edit", "write"].includes(item.tool)) return Boolean(item.output);
  return item.arguments !== undefined || Boolean(item.output);
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
    case "mcp": return "Preparing MCP";
    case "tool": return "Preparing";
    default: return `Preparing ${toolName}`;
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
    case "read": return { icon: Search, label: withTarget("Reading", values) };
    case "grep": return { icon: Search, label: searchLabel("Searching for", values) };
    case "find": return { icon: Search, label: searchLabel("Finding", values) };
    case "ls": return { icon: Search, label: withTarget("Listing", values) };
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
    default: return { icon: Wrench, label: `Used ${toolName}` };
  }
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
