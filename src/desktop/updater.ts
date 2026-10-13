import { app } from "electron";
import electronUpdater from "electron-updater";
import type { DesktopUpdateErrorCode, DesktopUpdatePhase, DesktopUpdateRetry, DesktopUpdateState } from "../shared/desktop-update.js";

const { autoUpdater } = electronUpdater;

export class DesktopUpdatePreparationError extends Error {
  constructor(readonly reason: "save" | "shutdown", message: string) {
    super(message);
    this.name = "DesktopUpdatePreparationError";
  }
}

export class DesktopUpdater {
  #state: DesktopUpdateState;
  #listeners = new Set<(state: DesktopUpdateState) => void>();
  #installing = false;
  #operation: DesktopUpdatePhase = "check";
  #availableVersion?: string;

  constructor(currentVersion: string, private readonly onInstall: () => Promise<void> | void) {
    this.#state = { currentVersion, status: { type: "idle" } };
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.autoRunAppAfterInstall = true;
    autoUpdater.allowPrerelease = true;
    autoUpdater.channel = "latest";
    autoUpdater.on("checking-for-update", () => {
      this.#operation = "check";
      this.#set({ type: "checking" });
    });
    autoUpdater.on("update-not-available", () => this.#set({ type: "up-to-date" }));
    autoUpdater.on("update-available", (info) => {
      this.#availableVersion = info.version;
      this.#set({ type: "available", version: info.version });
    });
    autoUpdater.on("download-progress", (progress) => {
      const current = this.#state.status;
      const version = current.type === "available" || current.type === "downloading" ? current.version : this.#availableVersion;
      if (!version) return;
      this.#operation = "download";
      this.#set({ type: "downloading", version, percent: Math.max(0, Math.min(100, Math.round(progress.percent))) });
    });
    autoUpdater.on("update-downloaded", (info) => {
      this.#availableVersion = info.version;
      this.#set({ type: "ready", version: info.version });
    });
    autoUpdater.on("error", (error) => {
      this.#installing = false;
      this.#setError(error, this.#operation, retryFor(this.#operation), this.#availableVersion);
    });
  }

  state(): DesktopUpdateState {
    return this.#state;
  }

  subscribe(listener: (state: DesktopUpdateState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  async check(): Promise<void> {
    if (!app.isPackaged) {
      this.#set({ type: "up-to-date" });
      return;
    }
    this.#operation = "check";
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      this.#setError(error, "check", "check");
    }
  }

  async download(): Promise<void> {
    const status = this.#state.status;
    const version = status.type === "available"
      ? status.version
      : status.type === "error" && status.retry === "download" ? status.version : undefined;
    if (!version) return;
    this.#operation = "download";
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      this.#setError(error, "download", "download", version);
    }
  }

  async install(): Promise<void> {
    const status = this.#state.status;
    const version = status.type === "ready"
      ? status.version
      : status.type === "error" && status.retry === "install" ? status.version : undefined;
    if (!version || this.#installing) return;
    this.#installing = true;
    this.#operation = "prepare";
    this.#set({ type: "installing", version });
    try {
      await this.onInstall();
      this.#operation = "install";
      if (process.platform === "win32") {
        // Start NSIS only after Electron has accepted Quit and begun closing its processes.
        app.once("will-quit", () => autoUpdater.quitAndInstall(false));
        app.quit();
      } else {
        autoUpdater.quitAndInstall(false);
      }
    } catch (error) {
      this.#installing = false;
      this.#setError(error, "prepare", "install", version);
    }
  }

  #set(status: DesktopUpdateState["status"]): void {
    this.#state = { ...this.#state, status };
    for (const listener of this.#listeners) listener(this.#state);
  }

  #setError(error: unknown, phase: DesktopUpdatePhase, retry: DesktopUpdateRetry, version?: string): void {
    this.#set(updateFailure(error, phase, retry, version));
  }
}

export function updateFailure(
  error: unknown,
  phase: DesktopUpdatePhase,
  retry: DesktopUpdateRetry,
  version?: string,
): Extract<DesktopUpdateState["status"], { type: "error" }> {
  const detail = safeDetail(error);
  const lower = detail.toLowerCase();
  let code: DesktopUpdateErrorCode = "unknown";
  let title = "Update could not be completed";
  let message = "OhMyGame is still available at the current version. Try again or copy the details if the problem continues.";

  if (error instanceof DesktopUpdatePreparationError && error.reason === "save") {
    code = "save";
    title = "Your work could not be saved";
    message = "The update did not start. Return to the workspace, resolve the save issue, then try again.";
  } else if (error instanceof DesktopUpdatePreparationError && error.reason === "shutdown") {
    code = "shutdown";
    title = "A background service did not stop";
    message = "The update did not start because OhMyGame could not close safely. Try again after the current task finishes.";
  } else if (matches(lower, "sha512", "checksum", "signature", "corrupt", "integrity")) {
    code = "verification";
    title = "The downloaded update could not be verified";
    message = "The update file may be incomplete or modified. Download it again; the current version was not changed.";
  } else if (matches(lower, "enospc", "not enough space", "no space left", "disk full")) {
    code = "storage";
    title = "There is not enough disk space";
    message = "Free some space on the system drive, then try the update again. Your projects and conversations are unchanged.";
  } else if (matches(lower, "eacces", "eperm", "access denied", "permission", "not permitted")) {
    code = "permission";
    title = "Windows blocked access to the update files";
    message = "Close other OhMyGame windows and try again. If it still fails, security software or administrator permissions may be blocking the installer.";
  } else if (matches(
    lower,
    "enotfound",
    "eai_again",
    "econn",
    "err_name_not_resolved",
    "err_internet_disconnected",
    "err_network_changed",
    "err_connection_",
    "err_timed_out",
    "err_address_unreachable",
    "err_proxy_connection_failed",
    "err_tunnel_connection_failed",
    "err_cert_",
    "getaddrinfo",
    "host not found",
    "network",
    "internet",
    "timeout",
    "timed out",
    "http status",
    "status code",
  )) {
    code = "network";
    title = phase === "check" ? "Could not check for updates" : "The update download was interrupted";
    message = "Check the network or proxy settings, then try again. The current version is still available.";
  } else if (phase === "install") {
    code = "installer";
    title = "The update installer could not start";
    message = "The downloaded update is still available. Close other OhMyGame windows and try again.";
  }

  return { type: "error", phase, code, title, message, detail, retry, ...(version ? { version } : {}), dataSafe: true };
}

function retryFor(phase: DesktopUpdatePhase): DesktopUpdateRetry {
  return phase === "check" ? "check" : phase === "download" ? "download" : "install";
}

function safeDetail(error: unknown): string {
  const raw = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  return raw
    .replace(/(https?:\/\/[^\s?]+)\?[^\s]+/gi, "$1?[redacted]")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "")
    .slice(0, 2_000);
}

function matches(value: string, ...needles: string[]): boolean {
  return needles.some((needle) => value.includes(needle));
}
