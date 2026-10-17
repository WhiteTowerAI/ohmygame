import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AGENT_RUNTIME_IDS,
  isAgentRuntimeId,
  type AgentRuntimeId,
} from "../../shared/agent-runtimes.js";
import {
  AGENT_REASONING_LEVELS,
  type AgentReasoningLevel,
} from "../../shared/contracts.js";

/**
 * A coding agent model chosen as the default for new conversations. It is kept
 * here, not in Pi's settings, because canvas text and other one-off generation
 * read Pi's default and can only use Pi's models.
 */
export interface AgentRuntimeDefault {
  model: { provider: AgentRuntimeId; id: string };
  reasoningLevel?: AgentReasoningLevel;
}

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
  #default?: AgentRuntimeDefault;
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
    this.#default = parseDefault(
      value && typeof value === "object"
        ? (value as { defaultModel?: unknown }).defaultModel
        : undefined,
    );
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

  /** The coding agent model new conversations start with, if the person chose one. */
  defaultModel(): AgentRuntimeDefault | undefined {
    return (
      this.#default && { ...this.#default, model: { ...this.#default.model } }
    );
  }

  /** Chooses a coding agent model as the default for new conversations, or clears it. */
  setDefaultModel(value: AgentRuntimeDefault | undefined): Promise<void> {
    this.#default = value;
    return this.#save();
  }

  update(
    id: AgentRuntimeId,
    change: Partial<AgentRuntimeSettings>,
  ): Promise<AgentRuntimeSettings> {
    const next: AgentRuntimeSettings = { ...this.get(id), ...change };
    if (!next.binaryPath) delete next.binaryPath;
    this.#settings.set(id, next);
    return this.#save().then(() => this.get(id));
  }

  #save(): Promise<void> {
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
          `${JSON.stringify({ version: 1, runtimes: snapshot, ...(this.#default ? { defaultModel: this.#default } : {}) }, null, 2)}\n`,
        );
        await rename(temporary, this.#filePath);
      } catch (cause) {
        await rm(temporary, { force: true });
        throw cause;
      }
    });
    this.#writes = write.catch(() => {});
    return write;
  }
}

function parseDefault(value: unknown): AgentRuntimeDefault | undefined {
  if (!value || typeof value !== "object") return undefined;
  const stored = value as {
    model?: { provider?: unknown; id?: unknown };
    reasoningLevel?: unknown;
  };
  if (
    !isAgentRuntimeId(stored.model?.provider) ||
    typeof stored.model?.id !== "string" ||
    !stored.model.id
  )
    return undefined;
  const reasoningLevel = (
    AGENT_REASONING_LEVELS as readonly unknown[]
  ).includes(stored.reasoningLevel)
    ? (stored.reasoningLevel as AgentReasoningLevel)
    : undefined;
  return {
    model: { provider: stored.model.provider, id: stored.model.id },
    ...(reasoningLevel ? { reasoningLevel } : {}),
  };
}
