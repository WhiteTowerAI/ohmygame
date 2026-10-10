import {
  isCanvasTable,
  mergeCanvasTable,
  type CanvasTable,
  type CanvasTableDetail,
} from "../shared/canvas-table.js";
import type { CanvasWorkspaceDetail } from "../shared/canvas-workspace.js";
import {
  AGENT_REASONING_LEVELS,
  type AgentModelRef,
  type AgentReasoningLevel,
} from "../shared/contracts.js";
import {
  createCanvasTable,
  generateCanvasTable,
  getCanvasTable,
  saveCanvasTable,
} from "./canvas-api.js";
import { Equal as equal } from "typebox/value";

export interface CanvasTableConflict {
  local: CanvasTable;
  remote: CanvasTableDetail;
}
export interface TableGenerationState {
  instruction: string;
  model?: AgentModelRef;
  reasoningLevel?: AgentReasoningLevel;
  generating?: boolean;
  applying?: boolean;
  proposal?: CanvasTable;
  error?: string;
}
const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);
interface TableSession {
  base: CanvasTableDetail;
  local: CanvasTable;
  undo: CanvasTable[];
  redo: CanvasTable[];
  conflict?: CanvasTableConflict;
  issue?: string;
}
export class CanvasTableStorage {
  readonly sessions = new Map<string, TableSession>();
  generations: Record<string, TableGenerationState>;
  saving = false;
  error?: string;
  #chain = Promise.resolve();
  #listeners = new Set<() => void>();
  #syncRequest = 0;
  #recoveryKey: string;
  #generationKey: string;
  #recoveries: Array<{ base: CanvasTableDetail; local: CanvasTable }> = [];
  constructor(
    readonly projectId: string,
    private readonly api = {
      create: createCanvasTable,
      generate: generateCanvasTable,
      get: getCanvasTable,
      save: saveCanvasTable,
    },
  ) {
    this.#recoveryKey = `canvas-tables:${projectId}`;
    this.#generationKey = `canvas-table-generations:${projectId}`;
    this.generations = readTableGenerations(this.#generationKey);
    try {
      const stored = JSON.parse(
        localStorage.getItem(this.#recoveryKey) ?? "[]",
      );
      if (Array.isArray(stored))
        this.#recoveries = stored.filter(
          (draft) =>
            typeof draft?.base?.revision === "string" &&
            isCanvasTable(draft.base.table) &&
            isCanvasTable(draft.local) &&
            draft.local.id === draft.base.table.id,
        );
    } catch {
      /* Recovery is optional; disk data is still available. */
    }
  }
  subscribe(listener: () => void) {
    this.#listeners.add(listener);
    return () => {
      this.#listeners.delete(listener);
    };
  }
  #publish() {
    const drafts = [...this.sessions.values()]
      .filter((session) => !equal(session.base.table, session.local))
      .map(({ base, local }) => ({ base, local }));
    try {
      drafts.length
        ? localStorage.setItem(this.#recoveryKey, JSON.stringify(drafts))
        : localStorage.removeItem(this.#recoveryKey);
    } catch {
      /* In-memory drafts remain editable. */
    }
    this.#notify();
  }
  #notify() {
    for (const listener of this.#listeners) listener();
  }
  generation(id: string) {
    return Object.hasOwn(this.generations, id)
      ? this.generations[id]
      : undefined;
  }
  changeGeneration(id: string, patch: Partial<TableGenerationState>) {
    this.generations = {
      ...this.generations,
      [id]: { ...(this.generation(id) ?? { instruction: "" }), ...patch },
    };
    try {
      localStorage.setItem(
        this.#generationKey,
        JSON.stringify(this.generations),
      );
    } catch {
      /* Instructions and candidates remain available in this session. */
    }
    this.#notify();
  }
  #writableSession(id: string) {
    const session = this.sessions.get(id);
    if (!session) throw new Error("Table not found.");
    if (session.conflict)
      throw new Error("Resolve the table conflict before using AI changes.");
    if (session.issue)
      throw new Error(
        "Restore the table file before using AI changes. Your draft is kept.",
      );
    return session;
  }
  async applyGeneration(id: string) {
    const state = this.generation(id),
      proposal = state?.proposal;
    if (!state || !proposal || state.generating || state.applying) return;
    this.changeGeneration(id, { applying: true, error: undefined });
    try {
      this.#writableSession(id);
      this.update(proposal);
      await this.flush(id);
      this.changeGeneration(id, { proposal: undefined });
    } catch (cause) {
      this.changeGeneration(id, { error: message(cause) });
    } finally {
      this.changeGeneration(id, { applying: false });
    }
  }
  async generate(
    id: string,
    model: AgentModelRef,
    reasoningLevel?: AgentReasoningLevel,
  ) {
    const state = this.generation(id),
      instruction = state?.instruction.trim();
    if (!state || !instruction || state.generating || state.applying) return;
    let autoApply = false;
    this.changeGeneration(id, {
      generating: true,
      model,
      reasoningLevel,
      error: undefined,
    });
    try {
      this.#writableSession(id);
      await this.flush(id);
      const base = this.#writableSession(id).base;
      const result = await this.api.generate(this.projectId, id, {
        instruction,
        model,
        reasoningLevel,
        revision: base.revision,
      });
      if (result.status !== "complete") {
        this.changeGeneration(id, { error: result.error });
        return;
      }
      if (!isCanvasTable(result.table) || result.table.id !== id)
        throw new Error("The model returned an invalid table. Try again.");
      this.changeGeneration(id, {
        proposal: result.table,
        model: result.model,
      });
      // A candidate may replace only the exact snapshot it was generated from.
      const disk = await this.api.get(this.projectId, id),
        now = this.sessions.get(id);
      autoApply =
        !state.proposal &&
        result.revision === base.revision &&
        disk.revision === base.revision &&
        !!now &&
        !now.conflict &&
        !now.issue &&
        equal(now.local, base.table);
      if (!autoApply)
        this.changeGeneration(id, {
          error:
            "Review the AI draft before replacing the table; your current edits are kept.",
        });
    } catch (cause) {
      this.changeGeneration(id, { error: message(cause) });
    } finally {
      this.changeGeneration(id, { generating: false });
    }
    if (autoApply) await this.applyGeneration(id);
  }
  #rebaseHistory(
    session: TableSession,
    base: CanvasTable,
    remote: CanvasTable,
  ) {
    for (const key of ["undo", "redo"] as const)
      session[key] = session[key].flatMap((snapshot) => {
        const merged = mergeCanvasTable(base, snapshot, remote);
        return merged ? [merged] : [];
      });
  }
  // Workspace polling supplies resource revisions; drafts are reconciled by stable cell IDs.
  async sync(workspace: Pick<CanvasWorkspaceDetail, "tables" | "tableIssues">) {
    const request = ++this.#syncRequest;
    for (const entry of workspace.tables ?? []) {
      const { revision, source: _source, ...table } = entry;
      let remote = { table, revision };
      let session = this.sessions.get(table.id);
      if (!session) {
        const recovery = this.#recoveries.find(
          (draft) => draft.local.id === table.id,
        );
        session = {
          base: recovery?.base ?? remote,
          local: recovery?.local ?? table,
          undo: [],
          redo: [],
        };
        this.sessions.set(table.id, session);
      } else if (session.base.revision !== revision && !session.conflict) {
        // A workspace response may have started before an in-flight save.
        // Re-read changed resources and discard reads overtaken by a save.
        const started = session.base;
        try {
          remote = await this.api.get(this.projectId, table.id);
        } catch (cause) {
          if (request !== this.#syncRequest) return;
          if (session.base !== started) continue;
          session.issue = message(cause);
          continue;
        }
        if (request !== this.#syncRequest) return;
        if (session.base !== started) continue;
      }
      session.issue = undefined;
      if (session.conflict) {
        session.conflict.remote = remote;
        continue;
      }
      if (session.base.revision === remote.revision) continue;
      const merged = mergeCanvasTable(
        session.base.table,
        session.local,
        remote.table,
      );
      if (!merged) session.conflict = { local: session.local, remote };
      else {
        if (!equal(merged, session.local))
          this.#rebaseHistory(session, session.base.table, remote.table);
        session.base = remote;
        session.local = merged;
      }
    }
    for (const recovery of this.#recoveries)
      if (!this.sessions.has(recovery.local.id))
        this.sessions.set(recovery.local.id, {
          ...recovery,
          undo: [],
          redo: [],
        });
    this.#recoveries = [];
    for (const [id, session] of this.sessions)
      if (!workspace.tables?.some((table) => table.id === id))
        session.issue =
          workspace.tableIssues?.find((issue) => issue.id === id)?.message ??
          "Table was removed from the workspace index. Your draft is kept locally.";
    this.#publish();
  }
  update(table: CanvasTable, history = true) {
    if (!isCanvasTable(table)) throw new Error("Invalid table data.");
    const session = this.sessions.get(table.id);
    if (!session || equal(session.local, table)) return false;
    if (history) {
      session.undo.push(session.local);
      if (session.undo.length > 100) session.undo.shift();
    }
    session.redo = [];
    session.local = table;
    if (session.conflict) session.conflict.local = table;
    this.error = undefined;
    this.#publish();
    return true;
  }
  history(id: string, direction: "undo" | "redo") {
    const session = this.sessions.get(id);
    if (!session) return;
    const source = session[direction],
      destination = session[direction === "undo" ? "redo" : "undo"],
      table = source.pop();
    if (!table) return;
    destination.push(session.local);
    session.local = table;
    if (session.conflict) session.conflict.local = table;
    this.error = undefined;
    this.#publish();
  }
  resolve(id: string, version: "local" | "remote") {
    const session = this.sessions.get(id),
      conflict = session?.conflict;
    if (!session || !conflict) return;
    session.base = conflict.remote;
    session.local =
      version === "local" ? conflict.local : conflict.remote.table;
    session.conflict = undefined;
    session.undo = [];
    session.redo = [];
    this.error = undefined;
    this.#publish();
  }
  async create() {
    const detail = await this.api.create(this.projectId, "Untitled table");
    this.sessions.set(detail.table.id, {
      base: detail,
      local: detail.table,
      undo: [],
      redo: [],
    });
    this.#publish();
    return detail.table.id;
  }
  async #flushSession(session: TableSession) {
    if (session.conflict)
      throw new Error("Resolve the table conflict before saving.");
    if (session.issue && !equal(session.base.table, session.local))
      throw new Error(session.issue);
    while (!equal(session.base.table, session.local)) {
      const snapshot = session.local;
      let base = session.base,
        outgoing = snapshot,
        saved: CanvasTableDetail | undefined;
      for (let attempt = 0; attempt < 3; attempt++) {
        try {
          saved = await this.api.save(this.projectId, {
            table: outgoing,
            revision: base.revision,
          });
          break;
        } catch (cause) {
          if ((cause as { status?: number }).status !== 409) throw cause;
          const remote = await this.api.get(this.projectId, outgoing.id);
          const merged = mergeCanvasTable(base.table, outgoing, remote.table);
          if (!merged) {
            session.conflict = { local: session.local, remote };
            throw new Error(
              "The same table cell changed elsewhere. Choose a version to resume saving.",
            );
          }
          base = remote;
          outgoing = merged;
        }
      }
      if (!saved)
        throw new Error("The table keeps changing. Try saving again.");
      const merged = mergeCanvasTable(snapshot, session.local, saved.table);
      if (!merged) {
        session.conflict = { local: session.local, remote: saved };
        throw new Error("Review the table changes before saving.");
      }
      if (!equal(snapshot, saved.table))
        this.#rebaseHistory(session, snapshot, saved.table);
      session.base = saved;
      session.local = merged;
      this.#publish();
    }
  }
  flush(id?: string): Promise<void> {
    const operation = this.#chain
      .catch(() => {})
      .then(async () => {
        this.saving = true;
        this.#publish();
        try {
          let failure: unknown;
          for (const session of this.sessions.values()) {
            if (id !== undefined && session.local.id !== id) continue;
            try {
              await this.#flushSession(session);
            } catch (cause) {
              failure ??= cause;
            }
          }
          if (failure) throw failure;
          this.error = undefined;
        } catch (cause) {
          this.error = message(cause);
          throw cause;
        } finally {
          this.saving = false;
          this.#publish();
        }
      });
    this.#chain = operation;
    return operation;
  }
}

export function readTableGenerations(
  key: string,
): Record<string, TableGenerationState> {
  try {
    const stored: unknown = JSON.parse(localStorage.getItem(key) ?? "{}");
    if (!stored || typeof stored !== "object" || Array.isArray(stored))
      return {};
    return Object.fromEntries(
      Object.entries(stored).flatMap(([id, value]) => {
        if (
          !value ||
          typeof value !== "object" ||
          typeof (value as TableGenerationState).instruction !== "string"
        )
          return [];
        const state = value as TableGenerationState;
        return [
          [
            id,
            {
              instruction: state.instruction,
              model:
                typeof state.model?.provider === "string" &&
                typeof state.model?.id === "string"
                  ? { provider: state.model.provider, id: state.model.id }
                  : undefined,
              reasoningLevel: AGENT_REASONING_LEVELS.includes(
                state.reasoningLevel!,
              )
                ? state.reasoningLevel
                : undefined,
              proposal:
                isCanvasTable(state.proposal) && state.proposal.id === id
                  ? state.proposal
                  : undefined,
              error:
                state.generating || state.applying
                  ? "AI table editing was interrupted. Your instruction and candidate draft are kept. Try again."
                  : typeof state.error === "string"
                    ? state.error
                    : undefined,
            },
          ],
        ];
      }),
    );
  } catch {
    return {};
  }
}
