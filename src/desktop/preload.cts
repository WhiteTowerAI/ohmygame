import { contextBridge, ipcRenderer } from "electron";
import type { DesktopUpdateState } from "../shared/desktop-update.js";
import type { ProjectFileOpenMode } from "../shared/contracts.js";
import type { PlaytestWatchState } from "../shared/playtest.js";
import type { DesktopClipboardFile } from "../shared/file-transfer.js";
import type { WebGamePlayerRequest, WebGamePlayerState, WebGamePreviewLayout } from "../shared/web-game-player.js";
import type { DesktopRuntimeState } from "../shared/desktop-runtime.js";

function argument(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv.find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new Error(`Missing desktop runtime argument: ${name}`);
  return value;
}

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld("ohMyGameDesktop", Object.freeze({
    platform: process.platform,
    runtime: Object.freeze({
      daemonUrl: argument("ohmygame-daemon-url"),
      token: argument("ohmygame-daemon-token"),
    }),
    runtimeService: Object.freeze({
      state: () => ipcRenderer.invoke("ohmygame:runtime-state") as Promise<DesktopRuntimeState>,
      restart: () => ipcRenderer.invoke("ohmygame:restart-runtime") as Promise<DesktopRuntimeState>,
      onState: (listener: (state: DesktopRuntimeState) => void) => {
        const handler = (_event: Electron.IpcRendererEvent, state: DesktopRuntimeState) => listener(state);
        ipcRenderer.on("ohmygame:runtime-state", handler);
        return () => ipcRenderer.removeListener("ohmygame:runtime-state", handler);
      },
    }),
    setAppearance: (appearance: "system" | "light" | "dark") =>
      ipcRenderer.invoke("ohmygame:set-appearance", appearance) as Promise<void>,
    restartApp: () => ipcRenderer.invoke("ohmygame:restart-app") as Promise<void>,
    onPrepareClose: (listener: () => Promise<void>) => {
      const callback = (_event: Electron.IpcRendererEvent, id: number) => {
        void Promise.resolve().then(listener).then(
          () => ipcRenderer.send("ohmygame:ready-to-close", id),
          (cause) => ipcRenderer.send("ohmygame:ready-to-close", id, cause instanceof Error ? cause.message : String(cause)),
        );
      };
      ipcRenderer.on("ohmygame:prepare-close", callback);
      return () => ipcRenderer.removeListener("ohmygame:prepare-close", callback);
    },
    onCancelClose: (listener: (error: string) => void) => {
      const callback = (_event: Electron.IpcRendererEvent, _id: number, error: string) => listener(error);
      ipcRenderer.on("ohmygame:cancel-close", callback);
      return () => ipcRenderer.removeListener("ohmygame:cancel-close", callback);
    },
    windowMenu: Object.freeze({
      icon: () => ipcRenderer.invoke("ohmygame:window-menu-icon") as Promise<string>,
      popup: (label: string, x: number, y: number) =>
        ipcRenderer.invoke("ohmygame:popup-window-menu", label, x, y) as Promise<void>,
    }),
    openExternal: (url: string) => ipcRenderer.invoke("ohmygame:open-auth-url", url) as Promise<void>,
    openProjectFile: (projectId: string, filePath: string, mode: ProjectFileOpenMode = "default") =>
      ipcRenderer.invoke("ohmygame:open-project-file", projectId, filePath, mode) as Promise<void>,
    browsePluginDirectory: (pluginId: string) => ipcRenderer.invoke("ohmygame:browse-plugin-directory", pluginId) as Promise<void>,
    revealPluginSkill: (pluginId: string, skillId: string) => ipcRenderer.invoke("ohmygame:reveal-plugin-skill", pluginId, skillId) as Promise<void>,
    selectPluginDirectory: () => ipcRenderer.invoke("ohmygame:select-plugin-directory") as Promise<string | undefined>,
    selectProjectDirectory: () => ipcRenderer.invoke("ohmygame:select-project-directory") as Promise<string | undefined>,
    clipboard: Object.freeze({
      files: () => ipcRenderer.invoke("ohmygame:clipboard-files") as Promise<DesktopClipboardFile[]>,
      paste: () => ipcRenderer.invoke("ohmygame:paste-native") as Promise<void>,
    }),
    capturePage: (bounds: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke("ohmygame:capture-page", bounds) as Promise<Uint8Array>,
    captureNodeThumbnail: (projectId: string, nodeId: string, viewport: { width: number; height: number }, batchId: string) =>
      ipcRenderer.invoke("ohmygame:capture-node-thumbnail", projectId, nodeId, viewport, batchId) as Promise<boolean>,
    cancelNodeThumbnails: (batchId: string) =>
      ipcRenderer.invoke("ohmygame:cancel-node-thumbnails", batchId) as Promise<void>,
    finishNodeThumbnail: (captured: boolean) => ipcRenderer.invoke("ohmygame:finish-node-thumbnail", captured) as Promise<void>,
    openPlaytest: (projectId: string, viewport: { width: number; height: number }) =>
      ipcRenderer.invoke("ohmygame:open-playtest", projectId, viewport) as Promise<void>,
    webGamePlayer: Object.freeze({
      preview: Object.freeze({
        attach: (projectId: string, attachment: string, url: string, layout: WebGamePreviewLayout) =>
          ipcRenderer.invoke("ohmygame:attach-web-game-preview", projectId, attachment, url, layout) as Promise<void>,
        layout: (projectId: string, attachment: string, layout: WebGamePreviewLayout) =>
          ipcRenderer.invoke("ohmygame:layout-web-game-preview", projectId, attachment, layout) as Promise<void>,
        detach: (projectId: string, attachment: string) =>
          ipcRenderer.invoke("ohmygame:detach-web-game-preview", projectId, attachment) as Promise<void>,
        capture: (projectId: string) => ipcRenderer.invoke("ohmygame:capture-web-game-preview", projectId) as Promise<Uint8Array>,
      }),
      open: (projectId: string, request: WebGamePlayerRequest) => ipcRenderer.invoke("ohmygame:open-web-game-player", projectId, request) as Promise<void>,
      state: (projectId: string) => ipcRenderer.invoke("ohmygame:web-game-player-state", projectId) as Promise<WebGamePlayerState>,
      close: (projectId: string) => ipcRenderer.invoke("ohmygame:close-web-game-player", projectId) as Promise<void>,
      refresh: (projectId: string, reload = false) => ipcRenderer.invoke("ohmygame:refresh-web-game-player", projectId, reload) as Promise<void>,
      onState: (listener: (state: WebGamePlayerState) => void) => {
        const callback = (_event: Electron.IpcRendererEvent, state: WebGamePlayerState) => listener(state);
        ipcRenderer.on("ohmygame:web-game-player-state", callback);
        return () => ipcRenderer.removeListener("ohmygame:web-game-player-state", callback);
      },
    }),
    openPlayableNode: (projectId: string, nodeId: string) =>
      ipcRenderer.invoke("ohmygame:open-playable-node", projectId, nodeId) as Promise<void>,
    onOpenPlayableNode: (listener: (projectId: string, nodeId: string) => void) => {
      const callback = (_event: Electron.IpcRendererEvent, projectId: string, nodeId: string) => listener(projectId, nodeId);
      ipcRenderer.on("ohmygame:open-playable-node", callback);
      return () => ipcRenderer.removeListener("ohmygame:open-playable-node", callback);
    },
    agentPlaytests: Object.freeze({
      state: () => ipcRenderer.invoke("ohmygame:agent-playtest-state") as Promise<PlaytestWatchState>,
      setVisible: (visible: boolean) => ipcRenderer.invoke("ohmygame:set-agent-playtest-visible", visible) as Promise<PlaytestWatchState>,
      onState: (listener: (state: PlaytestWatchState) => void) => {
        const callback = (_event: Electron.IpcRendererEvent, state: PlaytestWatchState) => listener(state);
        ipcRenderer.on("ohmygame:agent-playtest-state", callback);
        return () => ipcRenderer.removeListener("ohmygame:agent-playtest-state", callback);
      },
    }),
    updates: Object.freeze({
      state: () => ipcRenderer.invoke("ohmygame:update-state") as Promise<DesktopUpdateState | null>,
      check: () => ipcRenderer.invoke("ohmygame:check-for-update") as Promise<void>,
      download: () => ipcRenderer.invoke("ohmygame:download-update") as Promise<void>,
      install: () => ipcRenderer.invoke("ohmygame:install-update") as Promise<void>,
      onState: (listener: (state: DesktopUpdateState) => void) => {
        const callback = (_event: Electron.IpcRendererEvent, state: DesktopUpdateState) => listener(state);
        ipcRenderer.on("ohmygame:update-state", callback);
        return () => ipcRenderer.removeListener("ohmygame:update-state", callback);
      },
    }),
    auth: Object.freeze({
      callbackUrl: () => ipcRenderer.invoke("ohmygame:auth-callback-url") as Promise<string>,
      cancel: () => ipcRenderer.invoke("ohmygame:cancel-auth") as Promise<void>,
      openUrl: (url: string) => ipcRenderer.invoke("ohmygame:open-auth-url", url) as Promise<void>,
      takeCallback: () => ipcRenderer.invoke("ohmygame:take-auth-callback") as Promise<string | undefined>,
      onCallback: (listener: () => void) => {
        const callback = () => listener();
        ipcRenderer.on("ohmygame:auth-callback", callback);
        return () => ipcRenderer.removeListener("ohmygame:auth-callback", callback);
      },
    }),
  }));
}
