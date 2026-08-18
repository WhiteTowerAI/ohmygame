import {
  Check,
  ChevronDown,
  Copy,
  FilePenLine,
  FileText,
  LoaderCircle,
  Pencil,
  Search,
  Terminal,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { isValidElement, useEffect, useState, type KeyboardEvent, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentItem } from "../shared/contracts.js";
import { imageSource } from "./image-attachments.js";
import { projectAgentTurns, type AgentTurn } from "./agent-turns.js";
import { toolGroupSummary, type ToolItem } from "./work-items.js";
import { projectTurnDisplay, type TurnDisplay } from "./turn-display.js";

interface AgentTimelineProps {
  items: AgentItem[];
  activeTurnId?: string;
  revisionDisabled?: boolean;
  onRevise?: (prompt: string) => Promise<boolean>;
}

export function AgentTimeline({ items, activeTurnId, revisionDisabled, onRevise }: AgentTimelineProps) {
  const [now, setNow] = useState(Date.now());
  const [editingItemId, setEditingItemId] = useState<string>();
  const [draft, setDraft] = useState("");
  const [copiedItemId, setCopiedItemId] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  useEffect(() => {
    if (!activeTurnId) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [activeTurnId]);

  const turns = projectAgentTurns(items, activeTurnId);
  const latestUserId = [...turns].reverse().find((turn) => turn.user)?.user?.id;
  useEffect(() => {
    if (editingItemId && editingItemId !== latestUserId) setEditingItemId(undefined);
  }, [editingItemId, latestUserId]);

  async function copy(item: NonNullable<AgentTurn["user"]>) {
    if (!item.text) return;
    try {
      await navigator.clipboard.writeText(item.text);
    } catch {
      return;
    }
    setCopiedItemId(item.id);
    window.setTimeout(() => setCopiedItemId((current) => current === item.id ? undefined : current), 1_500);
  }

  function edit(item: NonNullable<AgentTurn["user"]>) {
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

  return turns.map((turn) => (
    <Turn
      key={turn.id}
      display={projectTurnDisplay(turn, now)}
      now={now}
      userControls={{
        editing: turn.user?.id === editingItemId && editingItemId === latestUserId,
        draft,
        copied: turn.user?.id === copiedItemId,
        canEdit: Boolean(onRevise && turn.user?.text && turn.user.id === latestUserId),
        disabled: Boolean(revisionDisabled || submitting),
        onCopy: copy,
        onEdit: edit,
        onDraftChange: setDraft,
        onCancel: () => setEditingItemId(undefined),
        onSubmit: submitRevision,
      }}
    />
  ));
}

interface UserControls {
  editing: boolean;
  copied: boolean;
  canEdit: boolean;
  disabled: boolean;
  draft: string;
  onCopy: (item: NonNullable<AgentTurn["user"]>) => void;
  onEdit: (item: NonNullable<AgentTurn["user"]>) => void;
  onDraftChange: (value: string) => void;
  onCancel: () => void;
  onSubmit: () => void;
}

function Turn({ display, now, userControls }: { display: TurnDisplay; now: number; userControls: UserControls }) {
  return (
    <article className="agent-turn">
      <UserInput item={display.user} controls={userControls} />
      {display.active ? <ActiveWork display={display} now={now} /> : null}
      {!display.active && display.work.length > 0 ? <CompletedWork display={display} /> : null}
      {display.messages.map((item) => <TimelineItem key={item.id} item={item} />)}
      {display.finalMessages.map((item) => <TimelineItem key={item.id} item={item} />)}
    </article>
  );
}

function UserInput({ item, controls }: { item: AgentTurn["user"]; controls: UserControls }) {
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
        <LoaderCircle className={display.working ? undefined : "spin"} size={12} aria-hidden="true" />
        <span>{display.working ? `Working for ${activeTurnDuration(display, now)}` : thinkingLabel(display.thinkingText)}</span>
      </div>
      {hasContent ? (
        <div className="active-work-items">
          <WorkItems items={display.work} />
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
        <ChevronDown className="work-chevron" size={13} />
        <span>Worked for {turnDuration(display)}</span>
      </summary>
      <div className="work-items">
        <WorkItems items={display.work} />
      </div>
    </details>
  );
}

function WorkItems({ items }: { items: TurnDisplay["work"] }) {
  return items.map((item) => item.kind === "item"
    ? <TimelineItem key={item.item.id} item={item.item} />
    : <ToolActivityGroup key={item.id} tools={item.tools} active={item.active} thinking={item.thinking} />);
}

function ToolActivityGroup({ tools, active, thinking }: { tools: ToolItem[]; active?: ToolItem; thinking?: Extract<AgentItem, { kind: "thinking" }> }) {
  if (thinking) return <ThinkingActivity text={thinking.text} />;
  if (active) return <ToolActivity item={active} />;
  if (tools.length === 1) return <ToolActivity item={tools[0]} completed />;
  const Icon = toolGroupIcon(tools);
  return (
    <details className="tool-activity-group">
      <summary className="tool-group-summary">
        <Icon size={13} aria-hidden="true" />
        <span className="tool-label">{toolGroupSummary(tools)}</span>
        <ChevronDown className="tool-group-chevron" size={13} aria-hidden="true" />
      </summary>
      <div className="tool-group-items">
        {tools.map((tool) => <ToolActivity key={tool.id} item={tool} completed />)}
      </div>
    </details>
  );
}

function toolGroupIcon(tools: ToolItem[]): LucideIcon {
  if (tools.some((tool) => tool.toolName === "edit" || tool.toolName === "write")) return FilePenLine;
  if (tools.some((tool) => tool.toolName === "grep" || tool.toolName === "find" || tool.toolName === "read" || tool.toolName === "ls")) return Search;
  if (tools.some((tool) => tool.toolName === "bash")) return Terminal;
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

function TimelineItem({ item }: { item: AgentItem }) {
  if (item.kind === "thinking") return null;
  if (item.kind === "tool") return <ToolActivity item={item} />;
  if (item.kind === "retry") {
    return (
      <div className="timeline-event timeline-event-warning">
        <LoaderCircle className="spin" size={13} />
        <span>Retrying {item.attempt}/{item.maxAttempts}: {item.error}</span>
      </div>
    );
  }
  if (item.kind === "compaction") {
    return (
      <div className={`timeline-event${item.status === "error" ? " timeline-event-error" : ""}`}>
        {item.status === "running" ? <LoaderCircle className="spin" size={13} /> : <X size={13} />}
        <span>{item.error ?? "Compacting context"}</span>
      </div>
    );
  }
  if (item.kind === "assistant") {
    if (!item.text && item.status === "complete") return null;
    return (
      <div className={`assistant-message assistant-${item.status}${item.phase === "commentary" ? " commentary-message" : ""}`}>
        {item.text ? <MarkdownContent text={item.text} /> : null}
        {item.status === "cancelled" && !item.text ? <span className="muted-text">Stopped</span> : null}
        {item.status === "interrupted" && !item.text ? <span className="muted-text">Interrupted</span> : null}
        {item.error ? <p className="message-error" role="alert">{item.error}</p> : null}
      </div>
    );
  }
  return null;
}

function MarkdownContent({ text, className = "" }: { text: string; className?: string }) {
  return (
    <div className={`markdown-content${className ? ` ${className}` : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => <a href={href} target="_blank" rel="noreferrer">{children}</a>,
          pre: ({ children }) => <MarkdownCodeBlock>{children}</MarkdownCodeBlock>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
}

function MarkdownCodeBlock({ children }: { children?: ReactNode }) {
  const [copied, setCopied] = useState(false);
  const code = nodeText(children).replace(/\n$/, "");
  const language = isValidElement<{ className?: string }>(children)
    ? children.props.className?.match(/language-([^\s]+)/)?.[1]
    : undefined;

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-header">
        <span>{language ?? "Code"}</span>
        <button type="button" onClick={() => {
          void navigator.clipboard.writeText(code).then(() => setCopied(true));
        }}>
          {copied ? <Check size={12} /> : <Copy size={12} />}
          <span>{copied ? "Copied" : "Copy"}</span>
        </button>
      </div>
      <pre>{children}</pre>
    </div>
  );
}

function ToolActivity({ item, completed = false }: { item: Extract<AgentItem, { kind: "tool" }>; completed?: boolean }) {
  const presentation = completed ? completedToolPresentation(item.toolName, item.args) : toolPresentation(item.toolName, item.args);
  const Icon = presentation.icon;
  const label = item.status === "preparing" ? preparingToolLabel(item.toolName) : presentation.label;
  return (
    <div className={`tool-activity tool-row timeline-activity tool-${item.status}`}>
      <Icon size={13} aria-hidden="true" />
      <span className="tool-label" title={label}>{label}</span>
      <span className="tool-result" aria-label={item.status}>
        {item.status === "preparing" || item.status === "running" ? <LoaderCircle className="spin" size={12} /> : null}
        {item.status === "error" ? <X size={12} /> : null}
      </span>
    </div>
  );
}

function preparingToolLabel(toolName: string): string {
  switch (toolName) {
    case "bash": return "Preparing command";
    case "read": return "Preparing read";
    case "write": return "Preparing file";
    case "edit": return "Preparing edit";
    case "tool": return "Preparing";
    default: return `Preparing ${toolName}`;
  }
}

function toolPresentation(toolName: string, args: unknown): { icon: LucideIcon; label: string } {
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

function completedToolPresentation(toolName: string, args: unknown): { icon: LucideIcon; label: string } {
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

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}
