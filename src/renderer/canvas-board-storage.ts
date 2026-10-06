import type { AssetCanvasDocument, ToolJob } from "../shared/contracts.js";
import { mergeCanvasDocument, type CanvasBoardDetail } from "../shared/canvas-workspace.js";
import { cancelCanvasJob, generateCanvasMedia, getCanvasBoard, listCanvasJobs, saveCanvasBoard } from "./canvas-api.js";

export interface CanvasBoardStorage {
  key: string;
  load(): Promise<AssetCanvasDocument>;
  save(canvas: AssetCanvasDocument): Promise<AssetCanvasDocument>;
  refresh(canvas: AssetCanvasDocument): Promise<AssetCanvasDocument | undefined>;
  jobs(): Promise<ToolJob[]>;
  generate(nodeId: string): Promise<ToolJob>;
  cancel(jobId: string): Promise<ToolJob>;
}
export interface CanvasBoardConflict { local: AssetCanvasDocument; remote: CanvasBoardDetail }

const canvasOnly = ({ id: _id, ...canvas }: CanvasBoardDetail["board"]): AssetCanvasDocument => canvas;
const conflictMessage = "The board was edited elsewhere. Choose a version before saving.";

export function createCanvasBoardStorage({ projectId, boardId, revision, onConflict, flushDocuments }: {
  projectId: string;
  boardId: string;
  revision: number;
  onConflict(conflict: CanvasBoardConflict): void;
  flushDocuments(): Promise<void>;
}): CanvasBoardStorage {
  let base: CanvasBoardDetail | undefined;
  let conflicted = false;
  const recoveryKey = `canvas-board:${projectId}:${boardId}`;
  const assertWritable = () => { if (conflicted) throw new Error(conflictMessage); };
  const remember = (local: AssetCanvasDocument, recoveryBase = canvasOnly(base!.board)) => {
    try { localStorage.setItem(recoveryKey, JSON.stringify({ base: recoveryBase, local })); } catch { /* Disk autosave remains available. */ }
  };
  const conflict = (local: AssetCanvasDocument, remote: CanvasBoardDetail, recoveryBase?: AssetCanvasDocument) => {
    conflicted = true;
    remember(local, recoveryBase);
    onConflict({ local, remote });
  };
  return {
    key: `${projectId}:${boardId}:${revision}`,
    load: async () => {
      base = await getCanvasBoard(projectId, boardId);
      let canvas = canvasOnly(base.board);
      try {
        const draft = JSON.parse(localStorage.getItem(recoveryKey) ?? "null") as { base: AssetCanvasDocument; local: AssetCanvasDocument } | null;
        if (draft) {
          const merged = mergeCanvasDocument(draft.base, draft.local, canvas);
          if (merged) canvas = merged;
          else conflict(draft.local, base, draft.base);
        }
      } catch { /* Malformed recovery data does not replace the saved board. */ }
      return canvas;
    },
    save: async (local) => {
      assertWritable();
      if (!base) throw new Error("The board is still loading.");
      let outgoing = local;
      for (let attempt = 0; attempt < 3; attempt++) {
        remember(outgoing);
        try {
          const saved = await saveCanvasBoard(projectId, { board: { ...outgoing, id: boardId }, revision: base.revision });
          assertWritable();
          base = saved;
          try { localStorage.removeItem(recoveryKey); } catch { /* A saved board remains usable without storage. */ }
          return canvasOnly(base.board);
        } catch (cause) {
          if ((cause as { status?: number }).status !== 409) throw cause;
          const remote = await getCanvasBoard(projectId, boardId);
          assertWritable();
          const merged = mergeCanvasDocument(canvasOnly(base.board), outgoing, canvasOnly(remote.board));
          if (!merged) { conflict(outgoing, remote); throw new Error(conflictMessage); }
          base = remote; outgoing = merged;
        }
      }
      throw new Error("The board keeps changing. Try saving again.");
    },
    refresh: async (local) => {
      assertWritable();
      if (!base) return;
      const remote = await getCanvasBoard(projectId, boardId);
      assertWritable();
      if (remote.revision === base.revision) return;
      const merged = mergeCanvasDocument(canvasOnly(base.board), local, canvasOnly(remote.board));
      if (!merged) { conflict(local, remote); throw new Error(conflictMessage); }
      base = remote;
      return merged;
    },
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
