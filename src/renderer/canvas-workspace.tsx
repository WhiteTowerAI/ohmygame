import { workspaceVersion } from "./workspace-version.js";
import { useCanvasTables } from "./use-canvas-tables.js";
import { CanvasTableConflictNotice, ExpandedCanvasTable, type CanvasTables } from "./canvas-table-node.js";
import { canvasTablePath } from "../shared/canvas-table.js";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { AssetCanvasNode, ProjectState, PromptContext } from "../shared/contracts.js";
import { canvasBoardPath } from "../shared/canvas-workspace.js";
import { canvasNodeTitle } from "../shared/canvas-assets.js";
import { canvasDocumentPath } from "../shared/canvas-document.js";
import { CanvasBoardEditor } from "./asset-canvas-workspace.js";
import { createCanvasBoardStorage, type CanvasBoardConflict, type CanvasBoardStorage } from "./canvas-board-storage.js";
import { MediaPicker } from "./media-picker.js";
import { addCanvasMediaFromProject } from "./api.js";
import { changeCanvasBoard, createCanvasBoard, deleteCanvasBoard } from "./canvas-api.js";
import { useCanvasDocuments, type CanvasDocumentsState } from "./use-canvas-documents.js";
import type { CanvasDocuments } from "./canvas-document-node.js";
import { ChevronLeft, ChevronRight, Layers3, MoreHorizontal, Pencil, Plus, Trash2, X } from "./icons.js";
import { CanvasChipSelect } from "./canvas-chip-select.js";
import { CanvasContextMenu } from "./editor-canvas.js";
import { CanvasAssetProvider, canvasAssetSources } from "./use-workspace-asset-url.js";
import "./game-design.css";
import { ProjectMediaModelSettings } from "./media-model-defaults.js";
import { CanvasNotice } from "./canvas-notice.js";
import { useDesktopSave } from "./desktop-close-guard.js";
import { t } from "./i18n.js";
import { Button, Dialog, Field, Input, Loading, Select } from "./ui/index.js";

class CanvasSaveFailure extends Error {
  constructor(cause: unknown) { super(cause instanceof Error ? cause.message : String(cause), { cause }); }
}

