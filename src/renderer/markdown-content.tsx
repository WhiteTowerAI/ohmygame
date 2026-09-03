import { isValidElement, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Check, Copy } from "./icons.js";

export function MarkdownContent({ text, className = "" }: { text: string; className?: string }) {
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

function nodeText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") return String(node);
  if (Array.isArray(node)) return node.map(nodeText).join("");
  if (isValidElement<{ children?: ReactNode }>(node)) return nodeText(node.props.children);
  return "";
}
