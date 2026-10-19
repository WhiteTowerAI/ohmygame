import { createHash } from "node:crypto";
import { mkdir, rm, stat } from "node:fs/promises";
import path from "node:path";
import type { AgentContextUsage } from "../../shared/contracts.js";
import { CodexAppServer } from "./codex-app-server.js";
import { record } from "./driver-context.js";
import { leaseAgentDirectory } from "./process-recovery.js";
import { stageSkills, stagedSkillsRoot } from "./skills.js";

type Limits = NonNullable<AgentContextUsage["limits"]>;

/** What one conversation's driver answers for its own thread on a shared app server. */
export interface CodexThreadHandlers {
  notification(method: string, params: Record<string, unknown>): void;
  request(method: string, params: Record<string, unknown>): Promise<unknown>;
  exit(failure: string): void;
}

export interface CodexServerOptions {
  /** Conversations with the same key share one app server. */
  key: string;
  /** The server's working folder, where Skills are staged; a shared one is removed with the server. */
  directory: string;
  shared: boolean;
  binaryPath: string;
  env: Record<string, string>;
  processDirectory?: string;
  skillDirectories: readonly string[];
}

/** One conversation's use of a pooled app server. */
export interface CodexServerLease {
  readonly server: CodexAppServer;
  /** Where this server's Skills are staged, when it has any. */
  readonly skillsRoot?: string;
  /** Quota windows the account reported when the server started. */
  readonly limits: Limits;
  /** Routes the thread's notifications and requests to this conversation. */
  bind(threadId: string): void;
  release(): Promise<void>;
}

interface Lease {
  handlers: CodexThreadHandlers;
  threads: Set<string>;
}

interface Pooled {
  ready: Promise<{ server: CodexAppServer; skillsRoot?: string }>;
  server?: CodexAppServer;
  leases: Set<Lease>;
  threads: Map<string, Lease>;
  limits: Limits;
}

const pool = new Map<string, Pooled>();
const stopping = new Map<string, Promise<void>>();

/**
 * One Codex app server serves every thread of the conversations that share
 * its executable, environment and staged Skills; the Skill roots are the one
 * server-wide setting. Thread configuration, permission profiles, dynamic
 * tools and turns are all per thread, so routing each message by its thread
 * keeps conversations apart. The server stops with its last conversation.
 */
export async function acquireCodexServer(
  options: CodexServerOptions,
  handlers: CodexThreadHandlers,
  limitsFrom: (value: unknown) => Limits,
): Promise<CodexServerLease> {
  await stopping.get(options.key);
  let pooled = pool.get(options.key);
  if (pooled?.server && !pooled.server.process.running) {
    pool.delete(options.key);
    pooled = undefined;
  }
  if (!pooled) {
    const created = {
      leases: new Set<Lease>(),
      threads: new Map<string, Lease>(),
      limits: [] as Limits,
    } as Pooled;
    created.ready = start(options, created, limitsFrom);
    pool.set(options.key, created);
    created.ready.catch(() => {
      if (pool.get(options.key) === created) pool.delete(options.key);
    });
    pooled = created;
  }
  const lease: Lease = { handlers, threads: new Set() };
  pooled.leases.add(lease);
  let ready: { server: CodexAppServer; skillsRoot?: string };
  try {
    ready = await pooled.ready;
  } catch (cause) {
    pooled.leases.delete(lease);
    throw cause;
  }
  const entry = pooled;
  let released = false;
  return {
    server: ready.server,
    ...(ready.skillsRoot ? { skillsRoot: ready.skillsRoot } : {}),
    get limits() {
      return entry.limits;
    },
    bind(threadId) {
      lease.threads.add(threadId);
      entry.threads.set(threadId, lease);
    },
    async release() {
      if (released) return;
      released = true;
      entry.leases.delete(lease);
      for (const threadId of lease.threads)
        if (entry.threads.get(threadId) === lease)
          entry.threads.delete(threadId);
      if (entry.leases.size || pool.get(options.key) !== entry) return;
      pool.delete(options.key);
      const stop = (async () => {
        await ready.server.stop();
        if (options.shared)
          await rm(options.directory, { recursive: true, force: true });
      })().finally(() => stopping.delete(options.key));
      stopping.set(options.key, stop);
      await stop;
    },
  };
}

async function start(
  options: CodexServerOptions,
  pooled: Pooled,
  limitsFrom: (value: unknown) => Limits,
): Promise<{ server: CodexAppServer; skillsRoot?: string }> {
  await mkdir(options.directory, { recursive: true, mode: 0o700 });
  if (options.shared) await leaseAgentDirectory(options.directory);
  const server = new CodexAppServer(
    options.binaryPath,
    options.directory,
    options.env,
    {
      processDirectory: options.processDirectory,
      notification: (method, params) => {
        if (method === "account/rateLimits/updated")
          pooled.limits = limitsFrom(params);
        const threadId = threadOf(params);
        if (threadId) {
          pooled.threads.get(threadId)?.handlers.notification(method, params);
          return;
        }
        for (const lease of pooled.leases)
          lease.handlers.notification(method, params);
      },
      request: (method, params) => {
        const threadId = threadOf(params);
        const lease = threadId
          ? pooled.threads.get(threadId)
          : pooled.leases.size === 1
            ? [...pooled.leases][0]
            : undefined;
        return lease
          ? lease.handlers.request(method, params)
          : Promise.reject(
              new Error(`No conversation is waiting for ${method}`),
            );
      },
      exit: (failure) => {
        if (pool.get(options.key) === pooled) pool.delete(options.key);
        for (const lease of pooled.leases) lease.handlers.exit(failure);
      },
    },
  );
  pooled.server = server;
  try {
    await server.initialize();
    pooled.limits = await server
      .request("account/rateLimits/read", {}, 5_000)
      .then(limitsFrom)
      .catch(() => []);
    let skillsRoot: string | undefined;
    if (options.skillDirectories.length) {
      const root = stagedSkillsRoot("codex-cli", options.directory);
      if ((await stageSkills(options.skillDirectories, root)).length) {
        skillsRoot = root;
        await server
          .request("skills/extraRoots/set", { extraRoots: [root] })
          .catch(() => {});
      }
    }
    return { server, ...(skillsRoot ? { skillsRoot } : {}) };
  } catch (cause) {
    await server.stop();
    throw cause;
  }
}

function threadOf(params: Record<string, unknown>): string | undefined {
  for (const value of [
    params.threadId,
    record(params.thread)?.id,
    // Legacy approval requests name the thread as the conversation.
    params.conversationId,
  ])
    if (typeof value === "string" && value) return value;
  return undefined;
}

/**
 * Which pooled server a Codex conversation uses and where it keeps its
 * staged Skills. Conversations differ in workspace, model and permissions,
 * all per thread; what must match is the executable, its environment and the
 * Skills, whose content is part of the key so an updated plugin starts fresh.
 */
export async function codexServerIdentity(
  root: string,
  binaryPath: string,
  env: Record<string, string>,
  skillDirectories: readonly string[],
): Promise<{ key: string; directory: string }> {
  const skills = await Promise.all(
    skillDirectories.map(async (directory) => {
      const info = await stat(path.join(directory, "SKILL.md")).catch(
        () => undefined,
      );
      return [directory, info?.mtimeMs ?? 0, info?.size ?? 0];
    }),
  );
  const key = createHash("sha256")
    .update(JSON.stringify([binaryPath, env, skills]))
    .digest("hex")
    .slice(0, 24);
  return {
    key,
    directory: path.join(root, "sessions", `codex-shared-${key}`),
  };
}
