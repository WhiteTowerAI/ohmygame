import type { ProjectState } from "../shared/contracts.js";
import { CheckpointLocationUnavailableError, type CheckpointLocationSettings } from "./checkpoint-location.js";
import type { CheckpointStore } from "./checkpoints.js";

/** How moving every project's file history to the checkpoint location is going. */
export interface CheckpointMoveStatus {
  /** Whether a pass over the projects is under way. */
  moving: boolean;
  /** Projects looked at in this pass, of all of them. */
  done: number;
  total: number;
  /** The project being moved, in bytes of its stored objects. */
  current?: { projectId: string; copied: number; total: number };
  /** Projects left for later because they were working. */
  waiting: string[];
  /** Projects whose store is on a disk that is not there. */
  unavailable: string[];
  failed: Array<{ projectId: string; error: string }>;
}

export interface CheckpointMovesOptions {
  store: CheckpointStore;
  settings: CheckpointLocationSettings;
  projects: () => ProjectState[];
  /** Whether the project is doing nothing that a move would wait for, such as running an agent. */
  idle: (projectId: string) => boolean;
  log?: (error: unknown, projectId: string) => void;
  /** How long a project that was working waits before the next pass tries it again. */
  retryMs?: number;
}

/**
 * Moves each project's store to the checkpoint location, or back into its
 * own storage, one project at a time. A project that is working, such as
 * running an agent, is moved on a later pass. A pass that is asked for while
 * one runs starts again when it ends, so the last choice is the one followed.
 */
export class CheckpointMoves {
  readonly #options: CheckpointMovesOptions;
  #status: CheckpointMoveStatus = { moving: false, done: 0, total: 0, waiting: [], unavailable: [], failed: [] };
  #running?: Promise<void>;
  #again = false;
  #abandon = false;
  #retry?: ReturnType<typeof setTimeout>;
  readonly #stopped = new AbortController();

  constructor(options: CheckpointMovesOptions) {
    this.#options = options;
  }

  status(): CheckpointMoveStatus {
    return structuredClone(this.#status);
  }

  /**
   * Moves the projects whose store is not where the setting says. With
   * `abandon`, a project whose store is on a disk that is gone starts a new
   * one and leaves that one behind.
   */
  start(options: { abandon?: boolean } = {}): Promise<void> {
    if (options.abandon) this.#abandon = true;
    if (this.#retry) clearTimeout(this.#retry);
    this.#retry = undefined;
    if (this.#running) {
      this.#again = true;
      return this.#running;
    }
    this.#running = (async () => {
      do {
        this.#again = false;
        const abandon = this.#abandon;
        this.#abandon = false;
        await this.#pass(abandon);
      } while (this.#again && !this.#stopped.signal.aborted);
    })().finally(() => {
      this.#running = undefined;
    });
    return this.#running;
  }

  /** Stops the move under way, which leaves that store where it was, and moves no more. */
  stop(): void {
    this.#stopped.abort();
    if (this.#retry) clearTimeout(this.#retry);
  }

  async #pass(abandon: boolean): Promise<void> {
    const { store, settings, projects, idle } = this.#options;
    const { location, problem } = await settings.get();
    if (problem) return;
    const list = projects();
    const status: CheckpointMoveStatus = { moving: true, done: 0, total: list.length, waiting: [], unavailable: [], failed: [] };
    this.#status = status;
    for (const project of list) {
      if (this.#stopped.signal.aborted || this.#again) break;
      if (!projects().some((each) => each.id === project.id)) {
        status.done += 1;
        continue;
      }
      if (!idle(project.id)) {
        status.waiting.push(project.id);
        status.done += 1;
        continue;
      }
      try {
        await store.move(project, location, {
          signal: this.#stopped.signal,
          abandon,
          progress: ({ copied, total }) => {
            status.current = { projectId: project.id, copied, total };
          },
        });
      } catch (error) {
        if (error instanceof CheckpointLocationUnavailableError) status.unavailable.push(project.id);
        else if (!this.#stopped.signal.aborted) {
          status.failed.push({ projectId: project.id, error: error instanceof Error ? error.message : String(error) });
          this.#options.log?.(error, project.id);
        }
      }
      status.current = undefined;
      status.done += 1;
    }
    status.moving = false;
    if (status.waiting.length && !this.#stopped.signal.aborted) {
      this.#retry = setTimeout(() => void this.start(), this.#options.retryMs ?? 30_000);
      this.#retry.unref?.();
    }
  }
}
