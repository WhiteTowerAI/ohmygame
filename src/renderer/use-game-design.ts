import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentModelRef } from "../shared/contracts.js";
import type { DesignWorkspaceDetail } from "../shared/design-boards.js";
import { mergeGameDesign, type GameDesignDetail, type GameDesignDocument } from "../shared/game-design.js";
import { createDesignDocument, generateDesignDocument, getDesignWorkspace, getGameDesign, insertDesignImage, saveGameDesign, setMainDesignDocument } from "./game-design-api.js";

export interface DocumentGenerationState {
  instruction: string;
  model?: AgentModelRef;
  generating?: boolean;
  error?: string;
  proposal?: string;
}

const equal = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
export function useDesignDocuments(projectId: string) {
  const [workspace, setWorkspace] = useState<DesignWorkspaceDetail>();
  const current = useRef<DesignWorkspaceDetail | undefined>(undefined);
  const bases = useRef(new Map<string, GameDesignDetail>());
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState<{ local: GameDesignDocument; remote: GameDesignDetail }>();
  const [saving, setSaving] = useState(false);
  const chain = useRef(Promise.resolve());
  const mounted = useRef(true);
  const refreshCounter = useRef(0);
  const recoveryKey = `design-documents:${projectId}`;
  const [generations, setGenerations] = useState<Record<string, DocumentGenerationState>>({});
  const generationStates = useRef(generations);
  const changeGeneration = useCallback((id: string, patch: Partial<DocumentGenerationState>) => {
    generationStates.current = { ...generationStates.current, [id]: { ...(generationStates.current[id] ?? { instruction: "" }), ...patch } };
    if (mounted.current) setGenerations(generationStates.current);
  }, []);
  const publish = useCallback((value: DesignWorkspaceDetail) => {
    current.current = value;
    if (mounted.current) setWorkspace(value);
    const drafts = value.documents.flatMap((document) => {
      const base = bases.current.get(document.id);
      const local = { id: document.id, title: document.title, markdown: document.markdown };
      return base && !equal(base.document, local) ? [{ base, local }] : [];
    });
    try { drafts.length ? localStorage.setItem(recoveryKey, JSON.stringify(drafts)) : localStorage.removeItem(recoveryKey); } catch { /* Saving to disk remains available when local storage is full. */ }
  }, [recoveryKey]);
  const refresh = useCallback(async () => {
    const requestId = ++refreshCounter.current;
    const started = new Map(bases.current);
    const next = await getDesignWorkspace(projectId);
    if (!mounted.current || requestId !== refreshCounter.current) return;
    let recovered: Array<{ base: GameDesignDetail; local: GameDesignDocument }> = [];
    if (!current.current) {
      try { recovered = JSON.parse(localStorage.getItem(recoveryKey) ?? "[]"); } catch { /* Invalid recovery data is ignored. */ }
    }
    next.documents = next.documents.map((remote) => {
      const old = bases.current.get(remote.id), local = current.current?.documents.find((doc) => doc.id === remote.id);
      if (old && old !== started.get(remote.id)) return local ?? remote;
      const recovery = recovered.find((draft) => draft.local?.id === remote.id);
      const before = old ?? recovery?.base;
      const ours = local ? { id: local.id, title: local.title, markdown: local.markdown } : recovery?.local;
      const merged = before && ours ? mergeGameDesign(before.document, ours, remote) : remote;
      if (!merged) {
        setConflict({ local: ours!, remote: { document: remote, revision: remote.revision } });
        setError("The same document was edited elsewhere. Choose a version before saving.");
        return local ?? { ...remote, ...ours };
      }
      bases.current.set(remote.id, { document: { id: remote.id, title: remote.title, markdown: remote.markdown }, revision: remote.revision });
      return { ...remote, ...merged };
    });
    publish(next);
  }, [projectId, publish, recoveryKey]);
  useEffect(() => {
    mounted.current = true;
    void refresh().catch((cause) => setError(message(cause)));
    const timer = window.setInterval(() => { void refresh().catch((cause) => setError(message(cause))); }, 3000);
    return () => { mounted.current = false; window.clearInterval(timer); };
  }, [refresh]);
  const update = useCallback((id: string, patch: Partial<Pick<GameDesignDocument, "title" | "markdown">>) => {
    if (!current.current) return;
    publish({ ...current.current, documents: current.current.documents.map((doc) => doc.id === id ? { ...doc, ...patch } : doc) });
  }, [publish]);
  const flush = useCallback(() => {
    const operation = chain.current.catch(() => {}).then(async () => {
      if (!current.current) return;
      if (conflict) throw new Error("Resolve the document conflict before saving.");
      setSaving(true);
      try {
        for (const entry of current.current.documents) {
          const local = { id: entry.id, title: entry.title, markdown: entry.markdown };
          let base = bases.current.get(entry.id);
          if (!base || equal(local, base.document)) continue;
          let outgoing = local, saved: GameDesignDetail | undefined;
          for (let attempt = 0; attempt < 3; attempt++) {
            try { saved = await saveGameDesign(projectId, { document: outgoing, revision: base.revision }, entry.id); break; }
            catch (cause) {
              if ((cause as { status?: number }).status !== 409) throw cause;
              const remote = (await getGameDesign(projectId, entry.id)).design;
              if (!remote) throw cause;
              const merged = mergeGameDesign(base.document, outgoing, remote.document);
              if (!merged) { setConflict({ local: outgoing, remote }); throw new Error("The same document was edited elsewhere. Choose a version before saving."); }
              base = remote; outgoing = merged;
            }
          }
          if (!saved) throw new Error("The document keeps changing. Try saving again.");
          const now = current.current.documents.find((doc) => doc.id === entry.id)!;
          const merged = mergeGameDesign(local, now, saved.document);
          if (!merged) { setConflict({ local: now, remote: saved }); throw new Error("Review the document changes before saving."); }
          bases.current.set(entry.id, saved);
          publish({ ...current.current, documents: current.current.documents.map((doc) => doc.id === entry.id ? { ...doc, ...merged, revision: saved!.revision } : doc) });
        }
        setError(undefined);
      } catch (cause) { setError(message(cause)); throw cause; }
      finally { if (mounted.current) setSaving(false); }
    });
    chain.current = operation;
    return operation;
  }, [projectId, publish, conflict]);
  useEffect(() => {
    if (!workspace || conflict) return;
    const timer = window.setTimeout(() => { void flush().catch(() => {}); }, 600);
    return () => window.clearTimeout(timer);
  }, [workspace, flush, conflict]);
  const create = useCallback(async () => {
    await flush();
    const detail = await createDesignDocument(projectId, "Untitled document");
    await refresh();
    return detail.document.id;
  }, [projectId, flush, refresh]);
  const insertImage = useCallback(async (documentId: string, assetId: string) => {
    await flush(); await insertDesignImage(projectId, documentId, assetId); await refresh();
  }, [projectId, flush, refresh]);
  const setMain = useCallback(async (documentId: string) => {
    await flush(); await setMainDesignDocument(projectId, documentId); await refresh();
  }, [projectId, flush, refresh]);
  const generate = useCallback(async (id: string, model: AgentModelRef) => {
    const state = generationStates.current[id], instruction = state?.instruction.trim();
    if (!instruction || state?.generating || state?.proposal !== undefined) return;
    changeGeneration(id, { generating: true, model, error: undefined });
    try {
      await flush();
      const base = current.current?.documents.find((doc) => doc.id === id);
      if (!base) throw new Error("Document not found");
      const result = await generateDesignDocument(projectId, id, { instruction, model, revision: base.revision });
      if (!mounted.current) return;
      // Refresh before applying so edits from another board, editor or agent are preserved.
      changeGeneration(id, { proposal: result.markdown, model: result.model });
      await refresh();
      const disk = (await getGameDesign(projectId, id)).design;
      if (!mounted.current) return;
      const now = current.current?.documents.find((doc) => doc.id === id);
      if (now && disk && now.markdown === base.markdown && disk.document.markdown === base.markdown && result.revision === base.revision) {
        update(id, { markdown: result.markdown });
        await flush();
        changeGeneration(id, { proposal: undefined });
      } else changeGeneration(id, { error: "The document changed during generation. Review the AI result before replacing it." });
    } catch (cause) { changeGeneration(id, { error: message(cause) }); }
    finally { changeGeneration(id, { generating: false }); }
  }, [projectId, changeGeneration, flush, refresh, update]);
  const applyGeneration = useCallback((id: string) => {
    const proposal = generationStates.current[id]?.proposal;
    if (proposal === undefined) return;
    update(id, { markdown: proposal });
    changeGeneration(id, { proposal: undefined, error: undefined });
  }, [update, changeGeneration]);
  const resolve = (version: "local" | "remote") => {
    if (!conflict || !current.current) return;
    bases.current.set(conflict.remote.document.id, conflict.remote);
    const selected = version === "local" ? conflict.local : conflict.remote.document;
    publish({ ...current.current, documents: current.current.documents.map((doc) => doc.id === selected.id ? { ...doc, ...selected, revision: conflict.remote.revision } : doc) });
    setConflict(undefined); setError(undefined);
  };
  return { workspace, update, create, insertImage, setMain, refresh, flush, saving, error, conflict, resolve, generations, changeGeneration, generate, applyGeneration };
}
function message(cause: unknown) { return cause instanceof Error ? cause.message : String(cause); }
