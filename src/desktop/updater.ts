import { app } from "electron";
import electronUpdater from "electron-updater";
import type { DesktopUpdateState } from "../shared/desktop-update.js";

const { autoUpdater } = electronUpdater;

export class DesktopUpdater {
  #state: DesktopUpdateState;
  #listeners = new Set<(state: DesktopUpdateState) => void>();

  constructor(currentVersion: string, private readonly onInstall: () => Promise<void> | void) {
    this.#state = { currentVersion, status: { type: "idle" } };
    autoUpdater.autoDownload = false;
    autoUpdater.autoInstallOnAppQuit = false;
    autoUpdater.allowPrerelease = true;
    autoUpdater.channel = "latest";
    autoUpdater.on("checking-for-update", () => this.#set({ type: "checking" }));
    autoUpdater.on("update-not-available", () => this.#set({ type: "up-to-date" }));
    autoUpdater.on("update-available", (info) => this.#set({ type: "available", version: info.version }));
    autoUpdater.on("download-progress", (progress) => {
      const current = this.#state.status;
      if (current.type !== "available" && current.type !== "downloading") return;
      this.#set({ type: "downloading", version: current.version, percent: Math.max(0, Math.min(100, Math.round(progress.percent))) });
    });
    autoUpdater.on("update-downloaded", (info) => this.#set({ type: "ready", version: info.version }));
    autoUpdater.on("error", (error) => this.#set({ type: "error", message: error instanceof Error ? error.message : String(error) }));
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
    try {
      await autoUpdater.checkForUpdates();
    } catch (error) {
      this.#setError(error);
    }
  }

  async download(): Promise<void> {
    const status = this.#state.status;
    if (status.type !== "available") return;
    try {
      await autoUpdater.downloadUpdate();
    } catch (error) {
      this.#setError(error);
    }
  }

  async install(): Promise<void> {
    if (this.#state.status.type !== "ready") return;
    await this.onInstall();
    autoUpdater.quitAndInstall(false, true);
  }

  #set(status: DesktopUpdateState["status"]): void {
    this.#state = { ...this.#state, status };
    for (const listener of this.#listeners) listener(this.#state);
  }

  #setError(error: unknown): void {
    this.#set({ type: "error", message: error instanceof Error ? error.message : String(error) });
  }
}
