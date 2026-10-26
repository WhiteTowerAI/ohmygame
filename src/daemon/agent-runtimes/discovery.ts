import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import {
  access,
  constants,
  mkdir,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import type { AgentModel, AgentUsageLimit } from "../../shared/contracts.js";
import type {
  AgentRuntimeAuthStatus,
  AgentRuntimeBilling,
  AgentRuntimeBinarySource,
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
import {
  CodexAppServer,
  codexLimits,
  checkCodexCompatibility,
} from "./codex-app-server.js";
import {
  AgentRuntimeCompatibilityError,
  cliProbeError,
} from "./compatibility.js";
import { OpenCodeDriver } from "./opencode.js";

const PROBE_TIMEOUT_MS = 15_000;

export interface ResolvedBinary {
  path: string;
  source: AgentRuntimeBinarySource;
  /** Changes when the CLI is updated in place, so a cached probe is not trusted past it. */
  signature: string;
}

/** Only these Windows npm shims can be resolved without executing a script. */
export function isCodexNpmShim(binaryPath: string): boolean {
  return (
    process.platform === "win32" &&
    /^codex\.(?:cmd|ps1)$/i.test(path.basename(binaryPath))
  );
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
  if (
    override &&
    /\.(?:cmd|bat|ps1)$/i.test(override) &&
    !(id === "codex-cli" && isCodexNpmShim(override))
  )
    return undefined;
  if (recheck) await loginShellPath(true);
  if (recheck)
    for (const key of versionCache.keys())
      if (key.startsWith(`${id}:`)) versionCache.delete(key);
  const definition = AGENT_RUNTIME_DEFINITIONS[id];
  const candidates = override
    ? [{ path: override, source: "manual" as const }]
    : [
        ...(await searchCandidates(definition.binaries)),
        ...(definition.bundledPaths?.[process.platform] ?? []).map(
          (candidate) => ({
            ...candidate,
            path: candidate.path.startsWith("~/")
              ? path.join(os.homedir(), candidate.path.slice(2))
              : candidate.path,
          }),
        ),
      ];
  // npm exposes a shell shim on Windows, but ships the native CLI inside the
  // package. Resolve that known layout without running the shim through cmd.
  if (id === "codex-cli" && process.platform === "win32") {
    if (override && isCodexNpmShim(override)) {
      if (!(await stat(override).catch(() => undefined))?.isFile())
        return undefined;
      candidates.splice(
        0,
        candidates.length,
        ...windowsNpmCodexCandidates(path.dirname(override), "manual"),
      );
    } else if (!override) {
      const directories = new Map(
        candidates.map((candidate) => [
          path.dirname(candidate.path),
          candidate.source,
        ]),
      );
      for (const [directory, source] of directories)
        candidates.push(...windowsNpmCodexCandidates(directory, source));
      const local = process.env.LOCALAPPDATA;
      if (local) {
        const bin = path.join(local, "OpenAI", "Codex", "bin");
        const entries = await readdir(bin, { withFileTypes: true }).catch(
          () => [],
        );
        for (const entry of entries)
          if (entry.isDirectory())
            candidates.push({
              path: path.join(bin, entry.name, "codex.exe"),
              source: "codex-app",
            });
      }
    }
  }
  const found: ResolvedBinary[] = [];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    try {
      await access(
        candidate.path,
        process.platform === "win32" ? constants.F_OK : constants.X_OK,
      );
      const info = await stat(candidate.path);
      if (!info.isFile()) continue;
      // One installation is often reachable through several links.
      const target = await realpath(candidate.path);
      if (seen.has(target)) continue;
      seen.add(target);
      found.push({
        ...candidate,
        signature: `${candidate.path}:${info.size}:${info.mtimeMs}`,
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

function windowsNpmCodexCandidates(
  directory: string,
  source: AgentRuntimeBinarySource,
): Array<{ path: string; source: AgentRuntimeBinarySource }> {
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  const target = `${arch === "arm64" ? "aarch64" : "x86_64"}-pc-windows-msvc`;
  const root = path.join(directory, "node_modules", "@openai", "codex");
  const platformPackage = `codex-win32-${arch}`;
  // npm may nest or hoist the optional platform package. Older releases kept
  // vendor/ in the main package and used codex/ instead of bin/.
  return [
    path.join(root, "node_modules", "@openai", platformPackage),
    path.join(directory, "node_modules", "@openai", platformPackage),
    root,
  ].flatMap((packageRoot) =>
    ["bin", "codex"].map((folder) => ({
      path: path.join(packageRoot, "vendor", target, folder, "codex.exe"),
      source,
    })),
  );
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

async function searchCandidates(
  names: readonly string[],
): Promise<Array<{ path: string; source: AgentRuntimeBinarySource }>> {
  const shell = await loginShellPath();
  const directories = new Map<string, AgentRuntimeBinarySource>();
  for (const [folders, source] of [
    [(process.env.PATH ?? "").split(path.delimiter), "path"],
    [(shell ?? "").split(path.delimiter), "login-shell"],
    [commonBinaryDirectories(), "common-directory"],
  ] as const)
    for (const folder of folders)
      if (folder && !directories.has(folder)) directories.set(folder, source);
  // Node cannot start a .cmd or .bat script, such as an npm shim, without a
  // shell, and the CLIs' long JSON arguments are not safe to pass through one.
  const extensions = process.platform === "win32" ? [".exe"] : [""];
  return [...directories].flatMap(([directory, source]) =>
    names.flatMap((name) =>
      extensions.map((extension) => ({
        path: path.join(directory, `${name}${extension}`),
        source,
      })),
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
): Promise<{
  models: AgentModel[];
  account?: string;
  limits?: AgentUsageLimit[];
}> {
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
      await server.initialize(PROBE_TIMEOUT_MS);
      await checkCodexCompatibility(server, privateDirectory, PROBE_TIMEOUT_MS);
      const [list, account, limits] = await Promise.all([
        codexModels(server),
        server
          .request<{ account?: { email?: unknown } | null }>(
            "account/read",
            { refreshToken: false },
            PROBE_TIMEOUT_MS,
          )
          .catch(() => undefined),
        server
          .request("account/rateLimits/read", {}, PROBE_TIMEOUT_MS)
          .then(codexLimits)
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
        ...(limits?.length ? { limits } : {}),
      };
    } catch (cause) {
      if (cause instanceof AgentRuntimeCompatibilityError) throw cause;
      throw cliProbeError(
        "Codex",
        cause instanceof Error ? cause.message : String(cause),
      );
    } finally {
      await server.stop();
    }
  }
  const output = await OpenCodeDriver.discover({
    binaryPath,
    env,
    privateDirectory,
  });
  return {
    models: parseOpenCodeModels(output).map((entry) => ({
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
              cliProbeError(
                "Claude Code",
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
          cliProbeError(
            "Claude Code",
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
      request: {
        subtype: "initialize",
        sdkMcpServers: ["ohmygame"],
        hooks: { PreToolUse: [{ hookCallbackIds: ["ohmygame-policy"] }] },
      },
    });
  });
}

/** OpenCode v2's structured /api/model catalog. */
export function parseOpenCodeModels(output: unknown): Array<{
  id: string;
  name: string;
  variants: string[];
  contextWindow?: number;
}> {
  if (!Array.isArray(output))
    throw new Error("OpenCode did not return a readable model catalog");
  return output.flatMap((value) => {
    if (!value || typeof value !== "object") return [];
    const item = value as Record<string, unknown>;
    const capabilities = item.capabilities as { tools?: unknown } | undefined;
    if (
      typeof item.id !== "string" ||
      typeof item.providerID !== "string" ||
      item.enabled !== true ||
      capabilities?.tools !== true ||
      item.status === "deprecated"
    )
      return [];
    const context = (item.limit as { context?: unknown } | undefined)?.context;
    return [
      {
        id: `${item.providerID}/${item.id}`,
        name: typeof item.name === "string" ? item.name : item.id,
        variants: Array.isArray(item.variants)
          ? item.variants.flatMap((v) =>
              v && typeof v === "object" && typeof v.id === "string"
                ? [v.id]
                : [],
            )
          : [],
        ...(typeof context === "number" && context > 0
          ? { contextWindow: context }
          : {}),
      },
    ];
  });
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
