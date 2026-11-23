import { isValidElement, memo, useEffect, useMemo, useRef, useState, type ReactNode, type RefObject } from "react";
import { createPortal } from "react-dom";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { isBrowserUrl } from "../shared/browser.js";
import { mediaFileInfo } from "../shared/media-files.js";
import { Box, Check, Copy, ExternalLink, FolderOpen, Globe2, FileCode2, FileText, Film, Image, Music2, TriangleAlert, type IconComponent } from "./icons.js";
import { t } from "./i18n.js";
import { ContextMenu, useAnchoredPosition, type MenuEntry } from "./ui/index.js";
import { useWorkspaceAssetUrl } from "./use-workspace-asset-url.js";

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

export const MarkdownContent = memo(function MarkdownContent({ text, className = "", projectId, workspacePath, baseDir, imageRevision, onOpenWorkspaceFile, onOpenInBrowser, renderImage }: {
  text: string;
  className?: string;
  /** Loads project images and enables previews for workspace links. */
  projectId?: string;
  workspacePath?: string;
  baseDir?: string;
  imageRevision?: number;
  onOpenWorkspaceFile?: (path: string) => void;
  onOpenInBrowser?: (url: string) => void;
  renderImage?: (src: string | undefined, alt: string | undefined) => ReactNode;
}) {
  // Stable component types keep loaded images mounted when only Markdown text changes.
  const components = useMemo<Components>(() => ({
    ...(renderImage || projectId || baseDir !== undefined ? {
      img: ({ src, alt, title }) => renderImage ? renderImage(src, alt) : (
        <WorkspaceMarkdownImage projectId={projectId} baseDir={baseDir} revision={imageRevision} src={src} alt={alt} title={title} />
      ),
    } : {}),
    a: ({ href, children }) => {
      const target = markdownLinkTarget(href, { workspacePath, baseDir, files: Boolean(onOpenWorkspaceFile) });
      if (target.kind === "file")
        return <WorkspaceFileLink href={href!} path={target.path} projectId={projectId} workspacePath={workspacePath} onOpen={onOpenWorkspaceFile!}>{children}</WorkspaceFileLink>;
      if (target.kind === "web") return <WebLink url={target.url} onOpenInBrowser={onOpenInBrowser}>{children}</WebLink>;
      if (target.kind === "anchor") return <a href={href}>{children}</a>;
      return <UnresolvedLink href={href}>{children}</UnresolvedLink>;
    },
    pre: MarkdownCodeBlock,
  }), [projectId, workspacePath, baseDir, imageRevision, onOpenWorkspaceFile, onOpenInBrowser, renderImage]);

  return (
    <div className={`markdown-content${className ? ` ${className}` : ""}`}>
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {text}
      </ReactMarkdown>
    </div>
  );
});

function WorkspaceMarkdownImage({ projectId, revision, baseDir = "", src, alt, title }: {
  projectId?: string;
  revision?: number;
  baseDir?: string;
  src?: string;
  alt?: string;
  title?: string;
}) {
  const path = workspaceLinkPath(src, undefined, baseDir);
  const imageProject = path && mediaFileInfo(path)?.mediaType === "image" ? projectId : undefined;
  const { url } = useWorkspaceAssetUrl(imageProject, path ?? "", revision, undefined, Boolean(imageProject));
  const external = src && /^(?:https?:|\/\/)/i.test(src) ? src : undefined;
  const resolved = url ?? external;
  return resolved ? <img src={resolved} alt={alt ?? ""} title={title} loading="lazy" />
    : <span className="workspace-markdown-image-fallback">{alt}</span>;
}

export type MarkdownLinkTarget =
  | { kind: "file"; path: string }
  | { kind: "web"; url: string }
  | { kind: "anchor" }
  | { kind: "unresolved" };

/**
 * Where a Markdown link goes: a project file (when the caller can open one), a
 * web page or email address, a heading on the same page, or nowhere the app
 * can follow, which is then shown as text rather than as a dead link.
 */
export function markdownLinkTarget(href: string | undefined, { workspacePath, baseDir, files }: { workspacePath?: string; baseDir?: string; files: boolean }): MarkdownLinkTarget {
  if (!href) return { kind: "unresolved" };
  if (href.startsWith("#")) return { kind: "anchor" };
  const path = files ? workspaceLinkPath(href, workspacePath, baseDir) : undefined;
  if (path) return { kind: "file", path };
  return isWebLink(href) ? { kind: "web", url: href } : { kind: "unresolved" };
}

function isWebLink(href: string): boolean {
  if (isBrowserUrl(href)) return true;
  try {
    return new URL(href).protocol === "mailto:";
  } catch {
    return false;
  }
}

function copyText(text: string): void {
  void navigator.clipboard?.writeText(text).catch(() => undefined);
}

