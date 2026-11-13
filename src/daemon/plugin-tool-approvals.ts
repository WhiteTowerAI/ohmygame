import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import type {
  SavedToolApproval,
  ToolApprovalScope,
} from "../shared/plugin-hooks.js";

/** A single daemon owns this store. Plugins cannot write it through the plugin API. */
export class PluginToolApprovals {
  readonly file: string;
  #document: {
    version: 1;
    grants: SavedToolApproval[];
    [key: string]: unknown;
  } = { version: 1, grants: [] };
  #ready: Promise<void>;
  #queue = Promise.resolve();
  #revisions = new Map<string, number>();
  #revoked = new Set<string>();
  #forgotten = new Set<string>();

  constructor(directory: string) {
    this.file = path.join(directory, "plugin-tool-approvals.json");
    this.#ready = this.#load();
    void this.#ready.catch(() => {});
  }

  async #load() {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    const value = JSON.parse(raw);
    if (
      !value ||
      value.version !== 1 ||
      !Array.isArray(value.grants) ||
      !value.grants.every(
        (grant: SavedToolApproval) =>
          validScope(grant) &&
          typeof grant.plugin === "string" &&
          typeof grant.digest === "string",
      )
    )
      throw new Error(
        "Cannot read saved plugin access; the file was left unchanged",
      );
    this.#document = value;
  }

  async list(plugin: string): Promise<SavedToolApproval[]> {
    await this.#ready;
    return structuredClone(
      this.#document.grants.filter((grant) => grant.plugin === plugin),
    );
  }

  revision(plugin: string): number {
    return this.#revisions.get(plugin) ?? 0;
  }

  async has(
    plugin: string,
    digest: string,
    scope: ToolApprovalScope,
  ): Promise<boolean> {
    // A rejected mutation has already reported its error to its caller. Wait
    // for it to settle without making later reads repeat that failure. Failed
    // revocations still block through the tombstones below; load errors remain fatal.
    await this.#queue.catch(() => {});
    return (
      !this.#forgotten.has(plugin) &&
      !this.#revoked.has(JSON.stringify([plugin, scope.key])) &&
      (await this.list(plugin)).some(
        (grant) =>
          grant.digest === digest &&
          grant.key === scope.key &&
          grant.label === scope.label,
      )
    );
  }

  grant(
    plugin: string,
    digest: string,
    scope: ToolApprovalScope,
    revision: number,
    signal?: AbortSignal,
  ): Promise<void> {
    if (!validScope(scope))
      return Promise.reject(new Error("Invalid plugin approval scope"));
    const saved = this.#write((grants) => {
      signal?.throwIfAborted();
      if (this.revision(plugin) !== revision)
        throw new Error("Plugin access changed; retry the call");
      return [
        ...grants.filter(
          (grant) => grant.plugin !== plugin || grant.key !== scope.key,
        ),
        { plugin, digest, key: scope.key, label: scope.label },
      ];
    });
    return saved.then(() => {
      if (this.revision(plugin) === revision) {
        this.#revoked.delete(JSON.stringify([plugin, scope.key]));
        this.#forgotten.delete(plugin);
      }
    });
  }

  revoke(plugin: string, key: string): Promise<void> {
    // Invalidates pending approvals immediately, even when a disk write is queued.
    this.#revisions.set(plugin, this.revision(plugin) + 1);
    this.#revoked.add(JSON.stringify([plugin, key]));
    return this.#write((grants) =>
      grants.filter((grant) => grant.plugin !== plugin || grant.key !== key),
    );
  }

  forget(plugin: string): Promise<void> {
    this.#forgotten.add(plugin);
    this.#revisions.set(plugin, this.revision(plugin) + 1);
    return this.#write((grants) =>
      grants.filter((grant) => grant.plugin !== plugin),
    );
  }

  #write(
    change: (grants: SavedToolApproval[]) => SavedToolApproval[],
  ): Promise<void> {
    const next = this.#queue
      .catch(() => {})
      .then(async () => {
        await this.#ready;
        const document = {
          ...this.#document,
          grants: change(this.#document.grants),
        };
        await mkdir(path.dirname(this.file), { recursive: true });
        const temporary = `${this.file}.${process.pid}.tmp`;
        await writeFile(temporary, `${JSON.stringify(document, null, 2)}\n`, {
          mode: 0o600,
        });
        await rename(temporary, this.file);
        this.#document = document;
      });
    this.#queue = next;
    return next;
  }
}

export function validScope(value: unknown): value is ToolApprovalScope {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const scope = value as ToolApprovalScope;
  return (
    typeof scope.key === "string" &&
    /^[a-zA-Z0-9][a-zA-Z0-9._:/ -]{0,199}$/.test(scope.key) &&
    typeof scope.label === "string" &&
    !!scope.label.trim() &&
    scope.label.length <= 200 &&
    !/[\u0000-\u001f\u007f]/.test(scope.label)
  );
}
