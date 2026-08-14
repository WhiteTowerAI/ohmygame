import {
  Check,
  ChevronDown,
  FilePenLine,
  FileText,
  LoaderCircle,
  Search,
  Terminal,
  Wrench,
  X,
  type LucideIcon,
} from "lucide-react";
import type { AgentItem } from "../shared/contracts.js";

export function AgentTimeline({ items }: { items: AgentItem[] }) {
  return (
    <>
      {items.map((item) => <TimelineEntry key={item.id} item={item} />)}
    </>
  );
}

function TimelineEntry({ item }: { item: AgentItem }) {
  if (item.kind === "user") return <div className="user-message">{item.text}</div>;
  if (item.kind === "tool") return <ToolActivity item={item} />;
  if (item.kind === "retry") {
    return (
      <div className="retry-activity" role="status">
        <LoaderCircle className="spin" size={13} />
        <span>Retrying {item.attempt}/{item.maxAttempts}: {item.error}</span>
      </div>
    );
  }
  if (item.kind === "compaction") {
    return (
      <div className={`compaction-activity compaction-${item.status}`} role="status">
        {item.status === "running" ? <LoaderCircle className="spin" size={13} /> : item.status === "error" ? <X size={13} /> : <Check size={13} />}
        <span>{item.status === "running" ? "Compacting context" : item.error ?? "Context compacted"}</span>
      </div>
    );
  }
  if (!item.text && item.status === "complete") return null;
  return (
    <div className={`assistant-message assistant-${item.status}`}>
      {item.text ? <div>{item.text}</div> : item.status === "streaming" ? (
        <span className="thinking-label"><LoaderCircle className="spin" size={13} />Thinking</span>
      ) : null}
      {item.status === "cancelled" && !item.text ? <span className="muted-text">Stopped</span> : null}
      {item.status === "interrupted" && !item.text ? <span className="muted-text">Interrupted</span> : null}
      {item.error ? <p className="message-error" role="alert">{item.error}</p> : null}
    </div>
  );
}

function ToolActivity({ item }: { item: Extract<AgentItem, { kind: "tool" }> }) {
  const { icon: Icon, label } = toolPresentation(item.toolName, item.args);
  const hasDetails = item.args !== undefined || Boolean(item.output);
  const content = (
    <>
      <Icon size={14} />
      <span className="tool-label" title={label}>{label}</span>
      <span className="tool-result" aria-label={item.status}>
        {item.status === "running" ? <LoaderCircle className="spin" size={13} /> : null}
        {item.status === "complete" ? <Check size={13} /> : null}
        {item.status === "error" ? <X size={13} /> : null}
      </span>
    </>
  );

  if (!hasDetails) {
    return <div className={`tool-activity tool-row tool-${item.status}`}>{content}</div>;
  }

  return (
    <details className={`tool-activity tool-${item.status}`}>
      <summary>
        <ChevronDown className="tool-chevron" size={13} />
        {content}
      </summary>
      <div className="tool-details">
        {item.args !== undefined ? (
          <div className="tool-detail-section">
            <span>{item.toolName === "bash" ? "Command" : "Input"}</span>
            <pre>{formatToolInput(item.toolName, item.args)}</pre>
          </div>
        ) : null}
        {item.output ? (
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
