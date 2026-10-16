import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  constants,
  mkdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import {
  AGENT_REASONING_LEVELS,
  type AgentModel,
  type AgentReasoningLevel,
} from "../../shared/contracts.js";
import type {
  AgentRuntimeAuthStatus,
  AgentRuntimeBilling,
  AgentRuntimeId,
} from "../../shared/agent-runtimes.js";
import { AGENT_RUNTIME_DEFINITIONS, parseVersion } from "./definitions.js";
import { commonBinaryDirectories, loginShellPath } from "./environment.js";
import { AgentProcess } from "./process.js";
import { CodexAppServer } from "./codex.js";

const PROBE_TIMEOUT_MS = 15_000;

export interface ResolvedBinary {
  path: string;
  /** Changes when the CLI is updated in place, so a cached probe is not trusted past it. */
  signature: string;
}

/**
 * Finds a CLI's executable: the one the person chose, or the first on PATH,
 * the login shell's PATH and the usual install folders. The result is an
 * absolute path that is then always run as is.
 */
export async function resolveBinary(
  id: AgentRuntimeId,
  override?: string,
): Promise<ResolvedBinary | undefined> {
  const candidates = override
    ? [override]
    : await searchCandidates(AGENT_RUNTIME_DEFINITIONS[id].binaries);
  for (const candidate of candidates) {
    try {
      await access(
        candidate,
        process.platform === "win32" ? constants.F_OK : constants.X_OK,
      );
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      return {
        path: candidate,
        signature: `${candidate}:${info.size}:${info.mtimeMs}`,
      };
    } catch {
      continue;
    }
  }
  return undefined;
}

async function searchCandidates(names: readonly string[]): Promise<string[]> {
  const shell = await loginShellPath();
  const directories = [
    ...new Set(
      [
        ...(process.env.PATH ?? "").split(path.delimiter),
        ...(shell ?? "").split(path.delimiter),
        ...commonBinaryDirectories(),
      ].filter(Boolean),
    ),
  ];
  const extensions =
    process.platform === "win32" ? [".exe", ".cmd", ".bat", ""] : [""];
  return directories.flatMap((directory) =>
    names.flatMap((name) =>
      extensions.map((extension) =>
        path.join(directory, `${name}${extension}`),
      ),
    ),
  );
}

export function runCli(
  binaryPath: string,
  args: readonly string[],
  env: Record<string, string>,
  cwd?: string,
  timeout = PROBE_TIMEOUT_MS,
): Promise<{ stdout: string; stderr: string; code: number | null }> {
  return new Promise((resolve) => {
    execFile(
      binaryPath,
      [...args],
      {
        env,
        timeout,
        maxBuffer: 16 * 1024 * 1024,
        windowsHide: true,
        encoding: "utf8",
        ...(cwd ? { cwd } : {}),
      },
      (error, stdout, stderr) => {
        const code = error
          ? typeof (error as NodeJS.ErrnoException & { code?: unknown })
              .code === "number"
            ? (error as unknown as { code: number }).code
            : 1
          : 0;
        resolve({ stdout: stdout ?? "", stderr: stderr ?? "", code });
      },
    );
  });
}

export async function probeVersion(
  binaryPath: string,
  id: AgentRuntimeId,
  env: Record<string, string>,
): Promise<string | undefined> {
  const { stdout, stderr } = await runCli(
    binaryPath,
    AGENT_RUNTIME_DEFINITIONS[id].versionArgs,
    env,
  );
  return parseVersion(`${stdout}\n${stderr}`);
}

export interface AuthProbe {
  status: AgentRuntimeAuthStatus;
  account?: string;
  billing: AgentRuntimeBilling;
}

