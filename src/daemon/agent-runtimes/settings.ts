import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AGENT_RUNTIME_IDS,
  isAgentRuntimeId,
  type AgentRuntimeId,
} from "../../shared/agent-runtimes.js";

export interface AgentRuntimeSettings {
  enabled: boolean;
  isolateUserConfig: boolean;
  binaryPath?: string;
}

const DEFAULTS: AgentRuntimeSettings = {
  enabled: true,
  isolateUserConfig: true,
};

/**
 * The person's choices for each coding agent, in `agent-runtimes.json`. A
 * missing or damaged file means the defaults: an installed agent is offered,
 * and it runs without the person's own CLI configuration.
 */
export class AgentRuntimeSettingsStore {
  readonly #filePath: string;
  #settings = new Map<AgentRuntimeId, AgentRuntimeSettings>();
  #writes: Promise<unknown> = Promise.resolve();

  constructor(dataDirectory: string) {
    this.#filePath = path.join(dataDirectory, "agent-runtimes.json");
  }

  async load(): Promise<void> {
    let value: unknown;
    try {
      value = JSON.parse(await readFile(this.#filePath, "utf8"));
    } catch (cause) {
      if (
        (cause as NodeJS.ErrnoException).code === "ENOENT" ||
        cause instanceof SyntaxError
      )
        return;
      throw cause;
    }
    const runtimes =
      value && typeof value === "object"
        ? (value as { runtimes?: unknown }).runtimes
        : undefined;
    if (!runtimes || typeof runtimes !== "object") return;
    for (const [id, entry] of Object.entries(runtimes)) {
      if (!isAgentRuntimeId(id) || !entry || typeof entry !== "object")
        continue;
      const stored = entry as Record<string, unknown>;
      this.#settings.set(id, {
        enabled:
          typeof stored.enabled === "boolean"
            ? stored.enabled
            : DEFAULTS.enabled,
        isolateUserConfig:
          typeof stored.isolateUserConfig === "boolean"
            ? stored.isolateUserConfig
            : DEFAULTS.isolateUserConfig,
        ...(typeof stored.binaryPath === "string" &&
        path.isAbsolute(stored.binaryPath)
          ? { binaryPath: stored.binaryPath }
          : {}),
      });
    }
  }

  get(id: AgentRuntimeId): AgentRuntimeSettings {
    return { ...DEFAULTS, ...this.#settings.get(id) };
  }

  update(
    id: AgentRuntimeId,
    change: Partial<AgentRuntimeSettings>,
  ): Promise<AgentRuntimeSettings> {
    const next: AgentRuntimeSettings = { ...this.get(id), ...change };
    if (!next.binaryPath) delete next.binaryPath;
    this.#settings.set(id, next);
    const snapshot = Object.fromEntries(
      AGENT_RUNTIME_IDS.filter((runtime) => this.#settings.has(runtime)).map(
        (runtime) => [runtime, this.#settings.get(runtime)],
      ),
    );
    const write = this.#writes.then(async () => {
      await mkdir(path.dirname(this.#filePath), { recursive: true });
      const temporary = `${this.#filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(
          temporary,
          `${JSON.stringify({ version: 1, runtimes: snapshot }, null, 2)}\n`,
        );
        await rename(temporary, this.#filePath);
      } catch (cause) {
        await rm(temporary, { force: true });
        throw cause;
      }
    });
    this.#writes = write.catch(() => {});
    return write.then(() => this.get(id));
  }
}
