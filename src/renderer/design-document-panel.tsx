import { useEffect, useLayoutEffect, useRef, useState, type MouseEvent } from "react";
import { createPortal } from "react-dom";
import type { ProjectState } from "../shared/contracts.js";
import type { CanvasDocumentsState } from "./use-canvas-documents.js";
import { CanvasMarkdown } from "./canvas-document-node.js";
import { CanvasNotice } from "./canvas-notice.js";
import { useDesktopSave } from "./desktop-close-guard.js";
import { Check, ChevronDown, Download, FileText, LoaderCircle, MessageCircle, MoreHorizontal, Plus } from "./icons.js";
import { Button, DropdownMenu, Empty, IconButton, SegmentedControl } from "./ui/index.js";
import { t } from "./i18n.js";
import "./design-document-panel.css";

type View = "read" | "edit" | "split";
type Document = NonNullable<CanvasDocumentsState["workspace"]>["documents"][number];
interface Heading { level: 2 | 3; text: string; element: HTMLElement }

/**
 * Design: the project's game design document, the Markdown the agent reads as
 * the game's design. It reads like a document with its outline beside it, and
 * edits as Markdown, or both side by side. It goes into the next message whole
 * (Reference in chat) or as the text picked in it (Add to chat).
 */
export function DesignDocumentPanel({ project, documents, toolbarTarget, referenced, onReference, onQuote, onAskAgent }: {
  project: Pick<ProjectState, "id">;
  /** Shared with the canvas, which shows the same documents as nodes. */
  documents: CanvasDocumentsState;
  /** The panel's toolbar, where the document picker and view controls go. */
  toolbarTarget: HTMLElement | null;
  /** The path of the document the next message references, if any. */
  referenced?: string;
  onReference: (document: Document | undefined) => void;
  onQuote: (text: string) => void;
  onAskAgent?: (text: string) => void;
}) {
  const { workspace } = documents;
  const storageKey = `design-document:${project.id}`;
  const [activeId, setActiveId] = useState<string | undefined>(() => { try { return localStorage.getItem(storageKey) ?? undefined; } catch { return undefined; } });
  const [view, setView] = useState<View>("read");
  const [pick, setPick] = useState<{ text: string; x: number; y: number }>();
  const [outline, setOutline] = useState<Heading[]>([]);
  const [current, setCurrent] = useState<HTMLElement>();
  const [actionError, setActionError] = useState<string>();
  const page = useRef<HTMLDivElement>(null);
  useDesktopSave(documents.flush);
  const docs = workspace?.documents ?? [];
  const doc = docs.find((item) => item.id === activeId) ?? docs.find((item) => item.main) ?? docs[0];
  const choose = (id: string) => {
    setActiveId(id);
    setPick(undefined);
    try { localStorage.setItem(storageKey, id); } catch { /* The picker still works without storage. */ }
  };
  // The outline is the rendered document's sections; its title is the picker's.
  useLayoutEffect(() => {
    const headings = [...page.current?.querySelectorAll<HTMLElement>(".markdown-content h2, .markdown-content h3") ?? []];
    setOutline(headings.map((element) => ({ level: element.tagName === "H2" ? 2 : 3, text: element.textContent ?? "", element })));
  }, [doc?.id, doc?.markdown, view]);
  // The section being read: the last heading above the top of the page.
  const follow = () => {
    const top = page.current?.getBoundingClientRect().top ?? 0;
    setCurrent(outline.filter((item) => item.element.getBoundingClientRect().top - top <= 24).at(-1)?.element);
  };
  useEffect(follow, [outline]);
  // Text picked in the document offers itself to the chat.
  const onPick = (event: MouseEvent) => {
    const selection = getSelection();
    const text = selection?.toString().trim();
    if (!text || !selection?.rangeCount || !page.current) { setPick(undefined); return; }
    const rect = selection.getRangeAt(0).getBoundingClientRect();
    const frame = page.current.getBoundingClientRect();
    setPick({ text, x: rect.left - frame.left + rect.width / 2, y: rect.top - frame.top + page.current.scrollTop });
    event.stopPropagation();
  };
  const download = (item: Document) => {
    const url = URL.createObjectURL(new Blob([item.markdown], { type: "text/markdown" })), link = window.document.createElement("a");
    link.href = url; link.download = `${item.title || "document"}.md`; link.click(); window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const run = (operation: () => Promise<unknown>) => {
    setActionError(undefined);
    void operation().catch((cause) => setActionError(cause instanceof Error ? cause.message : String(cause)));
  };
  const create = () => run(async () => { choose(await documents.create()); });
  const askAgent = () => onAskAgent?.("Write a game design document for this project and make it the main design document.");
  const path = doc ? `canvas/documents/${doc.id}.md` : undefined;

  const toolbar = doc ? <>
    <DropdownMenu placement="bottom-start" trigger={(props) => (
      <button type="button" {...props} className="design-doc-picker" title={t("designDoc.documents")}>
        <FileText size={14} /><span>{doc.title || t("canvasDocs.untitled")}</span><ChevronDown size={12} />
      </button>
    )} items={[
      { heading: t("designDoc.documents") },
      ...docs.map((item) => ({
        label: item.title || t("canvasDocs.untitled"),
        description: item.main ? t("canvasDoc.main") : undefined,
        checked: item.id === doc.id,
        onSelect: () => choose(item.id),
      })),
      "separator" as const,
      { label: t("designDoc.newDocument"), icon: <Plus size={14} />, onSelect: create },
    ]} />
    <span className="design-doc-spacer" />
    <SegmentedControl<View> size="sm" label={t("canvasDoc.view")} value={view} onChange={setView}
      options={[{ value: "read", label: t("designDoc.read") }, { value: "edit", label: t("designDoc.edit") }, { value: "split", label: t("designDoc.split") }]} />
    <IconButton size="sm" label={referenced === path ? t("designDoc.unreference") : t("designDoc.reference")} active={referenced === path}
      onClick={() => onReference(referenced === path ? undefined : doc)}><MessageCircle size={14} /></IconButton>
    <DropdownMenu placement="bottom-end" trigger={(props) => <IconButton {...props} size="sm" label={t("canvasDoc.options")}><MoreHorizontal size={14} /></IconButton>} items={[
      { label: doc.main ? t("canvasDoc.main") : t("canvasDoc.setMain"), icon: <Check size={14} />, disabled: doc.main, onSelect: () => run(() => documents.setMain(doc.id)) },
      { label: t("canvasDoc.download"), icon: <Download size={14} />, onSelect: () => download(doc) },
    ]} />
  </> : null;

  const notices = <>
    {actionError ? <CanvasNotice className="design-notice" message={t("canvas.actionFailed")} detail={actionError} onDismiss={() => setActionError(undefined)} /> : null}
    {documents.error && !documents.conflict ? <CanvasNotice className="design-notice" tone="error" message={t("canvas.documentsSaveFailed")} detail={documents.error} actionLabel={t("canvas.retrySave")} onAction={() => documents.flush()} /> : null}
    {documents.conflict ? <CanvasNotice className="design-notice" tone="warning" message={t("canvas.documentConflict", { title: documents.conflict.local.title })}>
      <button type="button" onClick={() => documents.resolve("remote")}>{t("canvas.useDisk")}</button>
      <button type="button" onClick={() => documents.resolve("local")}>{t("canvas.keepMine")}</button>
    </CanvasNotice> : null}
  </>;

  let body;
  if (!workspace) {
    body = documents.loadError
      ? <CanvasNotice className="design-notice" tone="error" message={t("canvas.loadFailed")} detail={documents.loadError} actionLabel={t("canvas.reloadWorkspace")} onAction={() => documents.refresh()} />
      : <div className="design-loading" role="status" aria-label={t("designDoc.loading")}><LoaderCircle className="spin" size={18} /></div>;
  } else if (!doc) {
    body = <Empty icon={<FileText size={20} />} title={t("designDoc.empty")} description={t("designDoc.emptyDetail")} action={<>
      {onAskAgent ? <Button variant="primary" onClick={askAgent}>{t("designDoc.askAgent")}</Button> : null}
      <Button onClick={create}>{t("designDoc.newDocument")}</Button>
    </>} />;
  } else {
    const reading = (
      <div ref={page} className="design-doc-page" onMouseUp={onPick} onScroll={follow}>
        <div className="design-doc-text"><CanvasMarkdown projectId={project.id} document={doc} /></div>
        {pick ? (
          <button type="button" className="design-doc-pick" style={{ left: pick.x, top: pick.y }}
            onMouseUp={(event) => event.stopPropagation()}
            onClick={() => { onQuote(pick.text); setPick(undefined); getSelection()?.removeAllRanges(); }}>
            <MessageCircle size={13} />{t("designDoc.addToChat")}
          </button>
        ) : null}
      </div>
    );
    const source = (
      <textarea className="design-doc-source" aria-label={t("canvasDoc.markdown")} spellCheck={false} value={doc.markdown}
        onChange={(event) => documents.update(doc.id, { markdown: event.target.value })} />
    );
    body = <div className={`design-doc is-${view}`}>
      {view === "read" && outline.length ? (
        <nav className="design-doc-outline" aria-label={t("designDoc.outline")}>
          {outline.map((item, index) => (
            <button key={index} type="button" title={item.text} aria-current={item.element === current ? "location" : undefined}
              className={`design-doc-outline-item is-h${item.level}${item.element === current ? " is-current" : ""}`}
              onClick={() => item.element.scrollIntoView({ block: "start", behavior: "smooth" })}>
              {item.text}
            </button>
          ))}
        </nav>
      ) : null}
      {view === "edit" ? source : view === "split" ? <>{source}{reading}</> : reading}
    </div>;
  }

  return <section className="design-doc-panel" aria-label={t("designDoc.label")}>
    {toolbarTarget && toolbar ? createPortal(toolbar, toolbarTarget) : null}
    {notices}
    {body}
  </section>;
}
