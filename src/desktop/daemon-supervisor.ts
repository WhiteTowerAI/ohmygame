import {
  startDaemon,
  type ManagedDaemon,
  type StartDaemonOptions,
} from "./daemon-process.js";
import type { DesktopRuntimeState } from "../shared/desktop-runtime.js";

interface SupervisorOptions extends StartDaemonOptions {
  onState?: (state: DesktopRuntimeState) => void;
  /** Starts in safe mode, with no plugins running, as `--safe-mode` asks. */
  safeMode?: boolean;
  maxAutomaticRestarts?: number;
  restartWindowMs?: number;
}

/** Owns service generations so a crashed daemon never leaves the UI using a dead address. */
export class DaemonSupervisor {
  #daemon?: ManagedDaemon;
  #pending?: Promise<DesktopRuntimeState>;
  #state: DesktopRuntimeState = {
    status: "starting",
    generation: 0,
    recovered: false,
  };
  #stopped = false;
  #restarts: number[] = [];
  #safeMode: boolean;

  constructor(private readonly options: SupervisorOptions) {
    this.#safeMode = options.safeMode ?? false;
  }

  get runtime() {
    if (!this.#daemon || this.#state.status !== "ready")
      throw new Error("The background service is unavailable.");
    return this.#daemon.runtime;
  }

  state(): DesktopRuntimeState {
    return structuredClone(this.#state);
  }

  start(): Promise<DesktopRuntimeState> {
    return this.#launch(false);
  }

  /** Restarts the service, in safe mode or, without it, normally; an automatic restart keeps the mode. */
  restart(options: { safeMode?: boolean } = {}): Promise<DesktopRuntimeState> {
    this.#restarts = [];
    this.#safeMode = options.safeMode ?? false;
    return this.#launch(true);
  }

  async stop(): Promise<void> {
    this.#stopped = true;
    await this.#pending?.catch(() => {});
    const daemon = this.#daemon;
    this.#daemon = undefined;
    await daemon?.stop();
    this.#publish({ ...this.#state, status: "stopped", runtime: undefined });
  }

  #launch(recovered: boolean): Promise<DesktopRuntimeState> {
    if (this.#pending) return this.#pending;
    if (this.#stopped)
      return Promise.reject(new Error("The background service has stopped."));
    const launch = this.#start(recovered);
    this.#pending = launch;
    void launch.then(
      () => {
        if (this.#pending === launch) this.#pending = undefined;
      },
      () => {
        if (this.#pending === launch) this.#pending = undefined;
      },
    );
    return launch;
  }

  async #start(recovered: boolean): Promise<DesktopRuntimeState> {
    const previous = this.#daemon;
    this.#daemon = undefined;
    const generation = this.#state.generation + 1;
    this.#publish({
      status: recovered ? "recovering" : "starting",
      generation,
      recovered,
      error: this.#state.error,
      ...(this.#safeMode ? { safeMode: true } : {}),
    });
    try {
      await previous?.stop();
      // An inherited setting never decides the mode; the supervisor does.
      const { OHMYGAME_SAFE_MODE: _inherited, ...environment } = this.options.environment ?? process.env;
      const daemon = await startDaemon({
        ...this.options,
        environment: this.#safeMode ? { ...environment, OHMYGAME_SAFE_MODE: "1" } : environment,
        onUnexpectedExit: (error) => {
          void this.#unexpectedExit(generation, error).catch(() => {});
        },
      });
      if (this.#stopped) {
        await daemon.stop();
        throw new Error("The background service has stopped.");
      }
      this.#daemon = daemon;
      this.#publish({
        status: "ready",
        generation,
        recovered,
        runtime: daemon.runtime,
        ...(this.#safeMode ? { safeMode: true } : {}),
      });
      return this.state();
    } catch (cause) {
      this.#publish({
        status: this.#stopped ? "stopped" : "error",
        generation,
        recovered,
        error: cause instanceof Error ? cause.message : String(cause),
        ...(this.#safeMode ? { safeMode: true } : {}),
      });
      throw cause;
    }
  }

  async #unexpectedExit(generation: number, error: Error): Promise<void> {
    if (this.#stopped || generation !== this.#state.generation) return;
    await this.#pending?.catch(() => {});
    if (this.#stopped || generation !== this.#state.generation) return;
    this.#daemon = undefined;
    const now = Date.now();
    this.#restarts = this.#restarts.filter(
      (time) => now - time < (this.options.restartWindowMs ?? 60_000),
    );
    this.#publish({
      ...this.#state,
      status: "error",
      runtime: undefined,
      error: error.message,
    });
    if (this.#restarts.length >= (this.options.maxAutomaticRestarts ?? 2))
      return;
    this.#restarts.push(now);
    await this.#launch(true);
  }

  #publish(state: DesktopRuntimeState): void {
    this.#state = state;
    this.options.onState?.(this.state());
  }
}