export function CanvasWorkspace({ project, documents, headerActionsTarget = null, onLeaveReady, onSaveReady, onContextChange, onProjectUpdated }: {
  project: ProjectState;
  /** The project's documents, when the workspace shares them with the design document panel. */
  documents?: CanvasDocumentsState;
  /** Where its controls go, such as its panel's toolbar. Without one, an asset canvas has its own header. */
  headerActionsTarget?: HTMLElement | null;
  onLeaveReady?: (leave: ((action: () => void) => void) | undefined) => void;
  onSaveReady?: (save: (() => Promise<void>) | undefined) => void;
  onContextChange?: (context: PromptContext | undefined) => void;
  onProjectUpdated?: (project: ProjectState) => void;
}) {
  const [writeVersion] = useState(() => workspaceVersion(project.id));
  const singleBoard = project.type === "asset-canvas";
  const own = useCanvasDocuments(project.id, !documents);
  const docs = documents ?? own, workspace = docs.workspace;
  const tableStorage = useCanvasTables(project.id, workspace);
  const tablesRef = useRef(tableStorage); tablesRef.current = tableStorage;
  const [expandedTable, setExpandedTable] = useState<{ id: string; mode: "edit" | "preview" }>();
  const assetPaths = useMemo(() => canvasAssetSources(project.id, workspace?.assets ?? [], workspace?.unavailableAssets), [project.id, workspace?.assets, workspace?.unavailableAssets]);
  const docsRef = useRef(docs); docsRef.current = docs;
  const [activeId, setActiveId] = useState<string | undefined>(() => { try { return localStorage.getItem(`canvas-active:${project.id}`) ?? undefined; } catch { return undefined; } });
  const [selectedNodes, setSelectedNodes] = useState<AssetCanvasNode[]>([]);
  const [boardConflict, setBoardConflict] = useState<CanvasBoardConflict>();
  const [boardOptions, setBoardOptions] = useState<{ id: string; x: number; y: number }>();
  const [documentView, setDocumentView] = useState<{ id: string; nodeId?: string }>();
  const [dialog, setDialog] = useState<{ type: "create" | "rename" | "delete"; id?: string }>();
  const [name, setName] = useState("");
  const [insertion, setInsertion] = useState<{ documentId?: string; assetId?: string; text?: string }>();
  const [error, setError] = useState<string>();
  const [noticeStack, setNoticeStack] = useState<HTMLDivElement | null>(null);
  const [busy, setBusy] = useState(false);
  const [boardSyncFailed, setBoardSyncFailed] = useState(false);
  const boardSave = useRef<(() => Promise<void>) | undefined>(undefined);
  const boardSync = useRef<(() => Promise<void>) | undefined>(undefined);
  // State, not a ref, so the conflict choices enable once the board can resolve them.
  const [resolveBoard, setResolveBoard] = useState<(version: "local" | "remote") => Promise<void>>();
  const registerSave = useCallback((save: (() => Promise<void>) | undefined) => { boardSave.current = save; }, []);
  const registerSync = useCallback((sync: (() => Promise<void>) | undefined) => { boardSync.current = sync; }, []);
  const registerResolve = useCallback((resolve: typeof resolveBoard) => setResolveBoard(() => resolve), []);
  const flush = useCallback(async () => {
    const results = await Promise.allSettled([boardSave.current?.(), docsRef.current.flush(), tablesRef.current.flush()]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw new CanvasSaveFailure(failure.reason);
  }, []);
  useDesktopSave(flush);
  const retrySync = async () => {
    const results = await Promise.allSettled([docsRef.current.refresh(), boardSync.current?.()]);
    const failure = results.find((result) => result.status === "rejected");
    if (failure?.status === "rejected") throw failure.reason;
  };
  const run = useCallback(async <T,>(operation: () => Promise<T>) => {
    setBusy(true); setError(undefined);
    try { return await operation(); } catch (cause) {
      if (!(cause instanceof CanvasSaveFailure)) setError(cause instanceof Error ? cause.message : String(cause));
    } finally { setBusy(false); }
  }, []);
  const tables: CanvasTables = { storage: tableStorage, issues: workspace?.tableIssues, open: (id, mode = "edit") => setExpandedTable({ id, mode }), add: () => run(async () => {
    const id = await tableStorage.create(); await docsRef.current.refresh(); return id;
  }) };
  const tableContents = [...tableStorage.sessions.values()].map((session) => session.local);
  const leave = useCallback((action: () => void) => { void run(async () => { await flush(); action(); }); }, [run, flush]);
  useEffect(() => { onLeaveReady?.(leave); return () => onLeaveReady?.(undefined); }, [leave, onLeaveReady]);
  useEffect(() => { onSaveReady?.(flush); return () => onSaveReady?.(undefined); }, [flush, onSaveReady]);
  useEffect(() => { if (workspace && (singleBoard || !workspace.boards.some((board) => board.id === activeId))) setActiveId(workspace.boards[0]?.id); }, [workspace, activeId, singleBoard]);
  useEffect(() => { if (activeId) { try { localStorage.setItem(`canvas-active:${project.id}`, activeId); } catch { /* Board selection remains usable without storage. */ } } }, [project.id, activeId]);
  const boardName = workspace?.boards.find((board) => board.id === activeId)?.name;
  const selectionContext = JSON.stringify({ total: selectedNodes.length, nodes: selectedNodes.slice(0, 25).map((node) => ({ id: node.id, name: canvasNodeTitle(node, workspace?.documents, workspace?.assets, tableContents).slice(0, 80), type: node.type, ...(node.type === "document" ? { source: canvasDocumentPath(node.data.documentId) } : node.type === "table" ? { source: canvasTablePath(node.data.tableId) } : node.type === "file" ? { source: node.data.path } : {}) })) });
  useEffect(() => {
    if (!activeId || !boardName) return;
    onContextChange?.({ kind: "canvas-board", label: `${singleBoard ? project.name : boardName}${selectedNodes.length ? t("canvas.selectedCount", { count: selectedNodes.length }) : ""}`.slice(0, 200), text: `Current canvas board: ${canvasBoardPath(activeId)}\nSelected nodes: ${selectionContext}\nAsset paths and descriptions: canvas/assets.json\nRead these current project files to resolve the user's references. Selected nodes identify what the message refers to; they do not limit the requested work. Read actual image files when evaluating their appearance.` });
  }, [activeId, boardName, singleBoard, project.name, selectionContext, onContextChange]);
  useEffect(() => { setSelectedNodes([]); }, [activeId]);
  useEffect(() => { setBoardConflict(undefined); }, [project.id, activeId]);
  useEffect(() => () => onContextChange?.(undefined), [onContextChange]);
  // Storage owns revisions and drafts; its lifetime must follow the board session,
  // not React's disposable memo cache.
  const adapterRef = useRef<CanvasBoardStorage | undefined>(undefined);
  const adapterKey = activeId ? `${project.id}:${activeId}` : undefined;
  if (adapterRef.current?.key !== adapterKey) adapterRef.current = activeId ? createCanvasBoardStorage({
    projectId: project.id, boardId: activeId,
    onConflict: (conflict) => { if (adapterRef.current?.key === adapterKey) setBoardConflict(conflict); }, flushDocuments: async () => { await docsRef.current.flush(); await tablesRef.current.flush(); },
  }) : undefined;
  const adapter = adapterRef.current;
  const design: CanvasDocuments = {
    projectId: project.id, documents: workspace?.documents ?? [], documentIssues: workspace?.documentIssues,
    add: () => run(() => docsRef.current.create()),
    update: docs.update, open: (id, nodeId) => setDocumentView({ id, nodeId }), flush,
    generations: docs.generations, changeGeneration: docs.changeGeneration,
    generate: (id, model, reasoningLevel, referenceSource) => {
      void docsRef.current.generate(id, model, reasoningLevel, referenceSource, () => boardSave.current?.() ?? Promise.resolve());
    }, applyGeneration: docs.applyGeneration,
    setMain: singleBoard ? undefined : (id) => { void run(() => docsRef.current.setMain(id)); },
    insertImage: (id, assetId) => { void run(() => docsRef.current.insertImage(id, assetId)); },
    pickImage: (id) => setInsertion({ documentId: id }),
    appendImage: (assetId) => setInsertion({ assetId, documentId: workspace?.mainDocumentId ?? workspace?.documents[0]?.id }),
    appendText: (text) => setInsertion({ text, documentId: workspace?.mainDocumentId ?? workspace?.documents[0]?.id }),
  };
  const optionsBoard = workspace?.boards.find((board) => board.id === boardOptions?.id);
  const tableConflicts = [...tableStorage.sessions.values()].flatMap((session) => session.conflict ? [session.conflict] : []);
  const floating = <div className="design-board-switcher">
    <Layers3 size="sm" aria-hidden="true" />
    <CanvasChipSelect label={t("canvas.board")} value={activeId} options={(workspace?.boards ?? []).map((board) => ({ value: board.id, label: board.name }))} disabled={busy}
      action={{ label: t("canvas.newBoard"), icon: Plus, onSelect: () => { setName(""); setDialog({ type: "create" }); } }}
      optionAction={{ label: (option) => t("canvas.boardOptions", { name: option.label }), icon: MoreHorizontal, onSelect: (id, anchor) => setBoardOptions({ id, x: anchor.left, y: anchor.bottom + 5 }) }}
      onChange={(id) => void run(async () => { await flush(); setActiveId(id); })} />
  </div>;
  const settingsButton = <ProjectMediaModelSettings key={project.id} project={project} onSaved={(updated) => onProjectUpdated?.(updated)} />;
  return <CanvasAssetProvider assets={assetPaths}><section className="viewer-pane design-workspace" aria-label={singleBoard ? t("canvas.assetCanvasWorkspace") : t("canvas.designWorkspace")}>
    {singleBoard && !headerActionsTarget ? <header className="pane-header viewer-header canvas-pane-header">
      <div className="viewer-navigation" />
      <div className="viewer-controls-slot" />
      <div className="viewer-publish design-header-actions">
        {settingsButton}
      </div>
    </header> : headerActionsTarget ? createPortal(settingsButton, headerActionsTarget) : null}
    {/* Every notice floats in one stack over the top of the canvas; the board adds its own here too. */}
    <div className="canvas-notice-anchor"><div className="canvas-notices" ref={setNoticeStack}>
    {error && error !== docs.error && error !== docs.loadError && error !== tableStorage.error ? <CanvasNotice message={t("canvas.actionFailed")} detail={error} onDismiss={() => setError(undefined)} /> : null}
    {workspace && (docs.loadError || boardSyncFailed) ? <CanvasNotice tone="warning" dismissible={false} message={t("canvas.syncPaused")} detail={docs.loadError} actionLabel={t("canvas.retrySyncAction")} onAction={retrySync} /> : null}
    {docs.loadError && !workspace ? <CanvasNotice tone="error" dismissible={false} message={t("canvas.loadFailed")} detail={docs.loadError} actionLabel={t("canvas.reloadWorkspace")} onAction={() => docsRef.current.refresh()} /> : null}
    {docs.error && !docs.conflict ? <CanvasNotice key="documents" tone="error" dismissible={false} message={t("canvas.documentsSaveFailed")} detail={docs.error} actionLabel={t("canvas.retrySave")} onAction={() => docsRef.current.flush()} /> : null}
    {docs.conflict ? <CanvasNotice key="document-conflict" tone="warning" dismissible={false} message={t("canvas.documentConflict", { title: docs.conflict.local.title })}><button type="button" onClick={() => docs.resolve("remote")}>{t("canvas.useDisk")}</button><button type="button" onClick={() => docs.resolve("local")}>{t("canvas.keepMine")}</button></CanvasNotice> : null}
    {tableStorage.error && !tableConflicts.length ? <CanvasNotice key="tables" tone="error" dismissible={false} message={t("canvas.tablesSaveFailed")} detail={tableStorage.error} actionLabel={t("canvas.retrySave")} onAction={() => tableStorage.flush()} /> : null}
    {tableConflicts.map((conflict) => <CanvasTableConflictNotice key={conflict.local.id} conflict={conflict} storage={tableStorage} />)}
    {boardConflict ? <CanvasNotice key="board-conflict" tone="warning" dismissible={false} message={t("canvas.boardConflict")}>{(["remote", "local"] as const).map((version) => <button type="button" key={version} disabled={busy || !resolveBoard} onClick={() => void run(async () => {
      await resolveBoard?.(version);
      setBoardConflict(undefined);
    })}>{version === "remote" ? t("canvas.useDisk") : t("canvas.keepMine")}</button>)}</CanvasNotice> : null}
    </div></div>
    {workspace && adapter ? <CanvasBoardEditor key={adapter.key} project={project} storage={adapter} documents={design} tables={tables} assets={workspace.assets} onAssetsAdded={docs.addAssets} conflicted={!!boardConflict} overlay={singleBoard ? undefined : floating} onSaveReady={registerSave} onSyncReady={registerSync} onResolveReady={registerResolve} noticeTarget={noticeStack} onSyncFailedChange={setBoardSyncFailed} onSelectionChange={setSelectedNodes} expandedDocument={documentView ? { ...documentView, busy, onClose: () => void run(async () => { await docsRef.current.flush(); setDocumentView(undefined); }) } : undefined} /> : docs.loadError ? <div className="design-loading"><span>{t("canvas.restoreWorkspace")}</span></div> : <Loading label={t("assetCanvas.loading")} />}
    {boardOptions && workspace && optionsBoard ? <CanvasContextMenu screenPosition={boardOptions} label={t("canvas.boardOptions", { name: optionsBoard.name })} onClose={() => setBoardOptions(undefined)}>
      <button type="button" role="menuitem" onClick={() => { setBoardOptions(undefined); setName(optionsBoard.name); setDialog({ type: "rename", id: optionsBoard.id }); }}><Pencil size="sm" /><span>{t("common.rename")}</span></button>
      {([-1, 1] as const).map((direction) => <button type="button" role="menuitem" key={direction} disabled={workspace.boards.findIndex((board) => board.id === optionsBoard.id) === (direction === -1 ? 0 : workspace.boards.length - 1)} onClick={() => { setBoardOptions(undefined); void run(async () => { await flush(); await changeCanvasBoard(project.id, optionsBoard.id, { direction }, writeVersion); await docsRef.current.refresh(); }); }}>{direction === -1 ? <ChevronLeft size="sm" /> : <ChevronRight size="sm" />}<span>{direction === -1 ? t("canvas.moveUp") : t("canvas.moveDown")}</span></button>)}
      <button type="button" role="menuitem" disabled={workspace.boards.length === 1} onClick={() => { setBoardOptions(undefined); setDialog({ type: "delete", id: optionsBoard.id }); }}><Trash2 size="sm" /><span>{t("canvas.deleteBoard")}</span></button>
    </CanvasContextMenu> : null}
    {expandedTable && tableStorage.sessions.get(expandedTable.id) ? <div className="design-expanded-document canvas-expanded-table" role="dialog" aria-modal="true" aria-label={t("canvas.expandedTable")}>
      <ExpandedCanvasTable key={expandedTable.id} table={tableStorage.sessions.get(expandedTable.id)!.local} tables={tables} initialMode={expandedTable.mode} />
      <button className="design-expanded-close" type="button" title={t("canvas.backToCanvas")} aria-label={t("canvas.backToCanvas")} onClick={() => setExpandedTable(undefined)}><X size="md" /></button>
    </div> : null}
    {dialog ? <Dialog open size="sm" title={dialog.type === "create" ? t("canvas.newBoard") : dialog.type === "rename" ? t("canvas.renameBoard") : t("canvas.deleteBoard")}
      description={dialog.type === "delete" ? t("canvas.confirmDeleteBoard", { name: workspace?.boards.find((board) => board.id === dialog.id)?.name }) : undefined}
      onClose={() => { if (!busy) setDialog(undefined); }}
      footer={<>
        <Button disabled={busy} onClick={() => setDialog(undefined)}>{t("common.cancel")}</Button>
        <Button type="submit" form="canvas-board-form" variant={dialog.type === "delete" ? "danger" : "primary"} disabled={busy || (dialog.type !== "delete" && !name.trim())}>{dialog.type === "delete" ? t("common.delete") : t("common.save")}</Button>
      </>}>
      <form id="canvas-board-form" onSubmit={(event) => { event.preventDefault(); void run(async () => {
        await flush();
        let createdId: string | undefined;
        if (dialog.type === "create") { const next = await createCanvasBoard(project.id, name.trim(), writeVersion); createdId = next.boards.at(-1)!.id; }
        else if (dialog.type === "rename") await changeCanvasBoard(project.id, dialog.id!, { name: name.trim() }, writeVersion);
        else await deleteCanvasBoard(project.id, dialog.id!, writeVersion);
        await docsRef.current.refresh();
        if (createdId) setActiveId(createdId);
        setDialog(undefined);
      }); }}>
        {dialog.type === "delete" ? null : <Input aria-label={t("common.name")} placeholder={t("common.name")} autoFocus required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} />}
      </form>
    </Dialog> : null}
    {insertion?.documentId && !insertion.assetId && insertion.text === undefined ? <MediaPicker title={t("canvas.insertImage")} projectId={project.id} accept={(file) => file.mediaType === "image"} onClose={() => { if (!busy) setInsertion(undefined); }} onSelect={(file) => void run(async () => {
      const added = await addCanvasMediaFromProject(project.id, file);
      docsRef.current.addAssets([added]);
      await docsRef.current.insertImage(insertion.documentId!, added.id);
      setInsertion(undefined);
    })} /> : insertion ? <Dialog open size="sm" title={insertion.text ? t("canvas.addText") : t("canvas.insertImage")} onClose={() => { if (!busy) setInsertion(undefined); }}
      footer={<>
        <Button disabled={busy} onClick={() => setInsertion(undefined)}>{t("common.cancel")}</Button>
        <Button type="submit" form="canvas-insert-form" variant="primary" disabled={busy || !insertion.documentId || (insertion.text === undefined && !insertion.assetId)}>{t("common.insert")}</Button>
      </>}>
      <form id="canvas-insert-form" className="canvas-dialog-form" onSubmit={(event) => { event.preventDefault(); void run(async () => {
        if (!insertion.documentId) return;
        if (insertion.text !== undefined) { const doc = docsRef.current.workspace?.documents.find((doc) => doc.id === insertion.documentId); if (!doc) throw new Error(t("canvas.documentNotFound")); docsRef.current.update(doc.id, { markdown: `${doc.markdown.trimEnd()}\n\n${insertion.text}\n` }); await docsRef.current.flush(); }
        else if (insertion.assetId) await docsRef.current.insertImage(insertion.documentId, insertion.assetId);
        setInsertion(undefined);
      }); }}>
        <Field label={t("canvas.document")}>{(field) => <Select id={field.id} label={t("canvas.document")} placeholder={t("canvas.selectDocument")} value={insertion.documentId || undefined}
          options={(workspace?.documents ?? []).map((doc) => ({ value: doc.id, label: doc.title }))} onChange={(documentId) => setInsertion({ ...insertion, documentId })} />}</Field>
        {insertion.text !== undefined ? <pre className="design-insert-text">{insertion.text}</pre> : null}
      </form>
    </Dialog> : null}
  </section></CanvasAssetProvider>;
}
