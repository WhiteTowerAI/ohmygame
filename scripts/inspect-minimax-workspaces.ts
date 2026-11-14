import { lstat, readdir, realpath } from "node:fs/promises";
import path from "node:path";
import { TOOL_IDS } from "../src/shared/contracts.js";
import { canvasPath } from "../src/daemon/canvas-files.js";
import {
  readCanvasBoard,
  readCanvasIndex,
  readCanvasJobHistory,
} from "../src/daemon/canvas-workspace.js";
import { inspectMediaTaskJournal } from "../src/daemon/media-task-journal.js";

/** Counts only. Paths, prompts, model IDs outside the mapping and recovery IDs stay local. */
export async function inspectMinimaxWorkspaces(
  dataDirectory: string,
  workspaces: readonly string[],
  regions: readonly { source: string; target: string }[],
  models: readonly string[],
) {
  const providers = regions.flatMap(({ source, target }) => [source, target]);
  const recoveryIds = new Map<string, number>();
  const seen = new Set<string>();
  const blockers: string[] = [];
  const reports = [];
  for (const [ordinal, workspace] of workspaces.entries()) {
    const problems = new Set<string>();
    const counts = providers.map((provider) => ({
      provider,
      boardReferences: 0,
      unsupportedBoardModels: 0,
      jobs: { running: 0, succeeded: 0, failed: 0, cancelled: 0 },
    }));
    const boards = {
      registered: 0,
      found: 0,
      inspected: 0,
      missing: 0,
      unindexed: 0,
      unreadable: 0,
    };
    const jobs = {
      total: 0,
      video: 0,
      otherVideo: 0,
      invalidVideo: 0,
      missingJournal: 0,
    };
    // Ordinals refer to --workspace argument order, not arbitrary stored IDs.
    const report = {
      workspace: ordinal + 1,
      boards,
      providers: counts,
      jobs,
      blockers: [] as string[],
    };
    try {
      const resolved = await realpath(workspace);
      if (!(await lstat(resolved)).isDirectory())
        throw new Error("Not a directory");
      if (seen.has(resolved)) {
        problems.add("duplicate-workspace");
        continue;
      }
      seen.add(resolved);
      let index: Awaited<ReturnType<typeof readCanvasIndex>>;
      try {
        index = await readCanvasIndex(workspace);
      } catch {
        problems.add("canvas-index-unreadable");
      }
      const registered = new Set(index?.boards.map((board) => board.id));
      boards.registered = registered.size;
      const found = new Set<string>();
      try {
        // canvasPath checks both canvas and boards for links without creating either.
        const directory = path.dirname(
          await canvasPath(workspace, "boards/.inspection"),
        );
        for (const name of await readdir(directory))
          if (name.endsWith(".json")) found.add(name.slice(0, -5));
      } catch (cause) {
        if (!missing(cause)) problems.add("board-directory-unreadable");
      }
      boards.found = found.size;
      boards.missing = [...registered].filter((id) => !found.has(id)).length;
      boards.unindexed = [...found].filter((id) => !registered.has(id)).length;
      if (boards.missing) problems.add("registered-boards-missing");
      if (boards.unindexed) problems.add("unindexed-boards");
      for (const id of found) {
        try {
          const detail = await readCanvasBoard(workspace, id);
          if (!detail) throw new Error("Board disappeared");
          boards.inspected++;
          for (const node of detail.board.nodes) {
            if (node.type !== "video" || !node.data.model) continue;
            const count = counts.find(
              ({ provider }) => provider === node.data.model!.provider,
            );
            if (!count) continue;
            count.boardReferences++;
            if (!models.includes(node.data.model.id)) {
              count.unsupportedBoardModels++;
              problems.add("unsupported-board-models");
            }
          }
        } catch {
          boards.unreadable++;
          problems.add("boards-unreadable");
        }
      }
      try {
        const history = await readCanvasJobHistory(workspace);
        jobs.total = history.length;
        const ids = new Set<string>(),
          projectIds = new Set<string>();
        for (const job of history) {
          if (ids.has(job.id)) problems.add("duplicate-job-ids");
          ids.add(job.id);
          projectIds.add(job.context!.projectId);
          const recoveryId = job.recoveryId ?? job.id;
          if (
            typeof recoveryId !== "string" ||
            !/^[a-zA-Z0-9-]{1,120}$/.test(recoveryId)
          )
            problems.add("invalid-recovery-id");
          else
            recoveryIds.set(recoveryId, (recoveryIds.get(recoveryId) ?? 0) + 1);
          if (job.toolId !== "plugin-node" && !TOOL_IDS.includes(job.toolId))
            problems.add("unsupported-job-tool");
          if (job.toolId !== "generate-video") continue;
          jobs.video++;
          const input = record(job.input) ? job.input : undefined;
          const model = input?.model;
          // Retry uses input.model, not the display model or today's board setting.
          if (
            !record(model) ||
            typeof model.provider !== "string" ||
            typeof model.id !== "string" ||
            !model.provider ||
            !model.id
          ) {
            jobs.invalidVideo++;
            problems.add("video-job-input-unreadable");
            continue;
          }
          if (
            job.model &&
            (!record(job.model) ||
              job.model.provider !== model.provider ||
              job.model.id !== model.id)
          )
            problems.add("video-job-model-disagreement");
          const count = counts.find(
            ({ provider }) => provider === model.provider,
          );
          if (!count) {
            jobs.otherVideo++;
            continue;
          }
          count.jobs[job.status]++;
          if (!models.includes(model.id))
            problems.add("unsupported-job-models");
          if (job.status !== "succeeded") {
            problems.add("unfinished-minimax-jobs");
            // The builtin provider has no persistent vendor-task recovery. An
            // absent journal must never be interpreted as permission to resubmit.
            try {
              if (
                (await inspectMediaTaskJournal(
                  path.join(dataDirectory, "media-tasks"),
                  recoveryId,
                )) === "missing"
              )
                jobs.missingJournal++;
            } catch {
              problems.add("job-journal-unreadable");
            }
          }
        }
        if (projectIds.size > 1) problems.add("mixed-project-history");
      } catch {
        problems.add("job-history-unreadable");
      }
    } catch {
      problems.add("workspace-unreadable");
    } finally {
      report.blockers = [...problems];
      blockers.push(
        ...report.blockers.map(
          (problem) => `workspace-${ordinal + 1}:${problem}`,
        ),
      );
      reports.push(report);
    }
  }

  const journals = {
    total: 0,
    unconfirmed: 0,
    taskRecorded: 0,
    resultRecorded: 0,
    unreadable: 0,
    temporary: 0,
    linkedByRecoveryId: 0,
    ambiguous: 0,
    unattributed: 0,
  };
  try {
    const directory = path.join(dataDirectory, "media-tasks"),
      info = await lstat(directory);
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new Error("Invalid task directory");
    for (const name of await readdir(directory)) {
      if (name.endsWith(".tmp")) {
        journals.temporary++;
        continue;
      }
      if (!name.endsWith(".json")) continue;
      journals.total++;
      const id = name.slice(0, -5),
        matches = recoveryIds.get(id) ?? 0;
      if (matches === 1) journals.linkedByRecoveryId++;
      else if (matches > 1) journals.ambiguous++;
      else journals.unattributed++;
      try {
        const state = await inspectMediaTaskJournal(directory, id);
        if (state === "unconfirmed") journals.unconfirmed++;
        else if (state === "task-recorded") journals.taskRecorded++;
        else if (state === "result-recorded") journals.resultRecorded++;
        else journals.unreadable++; // A disappearing file invalidates the snapshot.
      } catch {
        journals.unreadable++;
      }
    }
  } catch (cause) {
    if (!missing(cause)) blockers.push("media-journal-directory-unreadable");
  }
  if (journals.total || journals.temporary)
    blockers.push("media-journals-require-ownership-review");
  if ([...recoveryIds.values()].some((count) => count > 1))
    blockers.push("shared-recovery-ids-require-review");
  return { workspaces: reports, journals, blockers };
}

function record(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === "object" && !Array.isArray(value);
}

function missing(cause: unknown): boolean {
  return (cause as NodeJS.ErrnoException)?.code === "ENOENT";
}
