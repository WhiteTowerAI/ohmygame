import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AGENT_PERMISSION_MODES,
  AGENT_RUNTIME_IDS,
  isAgentRuntimeId,
  type AgentPermissionMode,
  type AgentRuntimeId,
} from "../../shared/agent-runtimes.js";

/** Conversation defaults live here; Pi's defaults also serve one-off generation. */
export interface AgentRuntimeDefault {
  model: { provider: AgentRuntimeId; id: string };
  nativeReasoningLevel?: string;
}

export interface AgentRuntimeSettings {
  enabled: boolean;
  isolateUserConfig: boolean;
  permissionMode: AgentPermissionMode;
  binaryPath?: string;
}

const DEFAULTS: AgentRuntimeSettings = {
  enabled: false,
  isolateUserConfig: true,
  permissionMode: "standard",
};

/**
 * The person's choices for each coding agent, in `agent-runtimes.json`. A
 * missing or damaged file means the defaults: every runtime is off until
 * enabled, and runs without the person's own CLI configuration.
 */
export class AgentRuntimeSettingsStore {
  readonly #filePath: string;
  #settings = new Map<AgentRuntimeId, AgentRuntimeSettings>();
  #writes: Promise<unknown> = Promise.resolve();
  #default?: AgentRuntimeDefault;

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
    const stored =
      value && typeof value === "object"
        ? (value as Record<string, unknown>)
        : {};
    this.#default = parseDefault(stored.defaultModel);
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
        permissionMode: AGENT_PERMISSION_MODES.includes(
          stored.permissionMode as AgentPermissionMode,
        )
          ? (stored.permissionMode as AgentPermissionMode)
          : DEFAULTS.permissionMode,
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

  defaultModel(): AgentRuntimeDefault | undefined {
    return this.#default
      ? { ...this.#default, model: { ...this.#default.model } }
      : undefined;
  }

  setDefaultModel(defaults: AgentRuntimeDefault | undefined): Promise<void> {
    this.#default = defaults;
    return this.#persist();
  }

  update(
    id: AgentRuntimeId,
    change: Partial<AgentRuntimeSettings>,
  ): Promise<AgentRuntimeSettings> {
    const next: AgentRuntimeSettings = { ...this.get(id), ...change };
    if (!next.binaryPath) delete next.binaryPath;
    this.#settings.set(id, next);
    return this.#persist().then(() => this.get(id));
  }

  #persist(): Promise<void> {
    const snapshot = Object.fromEntries(
      AGENT_RUNTIME_IDS.filter((runtime) => this.#settings.has(runtime)).map(
        (runtime) => [runtime, this.#settings.get(runtime)],
      ),
    );
    const defaults = this.#default;
    const write = this.#writes.then(async () => {
      await mkdir(path.dirname(this.#filePath), { recursive: true });
      const temporary = `${this.#filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(
          temporary,
          `${JSON.stringify({ version: 1, runtimes: snapshot, ...(defaults ? { defaultModel: defaults } : {}) }, null, 2)}\n`,
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
    nativeReasoningLevel?: unknown;
  };
  if (
    !isAgentRuntimeId(stored.model?.provider) ||
    typeof stored.model?.id !== "string" ||
    !stored.model.id
  )
    return undefined;
  const level = stored.nativeReasoningLevel;
  return {
    model: { provider: stored.model.provider, id: stored.model.id },
    ...(typeof level === "string" && level
      ? { nativeReasoningLevel: level }
      : {}),
  };
}
