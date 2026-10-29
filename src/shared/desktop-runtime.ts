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
}

export interface DesktopRuntimeService {
  state(): Promise<DesktopRuntimeState>;
  restart(): Promise<DesktopRuntimeState>;
  onState(listener: (state: DesktopRuntimeState) => void): () => void;
}
