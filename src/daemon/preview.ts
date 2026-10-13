import { spawn, type ChildProcess } from "node:child_process";
import { watch, type FSWatcher } from "node:fs";
import { mkdir, readFile, realpath, writeFile } from "node:fs/promises";
import { createServer } from "node:net";
import path from "node:path";
import type { ProjectState } from "../shared/contracts.js";
import type { RuntimeEventBus } from "../shared/events.js";
import { supportsWebPreview } from "../shared/project-runtime.js";
import {
  packageManagerRunArguments,
  resolvePackageManager,
  resolvePackageManagerExecutable,
  packageManagerSpawnCommand,
} from "./package-manager.js";
import { ensureProjectDependencies } from "./project-dependencies.js";
import { projectProcessEnvironment } from "./project-process.js";
import { ProjectWorkspaceError, resolvePreviewWorkspace } from "./projects.js";
import {
  registerProjectProcess,
  terminateProjectProcess,
} from "./process-lifecycle.js";
import { createPreviewProxy, type PreviewProxy } from "./preview-proxy.js";
import {
  previewDependencyDirectory,
  previewScriptArguments,
} from "./preview-launch.js";
import { startStaticPreview } from "./preview-static.js";

interface PreviewOptions {
  readinessTimeoutMs?: number;
  installTimeoutMs?: number;
  idleTimeoutMs?: number;
  leaseTimeoutMs?: number;
}
interface PreviewSession {
  project: ProjectState;
  paused: boolean;
  dirty: boolean;
  leases: Map<string, number>;
  idleSince?: number;
  watcher?: FSWatcher;
  changeTimer?: ReturnType<typeof setTimeout>;
  logTimer?: ReturnType<typeof setTimeout>;
  revision: number;
}
interface PreviewOperation {
  automatic: boolean;
}
const MAX_ERROR_OUTPUT = 8 * 1024;

export class PreviewCancelledError extends Error {
  constructor() {
    super("Preview start superseded or cancelled");
  }
}

export class PreviewManager {
  readonly #running = new Map<string, ChildProcess>();
  readonly #proxies = new Map<string, PreviewProxy>();
  readonly #static = new Map<string, { close(): Promise<void> }>();
  readonly #children = new Map<string, Set<ChildProcess>>();
  readonly #operations = new Map<string, PreviewOperation>();
  readonly #starting = new Map<string, Promise<string>>();
  readonly #stopping = new Map<string, Promise<void>>();
  readonly #sessions = new Map<string, PreviewSession>();
  readonly #timer: ReturnType<typeof setInterval>;
  readonly #readinessTimeoutMs: number;

