import { contextBridge, ipcRenderer } from "electron";
import type { DesktopUpdateState } from "../shared/desktop-update.js";
import type { ProjectFileOpenMode } from "../shared/contracts.js";
import type { PlaytestWatchState } from "../shared/playtest.js";

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
    setAppearance: (appearance: "system" | "light" | "dark") =>
      ipcRenderer.invoke("ohmygame:set-appearance", appearance) as Promise<void>,
    openExternal: (url: string) => ipcRenderer.invoke("ohmygame:open-auth-url", url) as Promise<void>,
    openProjectFile: (projectId: string, filePath: string, mode: ProjectFileOpenMode = "default") =>
      ipcRenderer.invoke("ohmygame:open-project-file", projectId, filePath, mode) as Promise<void>,
    browsePluginDirectory: (pluginId: string) => ipcRenderer.invoke("ohmygame:browse-plugin-directory", pluginId) as Promise<void>,
    revealPluginSkill: (pluginId: string, skillId: string) => ipcRenderer.invoke("ohmygame:reveal-plugin-skill", pluginId, skillId) as Promise<void>,
    selectPluginDirectory: () => ipcRenderer.invoke("ohmygame:select-plugin-directory") as Promise<string | undefined>,
    selectProjectDirectory: () => ipcRenderer.invoke("ohmygame:select-project-directory") as Promise<string | undefined>,
    capturePage: (bounds: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke("ohmygame:capture-page", bounds) as Promise<Uint8Array>,
    captureNodeThumbnail: (projectId: string, nodeId: string, viewport: { width: number; height: number }) =>
      ipcRenderer.invoke("ohmygame:capture-node-thumbnail", projectId, nodeId, viewport) as Promise<boolean>,
    finishNodeThumbnail: (captured: boolean) => ipcRenderer.invoke("ohmygame:finish-node-thumbnail", captured) as Promise<void>,
    openPlaytest: (projectId: string, chapterId: string, viewport: { width: number; height: number }) =>
      ipcRenderer.invoke("ohmygame:open-playtest", projectId, chapterId, viewport) as Promise<void>,
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
