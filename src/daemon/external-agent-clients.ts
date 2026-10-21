import {
  cp,
  lstat,
  mkdir,
  readFile,
  rename,
  rm,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentRuntimeId } from "../shared/agent-runtimes.js";
import {
  EXTERNAL_AGENT_CLIENT_IDS,
  EXTERNAL_MCP_SERVER_NAME,
  type ExternalAgentClientId,
  type ExternalAgentClientState,
  type ExternalMcpLauncher,
} from "../shared/external-mcp.js";

/** The coding agent CLI each client is, so discovery and its chosen executable are shared. */
const CLIENT_RUNTIMES: Record<ExternalAgentClientId, AgentRuntimeId> = {
  "claude-code": "claude-code-cli",
  codex: "codex-cli",
};

const CLI_TIMEOUT_MS = 30_000;

interface StoredClients {
  version: 1;
  /** The launcher each client was connected with; a different one is reconnected at startup. */
  connected: Partial<Record<ExternalAgentClientId, ExternalMcpLauncher>>;
}

export type RunCli = (
  binaryPath: string,
  args: readonly string[],
  env: Record<string, string>,
  cwd?: string,
  timeout?: number,
) => Promise<{ stdout: string; stderr: string; code: number | null }>;

export interface ExternalAgentClientsOptions {
  dataDirectory: string;
  /** How a client starts the launcher; absent without the desktop app. */
  launcher?: ExternalMcpLauncher;
  /** The folder holding the `ohmygame-studio` Skill. */
  skillDirectory: string;
  /** The CLI's executable and the environment to run it in, or undefined when it is not installed. */
  resolve: (
    runtime: AgentRuntimeId,
  ) => Promise<{ path: string; env: Record<string, string> } | undefined>;
  run: RunCli;
  environment?: NodeJS.ProcessEnv;
  home?: string;
}

/**
 * Adds OhMyGame to Claude Code and Codex through their own `mcp` commands,
 * which keep working as the CLIs change their configuration files, and copies
 * the Skill that teaches them the workflow. See docs/external-agents.md.
 */
export class ExternalAgentClients {
  readonly #options: ExternalAgentClientsOptions;
  readonly #file: string;
  #stored: StoredClients = { version: 1, connected: {} };
  #queue: Promise<unknown> = Promise.resolve();

