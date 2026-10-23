import { spawn } from "node:child_process";
import { mkdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { ProjectState } from "../shared/contracts.js";
import {
  isPluginIntegrationMessage,
  type PluginIntegrationAction,
  type PluginIntegrationRequest,
  type PluginIntegrationResult,
  type PluginIntegrationState,
} from "../shared/plugin-integration.js";
import type { PluginDetail } from "../shared/plugins.js";
import type { PluginCapabilities } from "./plugin-capabilities.js";
import { LocalPluginError } from "./local-plugins.js";
import { projectProcessEnvironment } from "./project-process.js";
import {
  registerProjectProcess,
  terminateProjectProcess,
} from "./process-lifecycle.js";

/** Plugin-wide setup replaces every project outcome of the same plugin. */
const isSetup = (action: PluginIntegrationAction) =>
  action === "prepare" || action === "connect";

/** Actions whose adapter result reports the current connection. */
const checksConnection = (action: PluginIntegrationAction) =>
  isSetup(action) || action === "status" || isProjectWrite(action);

const isProjectWrite = (action: PluginIntegrationAction) =>
  action === "bind" || action === "create";

/** Shared by HTTP routes, the prompt gate and the host itself. */
export function assertIntegrationPlugin(
  plugin: PluginDetail,
  project?: ProjectState,
): void {
  if (!plugin.installed || !plugin.enabled || !plugin.integration)
    throw new LocalPluginError(
      "Enable the project's integration plugin from Plugins in the main sidebar",
      409,
    );
  if (
    project &&
    plugin.projectTypes?.length &&
    !plugin.projectTypes.includes(project.type)
  )
    throw new LocalPluginError(
      "This plugin requires a different project type. Create or import a compatible project.",
      409,
    );
  if (project?.integration && project.integration.pluginId !== plugin.id)
    throw new LocalPluginError(
      "This project uses another integration plugin",
      409,
    );
}

type Task = {
  state: PluginIntegrationState;
  done: Promise<PluginIntegrationResult>;
  cancel: () => void;
};

/** Adapters are explicit installed-plugin actions, never startup hooks. Their
 * private data survives package updates; credentials and runtime handles do not
 * enter the project metadata or the renderer. */
export class PluginIntegrationHost {
  #tasks = new Map<string, Task>();
  #closed = false;
  constructor(
    private readonly capabilities: PluginCapabilities,
    /** Called with the project after a binding, or without one after setup. */
    private readonly changed: (project?: ProjectState) => void = () => {},
    private readonly withWrite: (
      project: ProjectState,
      operation: () => Promise<PluginIntegrationResult>,
    ) => Promise<PluginIntegrationResult> = (_project, operation) =>
      operation(),
  ) {}

  state(
    pluginId: string,
    projectId?: string,
  ): PluginIntegrationState | undefined {
    const state = this.#visible(pluginId, projectId)?.state;
    return state ? structuredClone(state) : undefined;
  }

  start(
    plugin: PluginDetail,
    action: PluginIntegrationAction,
    project?: ProjectState,
    projectId?: string,
  ): PluginIntegrationState {
    if (this.#closed)
      throw new LocalPluginError("Plugin integrations are shutting down", 503);
    assertIntegrationPlugin(plugin, project);
    // A compatible project without an integration may check and bind as a
    // candidate; previews need the selected integration.
    if (
      action.startsWith("preview-") &&
      (!project?.integration || !plugin.integration!.preview)
    )
      throw new LocalPluginError(
        "Plugin does not provide project preview",
        400,
      );
    if (action === "bind" && (!project || !projectId))
      throw new LocalPluginError("Select a project to connect", 400);
    if (action === "create" && (!project || !plugin.integration!.createProject))
      throw new LocalPluginError("Plugin cannot create this project", 400);
    const key = this.#key(plugin.id, project?.id);
    const previous = this.#tasks.get(key);
    if (previous?.state.running) {
      if (previous.state.action === action && !isProjectWrite(action))
        return structuredClone(previous.state);
      throw new LocalPluginError("Another plugin operation is running", 409);
    }
    for (const task of this.#tasks.values()) {
      if (
        task.state.pluginId === plugin.id &&
        task.state.running &&
        (isSetup(task.state.action) || isSetup(action))
      )
        throw new LocalPluginError(
          "Another plugin setup operation is running",
          409,
        );
    }
    const controller = new AbortController();
    const state: PluginIntegrationState = {
      pluginId: plugin.id,
      action,
      running: true,
      result: previous?.state.result,
      connectionCheckedAt: previous?.state.connectionCheckedAt,
    };
    const operation = () =>
      this.#run(plugin, action, project, projectId, state, controller.signal);
    const done = Promise.resolve()
      .then(() =>
        isProjectWrite(action) && project
          ? this.withWrite(project, operation)
          : operation(),
      )
      .then((result) => {
        state.result = { ...state.result, ...result };
        if (isSetup(action)) {
          for (const [otherKey, task] of this.#tasks) {
            if (task.state.pluginId === plugin.id && task.state !== state)
              this.#tasks.delete(otherKey);
          }
        }
        if (isSetup(action)) this.changed();
        else if (isProjectWrite(action)) this.changed(project);
        state.authorizationUrl = undefined;
        return state.result;
      })
      .catch((cause: unknown) => {
        state.error = this.capabilities.configuration.redact(
          plugin,
          cause instanceof Error ? cause.message : String(cause),
        );
        state.authorizationUrl = undefined;
        throw cause;
      })
      .finally(() => {
        state.running = false;
        state.message = undefined;
        // A failed check also counts, so an unreachable service is not retried
        // before every prompt; the previous connection result is retained.
        if (checksConnection(action)) state.connectionCheckedAt = Date.now();
      });
    // The UI may leave while an operation finishes. Retain its outcome for the
    // next view without an unhandled rejection or an automatic mutation retry.
    void done.catch(() => {});
    this.#tasks.set(key, {
      state,
      done,
      cancel: () => controller.abort(new Error("Plugin operation cancelled")),
    });
    return structuredClone(state);
  }

  async execute(
    plugin: PluginDetail,
    action: PluginIntegrationAction,
    project?: ProjectState,
    signal?: AbortSignal,
  ): Promise<PluginIntegrationResult> {
    signal?.throwIfAborted();
    this.start(plugin, action, project);
    const task = this.#tasks.get(this.#key(plugin.id, project?.id))!;
    const cancel = () => task.cancel();
    signal?.addEventListener("abort", cancel, { once: true });
    try {
      return await task.done;
    } finally {
      signal?.removeEventListener("abort", cancel);
    }
  }

  cancel(pluginId: string, projectId?: string): void {
    this.#visible(pluginId, projectId)?.cancel();
  }
  async forget(pluginId: string, projectId?: string): Promise<void> {
    const entries = [...this.#tasks].filter(
      ([key, task]) =>
        task.state.pluginId === pluginId &&
        (projectId === undefined || key === this.#key(pluginId, projectId)),
    );
    for (const [, task] of entries) task.cancel();
    await Promise.allSettled(entries.map(([, task]) => task.done));
    for (const [key] of entries) this.#tasks.delete(key);
  }
  async close(): Promise<void> {
    this.#closed = true;
    for (const task of this.#tasks.values()) task.cancel();
    await Promise.allSettled(
      [...this.#tasks.values()].map((task) => task.done),
    );
  }
  #key(pluginId: string, projectId?: string): string {
    return JSON.stringify([pluginId, projectId]);
  }
  /** A project view follows running plugin-wide setup instead of being
   * rejected by it; setup success clears the project's outcome for a new read. */
  #visible(pluginId: string, projectId?: string): Task | undefined {
    const own = this.#tasks.get(this.#key(pluginId, projectId));
    if (own || projectId === undefined) return own;
    const setup = this.#tasks.get(this.#key(pluginId));
    return setup?.state.running && isSetup(setup.state.action)
      ? setup
      : undefined;
  }

  async #run(
    plugin: PluginDetail,
    action: PluginIntegrationAction,
    project: ProjectState | undefined,
    projectId: string | undefined,
    state: PluginIntegrationState,
    signal: AbortSignal,
  ): Promise<PluginIntegrationResult> {
    const root = await realpath(await this.capabilities.packageRoot(plugin));
    const entry = await realpath(path.resolve(root, plugin.integration!.entry));
    const relative = path.relative(root, entry);
    if (
      !relative ||
      relative.startsWith("..") ||
      path.isAbsolute(relative) ||
      !(await stat(entry)).isFile() ||
      !entry.endsWith(".mjs")
    )
      throw new Error(
        "Integration entry must be an .mjs file inside the plugin",
      );
    const dataDirectory = this.capabilities.dataPath(plugin.id);
    await mkdir(dataDirectory, { recursive: true, mode: 0o700 });
    signal.throwIfAborted();
    const request: PluginIntegrationRequest = {
      version: 1,
      action,
      dataDirectory,
      workspacePath: project?.workspacePath,
      configuration: this.capabilities.configuration.resolved(plugin),
      projectId,
      ...(action === "create" ? { projectName: project!.name } : {}),
    };
    const child = spawn(process.execPath, [entry], {
      cwd: root,
      env: {
        ...projectProcessEnvironment(),
        OHMYGAME_PLUGIN_DATA_DIR: dataDirectory,
        ELECTRON_RUN_AS_NODE: "1",
      },
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });
    registerProjectProcess(child);
    let failure: Error | undefined;
    let result: PluginIntegrationResult | undefined;
    let buffer = "";
    let bytes = 0;
    const stop = (error: Error) => {
      if (failure) return;
      failure = error;
      void terminateProjectProcess(child).catch(() => {});
    };
    const abort = () =>
      stop(
        signal.reason instanceof Error
          ? signal.reason
          : new Error("Plugin operation cancelled"),
      );
    signal.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(
      () =>
        stop(
          new Error(
            "Plugin operation timed out; inspect its state before retrying",
          ),
        ),
      ["status", "preview-status", "preview-logs"].includes(action)
        ? 60_000
        : 15 * 60_000,
    );
    const consume = (line: string) => {
      if (!line.trim()) return;
      try {
        const message: unknown = JSON.parse(line);
        if (!isPluginIntegrationMessage(message) || result)
          throw new Error("Invalid plugin integration response");
        if (message.type === "progress") {
          state.message = this.capabilities.configuration.redact(
            plugin,
            message.message,
          );
          if (message.authorizationUrl) {
            const url = new URL(message.authorizationUrl);
            if (
              url.protocol !== "https:" &&
              !(
                url.protocol === "http:" &&
                ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname)
              )
            )
              throw new Error("Invalid plugin authorization URL");
            state.authorizationUrl = url.href;
          }
        } else if (message.type === "error") stop(new Error(message.message));
        else result = message.result;
      } catch (cause) {
        stop(cause instanceof Error ? cause : new Error(String(cause)));
      }
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 2 * 1024 * 1024)
        return stop(new Error("Plugin integration output exceeded its limit"));
      buffer += chunk;
      let newline: number;
      while ((newline = buffer.indexOf("\n")) >= 0) {
        consume(buffer.slice(0, newline));
        buffer = buffer.slice(newline + 1);
      }
      if (buffer.length > 256 * 1024)
        stop(new Error("Plugin integration message exceeded its limit"));
    });
    // stderr is diagnostic-only and may include upstream credentials. Adapters
    // must report a bounded, public error through the versioned protocol.
    child.stderr.resume();
    child.stdin.on("error", () => {});
    const closed = new Promise<void>((resolve) => {
      child.once("error", (error) => {
        failure ??= error;
      });
      child.once("close", (code) => {
        if (buffer.trim()) consume(buffer);
        if (code !== 0)
          failure ??= new Error(
            `Plugin operation exited with code ${code ?? "unknown"}`,
          );
        resolve();
      });
    });
    child.stdin.end(JSON.stringify(request) + "\n");
    try {
      await closed;
      if (failure) throw failure;
      if (!result) throw new Error("Plugin integration returned no result");
      return result;
    } finally {
      clearTimeout(timer);
      signal.removeEventListener("abort", abort);
      if (failure) await terminateProjectProcess(child);
    }
  }
}