  constructor(
    private readonly events: RuntimeEventBus,
    private readonly options: PreviewOptions = {},
  ) {
    this.#readinessTimeoutMs = options.readinessTimeoutMs ?? 30_000;
    this.#timer = setInterval(() => {
      void this.collectIdle().catch(() => {});
    }, 10_000);
    this.#timer.unref?.();
  }

  #session(project: ProjectState): PreviewSession {
    let session = this.#sessions.get(project.id);
    if (!session) {
      session = {
        project,
        paused: false,
        dirty: false,
        leases: new Map(),
        revision: 0,
      };
      this.#sessions.set(project.id, session);
    }
    return session;
  }

  /** Editor leases also observe files so manually created projects become previewable. */
  acquire(
    project: ProjectState,
    id: string,
    automatic = false,
    paused = false,
  ): void {
    const session = this.#session(project);
    const first = !session.leases.has(id);
    session.leases.set(
      id,
      Date.now() + (this.options.leaseTimeoutMs ?? 75_000),
    );
    session.idleSince = undefined;
    if (paused && first) {
      session.paused = true;
      if (project.preview.status === "stopped")
        this.#update(project, { stopReason: "recovery" });
    }
    if (!session.watcher && supportsWebPreview(project)) this.#watch(session);
    if (first && automatic) void this.automatic(project).catch(() => {});
  }

  release(project: ProjectState, id: string): void {
    const session = this.#sessions.get(project.id);
    if (!session) return;
    session.leases.delete(id);
    if (!session.leases.size) {
      session.idleSince ??= Date.now();
      this.#unwatch(session);
    }
  }

  touch(project: ProjectState, id: string, active = true): void {
    const session = this.#session(project);
    if (active) {
      session.leases.set(
        id,
        Date.now() + (this.options.leaseTimeoutMs ?? 75_000),
      );
      session.idleSince = undefined;
      if (!session.watcher && supportsWebPreview(project)) this.#watch(session);
    } else this.release(project, id);
  }

  async collectIdle(now = Date.now()): Promise<void> {
    for (const session of this.#sessions.values()) {
      for (const [id, expires] of session.leases)
        if (expires <= now) session.leases.delete(id);
      if (session.leases.size) continue;
      this.#unwatch(session);
      session.idleSince ??= now;
      const timeout =
        this.options.idleTimeoutMs ??
        (session.project.previewIdleMinutes ?? 5) * 60_000;
      if (
        timeout > 0 &&
        now - session.idleSince >= timeout &&
        ["ready", "starting"].includes(session.project.preview.status)
      )
        await this.stop(session.project, "idle");
    }
  }

  async automatic(project: ProjectState, changedOnly = false): Promise<void> {
    const session = this.#session(project);
    if (
      !this.#automaticAllowed(session) ||
      this.#starting.has(project.id) ||
      (changedOnly && !session.dirty)
    )
      return;
    if (
      !this.#stopping.has(project.id) &&
      ["ready", "starting"].includes(project.preview.status)
    )
      return;
    if (project.preview.status === "error" && !session.dirty) return;
    session.dirty = false;
    // Inspection and launch share one operation, so stopping cancels both.
    await this.#beginStart(project, false, true).catch(() => {});
  }

  #automaticAllowed(session: PreviewSession): boolean {
    return (
      this.#sessions.get(session.project.id) === session &&
      supportsWebPreview(session.project) &&
      session.project.previewAutoStart !== false &&
      !session.paused &&
      session.leases.size > 0
    );
  }

  ensureStarted(project: ProjectState, manual = true): Promise<string> {
    if (!supportsWebPreview(project))
      return Promise.reject(
        new ProjectWorkspaceError(
          "Enable Web preview in project settings first.",
        ),
      );
    if (manual) {
      this.#session(project).paused = false;
      // Play resumes an existing automatic launch as an explicit user request.
      const operation = this.#operations.get(project.id);
      if (operation) operation.automatic = false;
    }
    const starting = this.#starting.get(project.id);
    if (starting) return starting;
    if (
      !this.#stopping.has(project.id) &&
      project.preview.status === "ready" &&
      project.preview.url
    )
      return Promise.resolve(project.preview.url);
    return this.start(project, false, manual);
  }

  start(
    project: ProjectState,
    reinstall = false,
    manual = true,
  ): Promise<string> {
    if (manual) this.#session(project).paused = false;
    return this.#beginStart(project, reinstall);
  }

  #beginStart(
    project: ProjectState,
    reinstall: boolean,
    automatic = false,
  ): Promise<string> {
    const starting = this.#start(project, reinstall, automatic);
    this.#starting.set(project.id, starting);
    const forget = () => {
      if (this.#starting.get(project.id) === starting)
        this.#starting.delete(project.id);
    };
    void starting.then(forget, forget);
    return starting;
  }

  async #start(
    project: ProjectState,
    reinstall: boolean,
    automatic: boolean,
  ): Promise<string> {
    if (!supportsWebPreview(project))
      throw new ProjectWorkspaceError(
        "Enable Web preview in project settings first.",
      );
    const session = this.#session(project);
    const operation: PreviewOperation = { automatic };
    this.#operations.set(project.id, operation);
    const assertCurrent = () => {
      this.#assertCurrent(project.id, operation);
      if (operation.automatic && !this.#automaticAllowed(session))
        throw new PreviewCancelledError();
    };
    let child: ChildProcess | undefined;
    let began = false;
    try {
      const workspace = await resolvePreviewWorkspace(project);
      assertCurrent();
      if (!workspace.runnable)
        throw new ProjectWorkspaceError(
          workspace.error ?? "Workspace is not runnable yet",
        );
      await this.#stopping.get(project.id);
      assertCurrent();
      began = true;
      project.preview = {
        status: "starting",
        phase: "checking",
        startedAt: new Date().toISOString(),
        directory: workspace.relativePath,
        logs: "",
      };
      this.#publish(project);
      assertCurrent();
      await this.#terminateProject(project.id);
      assertCurrent();
      const port = await availablePort(project.previewPort);
      assertCurrent();
      const environment = {
        ...projectProcessEnvironment(),
        BROWSER: "none",
        HOST: "127.0.0.1",
        PORT: String(port),
      };
      let processError: Error | undefined;
      let output = () => "";
      const log = (value: string) => {
        if (
          this.#operations.get(project.id) !== operation &&
          (!child || this.#running.get(project.id) !== child)
        )
          return;
        project.preview.logs = `${project.preview.logs ?? ""}${value}`
          .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
          .slice(-MAX_ERROR_OUTPUT);
        session.logTimer ??= setTimeout(() => {
          session.logTimer = undefined;
          if (
            this.#operations.get(project.id) === operation ||
            (child && this.#running.get(project.id) === child)
          )
            this.#publish(project);
        }, 250);
        session.logTimer.unref?.();
      };
      if (workspace.mode === "static") {
        this.#update(project, {
          phase: "launching",
          command: "Serve static files",
        });
        assertCurrent();
        const server = await startStaticPreview(workspace.absolutePath, port);
        try {
          assertCurrent();
        } catch (cause) {
          await server.close();
          throw cause;
        }
        this.#static.set(project.id, server);
      } else {
        let command: string;
        let args: string[];
        let custom = false;
        if (workspace.mode === "command") {
          command = project
            .previewCommand!.replaceAll("{port}", String(port))
            .replaceAll("{host}", "127.0.0.1");
          args = [];
          custom = true;
          this.#update(project, { command, phase: "launching" });
        } else {
          const root = await realpath(project.workspacePath);
          assertCurrent();
          const dependencies = await previewDependencyDirectory(
            root,
            workspace.absolutePath,
          );
          assertCurrent();
          const { manager, source } = await resolvePackageManager(
            dependencies,
            project.packageManager,
          );
          assertCurrent();
          const manifest = JSON.parse(
            await readFile(
              path.join(workspace.absolutePath, "package.json"),
              "utf8",
            ),
          );
          assertCurrent();
          this.#update(project, { manager, managerSource: source });
          command = await resolvePackageManagerExecutable(manager, environment);
          assertCurrent();
          await ensureProjectDependencies(
            dependencies,
            manager,
            (_command, installArgs) => {
              assertCurrent();
              this.#update(project, {
                phase: "installing",
                command: `${manager} ${installArgs.join(" ")}`,
              });
              assertCurrent();
              return this.#run(
                project.id,
                command,
                installArgs,
                dependencies,
                log,
              );
            },
            reinstall,
            assertCurrent,
          );
          assertCurrent();
          args = packageManagerRunArguments(
            project.startupScript ?? "dev",
            previewScriptArguments(
              manifest.scripts[project.startupScript ?? "dev"],
              port,
              project.previewArguments,
            ),
          );
          this.#update(project, {
            phase: "launching",
            command: `${manager} ${args.join(" ")}`,
          });
        }
        assertCurrent();
        child = spawn(
          custom ? command : packageManagerSpawnCommand(command),
          args,
          {
            cwd: workspace.absolutePath,
            env: environment,
            stdio: ["ignore", "pipe", "pipe"],
            detached: process.platform !== "win32",
            shell: custom || process.platform === "win32",
            windowsHide: true,
          },
        );
        this.#track(project.id, child);
        this.#running.set(project.id, child);
        output = captureOutput([child.stdout, child.stderr], log);
        const currentChild = child;
        const failed = (error: string) => {
          if (
            this.#running.get(project.id) !== currentChild ||
            project.preview.status !== "ready"
          )
            return;
          session.dirty = false;
          project.preview = { ...project.preview, status: "error", error };
          this.#publish(project);
          void this.#terminateProject(project.id).catch(() => {});
        };
        child.on("error", (cause) => {
          processError = cause;
          failed(
            withOutput(`Preview could not run: ${cause.message}`, output()),
          );
        });
        child.once("exit", (code, signal) =>
          failed(
            withOutput(
              `Preview exited (${signal ?? code ?? "unknown"})`,
              output(),
            ),
          ),
        );
        this.#update(project, { phase: "connecting" });
        await waitUntilReady(
          `http://127.0.0.1:${port}`,
          child,
          this.#readinessTimeoutMs,
          output,
          () => processError,
          assertCurrent,
        );
      }
      const preferredPort = await this.#savedProxyPort(project);
      assertCurrent();
      let proxyHandle: PreviewProxy | undefined;
      const proxy = await createPreviewProxy(
        `http://127.0.0.1:${port}`,
        (diagnostic, diagnostics) => {
          if (
            !proxyHandle ||
            this.#proxies.get(project.id) !== proxyHandle ||
            project.preview.status !== "ready"
          )
            return;
          if (
            JSON.stringify(
              project.preview.diagnostics ?? project.preview.diagnostic,
            ) === JSON.stringify(diagnostics ?? diagnostic)
          )
            return;
          this.#update(project, { diagnostic, diagnostics });
        },
        {
          port: preferredPort,
          onActivity: (id, active) => {
            if (proxyHandle && this.#proxies.get(project.id) === proxyHandle)
              this.touch(project, `page:${id}`, active);
          },
          onNavigation: (client, source, pathname) => {
            if (
              !proxyHandle ||
              this.#proxies.get(project.id) !== proxyHandle ||
              project.preview.status !== "ready"
            )
              return;
            const pages = project.preview.pages ?? [];
            if (
              pages.some(
                (page) => page.client === client && page.path === pathname,
              )
            )
              return;
            this.#update(project, {
              pages: [
                ...pages.filter((page) => page.client !== client),
                { client, source, path: pathname },
              ].slice(-32),
            });
          },
        },
      );
      try {
        assertCurrent();
      } catch (cause) {
        await proxy.close();
        throw cause;
      }
      proxyHandle = proxy;
      this.#proxies.set(project.id, proxy);
      await this.#saveProxyPort(project, Number(new URL(proxy.url).port));
      assertCurrent();
      if (
        child &&
        (processError || child.exitCode !== null || child.signalCode !== null)
      )
        throw (
          processError ??
          new Error(withOutput("Preview exited before ready", output()))
        );
      session.revision += 1;
      session.dirty = false;
      session.idleSince = session.leases.size ? undefined : Date.now();
      project.preview = {
        ...project.preview,
        status: "ready",
        phase: undefined,
        url: proxy.url,
        revision: session.revision,
      };
      this.#publish(project);
      return proxy.url;
    } catch (cause) {
      if (this.#operations.get(project.id) !== operation) {
        // Dispose only this launch's child; a replacement may already own the project.
        if (child && this.#running.get(project.id) === child) {
          this.#running.delete(project.id);
          await terminateProjectProcess(child);
        }
        throw new PreviewCancelledError();
      }
      if (began || project.preview.status === "starting") {
        await this.#terminateProject(project.id).catch(() => {});
        if (this.#operations.get(project.id) === operation)
          this.#update(project, {
            status:
              cause instanceof PreviewCancelledError ? "stopped" : "error",
            phase: undefined,
            url: undefined,
            error:
              cause instanceof PreviewCancelledError
                ? undefined
                : cause instanceof Error
                  ? cause.message
                  : String(cause),
          });
      } else if (
        operation.automatic &&
        !(cause instanceof PreviewCancelledError)
      ) {
        this.#update(project, {
          status: "waiting",
          error: cause instanceof Error ? cause.message : String(cause),
        });
      }
      if (this.#operations.get(project.id) === operation)
        this.#operations.delete(project.id);
      throw cause;
    }
  }

  async stop(
    project: ProjectState,
    reason: "manual" | "idle" | "settings" = "manual",
  ): Promise<void> {
    const session = this.#session(project);
    if (reason === "manual") session.paused = true;
    const pending = this.#stopping.get(project.id);
    if (pending) {
      await pending;
      return;
    }
    const operation: PreviewOperation = { automatic: false };
    this.#operations.set(project.id, operation);
    this.#starting.delete(project.id);
    const stopping = this.#terminateProject(project.id);
    this.#stopping.set(project.id, stopping);
    try {
      await stopping;
    } finally {
      if (this.#stopping.get(project.id) === stopping)
        this.#stopping.delete(project.id);
    }
    if (
      this.#operations.has(project.id) &&
      this.#operations.get(project.id) !== operation
    )
      return;
    this.#operations.delete(project.id);
    project.preview = {
      ...project.preview,
      status: "stopped",
      phase: undefined,
      url: undefined,
      error: undefined,
      diagnostic: undefined,
      diagnostics: [],
      stopReason: reason,
    };
    this.#publish(project);
  }

  async stopAll(): Promise<void> {
    clearInterval(this.#timer);
    for (const session of this.#sessions.values()) {
      this.#unwatch(session);
      clearTimeout(session.logTimer);
    }
    this.#operations.clear();
    this.#starting.clear();
    await Promise.all([
      ...this.#stopping.values(),
      ...[
        ...new Set([
          ...this.#children.keys(),
          ...this.#proxies.keys(),
          ...this.#static.keys(),
        ]),
      ].map((id) => this.#terminateProject(id)),
    ]);
    this.#sessions.clear();
  }

  async forget(project: ProjectState): Promise<void> {
    const session = this.#sessions.get(project.id);
    if (session) this.#unwatch(session);
    await this.stop(project);
    clearTimeout(session?.logTimer);
    this.#sessions.delete(project.id);
  }

  #publish(project: ProjectState): void {
    // Every snapshot already contains the latest logs; consume their pending flush.
    const session = this.#sessions.get(project.id);
    if (session) {
      clearTimeout(session.logTimer);
      session.logTimer = undefined;
    }
    this.events.publish(project.id, "preview.updated", {
      preview: structuredClone(project.preview),
    });
  }
  #update(
    project: ProjectState,
    update: Partial<ProjectState["preview"]>,
  ): void {
    project.preview = { ...project.preview, ...update };
    this.#publish(project);
  }

  #watch(session: PreviewSession): void {
    try {
      session.watcher = watch(
        session.project.workspacePath,
        { recursive: true },
        (_event, filename) => {
          const parts = String(filename ?? "")
            .replaceAll("\\", "/")
            .split("/");
          if (
            parts.some(
              (part) =>
                part.startsWith(".") ||
                ["node_modules", "dist", "build"].includes(part),
            ) ||
            !path.extname(parts.at(-1) ?? "") ||
            /\.(?:pid|log|tmp|swp)$/i.test(parts.at(-1) ?? "")
          )
            return;
          session.dirty = true;
          clearTimeout(session.changeTimer);
          session.changeTimer = setTimeout(() => {
            session.changeTimer = undefined;
            if (session.project.preview.status === "ready") {
              if (session.project.preview.command === "Serve static files")
                this.#proxies.get(session.project.id)?.reload();
            } else void this.automatic(session.project, true).catch(() => {});
          }, 800);
          session.changeTimer.unref?.();
        },
      );
      session.watcher.on("error", () => this.#unwatch(session));
    } catch {
      /* Opening a project still works when its filesystem cannot be watched. */
    }
  }
  #unwatch(session: PreviewSession): void {
    session.watcher?.close();
    session.watcher = undefined;
    clearTimeout(session.changeTimer);
    session.changeTimer = undefined;
  }

  async #savedProxyPort(project: ProjectState): Promise<number | undefined> {
    try {
      const port = JSON.parse(
        await readFile(this.#portFile(project), "utf8"),
      ).port;
      if (Number.isInteger(port) && port >= 1024 && port <= 65535) return port;
    } catch {}
  }
  #portFile(project: ProjectState): string {
    return path.join(
      project.storagePath ?? path.join(project.workspacePath, ".data"),
      "preview-origin.json",
    );
  }
  async #saveProxyPort(project: ProjectState, port: number): Promise<void> {
    const file = this.#portFile(project);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, JSON.stringify({ port }));
  }

  async #terminateProject(id: string): Promise<void> {
    this.#running.delete(id);
    const proxy = this.#proxies.get(id);
    this.#proxies.delete(id);
    const staticServer = this.#static.get(id);
    this.#static.delete(id);
    const children = [...(this.#children.get(id) ?? [])];
    this.#children.delete(id);
    const session = this.#sessions.get(id);
    if (session)
      for (const lease of session.leases.keys())
        if (lease.startsWith("page:")) session.leases.delete(lease);
    await Promise.all([
      proxy?.close(),
      staticServer?.close(),
      ...children.map(terminateProjectProcess),
    ]);
  }

  async #run(
    id: string,
    command: string,
    args: string[],
    cwd: string,
    log: (output: string) => void,
  ): Promise<void> {
    const child = spawn(packageManagerSpawnCommand(command), args, {
      cwd,
      env: projectProcessEnvironment(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: process.platform !== "win32",
      shell: process.platform === "win32",
      windowsHide: true,
    });
    this.#track(id, child);
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      await Promise.race([
        waitForCommand(child, command, log),
        new Promise<never>((_resolve, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(
                  "Dependency installation timed out. Check the network and retry installation.",
                ),
              ),
            this.options.installTimeoutMs ?? 120_000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
      await terminateProjectProcess(child);
      this.#untrack(id, child);
    }
  }
  #assertCurrent(id: string, operation: PreviewOperation): void {
    if (this.#operations.get(id) !== operation)
      throw new PreviewCancelledError();
  }
  #track(id: string, child: ChildProcess): void {
    const children = this.#children.get(id) ?? new Set<ChildProcess>();
    children.add(child);
    this.#children.set(id, children);
    registerProjectProcess(child);
    child.once("close", () => this.#untrack(id, child));
  }
  #untrack(id: string, child: ChildProcess): void {
    const children = this.#children.get(id);
    children?.delete(child);
    if (children?.size === 0) this.#children.delete(id);
  }
}
async function availablePort(port = 0): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function waitUntilReady(
  url: string,
  child: ChildProcess,
  timeoutMs: number,
  output: () => string,
  processError: () => Error | undefined,
  assertCurrent: () => void,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    assertCurrent();
    if (processError()) throw processError();
    if (child.exitCode !== null || child.signalCode !== null)
      throw new Error(
        withOutput(
          `Preview exited before ready (${child.signalCode ?? child.exitCode})`,
          output(),
        ),
      );
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(1_000) });
      await response.body?.cancel();
      // An HTTP error page still proves the server is listening. Content errors
      // belong to the proxy diagnostic; stopping this server would break HMR.
      assertCurrent();
      if (
        !processError() &&
        child.exitCode === null &&
        child.signalCode === null
      )
        return;
    } catch {}
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(
    withOutput(`Preview did not become ready within ${timeoutMs}ms`, output()),
  );
}

function captureOutput(
  streams: (NodeJS.ReadableStream | null)[],
  onOutput?: (output: string) => void,
): () => string {
  let output = "";
  for (const stream of streams)
    stream?.on("data", (chunk) => {
      output = `${output}${String(chunk)}`.slice(-MAX_ERROR_OUTPUT);
      onOutput?.(String(chunk));
    });
  return () => output;
}

function withOutput(message: string, output: string): string {
  const detail = output.replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "").trim();
  return detail ? `${message}\n\n${detail}` : message;
}

async function waitForCommand(
  child: ChildProcess,
  command: string,
  onOutput?: (output: string) => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const output = captureOutput([child.stdout, child.stderr], onOutput);
    child.on("error", reject);
    child.once("close", (code, signal) =>
      code === 0
        ? resolve()
        : reject(
            new Error(
              withOutput(`${command} exited with ${signal ?? code}`, output()),
            ),
          ),
    );
  });
}
