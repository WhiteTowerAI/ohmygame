import {
  BrainCircuit,
  Check,
  ChevronDown,
  Copy,
  FilePenLine,
  FileText,
  LoaderCircle,
  Search,
  Terminal,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import { isValidElement, useEffect, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { AgentItem } from "../shared/contracts.js";
import { imageSource } from "./image-attachments.js";
import { projectAgentTurns, type AgentTurn } from "./agent-turns.js";

export function AgentTimeline({ items, activeTurnId, thinking = false }: { items: AgentItem[]; activeTurnId?: string; thinking?: boolean }) {
  return projectAgentTurns(items, activeTurnId).map((turn) => (
    <Turn key={turn.id} turn={turn} thinking={turn.active && thinking} />
  ));
}

function Turn({ turn, thinking }: { turn: AgentTurn; thinking: boolean }) {
  if (turn.active) return <ActiveTurn turn={turn} thinking={thinking} />;
  const phaseAware = turn.items.some((item) => item.kind === "assistant" && item.phase !== undefined);
  if (!phaseAware) return <ChronologicalTurn turn={turn} thinking={thinking} />;
  const workItems = turn.items.filter(isWorkItem);
  const messages = turn.items.filter((item) => !isWorkItem(item));
  return (
    <article className="agent-turn">
      <UserInput item={turn.user} />
      {workItems.length > 0 || thinking ? (
        <CompletedWork turn={turn} items={workItems} />
      ) : null}
      {messages.map((item) => <TimelineItem key={item.id} item={item} />)}
    </article>
  );
}

function ActiveTurn({ turn, thinking }: { turn: AgentTurn; thinking: boolean }) {
  const phaseAware = turn.items.some((item) => item.kind === "assistant" && item.phase !== undefined);
  const workStarted = turn.items.some((item) => item.kind !== "thinking" && isWorkItem(item));
  const visibleItems = turn.items.filter((item) => item.kind !== "thinking");

  if (!phaseAware) {
    let activity: ReactNode = <ThinkingActivity />;
    if (workStarted) activity = <ActiveWork turn={turn} items={turn.items} thinking={thinking} />;
    else if (visibleItems.length > 0) activity = visibleItems.map((item) => <TimelineItem key={item.id} item={item} />);
    return (
      <article className="agent-turn">
        <UserInput item={turn.user} />
        {activity}
      </article>
    );
  }

  const workItems = turn.items.filter(isWorkItem);
  const messages = turn.items.filter((item) => !isWorkItem(item));
  return (
    <article className="agent-turn">
      <UserInput item={turn.user} />
      {workStarted ? <ActiveWork turn={turn} items={workItems} thinking={thinking} /> : null}
      {messages.map((item) => <TimelineItem key={item.id} item={item} />)}
      {!workStarted && messages.length === 0 ? <ThinkingActivity /> : null}
    </article>
  );
}

function ChronologicalTurn({ turn, thinking }: { turn: AgentTurn; thinking: boolean }) {
  return (
    <article className="agent-turn">
      <UserInput item={turn.user} />
      {turn.items.map((item) => <TimelineItem key={item.id} item={item} />)}
      {thinking ? <ThinkingActivity /> : null}
    </article>
  );
}

function UserInput({ item }: { item: AgentTurn["user"] }) {
  if (!item) return null;
  return (
    <div className="user-input">
      {item.images?.length ? (
        <div className="user-message-images">
          {item.images.map((image, index) => <img key={`${image.mediaType}:${index}`} src={imageSource(image)} alt={`Attached image ${index + 1}`} />)}
        </div>
      ) : null}
      {item.text ? <div className="user-message">{item.text}</div> : null}
    </div>
  );
}

function ActiveWork({ turn, items, thinking }: { turn: AgentTurn; items: AgentItem[]; thinking: boolean }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  return (
    <section className="work-activity work-activity-active">
      <div className="work-summary work-summary-active">
        <LoaderCircle className="spin" size={12} aria-hidden="true" />
        <span>Working for {activeTurnDuration(turn, now)}</span>
      </div>
      <div className="active-work-items">
        {items.map((item) => <TimelineItem key={item.id} item={item} />)}
        {thinking ? <ThinkingActivity /> : null}
      </div>
    </section>
  );
}

function CompletedWork({ turn, items }: { turn: AgentTurn; items: AgentItem[] }) {
  return (
    <details className="work-activity">
      <summary className="work-summary">
        <ChevronDown className="work-chevron" size={13} />
        <span>Worked for {turnDuration(turn)}</span>
      </summary>
      <div className="work-items">
        {items.map((item) => <TimelineItem key={item.id} item={item} />)}
      </div>
    </details>
  );
}

function isWorkItem(item: AgentItem): boolean {
  return item.kind === "thinking" || item.kind === "tool" || item.kind === "retry" || item.kind === "compaction" ||
    (item.kind === "assistant" && item.phase === "commentary");
}

function turnDuration(turn: AgentTurn): string {
  const timestamps = [turn.user?.timestamp, ...turn.items.map((item) => item.timestamp)]
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  if (timestamps.length < 2) return "<1s";
  const seconds = Math.max(1, Math.round((Math.max(...timestamps) - Math.min(...timestamps)) / 1_000));
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function activeTurnDuration(turn: AgentTurn, now: number): string {
  const startedAt = turn.user?.timestamp ?? turn.items.find((item) => item.timestamp !== undefined)?.timestamp ?? now;
  return formatDuration(Math.max(0, now - startedAt));
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1_000);
  const minutes = Math.floor(seconds / 60);
  return minutes > 0 ? `${minutes}m ${seconds % 60}s` : `${seconds}s`;
}

function ThinkingActivity() {
  return (
    <div className="tool-activity tool-row timeline-activity thinking-activity" role="status">
      <LoaderCircle className="spin" size={13} aria-hidden="true" />
      <span className="tool-label">Thinking</span>
      <span />
    </div>
  );
}

function TimelineItem({ item }: { item: AgentItem }) {
  if (item.kind === "thinking") return <ThinkingBlock item={item} />;
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

function ThinkingBlock({ item }: { item: Extract<AgentItem, { kind: "thinking" }> }) {
  return (
    <div className="tool-activity tool-row timeline-activity thinking-block">
      <BrainCircuit size={13} aria-hidden="true" />
      <span className="tool-label">Thinking</span>
      <span className="tool-result">
        {item.status === "streaming" ? <LoaderCircle className="spin" size={12} /> : null}
      </span>
    </div>
  );
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

function ToolActivity({ item }: { item: Extract<AgentItem, { kind: "tool" }> }) {
  const { icon: Icon, label } = toolPresentation(item.toolName, item.args);
  return (
    <div className={`tool-activity tool-row timeline-activity tool-${item.status}`}>
      <Icon size={13} aria-hidden="true" />
      <span className="tool-label" title={label}>{label}</span>
      <span className="tool-result" aria-label={item.status}>
        {item.status === "running" ? <LoaderCircle className="spin" size={12} /> : null}
        {item.status === "error" ? <X size={12} /> : null}
      </span>
    </div>
  );
}

function toolPresentation(toolName: string, args: unknown): { icon: LucideIcon; label: string } {
  const values = record(args);
  switch (toolName) {
    case "bash": return { icon: Terminal, label: text(values?.command) || "Running command" };
    case "edit": return { icon: FilePenLine, label: withTarget("Editing", values) };
    case "write": return { icon: FileText, label: withTarget("Writing", values) };
    case "read": return { icon: Search, label: withTarget("Reading", values) };
    default: return { icon: Wrench, label: toolName };
  }
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
