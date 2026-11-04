import { app, autoUpdater as nativeUpdater } from "electron";
import electronUpdater, { type UpdateInfo } from "electron-updater";
import type { DesktopUpdateErrorCode, DesktopUpdatePhase, DesktopUpdateRetry, DesktopUpdateState, DesktopUpdateStatus } from "../shared/desktop-update.js";

const { autoUpdater } = electronUpdater;

/** `skipped` means the updater was not in a state a scheduled check may disturb. */
export type DesktopUpdateCheckOutcome = "checked" | "failed" | "skipped";

export class DesktopUpdatePreparationError extends Error {
  constructor(readonly reason: "save" | "shutdown", message: string) {
    super(message);
    this.name = "DesktopUpdatePreparationError";
  }
}

/** A found release older than this is checked again before it downloads. */
const RELEASE_INFO_MAX_AGE_MS = 30 * 60_000;

/**
 * A scheduled check keeps a found or downloaded release current: a newer one
 * replaces it, the same one leaves it as it is.
 */
function allowsScheduledCheck(status: DesktopUpdateStatus): boolean {
  return status.type === "idle"
    || status.type === "up-to-date"
    || status.type === "available"
    || status.type === "ready"
    || (status.type === "error" && status.phase === "check");
}

export class DesktopUpdater {
  #state: DesktopUpdateState;
  #listeners = new Set<(state: DesktopUpdateState) => void>();
  #installing = false;
  #checking: Promise<DesktopUpdateCheckOutcome> | undefined;
  #automaticChecking = false;
  #automaticCheckFailed = false;
  #operation: DesktopUpdatePhase = "check";
  #automatic = false;
  /** From the click until the transfer ends, including the freshness check before it. */
  #downloadRequested = false;
  /** electron-updater is transferring the release it last found. */
  #transferring = false;
  /** When electron-updater last found a release; downloadUpdate() uses that one. */
  #foundAt = 0;
  /**
   * macOS: a download handed to Squirrel.Mac to stage for quit. Once staged,
   * MacUpdater installs that release on every later quitAndInstall() in this
   * run, so a newer download could not replace it.
   */
  #squirrel: "none" | "staging" | "staged" = "none";
  /** Errors emitted during a scheduled check, held until it is known which one is the check's. */
  #heldErrors: { error: unknown; operation: DesktopUpdatePhase; version?: string }[] = [];