  constructor(options: ExternalAgentClientsOptions) {
    this.#options = options;
    this.#file = path.join(
      options.dataDirectory,
      "external-mcp",
      "clients.json",
    );
  }

  get launcher(): ExternalMcpLauncher | undefined {
    return this.#options.launcher;
  }

  async load(): Promise<void> {
    try {
      const value = JSON.parse(
        await readFile(this.#file, "utf8"),
      ) as Partial<StoredClients>;
      if (
        value.version === 1 &&
        value.connected &&
        typeof value.connected === "object"
      )
        this.#stored = { version: 1, connected: value.connected };
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException).code !== "ENOENT") throw cause;
    }
  }

  /**
   * Keeps connected clients current after an update: the Skill is copied
   * again, and a client connected with another launcher, such as an app that
   * moved, is connected again.
   */
  async refresh(): Promise<void> {
    for (const id of EXTERNAL_AGENT_CLIENT_IDS) {
      const used = this.#stored.connected[id];
      if (!used) continue;
      try {
        if (
          this.#options.launcher &&
          !sameLauncher(used, this.#options.launcher)
        )
          await this.connect(id);
        else await this.#installSkill(id);
      } catch {
        // A CLI that is gone or fails now is left as it was; the person can connect it again.
      }
    }
  }

  async states(): Promise<ExternalAgentClientState[]> {
    return Promise.all(
      EXTERNAL_AGENT_CLIENT_IDS.map(async (id) => ({
        id,
        available: !!(await this.#options.resolve(CLIENT_RUNTIMES[id])),
        connected: !!this.#stored.connected[id],
      })),
    );
  }

  connect(id: ExternalAgentClientId): Promise<void> {
    return this.#serial(async () => {
      const launcher = this.#options.launcher;
      if (!launcher)
        throw new Error("Connecting agents needs the OhMyGame desktop app");
      const cli = await this.#cli(id);
      // Replacing an earlier entry keeps connecting idempotent.
      await this.#options.run(
        cli.path,
        removeArguments(id),
        cli.env,
        undefined,
        CLI_TIMEOUT_MS,
      );
      const added = await this.#options.run(
        cli.path,
        addArguments(id, launcher),
        cli.env,
        undefined,
        CLI_TIMEOUT_MS,
      );
      if (added.code !== 0) throw new Error(failure(id, "add", added));
      await this.#installSkill(id);
      this.#stored.connected[id] = launcher;
      await this.#save();
    });
  }

  disconnect(id: ExternalAgentClientId): Promise<void> {
    return this.#serial(async () => {
      const cli = await this.#options.resolve(CLIENT_RUNTIMES[id]);
      if (cli) {
        const removed = await this.#options.run(
          cli.path,
          removeArguments(id),
          cli.env,
          undefined,
          CLI_TIMEOUT_MS,
        );
        // An entry the person already removed is not an error.
        if (
          removed.code !== 0 &&
          !/not found|no .*server|does not exist/i.test(
            `${removed.stderr}\n${removed.stdout}`,
          )
        )
          throw new Error(failure(id, "remove", removed));
      }
      delete this.#stored.connected[id];
      await this.#removeSkill(id);
      await this.#save();
    });
  }

  #serial<T>(work: () => Promise<T>): Promise<T> {
    const next = this.#queue.then(work, work);
    this.#queue = next.catch(() => {});
    return next;
  }

  async #cli(id: ExternalAgentClientId) {
    const cli = await this.#options.resolve(CLIENT_RUNTIMES[id]);
    if (!cli)
      throw new Error(`${clientName(id)} was not found on this computer`);
    return cli;
  }

  /** Where each client reads user Skills. Codex and DeepSeek Harness share `~/.agents/skills`. */
  #skillFolder(id: ExternalAgentClientId): string {
    const home = this.#options.home ?? os.homedir();
    const environment = this.#options.environment ?? process.env;
    const root =
      id === "claude-code"
        ? path.join(
            environment.CLAUDE_CONFIG_DIR || path.join(home, ".claude"),
            "skills",
          )
        : path.join(home, ".agents", "skills");
    return path.join(root, EXTERNAL_MCP_SERVER_NAME);
  }

  async #installSkill(id: ExternalAgentClientId): Promise<void> {
    const target = this.#skillFolder(id);
    if (!(await ownsSkill(target, true))) return;
    const temporary = `${target}.${process.pid}.tmp`;
    await rm(temporary, { recursive: true, force: true });
    await mkdir(path.dirname(target), { recursive: true });
    await cp(this.#options.skillDirectory, temporary, { recursive: true });
    await rm(target, { recursive: true, force: true });
    await rename(temporary, target);
  }

  async #removeSkill(id: ExternalAgentClientId): Promise<void> {
    const target = this.#skillFolder(id);
    // Another connected client may read the same folder.
    const shared = EXTERNAL_AGENT_CLIENT_IDS.some(
      (other) =>
        other !== id &&
        this.#stored.connected[other] &&
        this.#skillFolder(other) === target,
    );
    if (!shared && (await ownsSkill(target, false)))
      await rm(target, { recursive: true, force: true });
  }

  async #save(): Promise<void> {
    await mkdir(path.dirname(this.#file), { recursive: true, mode: 0o700 });
    const temporary = `${this.#file}.${process.pid}.tmp`;
    await writeFile(temporary, `${JSON.stringify(this.#stored, null, 2)}\n`, {
      mode: 0o600,
    });
    await rename(temporary, this.#file);
  }
}

export function addArguments(
  id: ExternalAgentClientId,
  launcher: ExternalMcpLauncher,
): string[] {
  const env = Object.entries(launcher.env).map(
    ([name, value]) => `${name}=${value}`,
  );
  const command = ["--", launcher.command, ...launcher.args];
  return id === "claude-code"
    ? [
        "mcp",
        "add",
        "--scope",
        "user",
        EXTERNAL_MCP_SERVER_NAME,
        ...env.flatMap((item) => ["-e", item]),
        ...command,
      ]
    : [
        "mcp",
        "add",
        EXTERNAL_MCP_SERVER_NAME,
        ...env.flatMap((item) => ["--env", item]),
        ...command,
      ];
}

export function removeArguments(id: ExternalAgentClientId): string[] {
  return id === "claude-code"
    ? ["mcp", "remove", "--scope", "user", EXTERNAL_MCP_SERVER_NAME]
    : ["mcp", "remove", EXTERNAL_MCP_SERVER_NAME];
}

/** A Skill folder OhMyGame may replace or remove: missing, or one it wrote. */
async function ownsSkill(
  folder: string,
  missingIsOwned: boolean,
): Promise<boolean> {
  const entry = await lstat(folder).catch((cause: NodeJS.ErrnoException) => {
    if (cause.code === "ENOENT") return undefined;
    throw cause;
  });
  if (!entry) return missingIsOwned;
  // Existing folders without our Skill, and links managed by the person, are never replaced.
  if (!entry.isDirectory()) return false;
  try {
    const text = await readFile(path.join(folder, "SKILL.md"), "utf8");
    return new RegExp(`^name:\\s*${EXTERNAL_MCP_SERVER_NAME}\\s*$`, "m").test(
      text,
    );
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw cause;
  }
}

function sameLauncher(a: ExternalMcpLauncher, b: ExternalMcpLauncher): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

function clientName(id: ExternalAgentClientId): string {
  return id === "claude-code" ? "Claude Code" : "Codex";
}

function failure(
  id: ExternalAgentClientId,
  action: "add" | "remove",
  result: { stdout: string; stderr: string; code: number | null },
): string {
  const detail = (result.stderr || result.stdout)
    .trim()
    .split("\n")
    .slice(-3)
    .join(" ");
  return `${clientName(id)} could not ${action} OhMyGame${detail ? `: ${detail}` : ""}`;
}
