import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  constants,
  mkdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentModel } from "../../shared/contracts.js";
import type {
  AgentRuntimeAuthStatus,
  AgentRuntimeBilling,
  AgentRuntimeId,
} from "../../shared/agent-runtimes.js";
import {
  AGENT_RUNTIME_DEFINITIONS,
  parseVersion,
  compareVersions,
} from "./definitions.js";
import {
  agentEnvironment,
  commonBinaryDirectories,
  loginShellPath,
} from "./environment.js";
import { leaseAgentDirectory } from "./process-recovery.js";
import { AgentProcess } from "./process.js";
import { CodexAppServer } from "./codex.js";

const PROBE_TIMEOUT_MS = 15_000;

export interface ResolvedBinary {
  path: string;
  /** Changes when the CLI is updated in place, so a cached probe is not trusted past it. */
  signature: string;
}

/**
 * Finds a CLI's executable: the one the person chose, or else the newest of
 * those on PATH, the login shell's PATH, the usual install folders and the
 * copies other apps bundle. A computer often has several, such as an old
 * global npm install next to the Codex in the ChatGPT app, and the oldest one
 * found first may not know the account's current models. The result is an
 * absolute path that is then always run as is.
 */
export async function resolveBinary(
  id: AgentRuntimeId,
  override?: string,
  recheck = false,
): Promise<ResolvedBinary | undefined> {
  if (recheck)
    for (const key of versionCache.keys())
      if (key.startsWith(`${id}:`)) versionCache.delete(key);
  const definition = AGENT_RUNTIME_DEFINITIONS[id];
  const candidates = override
    ? [override]
    : [
        ...(await searchCandidates(definition.binaries)),
        ...(definition.bundledPaths?.[process.platform] ?? []).map(
          (candidate) =>
            candidate.startsWith("~/")
              ? path.join(os.homedir(), candidate.slice(2))
              : candidate,
        ),
      ];
  const found: ResolvedBinary[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    try {
      await access(
        candidate,
        process.platform === "win32" ? constants.F_OK : constants.X_OK,
      );
      const info = await stat(candidate);
      if (!info.isFile()) continue;
      // One installation is often reachable through several links.
      const target = await realpath(candidate);
      if (seen.has(target)) continue;
      seen.add(target);
      found.push({
        path: candidate,
        signature: `${candidate}:${info.size}:${info.mtimeMs}`,
      });
    } catch {
      continue;
    }
  }
  if (found.length <= 1) return found[0];
  const versions = await Promise.all(
    found.map((binary) => cachedVersion(binary, id)),
  );
  // The newest wins; among equal or unreadable versions, the one found first, as PATH orders them.
  let best = 0;
  for (let index = 1; index < found.length; index++) {
    const version = versions[index];
    const current = versions[best];
    if (version && (!current || compareVersions(version, current) > 0))
      best = index;
  }
  return found[best];
}

const versionCache = new Map<
  string,
  { at: number; promise: Promise<string | undefined> }
>();
const VERSION_TTL_MS = 5 * 60_000;

