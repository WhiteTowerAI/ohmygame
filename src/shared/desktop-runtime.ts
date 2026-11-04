export interface DaemonRuntime {
  url: string;
  token: string;
  /** Where plugin pages are served from; their frames can't leave it. */
  pluginUiUrl?: string;
}

export interface DesktopRuntimeState {
  status: "starting" | "ready" | "recovering" | "error" | "stopped";
  generation: number;
  recovered: boolean;
  runtime?: DaemonRuntime;
  error?: string;
  /** Started with no plugins running, to recover from one that breaks the app. */
  safeMode?: boolean;
}

export interface DesktopRuntimeService {
  state(): Promise<DesktopRuntimeState>;
  /** Restarts the service; `safeMode` starts it with no plugins running, and without it, normally. */
  restart(options?: { safeMode?: boolean }): Promise<DesktopRuntimeState>;
  onState(listener: (state: DesktopRuntimeState) => void): () => void;
}
