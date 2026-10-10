import { useCallback, useEffect, useRef, useState } from "react";
import { AGENT_REASONING_LEVELS, type AgentModelRef, type AgentReasoningLevel, type AssetCanvasTextGenerationSource } from "../shared/contracts.js";
import type { CanvasWorkspaceDetail } from "../shared/canvas-workspace.js";
import {
  canvasDocumentPath,
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
  applying?: boolean;
  error?: string;
  proposal?: string;
  proposalStatus?: "complete" | "incomplete";
}

const documentContent = ({ id, title, markdown }: CanvasMarkdownDocument): CanvasMarkdownDocument => ({ id, title, markdown });
const equal = (a: CanvasMarkdownDocument, b: CanvasMarkdownDocument) =>
  a.id === b.id && a.title === b.title && a.markdown === b.markdown;
export function useCanvasDocuments(projectId: string) {
  const [workspace, setWorkspace] = useState<CanvasWorkspaceDetail>();
  const current = useRef<CanvasWorkspaceDetail | undefined>(undefined);
  const bases = useRef(new Map<string, CanvasDocumentDetail>());
  const [error, setError] = useState<string>();
  const [loadError, setLoadError] = useState<string>();
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
  const generationKey = `canvas-document-generations:${projectId}`;
  const [generations, setGenerations] = useState<
    Record<string, DocumentGenerationState>
  >(() => readDocumentGenerations(generationKey));
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
      try {
        localStorage.setItem(generationKey, JSON.stringify(generationStates.current));
      } catch {
        /* The in-memory candidate remains editable and can still be copied. */
      }
      if (mounted.current) setGenerations(generationStates.current);
    },
    [generationKey],
  );
  const publish = useCallback(
    (value: CanvasWorkspaceDetail) => {
      current.current = value;
      if (mounted.current) setWorkspace(value);
      const drafts = value.documents.flatMap((document) => {
        const base = bases.current.get(document.id);
        const local = documentContent(document);
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
    let next: CanvasWorkspaceDetail;
    try { next = await getCanvasWorkspace(projectId); }
    catch (cause) {
      if (mounted.current && requestId === refreshCounter.current) setLoadError(message(cause));
      throw cause;
    }
    if (!mounted.current || requestId !== refreshCounter.current) return;
    setLoadError(undefined);
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
      const remoteDetail: CanvasDocumentDetail = {
        document: documentContent(remote),
        revision: remote.revision,
      };
      const old = bases.current.get(remote.id),
        local = current.current?.documents.find((doc) => doc.id === remote.id);
      if (old && old !== started.get(remote.id)) return local ?? remote;
      const recovery = recovered.find((draft) => draft.local?.id === remote.id);
      const before = old ?? recovery?.base;
      const ours = local ? documentContent(local) : recovery?.local;
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
            remote: remoteDetail,
          });
        setError(
          "The same document was edited elsewhere. Choose a version before saving.",
        );
        return local ?? { ...remote, ...ours };
      }
      bases.current.set(remote.id, remoteDetail);
      return { ...remote, ...merged };
    });
    // Keep unsaved drafts when either their files or index entries disappear.
    for (const local of [...(current.current?.documents ?? []), ...recovered.map((draft) => draft.local)]) {
      if (next.documents.some((doc) => doc.id === local.id)) continue;
      const before = bases.current.get(local.id) ?? recovered.find((draft) => draft.local.id === local.id)?.base;
      if (!before || equal(before.document, local)) continue;
      let issue = next.documentIssues?.find((issue) => issue.id === local.id);
      if (!issue) {
        issue = { id: local.id, title: local.title, source: canvasDocumentPath(local.id), message: "Document was removed from the workspace index" };
        (next.documentIssues ??= []).push(issue);
      }
      bases.current.set(local.id, before);
      next.documents.push({ ...local, revision: before.revision, source: issue.source, main: next.mainDocumentId === local.id });
    }
    publish(next);
  }, [projectId, publish, recoveryKey, reportConflict]);
  useEffect(() => {
    mounted.current = true;
    void refresh().catch(() => {});
    const timer = window.setInterval(() => {
      void refresh().catch(() => {});
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
        try {
          while (true) {
            if (conflictRef.current)
              throw new Error("Resolve the document conflict before saving.");
            const entries = current.current.documents.filter((doc) => {
              if (current.current?.documentIssues?.some((issue) => issue.id === doc.id)) return false;
              const base = bases.current.get(doc.id);
              return base && !equal(base.document, doc);
            });
            if (!entries.length) break;
            setSaving(true);
            for (const entry of entries) {
              const local = documentContent(entry);
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
  const applyGeneration = useCallback(
    async (id: string) => {
      const state = generationStates.current[id], proposal = state?.proposal;
      if (proposal === undefined || state?.generating || state?.applying) return;
      changeGeneration(id, { applying: true });
      try {
        if (conflictRef.current) throw new Error("Resolve the document conflict before adopting this draft.");
        if (!current.current?.documents.some((doc) => doc.id === id) || current.current.documentIssues?.some((issue) => issue.id === id))
          throw new Error("Restore the document file before adopting this draft. You can still edit or copy it.");
        update(id, { markdown: proposal });
        await flush();
        changeGeneration(id, { proposal: undefined, proposalStatus: undefined, error: undefined });
      } catch (cause) {
        changeGeneration(id, { error: message(cause) });
      } finally {
        changeGeneration(id, { applying: false });
      }
    },
    [update, flush, changeGeneration],
  );
  const generate = useCallback(
    async (id: string, model: AgentModelRef, reasoningLevel?: AgentReasoningLevel, referenceSource?: AssetCanvasTextGenerationSource, prepare?: () => Promise<void>) => {
      const state = generationStates.current[id],
        instruction = state?.instruction.trim();
      if (!instruction || state?.generating || state?.applying)
        return;
      let autoApply = false;
      changeGeneration(id, { generating: true, model, reasoningLevel, error: undefined });
      try {
        await prepare?.();
        await flush();
        const base = current.current?.documents.find((doc) => doc.id === id);
        if (!base) throw new Error("Document not found");
        const result = await generateCanvasDocument(projectId, id, {
          instruction,
          model,
          reasoningLevel,
          referenceSource,
          revision: base.revision,
        });
        if (result.status === "empty") {
          changeGeneration(id, { error: result.error });
          return;
        }
        changeGeneration(id, {
          proposal: result.markdown,
          proposalStatus: result.status,
          model: result.model,
          error: result.status === "incomplete" ? result.error : undefined,
        });
        // Incomplete results and retries remain candidates until explicitly adopted.
        if (!mounted.current || result.status !== "complete" || state?.proposal !== undefined) return;
        // Refresh before applying so edits from another board, editor or agent are preserved.
        await refresh();
        const disk = await getCanvasDocument(projectId, id);
        if (!mounted.current) return;
        const now = current.current?.documents.find((doc) => doc.id === id);
        if (
          now &&
          disk &&
          !conflictRef.current &&
          now.markdown === base.markdown &&
          disk.document.markdown === base.markdown &&
          result.revision === base.revision
        ) autoApply = true;
        else
          changeGeneration(id, {
            error:
              "The document changed during generation. Review the AI result before replacing it.",
          });
      } catch (cause) {
        changeGeneration(id, { error: message(cause) });
      } finally {
        changeGeneration(id, { generating: false });
      }
      if (autoApply) await applyGeneration(id);
    },
    [projectId, changeGeneration, flush, refresh, applyGeneration],
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
    loadError,
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

export function readDocumentGenerations(key: string): Record<string, DocumentGenerationState> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
    if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
    return Object.fromEntries(Object.entries(stored).flatMap(([id, value]) => {
      if (!value || typeof value !== "object" || typeof value.instruction !== "string") return [];
      const state = value as DocumentGenerationState;
      return [[id, {
        instruction: state.instruction,
        model: typeof state.model?.provider === "string" && typeof state.model?.id === "string" ? { provider: state.model.provider, id: state.model.id } : undefined,
        reasoningLevel: AGENT_REASONING_LEVELS.includes(state.reasoningLevel!) ? state.reasoningLevel : undefined,
        proposal: typeof state.proposal === "string" ? state.proposal : undefined,
        proposalStatus: state.proposalStatus === "complete" || state.proposalStatus === "incomplete" ? state.proposalStatus : undefined,
        error: state.generating ? "Document generation was interrupted. Your instruction and candidate draft are kept. Try again."
          : state.applying ? "Saving was interrupted. Review the document before adopting the candidate draft again."
          : typeof state.error === "string" ? state.error : undefined,
      }]];
    }));
  } catch {
    return {};
  }
}