/** Asks the CLI who it is signed in as. OhMyGame never reads a CLI's credential files. */
export async function probeAuth(
  binaryPath: string,
  id: AgentRuntimeId,
  env: Record<string, string>,
): Promise<AuthProbe> {
  if (id === "claude-code-cli") {
    const { stdout } = await runCli(binaryPath, ["auth", "status"], env);
    try {
      const status = JSON.parse(stdout) as {
        loggedIn?: unknown;
        authMethod?: unknown;
        email?: unknown;
        apiProvider?: unknown;
      };
      if (status.loggedIn !== true)
        return { status: "signed-out", billing: "unknown" };
      const billing: AgentRuntimeBilling =
        status.apiProvider && status.apiProvider !== "firstParty"
          ? "provider"
          : status.authMethod === "claude.ai" ||
              status.authMethod === "oauth_token"
            ? "subscription"
            : "api-key";
      return {
        status: "signed-in",
        billing,
        ...(typeof status.email === "string" ? { account: status.email } : {}),
      };
    } catch {
      return { status: "unknown", billing: "unknown" };
    }
  }
  if (id === "codex-cli") {
    const { stdout, stderr } = await runCli(
      binaryPath,
      ["login", "status"],
      env,
    );
    const text = `${stdout}\n${stderr}`;
    if (/not logged in/i.test(text))
      return { status: "signed-out", billing: "unknown" };
    if (/logged in using chatgpt/i.test(text))
      return { status: "signed-in", billing: "subscription" };
    if (/logged in using an api key/i.test(text))
      return { status: "signed-in", billing: "api-key" };
    return { status: "unknown", billing: "unknown" };
  }
  // OpenCode signs in per model provider; the model a conversation picks says who bills it.
  return { status: "unknown", billing: "provider" };
}

/** The models a CLI offers, as OhMyGame's model picker lists them. */
export async function probeModels(
  binaryPath: string,
  id: AgentRuntimeId,
  env: Record<string, string>,
  privateDirectory: string,
  isolate: boolean,
): Promise<{ models: AgentModel[]; account?: string }> {
  const name = AGENT_RUNTIME_DEFINITIONS[id].name;
  const model = (
    modelId: string,
    label: string,
    levels: readonly string[],
  ): AgentModel => ({
    provider: id,
    id: modelId,
    name: label,
    providerName: name,
    reasoningLevels: reasoningLevels(levels),
    runtime: id,
  });
  if (id === "claude-code-cli") {
    const listed = await claudeModels(binaryPath, env, privateDirectory);
    return {
      models: listed.map((entry) =>
        model(
          entry.value,
          entry.displayName,
          entry.supportsEffort ? (entry.supportedEffortLevels ?? []) : [],
        ),
      ),
    };
  }
  if (id === "codex-cli") {
    const server = new CodexAppServer(binaryPath, privateDirectory, env);
    try {
      await server.initialize();
      const [list, account] = await Promise.all([
        server.request<{ data?: Array<Record<string, unknown>> }>(
          "model/list",
          {},
          PROBE_TIMEOUT_MS,
        ),
        server
          .request<{ account?: { email?: unknown } | null }>(
            "account/read",
            {},
            PROBE_TIMEOUT_MS,
          )
          .catch(() => undefined),
      ]);
      const models = (list.data ?? [])
        .filter(
          (entry) => entry.hidden !== true && typeof entry.id === "string",
        )
        .map((entry) =>
          model(
            String(entry.id),
            typeof entry.displayName === "string"
              ? entry.displayName
              : String(entry.id),
            Array.isArray(entry.supportedReasoningEfforts)
              ? entry.supportedReasoningEfforts.map((effort) =>
                  String(
                    (effort as { reasoningEffort?: unknown }).reasoningEffort,
                  ),
                )
              : [],
          ),
        );
      return {
        models,
        ...(typeof account?.account?.email === "string"
          ? { account: account.account.email }
          : {}),
      };
    } finally {
      await server.stop();
    }
  }
  const configHome = path.join(privateDirectory, "opencode-config");
  await mkdir(path.join(configHome, "opencode"), {
    recursive: true,
    mode: 0o700,
  });
  await writeFile(path.join(configHome, "opencode", "opencode.json"), "{}\n", {
    mode: 0o600,
  });
  const { stdout } = await runCli(
    binaryPath,
    ["models", "--verbose", ...(isolate ? ["--pure"] : [])],
    {
      ...env,
      OPENCODE_DISABLE_AUTOUPDATE: "1",
      ...(isolate
        ? { XDG_CONFIG_HOME: configHome, OPENCODE_DISABLE_PROJECT_CONFIG: "1" }
        : {}),
    },
    privateDirectory,
    60_000,
  );
  return {
    models: parseOpenCodeModels(stdout).map((entry) =>
      model(entry.id, entry.name, entry.variants),
    ),
  };
}

