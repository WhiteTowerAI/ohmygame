import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal } from "react-dom";
import type { AssetCanvasDocument, ProjectState } from "../shared/contracts.js";
import { mergeCanvasDocument, type DesignBoardDetail } from "../shared/design-boards.js";
import { CanvasBoardEditor, type CanvasBoardStorage } from "./asset-canvas-workspace.js";
import { LibraryAssetPicker } from "./node-workbench.js";
import { changeDesignBoard, createDesignBoard, deleteDesignBoard, getDesignBoard, saveDesignBoard, listDesignJobs, startDesignJob, cancelDesignJob, retryDesignJob } from "./game-design-api.js";
import { useDesignDocuments } from "./use-game-design.js";
import { ExpandedDesignDocument, type CanvasDesignDocuments } from "./design-document-node.js";
import { Check, ChevronLeft, ChevronRight, Layers3, LoaderCircle, MoreHorizontal, Pencil, Plus, Trash2, X } from "./icons.js";
import { CanvasChipSelect } from "./canvas-chip-select.js";
import { CanvasContextMenu } from "./editor-canvas.js";
import { loadLibraryAssets, type LibraryAsset } from "./library-assets.js";
import "./game-design.css";

const canvasOnly = ({ id: _id, ...canvas }: DesignBoardDetail["board"]): AssetCanvasDocument => canvas;
export function GameDesignWorkspace({ project, headerActionsTarget, onLeaveReady, onSaveReady }: {
  project: ProjectState; headerActionsTarget: HTMLElement | null;
  onLeaveReady: (leave: ((action: () => void) => void) | undefined) => void;
  onSaveReady?: (save: (() => Promise<void>) | undefined) => void;
}) {
  const docs = useDesignDocuments(project.id), workspace = docs.workspace;
  const docsRef = useRef(docs); docsRef.current = docs;
  const [activeId, setActiveId] = useState<string | undefined>(() => { try { return localStorage.getItem(`design-active:${project.id}`) ?? undefined; } catch { return undefined; } });
  const [boardRevision, setBoardRevision] = useState(0);
  const [boardConflict, setBoardConflict] = useState<{ local: AssetCanvasDocument; remote: DesignBoardDetail }>();
  const [boardOptions, setBoardOptions] = useState<{ id: string; x: number; y: number }>();
  const [documentId, setDocumentId] = useState<string>();
  const [dialog, setDialog] = useState<{ type: "create" | "rename" | "delete"; id?: string }>();
  const [name, setName] = useState("");
  const [insertion, setInsertion] = useState<{ documentId?: string; assetId?: string; text?: string }>();
  const [assets, setAssets] = useState<LibraryAsset[]>([]);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [boardStatus, setBoardStatus] = useState("loading");
  const boardSave = useRef<(() => Promise<void>) | undefined>(undefined);
  const registerSave = useCallback((save: (() => Promise<void>) | undefined) => { boardSave.current = save; }, []);
  const flush = useCallback(async () => { await boardSave.current?.(); await docsRef.current.flush(); }, []);
  const run = useCallback(async (operation: () => Promise<void>) => {
    setBusy(true); setError(undefined);
    try { await operation(); } catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); } finally { setBusy(false); }
  }, []);
  const leave = useCallback((action: () => void) => { void run(async () => { await flush(); action(); }); }, [run, flush]);
  useEffect(() => { onLeaveReady(leave); return () => onLeaveReady(undefined); }, [leave, onLeaveReady]);
  useEffect(() => { onSaveReady?.(flush); return () => onSaveReady?.(undefined); }, [flush, onSaveReady]);
  useEffect(() => { if (workspace && !workspace.boards.some((board) => board.id === activeId)) setActiveId(workspace.boards[0]?.id); }, [workspace, activeId]);
  useEffect(() => { if (activeId) { try { localStorage.setItem(`design-active:${project.id}`, activeId); } catch { /* Board selection remains usable without storage. */ } } }, [project.id, activeId]);
  const adapter = useMemo<CanvasBoardStorage | undefined>(() => {
    if (!activeId) return;
    let base: DesignBoardDetail | undefined;
    const recoveryKey = `design-board:${project.id}:${activeId}`;
    return {
      key: `${project.id}:${activeId}:${boardRevision}`,
      load: async () => {
        base = await getDesignBoard(project.id, activeId);
        let canvas = canvasOnly(base.board);
        try {
          const draft = JSON.parse(localStorage.getItem(recoveryKey) ?? "null") as { base: AssetCanvasDocument; local: AssetCanvasDocument } | null;
          if (draft) {
            const merged = mergeCanvasDocument(draft.base, draft.local, canvas);
            if (merged) canvas = merged;
            else setBoardConflict({ local: draft.local, remote: base });
          }
        } catch { /* Malformed recovery data does not replace the saved board. */ }
        return canvas;
      },
      save: async (local) => {
        if (!base) throw new Error("The board is still loading.");
        try { localStorage.setItem(recoveryKey, JSON.stringify({ base: canvasOnly(base.board), local })); } catch { /* Disk autosave is still available. */ }
        let outgoing = local;
        for (let attempt = 0; attempt < 3; attempt++) {
          try {
            base = await saveDesignBoard(project.id, { board: { ...outgoing, id: activeId }, revision: base.revision });
            localStorage.removeItem(recoveryKey);
            return canvasOnly(base.board);
          } catch (cause) {
            if ((cause as { status?: number }).status !== 409) throw cause;
            const remote = await getDesignBoard(project.id, activeId);
            const merged = mergeCanvasDocument(canvasOnly(base.board), outgoing, canvasOnly(remote.board));
            if (!merged) { setBoardConflict({ local: outgoing, remote }); throw new Error("The board was edited elsewhere. Choose a version before saving."); }
            base = remote; outgoing = merged;
          }
        }
        throw new Error("The board keeps changing. Try saving again.");
      },
      refresh: async (local) => {
        if (!base) return;
        const remote = await getDesignBoard(project.id, activeId);
        if (remote.revision === base.revision) return;
        const merged = mergeCanvasDocument(canvasOnly(base.board), local, canvasOnly(remote.board));
        if (!merged) { setBoardConflict({ local, remote }); throw new Error("The board was edited elsewhere. Choose a version before saving."); }
        base = remote;
        return merged;
      },
      jobs: async () => (await listDesignJobs(project.id)).filter((job) => job.context?.boardId === activeId),
      start: (nodeId, toolId, input) => startDesignJob(project.id, activeId, nodeId, toolId, input),
      cancel: (jobId) => cancelDesignJob(project.id, jobId),
      retry: (jobId) => retryDesignJob(project.id, jobId),
    };
  }, [project.id, activeId, boardRevision]);
  const design: CanvasDesignDocuments = {
    projectId: project.id, documents: workspace?.documents ?? [],
    add: async () => {
      setBusy(true); setError(undefined);
      try { return await docsRef.current.create(); }
      catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); return undefined; }
      finally { setBusy(false); }
    },
    update: docs.update, open: setDocumentId,
    generations: docs.generations, changeGeneration: docs.changeGeneration,
    generate: (id, model) => { void docsRef.current.generate(id, model); }, applyGeneration: docs.applyGeneration,
    setMain: (id) => { void run(() => docsRef.current.setMain(id)); },
    insertImage: (id, assetId) => { void run(() => docsRef.current.insertImage(id, assetId)); },
    pickImage: (id) => {
      setInsertion({ documentId: id });
      void loadLibraryAssets().then((value) => setAssets(value.filter((asset) => asset.mediaType === "image"))).catch((cause) => setError(String(cause)));
    },
    appendImage: (assetId) => setInsertion({ assetId, documentId: workspace?.mainDocumentId }),
    appendText: (text) => setInsertion({ text, documentId: workspace?.mainDocumentId }),
  };
  const optionsBoard = workspace?.boards.find((board) => board.id === boardOptions?.id);
  const expanded = workspace?.documents.find((doc) => doc.id === documentId);
  const status = docs.error || error || boardStatus === "error" ? "error" : docs.saving || boardStatus === "saving" ? "saving" : boardStatus;
  const floating = <div className="design-board-switcher">
    <Layers3 size={13} aria-hidden="true" />
    <CanvasChipSelect label="Board" value={activeId} options={(workspace?.boards ?? []).map((board) => ({ value: board.id, label: board.name }))} disabled={busy}
      action={{ label: "New board", icon: Plus, onSelect: () => { setName(""); setDialog({ type: "create" }); } }}
      optionAction={{ label: (option) => `Board options: ${option.label}`, icon: MoreHorizontal, onSelect: (id, anchor) => setBoardOptions({ id, x: anchor.left, y: anchor.bottom + 5 }) }}
      onChange={(id) => void run(async () => { await flush(); setActiveId(id); setBoardStatus("loading"); })} />
  </div>;
  return <section className="viewer-pane design-workspace" aria-label="Design workspace">
    {headerActionsTarget ? createPortal(<span className={`design-save-status is-${status}`} role="status">{status === "saving" ? <LoaderCircle size={12} className="spin" /> : status === "saved" ? <Check size={12} /> : null}{status === "saved" ? "Saved" : status === "saving" ? "Saving" : status === "error" ? "Save failed" : "Loading"}</span>, headerActionsTarget) : null}
    {error || docs.error ? <div className="design-notice" role="alert"><span>{error ?? docs.error}</span><button type="button" onClick={() => void run(async () => { await docsRef.current.refresh(); await flush(); })}>Retry</button></div> : null}
    {adapter ? <CanvasBoardEditor key={adapter.key} project={project} storage={adapter} designDocuments={design} overlay={floating} onSaveReady={registerSave} onStatusChange={setBoardStatus} /> : <div className="design-loading"><LoaderCircle size={22} className="spin" /></div>}
    {boardOptions && workspace && optionsBoard ? <CanvasContextMenu screenPosition={boardOptions} label={`Board options: ${optionsBoard.name}`} onClose={() => setBoardOptions(undefined)}>
      <button type="button" role="menuitem" onClick={() => { setBoardOptions(undefined); setName(optionsBoard.name); setDialog({ type: "rename", id: optionsBoard.id }); }}><Pencil size={14} /><span>Rename</span></button>
      {([-1, 1] as const).map((direction) => <button type="button" role="menuitem" key={direction} disabled={workspace.boards.findIndex((board) => board.id === optionsBoard.id) === (direction === -1 ? 0 : workspace.boards.length - 1)} onClick={() => { setBoardOptions(undefined); void run(async () => { await flush(); await changeDesignBoard(project.id, optionsBoard.id, { direction }); await docsRef.current.refresh(); }); }}>{direction === -1 ? <ChevronLeft size={14} /> : <ChevronRight size={14} />}<span>{direction === -1 ? "Move up" : "Move down"}</span></button>)}
      <button type="button" role="menuitem" disabled={workspace.boards.length === 1} onClick={() => { setBoardOptions(undefined); setDialog({ type: "delete", id: optionsBoard.id }); }}><Trash2 size={14} /><span>Delete board</span></button>
    </CanvasContextMenu> : null}
    {expanded ? <div className="design-expanded-document" role="dialog" aria-modal="true" aria-label={expanded.title}>
      <ExpandedDesignDocument design={design} document={expanded} />
      <button className="design-expanded-close" type="button" title="Back to canvas" aria-label="Back to canvas" disabled={busy} onClick={() => void run(async () => { await docsRef.current.flush(); setDocumentId(undefined); })}><X size={16} /></button>
    </div> : null}
    {dialog ? <DesignModal title={dialog.type === "create" ? "New board" : dialog.type === "rename" ? "Rename board" : "Delete board"} onClose={() => { if (!busy) setDialog(undefined); }}>
      <form onSubmit={(event) => { event.preventDefault(); void run(async () => {
        await flush();
        if (dialog.type === "create") { const next = await createDesignBoard(project.id, name.trim()); await docsRef.current.refresh(); setActiveId(next.boards.at(-1)!.id); }
        else if (dialog.type === "rename") await changeDesignBoard(project.id, dialog.id!, { name: name.trim() });
        else await deleteDesignBoard(project.id, dialog.id!);
        await docsRef.current.refresh(); setDialog(undefined);
      }); }}>
        {dialog.type === "delete" ? <p>Delete "{workspace?.boards.find((board) => board.id === dialog.id)?.name}"? Documents and Library assets will be kept.</p> : <label>Name<input autoFocus required maxLength={120} value={name} onChange={(event) => setName(event.target.value)} /></label>}
        <footer><button type="button" disabled={busy} onClick={() => setDialog(undefined)}>Cancel</button><button type="submit" disabled={busy || (dialog.type !== "delete" && !name.trim())}>{dialog.type === "delete" ? "Delete" : "Save"}</button></footer>
      </form>
    </DesignModal> : null}
    {insertion?.documentId && !insertion.assetId && insertion.text === undefined ? <LibraryAssetPicker title="Insert image" assets={assets} onClose={() => { if (!busy) setInsertion(undefined); }} onSelect={(asset) => void run(async () => { await docsRef.current.insertImage(insertion.documentId!, asset.id); setInsertion(undefined); })} /> : insertion ? <DesignModal title={insertion.text ? "Add text to document" : "Insert image"} onClose={() => { if (!busy) setInsertion(undefined); }}>
      <form onSubmit={(event) => { event.preventDefault(); void run(async () => {
        if (!insertion.documentId) return;
        if (insertion.text !== undefined) { const doc = docsRef.current.workspace?.documents.find((doc) => doc.id === insertion.documentId); if (!doc) throw new Error("Document not found"); docsRef.current.update(doc.id, { markdown: `${doc.markdown.trimEnd()}\n\n${insertion.text}\n` }); await docsRef.current.flush(); }
        else if (insertion.assetId) await docsRef.current.insertImage(insertion.documentId, insertion.assetId);
        setInsertion(undefined);
      }); }}>
        <label>Document<select required value={insertion.documentId ?? ""} onChange={(event) => setInsertion({ ...insertion, documentId: event.target.value })}><option value="" disabled>Select document</option>{workspace?.documents.map((doc) => <option key={doc.id} value={doc.id}>{doc.title}</option>)}</select></label>
        {insertion.text !== undefined ? <pre className="design-insert-text">{insertion.text}</pre> : null}
        <footer><button type="button" disabled={busy} onClick={() => setInsertion(undefined)}>Cancel</button><button type="submit" disabled={busy || !insertion.documentId || (insertion.text === undefined && !insertion.assetId)}>Insert</button></footer>
      </form>
    </DesignModal> : null}
    {docs.conflict ? <DesignModal title="Document changed" onClose={() => {}}><p>Choose which version to keep for "{docs.conflict.local.title}".</p><div className="design-conflict-preview"><pre>{docs.conflict.local.markdown}</pre><pre>{docs.conflict.remote.document.markdown}</pre></div><footer><button type="button" onClick={() => docs.resolve("remote")}>Use disk version</button><button type="button" onClick={() => docs.resolve("local")}>Keep my version</button></footer></DesignModal> : null}
    {boardConflict ? <DesignModal title="Board changed" onClose={() => {}}><p>The board was edited elsewhere. Choose which version to keep.</p><footer>{(["remote", "local"] as const).map((version) => <button type="button" key={version} disabled={busy} onClick={() => void run(async () => {
      if (version === "local") await saveDesignBoard(project.id, { board: { ...boardConflict.local, id: boardConflict.remote.board.id }, revision: boardConflict.remote.revision });
      localStorage.removeItem(`design-board:${project.id}:${boardConflict.remote.board.id}`); setBoardConflict(undefined); setBoardRevision((value) => value + 1);
    })}>{version === "remote" ? "Use disk version" : "Keep my version"}</button>)}</footer></DesignModal> : null}
  </section>;
}
function DesignModal({ title, children, onClose }: { title: string; children: ReactNode; onClose(): void }) {
  useEffect(() => { const close = (event: KeyboardEvent) => { if (event.key === "Escape") { event.stopPropagation(); onClose(); } }; window.addEventListener("keydown", close); return () => window.removeEventListener("keydown", close); }, [onClose]);
  return createPortal(<div className="design-modal-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) onClose(); }}><section className="design-modal" role="dialog" aria-modal="true" aria-label={title}><header><h2>{title}</h2><button type="button" title="Close" aria-label="Close" onClick={onClose}><X size={16} /></button></header>{children}</section></div>, document.body);
}
