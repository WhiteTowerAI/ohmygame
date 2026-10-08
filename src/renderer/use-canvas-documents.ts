import { useCallback, useEffect, useRef, useState } from "react";
import type { AgentModelRef, AgentReasoningLevel } from "../shared/contracts.js";
import type { CanvasWorkspaceDetail } from "../shared/canvas-workspace.js";
import {
  mergeCanvasDocumentContent,
  type CanvasDocumentDetail,
  type CanvasMarkdownDocument,
} from "../shared/canvas-document.js";
import {
  createCanvasDocument,
  generateCanvasDocument,
  getCanvasWorkspace,
  getCanvasDocument,
  insertCanvasImage,
  saveCanvasDocument,
  setMainCanvasDocument,
} from "./canvas-api.js";
import { isCanvasDocument } from "../shared/canvas-document-schema.js";

export interface DocumentGenerationState {
  instruction: string;
  model?: AgentModelRef;
  reasoningLevel?: AgentReasoningLevel;
  generating?: boolean;
  error?: string;
  proposal?: string;
}

const equal = (a: unknown, b: unknown) =>
  JSON.stringify(a) === JSON.stringify(b);
export function useCanvasDocuments(projectId: string) {
  const [workspace, setWorkspace] = useState<CanvasWorkspaceDetail>();
  const current = useRef<CanvasWorkspaceDetail | undefined>(undefined);
  const bases = useRef(new Map<string, CanvasDocumentDetail>());
  const [error, setError] = useState<string>();
  const [conflict, setConflict] = useState<{
    local: CanvasMarkdownDocument;
    remote: CanvasDocumentDetail;
  }>();
  const conflictRef = useRef<typeof conflict>(undefined);
  const reportConflict = useCallback((value: NonNullable<typeof conflict>) => {
    conflictRef.current = value;
    setConflict(value);
  }, []);
  const [saving, setSaving] = useState(false);
  const chain = useRef(Promise.resolve());
  const mounted = useRef(true);
  const refreshCounter = useRef(0);
  const recoveryKey = `canvas-documents:${projectId}`;
  const [generations, setGenerations] = useState<
    Record<string, DocumentGenerationState>
  >({});
  const generationStates = useRef(generations);
  const changeGeneration = useCallback(
    (id: string, patch: Partial<DocumentGenerationState>) => {
      generationStates.current = {
        ...generationStates.current,
        [id]: {
          ...(generationStates.current[id] ?? { instruction: "" }),
          ...patch,
        },
      };
      if (mounted.current) setGenerations(generationStates.current);
    },
    [],
  );
  const publish = useCallback(
    (value: CanvasWorkspaceDetail) => {
      current.current = value;
      if (mounted.current) setWorkspace(value);
      const drafts = value.documents.flatMap((document) => {
        const base = bases.current.get(document.id);
        const local = {
          id: document.id,
          title: document.title,
          markdown: document.markdown,
        };
        return base && !equal(base.document, local) ? [{ base, local }] : [];
      });
      try {
        drafts.length
          ? localStorage.setItem(recoveryKey, JSON.stringify(drafts))
          : localStorage.removeItem(recoveryKey);
      } catch {
        /* Saving to disk remains available when local storage is full. */
      }
    },
    [recoveryKey],
  );
  const refresh = useCallback(async () => {
    const requestId = ++refreshCounter.current;
    const started = new Map(bases.current);
    const next = await getCanvasWorkspace(projectId);
    if (!mounted.current || requestId !== refreshCounter.current) return;
    let recovered: Array<{
      base: CanvasDocumentDetail;
      local: CanvasMarkdownDocument;
    }> = [];
    if (!current.current) {
      try {
        const stored = JSON.parse(localStorage.getItem(recoveryKey) ?? "[]");
        if (Array.isArray(stored))
          recovered = stored.filter(
            (draft) =>
              typeof draft?.base?.revision === "string" &&
              isCanvasDocument(draft.base.document) &&
              isCanvasDocument(draft.local),
          );
      } catch {
        /* Invalid recovery data is ignored. */
      }
    }
    next.documents = next.documents.map((remote) => {
      const old = bases.current.get(remote.id),
        local = current.current?.documents.find((doc) => doc.id === remote.id);
      if (old && old !== started.get(remote.id)) return local ?? remote;
      const recovery = recovered.find((draft) => draft.local?.id === remote.id);
      const before = old ?? recovery?.base;
      const ours = local
        ? { id: local.id, title: local.title, markdown: local.markdown }
        : recovery?.local;
      if (conflictRef.current?.local.id === remote.id)
        return local ?? { ...remote, ...conflictRef.current.local };
      const merged =
        before && ours
          ? mergeCanvasDocumentContent(before.document, ours, remote)
          : remote;
      if (!merged) {
        bases.current.set(remote.id, before!);
        if (!conflictRef.current)
          reportConflict({
            local: ours!,
            remote: { document: remote, revision: remote.revision },
          });
        setError(
          "The same document was edited elsewhere. Choose a version before saving.",
        );
        return local ?? { ...remote, ...ours };
      }
      bases.current.set(remote.id, {
        document: {
          id: remote.id,
          title: remote.title,
          markdown: remote.markdown,
        },
        revision: remote.revision,
      });
      return { ...remote, ...merged };
    });
    publish(next);
  }, [projectId, publish, recoveryKey, reportConflict]);
  useEffect(() => {
    mounted.current = true;
    void refresh().catch((cause) => setError(message(cause)));
    const timer = window.setInterval(() => {
      void refresh().catch((cause) => setError(message(cause)));
    }, 3000);
    return () => {
      mounted.current = false;
      window.clearInterval(timer);
    };
  }, [refresh]);
  const update = useCallback(
    (
      id: string,
      patch: Partial<Pick<CanvasMarkdownDocument, "title" | "markdown">>,
    ) => {
      if (!current.current) return;
      if (conflictRef.current?.local.id === id)
        reportConflict({
          ...conflictRef.current,
          local: { ...conflictRef.current.local, ...patch },
        });
      publish({
        ...current.current,
        documents: current.current.documents.map((doc) =>
          doc.id === id ? { ...doc, ...patch } : doc,
        ),
      });
    },
    [publish, reportConflict],
  );
  const flush = useCallback(() => {
    const operation = chain.current
      .catch(() => {})
      .then(async () => {
        if (!current.current) return;
        if (conflictRef.current)
          throw new Error("Resolve the document conflict before saving.");
        setSaving(true);
        try {
          while (true) {
            if (conflictRef.current)
              throw new Error("Resolve the document conflict before saving.");
            const entries = current.current.documents.filter((doc) => {
              const base = bases.current.get(doc.id);
              return (
                base &&
                !equal(base.document, {
                  id: doc.id,
                  title: doc.title,
                  markdown: doc.markdown,
                })
              );
            });
            if (!entries.length) break;
            for (const entry of entries) {
              const local = {
                id: entry.id,
                title: entry.title,
                markdown: entry.markdown,
              };
              let base = bases.current.get(entry.id);
              if (!base || equal(local, base.document)) continue;
              let outgoing = local,
                saved: CanvasDocumentDetail | undefined;
              for (let attempt = 0; attempt < 3; attempt++) {
                try {
                  saved = await saveCanvasDocument(
                    projectId,
                    { document: outgoing, revision: base.revision },
                    entry.id,
                  );
                  break;
                } catch (cause) {
                  if ((cause as { status?: number }).status !== 409)
                    throw cause;
                  const remote = await getCanvasDocument(projectId, entry.id);
                  if (!remote) throw cause;
                  const merged = mergeCanvasDocumentContent(
                    base.document,
                    outgoing,
                    remote.document,
                  );
                  if (!merged) {
                    const latest = current.current.documents.find(
                      (doc) => doc.id === entry.id,
                    );
                    reportConflict({ local: latest ?? outgoing, remote });
                    throw new Error(
                      "The same document was edited elsewhere. Choose a version before saving.",
                    );
                  }
                  base = remote;
                  outgoing = merged;
                }
              }
              if (!saved)
                throw new Error(
                  "The document keeps changing. Try saving again.",
                );
              const now = current.current.documents.find(
                (doc) => doc.id === entry.id,
              )!;
              const merged = mergeCanvasDocumentContent(
                local,
                now,
                saved.document,
              );
              if (!merged) {
                reportConflict({ local: now, remote: saved });
                throw new Error("Review the document changes before saving.");
              }
              bases.current.set(entry.id, saved);
              publish({
                ...current.current,
                documents: current.current.documents.map((doc) =>
                  doc.id === entry.id
                    ? { ...doc, ...merged, revision: saved!.revision }
                    : doc,
                ),
              });
            }
          }
          setError(undefined);
        } catch (cause) {
          setError(message(cause));
          throw cause;
        } finally {
          if (mounted.current) setSaving(false);
        }
      });
    chain.current = operation;
    return operation;
  }, [projectId, publish, reportConflict]);
  useEffect(() => {
    if (!workspace || conflict) return;
    const timer = window.setTimeout(() => {
      void flush().catch(() => {});
    }, 600);
    return () => window.clearTimeout(timer);
  }, [workspace, flush, conflict]);
  const create = useCallback(async () => {
    await flush();
    const detail = await createCanvasDocument(projectId, "Untitled document");
    await refresh();
    return detail.document.id;
  }, [projectId, flush, refresh]);
  const insertImage = useCallback(
    async (documentId: string, assetId: string) => {
      await flush();
      await insertCanvasImage(projectId, documentId, assetId);
      await refresh();
    },
    [projectId, flush, refresh],
  );
  const setMain = useCallback(
    async (documentId: string) => {
      await flush();
      await setMainCanvasDocument(projectId, documentId);
      await refresh();
    },
    [projectId, flush, refresh],
  );
  const generate = useCallback(
    async (id: string, model: AgentModelRef, reasoningLevel?: AgentReasoningLevel) => {
      const state = generationStates.current[id],
        instruction = state?.instruction.trim();
      if (!instruction || state?.generating || state?.proposal !== undefined)
        return;
      changeGeneration(id, { generating: true, model, reasoningLevel, error: undefined });
      try {
        await flush();
        const base = current.current?.documents.find((doc) => doc.id === id);
        if (!base) throw new Error("Document not found");
        const result = await generateCanvasDocument(projectId, id, {
          instruction,
          model,
          reasoningLevel,
          revision: base.revision,
        });
        if (!mounted.current) return;
        // Refresh before applying so edits from another board, editor or agent are preserved.
        changeGeneration(id, {
          proposal: result.markdown,
          model: result.model,
        });
        await refresh();
        const disk = await getCanvasDocument(projectId, id);
        if (!mounted.current) return;
        const now = current.current?.documents.find((doc) => doc.id === id);
        if (
          now &&
          disk &&
          now.markdown === base.markdown &&
          disk.document.markdown === base.markdown &&
          result.revision === base.revision
        ) {
          update(id, { markdown: result.markdown });
          await flush();
          changeGeneration(id, { proposal: undefined });
        } else
          changeGeneration(id, {
            error:
              "The document changed during generation. Review the AI result before replacing it.",
          });
      } catch (cause) {
        changeGeneration(id, { error: message(cause) });
      } finally {
        changeGeneration(id, { generating: false });
      }
    },
    [projectId, changeGeneration, flush, refresh, update],
  );
  const applyGeneration = useCallback(
    (id: string) => {
      const proposal = generationStates.current[id]?.proposal;
      if (proposal === undefined) return;
      update(id, { markdown: proposal });
      changeGeneration(id, { proposal: undefined, error: undefined });
    },
    [update, changeGeneration],
  );
  const resolve = (version: "local" | "remote") => {
    if (!conflict || !current.current) return;
    bases.current.set(conflict.remote.document.id, conflict.remote);
    const selected =
      version === "local" ? conflict.local : conflict.remote.document;
    publish({
      ...current.current,
      documents: current.current.documents.map((doc) =>
        doc.id === selected.id
          ? { ...doc, ...selected, revision: conflict.remote.revision }
          : doc,
      ),
    });
    conflictRef.current = undefined;
    setConflict(undefined);
    setError(undefined);
  };
  return {
    workspace,
    update,
    create,
    insertImage,
    setMain,
    refresh,
    flush,
    saving,
    error,
    conflict,
    resolve,
    generations,
    changeGeneration,
    generate,
    applyGeneration,
  };
}
function message(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause);
}
