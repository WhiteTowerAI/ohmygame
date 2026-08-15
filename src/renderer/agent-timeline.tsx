import {
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
  return (
    <article className="agent-turn">
      {turn.user ? (
        <div className="user-input">
          {turn.user.images?.length ? (
            <div className="user-message-images">
              {turn.user.images.map((image, index) => <img key={`${image.mediaType}:${index}`} src={imageSource(image)} alt={`Attached image ${index + 1}`} />)}
            </div>
          ) : null}
          {turn.user.text ? <div className="user-message">{turn.user.text}</div> : null}
        </div>
      ) : null}
      {turn.active || turn.work.length > 0 ? <WorkSummary turn={turn} thinking={thinking} /> : null}
      {turn.response ? <AssistantResponse item={turn.response} /> : null}
    </article>
  );
}

function WorkSummary({ turn, thinking }: { turn: AgentTurn; thinking: boolean }) {
  const [open, setOpen] = useState(false);
  const [now, setNow] = useState(Date.now());
  const expandable = turn.work.length > 0;

  useEffect(() => {
    if (!turn.active) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, [turn.active]);

  const elapsed = turn.startedAt === undefined
    ? undefined
    : Math.max(0, (turn.active ? now : turn.completedAt ?? turn.startedAt) - turn.startedAt);
  const initialThinking = turn.active && turn.work.length === 0;
  const current = turn.active
    ? thinking && !initialThinking ? "Thinking" : activityLabel(turn.work.at(-1))
    : undefined;

  return (
    <section className={`work-summary work-${turn.status}`}>
      <button
        type="button"
        className="work-summary-toggle"
        aria-expanded={expandable ? open : undefined}
        disabled={!expandable}
        onClick={() => setOpen((value) => !value)}
      >
        {turn.active ? <LoaderCircle className="spin" size={13} aria-hidden="true" /> : null}
        <span className="work-summary-title">{summaryTitle(turn, elapsed, initialThinking)}</span>
        {current ? <span className="work-summary-current" title={current}>{current}</span> : null}
        {expandable ? <ChevronDown className="work-summary-chevron" size={14} aria-hidden="true" /> : null}
      </button>
      {expandable && open ? (
        <div className="work-details">
          {turn.work.map((item) => <WorkItem key={item.id} item={item} />)}
          {thinking && !initialThinking ? <ThinkingActivity /> : null}
        </div>
      ) : null}
    </section>
  );
}

function ThinkingActivity() {
  return (
    <div className="tool-activity tool-row thinking-activity" role="status">
      <LoaderCircle className="spin" size={13} aria-hidden="true" />
      <span className="tool-label">Thinking</span>
      <span />
    </div>
  );
}

function WorkItem({ item }: { item: AgentItem }) {
  if (item.kind === "tool") return <ToolActivity item={item} />;
  if (item.kind === "retry") {
    return (
      <div className="work-event work-event-warning">
        <LoaderCircle className="spin" size={13} />
        <span>Retrying {item.attempt}/{item.maxAttempts}: {item.error}</span>
      </div>
    );
  }
  if (item.kind === "compaction") {
    return (
      <div className={`work-event${item.status === "error" ? " work-event-error" : ""}`}>
        {item.status === "running" ? <LoaderCircle className="spin" size={13} /> : <X size={13} />}
        <span>{item.error ?? "Compacting context"}</span>
      </div>
    );
  }
  if (item.kind === "assistant" && item.text) {
    return <MarkdownContent className="work-note" text={item.text} />;
  }
  return null;
}

function AssistantResponse({ item }: { item: Extract<AgentItem, { kind: "assistant" }> }) {
  if (!item.text && item.status === "complete") return null;
  return (
    <div className={`assistant-message assistant-${item.status}`}>
      {item.text ? <MarkdownContent text={item.text} /> : null}
      {item.status === "cancelled" && !item.text ? <span className="muted-text">Stopped</span> : null}
      {item.status === "interrupted" && !item.text ? <span className="muted-text">Interrupted</span> : null}
      {item.error ? <p className="message-error" role="alert">{item.error}</p> : null}
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
  const isFileTool = ["read", "write", "edit"].includes(item.toolName);
  const showInput = !isFileTool;
  const showOutput = item.status === "error" || !isFileTool;
  const hasDetails = (showInput && item.args !== undefined) || (showOutput && Boolean(item.output));
  const content = (
    <>
      <Icon size={13} aria-hidden="true" />
      <span className="tool-label" title={label}>{label}</span>
      <span className="tool-result" aria-label={item.status}>
        {item.status === "running" ? <LoaderCircle className="spin" size={12} /> : null}
        {item.status === "complete" ? <Check size={12} /> : null}
        {item.status === "error" ? <X size={12} /> : null}
      </span>
    </>
  );

  if (!hasDetails) return <div className={`tool-activity tool-row tool-${item.status}`}>{content}</div>;

  return (
    <details className={`tool-activity tool-${item.status}`} open={item.status === "error" ? true : undefined}>
      <summary>
        <ChevronDown className="tool-chevron" size={12} />
        {content}
      </summary>
      <div className="tool-details">
        {showInput && item.args !== undefined ? (
          <div className="tool-detail-section">
            <span>{item.toolName === "bash" ? "Command" : "Input"}</span>
            <pre>{formatToolInput(item.toolName, item.args)}</pre>
          </div>
        ) : null}
        {showOutput && item.output ? (
          <div className="tool-detail-section">
            <span>Output</span>
            <pre>{item.output}</pre>
          </div>
        ) : null}
        {item.truncated ? <span>Output truncated</span> : null}
      </div>
    </details>
  );
}

function summaryTitle(turn: AgentTurn, elapsed: number | undefined, initialThinking: boolean): string {
  const duration = elapsed === undefined ? "" : ` for ${formatDuration(elapsed)}`;
  if (turn.status === "running") return `${initialThinking ? "Thinking" : "Working"}${duration}`;
  if (turn.status === "cancelled") return `Stopped after ${formatDuration(elapsed ?? 0)}`;
  if (turn.status === "interrupted") return `Interrupted after ${formatDuration(elapsed ?? 0)}`;
  if (turn.status === "error") return `Failed after ${formatDuration(elapsed ?? 0)}`;
  return `Worked${duration}`;
}

function formatDuration(milliseconds: number): string {
  const seconds = Math.max(1, Math.floor(milliseconds / 1_000));
  const minutes = Math.floor(seconds / 60);
  const remainder = seconds % 60;
  return minutes > 0 ? `${minutes}m ${remainder}s` : `${remainder}s`;
}

function activityLabel(item: AgentItem | undefined): string | undefined {
  if (!item) return undefined;
  if (item.kind === "tool") return toolPresentation(item.toolName, item.args).label;
  if (item.kind === "retry") return `Retrying ${item.attempt}/${item.maxAttempts}`;
  if (item.kind === "compaction") return "Compacting context";
  if (item.kind === "assistant") return "Writing response";
  return undefined;
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

function formatValue(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function formatToolInput(toolName: string, value: unknown): string {
  const values = record(value);
  if (toolName === "bash" && typeof values?.command === "string") return values.command;
  return formatValue(value);
}

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}