/** Coalesces concurrent probes; failures are retried on the next check. */
function cachedVersion(
  binary: ResolvedBinary,
  id: AgentRuntimeId,
): Promise<string | undefined> {
  const key = `${id}:${binary.signature}`;
  const cached = versionCache.get(key);
  if (cached && Date.now() - cached.at < VERSION_TTL_MS) return cached.promise;
  const entry = {
    at: Date.now(),
    promise: probeVersion(
      binary.path,
      id,
      agentEnvironment(id, binary.path),
    ).catch(() => undefined),
  };
  versionCache.set(key, entry);
  void entry.promise.then((version) => {
    if (!version && versionCache.get(key) === entry) versionCache.delete(key);
  });
  if (versionCache.size > 128)
    versionCache.delete(versionCache.keys().next().value!);
  return entry.promise;
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
  // Node cannot start a .cmd or .bat script, such as an npm shim, without a
  // shell, and the CLIs' long JSON arguments are not safe to pass through one.
  const extensions = process.platform === "win32" ? [".exe"] : [""];
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
  const { stdout, stderr, code } = await runCli(
    binaryPath,
    AGENT_RUNTIME_DEFINITIONS[id].versionArgs,
    env,
  );
  return code === 0 ? parseVersion(`${stdout}\n${stderr}`) : undefined;
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
    reasoningLevels: [],
    nativeReasoningLevels: [...new Set(levels)],
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
        codexModels(server),
        server
          .request<{ account?: { email?: unknown } | null }>(
            "account/read",
            {},
            PROBE_TIMEOUT_MS,
          )
          .catch(() => undefined),
      ]);
      const models = list
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
  const { stdout, stderr, code } = await runCli(
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
  if (code !== 0)
    throw new Error(
      `OpenCode could not list its models: ${stderr.trim().slice(-500) || `exit ${code}`}`,
    );
  return {
    models: parseOpenCodeModels(stdout).map((entry) => ({
      ...model(entry.id, entry.name, entry.variants),
      ...(entry.contextWindow ? { contextWindow: entry.contextWindow } : {}),
    })),
  };
}

async function codexModels(
  server: CodexAppServer,
): Promise<Array<Record<string, unknown>>> {
  const models: Array<Record<string, unknown>> = [];
  let cursor: string | undefined;
  const seen = new Set<string>();
  do {
    const page = await server.request<{
      data?: Array<Record<string, unknown>>;
      nextCursor?: string | null;
    }>(
      "model/list",
      { ...(cursor ? { cursor } : {}), limit: 100 },
      PROBE_TIMEOUT_MS,
    );
    models.push(...(page.data ?? []));
    cursor =
      typeof page.nextCursor === "string" && page.nextCursor
        ? page.nextCursor
        : undefined;
    if (cursor && seen.has(cursor))
      throw new Error("Codex returned a repeated model catalog cursor");
    if (cursor) seen.add(cursor);
  } while (cursor);
  return models;
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
          if (message.type !== "control_response" || !message.response) return;
          const isInitialize = message.response?.request_id === `init-${id}`;
          if (!isInitialize && message.response?.request_id !== id) return;
          if (message.response.subtype === "error")
            finish(
              new Error(
                message.response.error ??
                  "Claude Code could not list its models",
              ),
            );
          else {
            const models = (message.response?.response?.models ?? []).filter(
              (model) =>
                typeof model.value === "string" &&
                typeof model.displayName === "string",
            );
            // Older CLIs return the catalog during initialize; newer CLIs
            // expose list_models. Neither operation sends a model request.
            if (models.length || !isInitialize) finish(models);
            else
              child.write({
                type: "control_request",
                request_id: id,
                request: { subtype: "list_models" },
              });
          }
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
  });
}

/** `opencode models --verbose` prints each model's `provider/model` line followed by its JSON. */
export function parseOpenCodeModels(output: string): Array<{
  id: string;
  name: string;
  variants: string[];
  contextWindow?: number;
}> {
  const models: Array<{
    id: string;
    name: string;
    variants: string[];
    contextWindow?: number;
  }> = [];
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
        limit?: { context?: number };
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
        ...(typeof value.limit?.context === "number" && value.limit.context > 0
          ? { contextWindow: value.limit.context }
          : {}),
      });
      index = end;
    } catch {
      models.push({ id: line, name: line, variants: [] });
    }
  }
  return models;
}

/** A private folder for one probe or session, removed with it. */
export async function privateFolder(
  root: string,
  name: string,
): Promise<{ path: string; remove: () => Promise<void> }> {
  const folder = path.join(root, `${name}-${randomUUID()}`);
  await mkdir(folder, { recursive: true, mode: 0o700 });
  await leaseAgentDirectory(folder);
  return {
    path: folder,
    remove: () => rm(folder, { recursive: true, force: true }),
  };
}
