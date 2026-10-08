import type { AssetCanvasDocument, ToolJob } from "../shared/contracts.js";
import { isAssetCanvasDocument } from "../shared/asset-canvas.js";
import { mergeCanvasDocument, type CanvasBoardDetail } from "../shared/canvas-workspace.js";
import { cancelCanvasJob, generateCanvasMedia, getCanvasBoard, listCanvasJobs, saveCanvasBoard } from "./canvas-api.js";

export interface CanvasBoardStorage {
  key: string;
  load(): Promise<AssetCanvasDocument>;
  save(canvas: AssetCanvasDocument): Promise<AssetCanvasDocument>;
  refresh(canvas: AssetCanvasDocument): Promise<AssetCanvasDocument | undefined>;
  resolveConflict(version: "local" | "remote", canvas: AssetCanvasDocument): Promise<AssetCanvasDocument>;
  jobs(): Promise<ToolJob[]>;
  generate(nodeId: string): Promise<ToolJob>;
  cancel(jobId: string): Promise<ToolJob>;
}
export interface CanvasBoardConflict { local: AssetCanvasDocument; remote: CanvasBoardDetail }

const canvasOnly = ({ id: _id, ...canvas }: CanvasBoardDetail["board"]): AssetCanvasDocument => canvas;
const conflictMessage = "The board was edited elsewhere. Choose a version before saving.";

export function createCanvasBoardStorage({ projectId, boardId, onConflict, flushDocuments }: {
  projectId: string;
  boardId: string;
  onConflict(conflict: CanvasBoardConflict): void;
  flushDocuments(): Promise<void>;
}): CanvasBoardStorage {
  let base: CanvasBoardDetail | undefined;
  let loading: Promise<AssetCanvasDocument> | undefined;
  let operations = Promise.resolve<unknown>(undefined);
  let conflicting: (CanvasBoardConflict & { base: AssetCanvasDocument }) | undefined;
  const recoveryKey = `canvas-board:${projectId}:${boardId}`;
  const assertWritable = (local?: AssetCanvasDocument) => {
    if (!conflicting) return;
    const serialized = JSON.stringify(local);
    if (local && serialized !== JSON.stringify(canvasOnly(conflicting.remote.board)) && serialized !== JSON.stringify(conflicting.local)) {
      remember(local, conflicting.base);
      conflicting = { ...conflicting, local };
      onConflict({ local, remote: conflicting.remote });
    }
    throw new Error(conflictMessage);
  };
  const remember = (local: AssetCanvasDocument, recoveryBase = canvasOnly(base!.board)) => {
    try { localStorage.setItem(recoveryKey, JSON.stringify({ base: recoveryBase, local })); } catch { /* Disk autosave remains available. */ }
  };
  const conflict = (local: AssetCanvasDocument, remote: CanvasBoardDetail, recoveryBase?: AssetCanvasDocument) => {
    conflicting = { local, remote, base: recoveryBase ?? canvasOnly(base!.board) };
    remember(local, conflicting.base);
    onConflict({ local, remote });
  };
  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    // Revision updates stay serialized even when callers request different operations together.
    const result = operations.catch(() => {}).then(operation);
    operations = result;
    return result;
  };
  const ready = async () => {
    if (loading) await loading;
    if (!base) throw new Error("Reload the canvas before saving. Your edits are kept in this session.");
  };
  return {
    key: `${projectId}:${boardId}`,
    load: () => {
      // Strict Mode and repeated renders must share one initialized storage session.
      loading ??= (async () => {
        base = await getCanvasBoard(projectId, boardId);
        let canvas = canvasOnly(base.board);
        try {
          const draft = JSON.parse(localStorage.getItem(recoveryKey) ?? "null") as { base: AssetCanvasDocument; local: AssetCanvasDocument } | null;
          if (draft && isAssetCanvasDocument(draft.base) && isAssetCanvasDocument(draft.local)) {
            const merged = mergeCanvasDocument(draft.base, draft.local, canvas);
            if (merged) canvas = merged;
            else { conflict(draft.local, base, draft.base); canvas = draft.local; }
          }
        } catch { /* Malformed recovery data does not replace the saved board. */ }
        return canvas;
      })();
      const request = loading;
      void request.catch(() => { if (loading === request) loading = undefined; });
      return request;
    },
    save: (local) => enqueue(async () => {
      await ready();
      assertWritable(local);
      if (JSON.stringify(local) === JSON.stringify(canvasOnly(base!.board))) {
        try { localStorage.removeItem(recoveryKey); } catch { /* The disk version is already saved. */ }
        return local;
      }
      let outgoing = local;
      for (let attempt = 0; attempt < 3; attempt++) {
        remember(outgoing);
        try {
          const saved = await saveCanvasBoard(projectId, { board: { ...outgoing, id: boardId }, revision: base!.revision });
          base = saved;
          loading = Promise.resolve(canvasOnly(saved.board));
          try { localStorage.removeItem(recoveryKey); } catch { /* A saved board remains usable without storage. */ }
          return canvasOnly(base.board);
        } catch (cause) {
          if ((cause as { status?: number }).status !== 409) throw cause;
          const remote = await getCanvasBoard(projectId, boardId);
          const merged = mergeCanvasDocument(canvasOnly(base!.board), outgoing, canvasOnly(remote.board));
          if (!merged) { conflict(outgoing, remote); throw new Error(conflictMessage); }
          base = remote; outgoing = merged;
        }
      }
      throw new Error("The board keeps changing. Try saving again.");
    }),
    refresh: (local) => enqueue(async () => {
      await ready();
      assertWritable(local);
      const remote = await getCanvasBoard(projectId, boardId);
      if (remote.revision === base!.revision) return;
      const merged = mergeCanvasDocument(canvasOnly(base!.board), local, canvasOnly(remote.board));
      if (!merged) { conflict(local, remote); throw new Error(conflictMessage); }
      base = remote;
      if (JSON.stringify(merged) !== JSON.stringify(canvasOnly(remote.board))) remember(merged);
      loading = Promise.resolve(merged);
      return merged;
    }),
    resolveConflict: (version, local) => enqueue(async () => {
      await ready();
      const remote = await getCanvasBoard(projectId, boardId);
      if (version === "local") {
        const outgoing = conflicting ? mergeCanvasDocument(canvasOnly(conflicting.remote.board), local, canvasOnly(remote.board)) : local;
        if (!outgoing) {
          conflict(local, remote);
          throw new Error("The board changed again. Review the latest version before choosing.");
        }
        remember(outgoing);
        const saved = await saveCanvasBoard(projectId, { board: { ...outgoing, id: boardId }, revision: remote.revision });
        base = saved;
      } else base = remote;
      conflicting = undefined;
      loading = Promise.resolve(canvasOnly(base!.board));
      try { localStorage.removeItem(recoveryKey); } catch { /* The selected version is saved on disk. */ }
      return canvasOnly(base!.board);
    }),
    jobs: async () => (await listCanvasJobs(projectId)).filter((job) => job.context?.boardId === boardId),
    generate: async (nodeId) => {
      assertWritable();
      await flushDocuments();
      assertWritable();
      return generateCanvasMedia(projectId, boardId, nodeId);
    },
    cancel: (jobId) => cancelCanvasJob(projectId, jobId),
  };
}