interface ClaudeModel {
  value: string;
  displayName: string;
  supportsEffort?: boolean;
  supportedEffortLevels?: string[];
}

/** Claude Code lists its models over its control protocol, without a model request. */
async function claudeModels(
  binaryPath: string,
  env: Record<string, string>,
  cwd: string,
): Promise<ClaudeModel[]> {
  return new Promise((resolve, reject) => {
    const id = `models-${randomUUID()}`;
    let settled = false;
    const finish = (result: ClaudeModel[] | Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      void child.stop();
      if (result instanceof Error) reject(result);
      else resolve(result);
    };
    const child = new AgentProcess({
      binaryPath,
      args: [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--verbose",
        "--setting-sources",
        "",
        "--strict-mcp-config",
        "--permission-prompt-tool",
        "stdio",
      ],
      cwd,
      env,
      onLine: (line) => {
        try {
          const message = JSON.parse(line) as {
            type?: string;
            response?: {
              request_id?: string;
              subtype?: string;
              response?: { models?: ClaudeModel[] };
              error?: string;
            };
          };
          if (
            message.type !== "control_response" ||
            message.response?.request_id !== id
          )
            return;
          if (message.response.subtype === "error")
            finish(
              new Error(
                message.response.error ??
                  "Claude Code could not list its models",
              ),
            );
          else
            finish(
              (message.response.response?.models ?? []).filter(
                (model) =>
                  typeof model.value === "string" &&
                  typeof model.displayName === "string",
              ),
            );
        } catch {
          /* Not a message. */
        }
      },
      onExit: (_code, _signal, stderr) =>
        finish(
          new Error(
            stderr.trim().split("\n").at(-1) ||
              "Claude Code exited before listing its models",
          ),
        ),
    });
    const timer = setTimeout(
      () => finish(new Error("Claude Code did not list its models in time")),
      PROBE_TIMEOUT_MS,
    );
    child.write({
      type: "control_request",
      request_id: `init-${id}`,
      request: { subtype: "initialize" },
    });
    child.write({
      type: "control_request",
      request_id: id,
      request: { subtype: "list_models" },
    });
  });
}

/** `opencode models --verbose` prints each model's `provider/model` line followed by its JSON. */
export function parseOpenCodeModels(
  output: string,
): Array<{ id: string; name: string; variants: string[] }> {
  const models: Array<{ id: string; name: string; variants: string[] }> = [];
  const lines = output.split("\n");
  for (let index = 0; index < lines.length; index++) {
    const line = lines[index]!.trim();
    if (!/^[\w.@-]+\/\S+$/.test(line)) continue;
    let end = index + 1;
    let depth = 0;
    let json = "";
    for (; end < lines.length; end++) {
      const current = lines[end]!;
      json += `${current}\n`;
      depth +=
        (current.match(/{/g)?.length ?? 0) - (current.match(/}/g)?.length ?? 0);
      if (depth <= 0 && json.trim()) break;
    }
    try {
      const value = JSON.parse(json) as {
        name?: unknown;
        capabilities?: { toolcall?: unknown };
        variants?: Record<string, unknown>;
        status?: unknown;
      };
      // An agent needs tools; a model that cannot call them cannot do the work.
      if (
        value.capabilities?.toolcall === false ||
        value.status === "deprecated"
      )
        continue;
      models.push({
        id: line,
        name: typeof value.name === "string" ? value.name : line,
        variants: Object.keys(value.variants ?? {}),
      });
      index = end;
    } catch {
      models.push({ id: line, name: line, variants: [] });
    }
  }
  return models;
}

function reasoningLevels(values: readonly string[]): AgentReasoningLevel[] {
  const allowed = new Set<string>(AGENT_REASONING_LEVELS);
  return AGENT_REASONING_LEVELS.filter(
    (level) => values.includes(level) && allowed.has(level),
  );
}

/** A private folder for one probe or session, removed with it. */
export async function privateFolder(
  root: string,
  name: string,
): Promise<{ path: string; remove: () => Promise<void> }> {
  const folder = path.join(root, `${name}-${randomUUID()}`);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  return {
    path: folder,
    remove: () => rm(folder, { recursive: true, force: true }),
  };
}
