import type { AgentModelRef, ProjectState } from "../shared/contracts.js";
import type { ProjectManager } from "./projects.js";

export type ProjectNameGenerator = (
  prompt: string,
  model: AgentModelRef | undefined,
  signal: AbortSignal,
) => Promise<string | undefined>;

/** A short, independent request must never delay or fail the user's agent turn. */
export class ProjectNaming {
  readonly #pending = new Map<
    string,
    { controller: AbortController; done: Promise<void> }
  >();
  #closed = false;

  constructor(
    private readonly projects: ProjectManager,
    private readonly generate: ProjectNameGenerator,
    private readonly onRenamed: (project: ProjectState) => void,
  ) {}

  start(
    project: ProjectState,
    prompt: string,
    model: AgentModelRef | undefined,
  ): void {
    if (
      this.#closed ||
      project.nameSource !== "default" ||
      !prompt.trim() ||
      this.#pending.has(project.id)
    )
      return;
    const controller = new AbortController();
    const signal = AbortSignal.any([
      controller.signal,
      AbortSignal.timeout(15_000),
    ]);
    const done = this.#name(project.id, prompt, model, signal)
      .catch(() => {
        // Keep the default name on provider failure; a later request may try again.
      })
      .finally(() => {
        this.#pending.delete(project.id);
      });
    this.#pending.set(project.id, { controller, done });
  }

  async close(): Promise<void> {
    this.#closed = true;
    const pending = [...this.#pending.values()];
    for (const { controller } of pending) controller.abort();
    await Promise.all(pending.map(({ done }) => done));
  }

  async #name(
    id: string,
    prompt: string,
    model: AgentModelRef | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    let onAbort!: () => void;
    // Also release the job if a provider ignores cancellation.
    const aborted = new Promise<undefined>((resolve) => {
      onAbort = () => resolve(undefined);
      signal.addEventListener("abort", onAbort, { once: true });
    });
    try {
      const name = await Promise.race([
        this.generate(prompt, model, signal),
        aborted,
      ]);
      if (!name || signal.aborted) return;
      const project = await this.projects.nameAutomatically(id, name);
      if (project) this.onRenamed(project);
    } finally {
      signal.removeEventListener("abort", onAbort);
    }
  }
}
