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
    private readonly changed: () => void = () => {},
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
    const state = this.#tasks.get(this.#key(pluginId, projectId))?.state;
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
    if (!plugin.enabled || !plugin.integration)
      throw new LocalPluginError(
        "Enable an installed plugin with an integration first",
        400,
      );
    if (
      project &&
      plugin.projectTypes?.length &&
      !plugin.projectTypes.includes(project.type)
    )
      throw new LocalPluginError(
        "Plugin does not support this project type",
        400,
      );
    if (
      action.startsWith("preview-") &&
      (!project || !plugin.integration.preview)
    )
      throw new LocalPluginError(
        "Plugin does not provide project preview",
        400,
      );
    if (action === "bind" && (!project || !projectId))
      throw new LocalPluginError("Select a project to connect", 400);
    const key = this.#key(plugin.id, project?.id);
    const previous = this.#tasks.get(key);
    if (previous?.state.running) {
      if (previous.state.action === action && action !== "bind")
        return structuredClone(previous.state);
      throw new LocalPluginError("Another plugin operation is running", 409);
    }
    for (const task of this.#tasks.values()) {
      if (
        task.state.pluginId === plugin.id &&
        task.state.running &&
        (["prepare", "connect"].includes(task.state.action) ||
          ["prepare", "connect"].includes(action))
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
    };
    const operation = () =>
      this.#run(plugin, action, project, projectId, state, controller.signal);
    const done = Promise.resolve()
      .then(() =>
        action === "bind" && project
          ? this.withWrite(project, operation)
          : operation(),
      )
      .then((result) => {
        state.result = { ...state.result, ...result };
        if (["prepare", "connect"].includes(action)) {
          for (const [otherKey, task] of this.#tasks) {
            if (task.state.pluginId === plugin.id && task.state !== state)
              this.#tasks.delete(otherKey);
          }
        }
        if (["prepare", "connect", "bind"].includes(action)) this.changed();
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
    this.#tasks.get(this.#key(pluginId, projectId))?.cancel();
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
