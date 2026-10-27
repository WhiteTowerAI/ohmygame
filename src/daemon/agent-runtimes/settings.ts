import { randomUUID } from "node:crypto";
import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import {
  AGENT_PERMISSION_MODES,
  AGENT_RUNTIME_IDS,
  ACCOUNT_RUNTIME_IDS,
  isAccountRuntimeId,
  type AccountRuntimeId,
  isAgentRuntimeId,
  type AgentPermissionMode,
  type AgentRuntimeId,
  type AgentAccountProfile,
} from "../../shared/agent-runtimes.js";

/** Conversation defaults live here; Pi's defaults also serve one-off generation. */
export interface AgentRuntimeDefault {
  model: { provider: AgentRuntimeId; id: string };
  nativeReasoningLevel?: string;
}

export interface AgentRuntimeSettings {
  enabled: boolean;
  permissionMode: AgentPermissionMode;
  binaryPath?: string;
  defaultProfileId?: string;
}

const DEFAULTS: AgentRuntimeSettings = {
  enabled: false,
  permissionMode: "standard",
};

/**
 * The person's choices for each coding agent, in `agent-runtimes.json`. A
 * missing or damaged file means the defaults: every runtime is off until
 * enabled. Each runtime loads its own CLI configuration.
 */
export class AgentRuntimeSettingsStore {
  readonly #filePath: string;
  #settings = new Map<AgentRuntimeId, AgentRuntimeSettings>();
  #writes: Promise<unknown> = Promise.resolve();
  #default?: AgentRuntimeDefault;
  #profiles = new Map<AccountRuntimeId, AgentAccountProfile[]>();

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
    const profiles = stored.accountProfiles && typeof stored.accountProfiles === "object" ? stored.accountProfiles as Record<string, unknown> : {};
    for (const runtime of ACCOUNT_RUNTIME_IDS) {
      const saved = profiles[runtime];
      const ids = new Set<string>();
      this.#profiles.set(runtime, Array.isArray(saved) ? saved.flatMap((profile) => {
        if (!profile || typeof profile !== "object" || typeof profile.id !== "string" ||
          !/^[a-zA-Z0-9_-]{1,80}$/.test(profile.id) || profile.id === "system" || ids.has(profile.id) ||
          typeof profile.name !== "string" || !profile.name.trim() ||
          typeof profile.configDirectory !== "string" || !path.isAbsolute(profile.configDirectory)) return [];
        ids.add(profile.id);
        const directory = path.resolve(profile.configDirectory);
        const managedRoot = path.join(path.dirname(this.#filePath), "agent-runtimes", "account-profiles", runtime);
        // Only a directory the app created, directly inside its reserved root, is removed with its profile.
        const managed = profile.managed === true && path.dirname(directory) === managedRoot;
        return [{ id: profile.id, name: profile.name, configDirectory: directory, managed }];
      }) : []);
    }
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
        ...(isAccountRuntimeId(id) && typeof stored.defaultProfileId === "string" && this.profiles(id).some((profile) => profile.id === stored.defaultProfileId) ? { defaultProfileId: stored.defaultProfileId } : {}),
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

  profiles(runtime: AccountRuntimeId): AgentAccountProfile[] {
    return [{ id: "system", name: "System default" }, ...(this.#profiles.get(runtime) ?? [])].map((profile) => ({ ...profile }));
  }

  async addProfile(runtime: AccountRuntimeId, name: string, configDirectory: string, managed = false): Promise<AgentAccountProfile> {
    if (!name.trim() || name.trim().length > 80) throw new Error("Choose an account configuration name (1–80 characters)");
    if (!path.isAbsolute(configDirectory)) throw new Error("The configuration directory must be absolute");
    const directory = path.resolve(configDirectory);
    if ((this.#profiles.get(runtime) ?? []).some((profile) => profile.configDirectory === directory)) throw new Error("This configuration directory is already connected");
    const profile = { id: randomUUID(), name: name.trim(), configDirectory: directory, managed };
    this.#profiles.set(runtime, [...(this.#profiles.get(runtime) ?? []), profile]);
    await this.#persist();
    return profile;
  }

  resolveProfileId(runtime: AccountRuntimeId, profileId: string): string {
    return this.profiles(runtime).some((profile) => profile.id === profileId) ? profileId : "system";
  }

  async removeProfile(runtime: AccountRuntimeId, profileId: string): Promise<void> {
    if (profileId === "system") throw new Error("System default cannot be deleted");
    const profiles = this.#profiles.get(runtime) ?? [];
    if (!profiles.some((profile) => profile.id === profileId)) throw new Error("Account configuration not found");
    this.#profiles.set(runtime, profiles.filter((profile) => profile.id !== profileId));
    if (this.get(runtime).defaultProfileId === profileId)
      this.#settings.set(runtime, { ...this.get(runtime), defaultProfileId: "system" });
    await this.#persist();
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
    const accountProfiles = Object.fromEntries(this.#profiles);
    const write = this.#writes.then(async () => {
      await mkdir(path.dirname(this.#filePath), { recursive: true });
      const temporary = `${this.#filePath}.${randomUUID()}.tmp`;
      try {
        await writeFile(
          temporary,
          `${JSON.stringify({ version: 1, runtimes: snapshot, accountProfiles, ...(defaults ? { defaultModel: defaults } : {}) }, null, 2)}\n`,
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