  constructor(currentVersion: string, private readonly onInstall: () => Promise<void> | void) {
    this.#state = { currentVersion, status: { type: "idle" } };
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.autoRunAppAfterInstall = true;
    autoUpdater.allowPrerelease = true;
    autoUpdater.channel = "latest";
    autoUpdater.on("checking-for-update", () => {
      if (this.#busy()) return;
      this.#operation = "check";
      if (this.#automaticChecking) return;
      this.#set({ type: "checking" });
    });
    autoUpdater.on("update-not-available", () => {
      if (this.#busy()) return;
      this.#state = { ...this.#state, availableRelease: undefined };
      this.#set({ type: "up-to-date" });
    });
    autoUpdater.on("update-available", (info) => {
      // A check that overlaps a transfer or installation must not relabel it.
      if (this.#busy()) return;
      this.#foundAt = Date.now();
      const status = this.#state.status;
      this.#rememberRelease(info);
      if (status.type === "ready" && status.version === info.version) return;
      this.#set({ type: "available", version: info.version });
      if (this.#automatic) void this.download();
    });
    autoUpdater.on("download-progress", (progress) => {
      const current = this.#state.status;
      const version = current.type === "available" || current.type === "downloading" ? current.version : this.#state.availableRelease?.version;
      if (!version) return;
      this.#operation = "download";
      this.#set({ type: "downloading", version, percent: Math.max(0, Math.min(100, Math.round(progress.percent))) });
    });
    autoUpdater.on("update-downloaded", (info) => {
      this.#rememberRelease(info);
      this.#set({ type: "ready", version: info.version });
      // MacUpdater hands the download to Squirrel.Mac right after this event when it installs on quit.
      if (process.platform === "darwin" && autoUpdater.autoInstallOnAppQuit && this.#squirrel === "none") this.#squirrel = "staging";
    });
    if (process.platform === "darwin") {
      nativeUpdater.on("update-downloaded", () => { this.#squirrel = "staged"; });
      // A failed handoff fails the download, which can then be retried or replaced.
      nativeUpdater.on("error", (error) => {
        if (this.#squirrel !== "staging") return;
        this.#squirrel = "none";
        this.#setError(error, "download", "download", this.#state.availableRelease?.version);
      });
    }
    autoUpdater.on("error", (error) => {
      const failure = { error, operation: this.#operation, version: this.#state.availableRelease?.version };
      // A scheduled check rejects with its own error; anything else is applied once it ends.
      if (this.#automaticChecking) this.#heldErrors.push(failure);
      else this.#fail(failure);
    });
  }

  state(): DesktopUpdateState {
    return this.#state;
  }

  subscribe(listener: (state: DesktopUpdateState) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  /**
   * Settings → General → Automatic updates: a found release downloads in the
   * background and installs when the app quits. Off, each step waits for the person.
   */
  setAutomatic(enabled: boolean): void {
    this.#automatic = enabled;
    this.#syncInstallOnQuit();
    if (enabled && this.#state.status.type === "available") void this.download();
  }

  async check(automatic = false): Promise<DesktopUpdateCheckOutcome> {
    if (!app.isPackaged) {
      this.#set({ type: "up-to-date" });
      return "checked";
    }
    if (this.#busy() || (automatic && !allowsScheduledCheck(this.#state.status))) return "skipped";
    return this.#runCheck(automatic);
  }

  async download(): Promise<void> {
    if (this.#downloadRequested || this.#busy() || !this.#downloadableVersion()) return;
    this.#downloadRequested = true;
    let version: string | undefined;
    try {
      await this.#refreshStaleRelease();
      version = this.#downloadableVersion();
      if (!version) return;
      this.#operation = "download";
      this.#transferring = true;
      await autoUpdater.downloadUpdate();
    } catch (error) {
      this.#fail({ error, operation: "download", version });
    } finally {
      this.#transferring = false;
      this.#downloadRequested = false;
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

  #runCheck(automatic: boolean): Promise<DesktopUpdateCheckOutcome> {
    if (this.#checking) return Promise.resolve("skipped");
    const run = async (): Promise<DesktopUpdateCheckOutcome> => {
      this.#automaticChecking = automatic;
      this.#automaticCheckFailed = false;
      this.#operation = "check";
      let checkError: unknown;
      try {
        await autoUpdater.checkForUpdates();
      } catch (error) {
        checkError = error;
        if (automatic) this.#automaticCheckFailed = true;
        else this.#setError(error, "check", "check");
      } finally {
        this.#checking = undefined;
        this.#automaticChecking = false;
      }
      const held = this.#heldErrors.filter((failure) => failure.error !== checkError);
      this.#heldErrors = [];
      for (const failure of held) this.#fail(failure);
      const automaticCheckFailed = automatic && this.#automaticCheckFailed;
      this.#automaticCheckFailed = false;
      if (automaticCheckFailed) return "failed";
      const status = this.#state.status;
      return status.type === "error" && status.phase === "check" ? "failed" : "checked";
    };
    this.#checking = run();
    return this.#checking;
  }

  /**
   * downloadUpdate() fetches the release electron-updater last found. When that
   * was a while ago, or a check is still running, look again first so the
   * download is the newest release. A failed look keeps the release already found.
   */
  async #refreshStaleRelease(): Promise<void> {
    if (this.#checking) {
      await this.#checking;
      return;
    }
    if (!app.isPackaged || Date.now() - this.#foundAt < RELEASE_INFO_MAX_AGE_MS) return;
    await this.#runCheck(true);
  }

  #downloadableVersion(): string | undefined {
    const status = this.#state.status;
    return status.type === "available"
      ? status.version
      : status.type === "error" && status.retry === "download" ? status.version : undefined;
  }

  /**
   * A transfer or installation owns the update until it finishes or fails, and
   * a release handed to Squirrel.Mac owns it for the rest of the run.
   */
  #busy(): boolean {
    const type = this.#state.status.type;
    return this.#transferring || this.#installing || this.#squirrel !== "none" || type === "downloading" || type === "installing";
  }

  #fail({ error, operation, version }: { error: unknown; operation: DesktopUpdatePhase; version?: string }): void {
    // After the handoff the release is Squirrel.Mac's: a later download step only
    // fails a cache for future downloads, and a staging failure reports itself above.
    if (operation === "download" && this.#squirrel !== "none") return;
    this.#installing = false;
    this.#setError(error, operation, retryFor(operation), version);
  }

  /**
   * Install on quit only while a complete download is waiting. Downloading a
   * newer release clears electron-updater's pending installer, so quitting
   * mid-transfer must not try to run the one it replaced.
   */
  #syncInstallOnQuit(): void {
    const type = this.#state.status.type;
    autoUpdater.autoInstallOnAppQuit = this.#automatic && (type === "ready" || type === "installing");
  }

  #set(status: DesktopUpdateState["status"]): void {
    this.#state = { ...this.#state, status };
    this.#syncInstallOnQuit();
    for (const listener of this.#listeners) listener(this.#state);
  }

  #rememberRelease(info: Pick<UpdateInfo, "version" | "releaseNotes">): void {
    const notes = typeof info.releaseNotes === "string"
      ? info.releaseNotes
      : info.releaseNotes?.find((entry) => entry.version === info.version)?.note;
    const previous = this.#state.availableRelease;
    this.#state = { ...this.#state, availableRelease: {
      version: info.version,
      notes: notes?.trim() || (previous?.version === info.version ? previous.notes : ""),
    } };
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