/** Opens a web or email link the way clicking it does: the desktop app sends it to the system. */
function openWebLink(url: string): void {
  window.open(url, "_blank", "noopener,noreferrer");
}

function WebLink({ url, onOpenInBrowser, children }: { url: string; onOpenInBrowser?: (url: string) => void; children?: ReactNode }) {
  const email = url.toLowerCase().startsWith("mailto:");
  const inPanel = onOpenInBrowser && isBrowserUrl(url) ? onOpenInBrowser : undefined;
  const items: MenuEntry[] = [
    ...(inPanel ? [{ label: t("markdown.openInBrowserPanel"), icon: <Globe2 size={14} />, onSelect: () => inPanel(url) }] : []),
    { label: t(email ? "markdown.openInMailApp" : "markdown.openInSystemBrowser"), icon: <ExternalLink size={14} />, onSelect: () => openWebLink(url) },
    "separator",
    email
      ? { label: t("markdown.copyEmail"), icon: <Copy size={14} />, onSelect: () => copyText(decodeEmail(url)) }
      : { label: t("markdown.copyLink"), icon: <Copy size={14} />, onSelect: () => copyText(url) },
    { label: t("markdown.copyLinkText"), onSelect: () => copyText(nodeText(children)) },
  ];
  const link = <a href={url} target="_blank" rel="noreferrer" title={email ? decodeEmail(url) : url}>{children}</a>;
  return <ContextMenu inline items={items}>
    {inPanel ? <span className="markdown-browser-link">
      {link}
      <button type="button" aria-label={t("markdown.openInBrowserPanel")} title={t("markdown.openInBrowserPanel")} onClick={() => inPanel(url)}>
        <Globe2 size={13} aria-hidden="true" />
      </button>
    </span> : link}
  </ContextMenu>;
}

function decodeEmail(url: string): string {
  const address = url.slice("mailto:".length).split("?", 1)[0];
  try {
    return decodeURIComponent(address);
  } catch {
    return address;
  }
}

/** A link the app cannot follow reads as text, and still says where it pointed. */
function UnresolvedLink({ href, children }: { href?: string; children?: ReactNode }) {
  const items: MenuEntry[] = [
    ...(href ? [{ label: t("markdown.copyLink"), icon: <Copy size={14} />, onSelect: () => copyText(href) }] : []),
    { label: t("markdown.copyLinkText"), onSelect: () => copyText(nodeText(children)) },
  ];
  return <ContextMenu inline items={items}>
    <span className="markdown-unresolved-link" title={href ? t("markdown.cannotOpenLink", { href }) : undefined}>{children}</span>
  </ContextMenu>;
}

// A preview waits a moment, so moving across a message does not flash cards.
const FILE_PREVIEW_DELAY = 350;

function WorkspaceFileLink({ href, path, projectId, workspacePath, onOpen, children }: {
  href: string;
  path: string;
  projectId?: string;
  workspacePath?: string;
  onOpen: (path: string) => void;
  children?: ReactNode;
}) {
  const anchor = useRef<HTMLAnchorElement>(null);
  const timer = useRef<number>(undefined);
  const [preview, setPreview] = useState(false);
  const iconKind = workspaceFileIconKind(path);
  const FileIcon = FILE_ICON_COMPONENTS[iconKind];
  useEffect(() => () => window.clearTimeout(timer.current), []);
  const show = (delay: number) => {
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setPreview(true), delay);
  };
  const hide = () => {
    window.clearTimeout(timer.current);
    setPreview(false);
  };
  const desktop = typeof window !== "undefined" ? window.ohMyGameDesktop : undefined;
  const openWith = desktop?.openProjectFile && projectId
    ? (mode: "default" | "reveal") => void desktop.openProjectFile(projectId, path, mode).catch(() => undefined)
    : undefined;
  const fileManager = desktop?.platform === "darwin" ? "Finder" : desktop?.platform === "win32" ? t("workspace.fileExplorer") : t("workspace.fileManager");
  const absolutePath = workspacePath ? joinWorkspacePath(workspacePath, path) : undefined;
  const items: MenuEntry[] = [
    { label: t("markdown.openFile"), icon: <FileIcon size={14} />, onSelect: () => onOpen(path) },
    ...(openWith ? [
      { label: t("markdown.openInDefaultApp"), icon: <ExternalLink size={14} />, onSelect: () => openWith("default") },
      { label: t("workspace.showIn", { app: fileManager }), icon: <FolderOpen size={14} />, onSelect: () => openWith("reveal") },
    ] : []),
    "separator",
    { label: t("workspace.copyPath"), icon: <Copy size={14} />, onSelect: () => copyText(path) },
    ...(absolutePath ? [{ label: t("markdown.copyFullPath"), onSelect: () => copyText(absolutePath) }] : []),
  ];
  return <ContextMenu inline items={items}>
    <a ref={anchor} className="workspace-file-link" data-file-kind={iconKind} href={href}
      onPointerEnter={() => show(FILE_PREVIEW_DELAY)} onPointerLeave={hide}
      // A click focuses the link too; only keyboard focus shows the card.
      onFocus={(event) => { if (event.currentTarget.matches(":focus-visible")) show(0); }}
      onBlur={hide} onContextMenu={hide}
      onClick={(event) => {
        event.preventDefault();
        hide();
        onOpen(path);
      }}><FileIcon size={13} aria-hidden="true" />{children}</a>
    {preview ? <WorkspaceFilePreview anchor={anchor} path={path} kind={iconKind} projectId={projectId} /> : null}
  </ContextMenu>;
}

