import { isValidElement, memo, useState, type ReactNode } from "react";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";
import { Box, Check, Copy, FileCode2, FileText, Film, Image, Music2, type IconComponent } from "./icons.js";

export type WorkspaceFileIconKind = "code" | "text" | "image" | "video" | "audio" | "model" | "file";

const FILE_ICON_COMPONENTS: Record<WorkspaceFileIconKind, IconComponent> = {
  code: FileCode2,
  text: FileText,
  image: Image,
  video: Film,
  audio: Music2,
  model: Box,
  file: FileText,
};

const FILE_ICON_EXTENSIONS: Record<Exclude<WorkspaceFileIconKind, "file">, ReadonlySet<string>> = {
  code: new Set(["c", "cc", "cpp", "cs", "css", "cxx", "gd", "glsl", "go", "h", "hpp", "html", "htm", "java", "js", "jsx", "kt", "kts", "less", "lua", "mjs", "cjs", "php", "py", "rb", "rs", "sass", "scss", "shader", "sh", "sql", "svelte", "swift", "ts", "tscn", "tsx", "vue", "wgsl"]),
  text: new Set(["conf", "config", "csv", "env", "ini", "json", "jsonc", "lock", "md", "markdown", "text", "toml", "txt", "xml", "yaml", "yml"]),
  image: new Set(["avif", "bmp", "gif", "ico", "jpeg", "jpg", "png", "svg", "webp"]),
  video: new Set(["m4v", "mov", "mp4", "webm"]),
  audio: new Set(["aac", "flac", "m4a", "mp3", "ogg", "wav"]),
  model: new Set(["blend", "dae", "fbx", "glb", "gltf", "obj", "stl"]),
};

export const MarkdownContent = memo(function MarkdownContent({ text, className = "", workspacePath, onOpenWorkspaceFile, renderImage }: {
  text: string;
  className?: string;
  workspacePath?: string;
  onOpenWorkspaceFile?: (path: string) => void;
  renderImage?: (src: string | undefined, alt: string | undefined) => ReactNode;
}) {
  return (
    <div className={`markdown-content${className ? ` ${className}` : ""}`}>
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          ...(renderImage ? { img: ({ src, alt }: { src?: string; alt?: string }) => renderImage(src, alt) } : {}),
          a: ({ href, children }) => {
            const filePath = onOpenWorkspaceFile ? workspaceLinkPath(href, workspacePath) : undefined;
            if (filePath) {
              const iconKind = workspaceFileIconKind(filePath);
              const FileIcon = FILE_ICON_COMPONENTS[iconKind];
              return <a className="workspace-file-link" data-file-kind={iconKind} href={href} title={`Open ${filePath} in Code`} onClick={(event) => {
                event.preventDefault();
                onOpenWorkspaceFile?.(filePath);
              }}><FileIcon size={13} aria-hidden="true" />{children}</a>;
            }
            return <a href={href} target="_blank" rel="noreferrer">{children}</a>;
          },
          pre: ({ children }) => <MarkdownCodeBlock>{children}</MarkdownCodeBlock>,
        }}
      >
        {text}
      </ReactMarkdown>
    </div>
  );
});

export function workspaceFileIconKind(filePath: string): WorkspaceFileIconKind {
  const name = filePath.split("/").at(-1)?.toLocaleLowerCase() ?? "";
  const extension = name.includes(".") ? name.split(".").at(-1) ?? "" : "";
  for (const [kind, extensions] of Object.entries(FILE_ICON_EXTENSIONS) as Array<[Exclude<WorkspaceFileIconKind, "file">, ReadonlySet<string>]>) {
    if (extensions.has(extension)) return kind;
  }
  return "file";
}

export function workspaceLinkPath(href: string | undefined, workspacePath?: string): string | undefined {
  if (!href || href.startsWith("#")) return undefined;
  let value = href;
  if (/^file:/i.test(value)) {
    try {
      value = new URL(value).pathname;
    } catch {
      return undefined;
    }
  } else if (/^[a-z][a-z\d+.-]*:/i.test(value)) {
    return undefined;
  }
  value = value.split(/[?#]/, 1)[0];
  try {
    value = decodeURIComponent(value);
  } catch {
    return undefined;
  }
  value = value.replaceAll("\\", "/");
  value = value.replace(/:\d+(?::\d+)?$/, "");
  const root = workspacePath?.replaceAll("\\", "/").replace(/\/$/, "");
  if (/^\/[A-Za-z]:\//.test(value)) value = value.slice(1);
  const absolute = value.startsWith("/") || /^[A-Za-z]:\//.test(value);
  if (absolute) {
    if (!root || !pathWithinRoot(value, root)) return undefined;
    value = value.slice(root.length).replace(/^\/+/, "");
  }
  const parts = value.split("/").filter((part) => part && part !== ".");
  if (parts.length === 0 || parts.some((part) => part === "..")) return undefined;
  const filePath = parts.join("/");
  return looksLikeWorkspaceFile(filePath) ? filePath : undefined;
}

const EXTENSIONLESS_WORKSPACE_FILES = new Set(["agents.md", "dockerfile", "gemfile", "license", "makefile", "procfile", "rakefile"]);
const OTHER_WORKSPACE_FILE_EXTENSIONS = new Set(["data", "gitignore", "pdf", "wasm", "zip"]);

function looksLikeWorkspaceFile(filePath: string): boolean {
  const name = filePath.split("/").at(-1) ?? "";
  if (!name || name.endsWith("/")) return false;
  if (EXTENSIONLESS_WORKSPACE_FILES.has(name.toLocaleLowerCase())) return true;
  if (name.startsWith(".") && name.length > 1) return true;
  const extension = name.includes(".") ? name.split(".").at(-1)?.toLocaleLowerCase() : undefined;
  if (!extension) return false;
  return filePath.includes("/") || OTHER_WORKSPACE_FILE_EXTENSIONS.has(extension) ||
    Object.values(FILE_ICON_EXTENSIONS).some((extensions) => extensions.has(extension));
}

function pathWithinRoot(value: string, root: string): boolean {
  const insensitive = /^[A-Za-z]:\//.test(root);
  const candidate = insensitive ? value.toLocaleLowerCase() : value;
  const base = insensitive ? root.toLocaleLowerCase() : root;
  return candidate.startsWith(`${base}/`);
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