function joinWorkspacePath(root: string, path: string): string {
  const separator = /^[A-Za-z]:\\/.test(root) || (root.includes("\\") && !root.includes("/")) ? "\\" : "/";
  return `${root.replace(/[\\/]+$/, "")}${separator}${separator === "/" ? path : path.replaceAll("/", "\\")}`;
}

/**
 * The card a project file link shows on hover: its path and, for an image, a
 * thumbnail. Other media is not downloaded just to be hovered.
 */
function WorkspaceFilePreview({ anchor, path, kind, projectId }: {
  anchor: RefObject<HTMLAnchorElement | null>;
  path: string;
  kind: WorkspaceFileIconKind;
  projectId?: string;
}) {
  const card = useRef<HTMLDivElement>(null);
  const style = useAnchoredPosition(true, anchor, card, "top-start");
  const image = kind === "image";
  const media = useWorkspaceAssetUrl(image ? projectId : undefined, path, 0, undefined, image && Boolean(projectId));
  const FileIcon = FILE_ICON_COMPONENTS[kind];
  const name = path.split("/").at(-1) ?? path;
  return createPortal(
    <div ref={card} className="markdown-file-preview" role="tooltip" style={style}>
      {image && projectId ? <div className="markdown-file-preview-media">
        {media.url ? <img src={media.url} alt="" />
          : media.error ? <span className="markdown-file-preview-error"><TriangleAlert size={14} aria-hidden="true" />{t("markdown.fileUnavailable")}</span>
          : <span className="markdown-file-preview-loading" aria-label={t("workspace.loadingPreview")} />}
      </div> : null}
      <div className="markdown-file-preview-name"><FileIcon size={13} aria-hidden="true" /><span>{name}</span></div>
      <div className="markdown-file-preview-path">{path}</div>
      <div className="markdown-file-preview-hint">{t("markdown.fileLinkHint")}</div>
    </div>,
    document.body,
  );
}

export function workspaceFileIconKind(filePath: string): WorkspaceFileIconKind {
  const name = filePath.split("/").at(-1)?.toLocaleLowerCase() ?? "";
  const extension = name.includes(".") ? name.split(".").at(-1) ?? "" : "";
  for (const [kind, extensions] of Object.entries(FILE_ICON_EXTENSIONS) as Array<[Exclude<WorkspaceFileIconKind, "file">, ReadonlySet<string>]>) {
    if (extensions.has(extension)) return kind;
  }
  return "file";
}

/** `baseDir` is the workspace-relative folder that relative links resolve against. */
export function workspaceLinkPath(href: string | undefined, workspacePath?: string, baseDir?: string): string | undefined {
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
  const parts: string[] = [];
  for (const part of [...(absolute || !baseDir ? [] : baseDir.split("/")), ...value.split("/")]) {
    if (!part || part === ".") continue;
    if (part !== "..") parts.push(part);
    else if (baseDir === undefined || !parts.pop()) return undefined;
  }
  if (parts.length === 0) return undefined;
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
  const [copyResult, setCopyResult] = useState<{ code: string; copied: boolean }>();
  const copyAttempt = useRef(0);
  const code = nodeText(children).replace(/\n$/, "");
  const result = copyResult?.code === code ? copyResult : undefined;
  const language = isValidElement<{ className?: string }>(children)
    ? children.props.className?.match(/language-([^\s]+)/)?.[1]
    : undefined;

  return (
    <div className="markdown-code-block">
      <div className="markdown-code-header">
        <span>{language ?? t("markdown.code")}</span>
        <button type="button" onClick={async () => {
          const attempt = ++copyAttempt.current;
          setCopyResult(undefined);
          let copied = false;
          try {
            await navigator.clipboard.writeText(code);
            copied = true;
          } catch {
            // Clipboard access can fail when the window loses focus.
          }
          if (attempt === copyAttempt.current) setCopyResult({ code, copied });
        }}>
          {result?.copied ? <Check size={12} /> : <Copy size={12} />}
          <span>{t(result ? (result.copied ? "common.copied" : "common.copyFailed") : "common.copy")}</span>
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
