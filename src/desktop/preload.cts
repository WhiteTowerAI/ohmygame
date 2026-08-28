import { contextBridge, ipcRenderer } from "electron";
import type { DesktopUpdateState } from "../shared/desktop-update.js";

function argument(name: string): string {
  const prefix = `--${name}=`;
  const value = process.argv.find((entry) => entry.startsWith(prefix))?.slice(prefix.length);
  if (!value) throw new Error(`Missing desktop runtime argument: ${name}`);
  return value;
}

if (process.isMainFrame) {
  contextBridge.exposeInMainWorld("openGameDesktop", Object.freeze({
    platform: process.platform,
    runtime: Object.freeze({
      daemonUrl: argument("open-game-daemon-url"),
      token: argument("open-game-daemon-token"),
    }),
    openExternal: (url: string) => ipcRenderer.invoke("open-game:open-auth-url", url) as Promise<void>,
    browsePluginDirectory: (pluginId: string) => ipcRenderer.invoke("open-game:browse-plugin-directory", pluginId) as Promise<void>,
    capturePage: (bounds: { x: number; y: number; width: number; height: number }) =>
      ipcRenderer.invoke("open-game:capture-page", bounds) as Promise<Uint8Array>,
    openPlaytest: (projectId: string, chapterId: string) =>
      ipcRenderer.invoke("open-game:open-playtest", projectId, chapterId) as Promise<void>,
    updates: Object.freeze({
      state: () => ipcRenderer.invoke("open-game:update-state") as Promise<DesktopUpdateState | null>,
      check: () => ipcRenderer.invoke("open-game:check-for-update") as Promise<void>,
      download: () => ipcRenderer.invoke("open-game:download-update") as Promise<void>,
      install: () => ipcRenderer.invoke("open-game:install-update") as Promise<void>,
      onState: (listener: (state: DesktopUpdateState) => void) => {
        const callback = (_event: Electron.IpcRendererEvent, state: DesktopUpdateState) => listener(state);
        ipcRenderer.on("open-game:update-state", callback);
        return () => ipcRenderer.removeListener("open-game:update-state", callback);
      },
    }),
    auth: Object.freeze({
      callbackUrl: () => ipcRenderer.invoke("open-game:auth-callback-url") as Promise<string>,
      cancel: () => ipcRenderer.invoke("open-game:cancel-auth") as Promise<void>,
      openUrl: (url: string) => ipcRenderer.invoke("open-game:open-auth-url", url) as Promise<void>,
      takeCallback: () => ipcRenderer.invoke("open-game:take-auth-callback") as Promise<string | undefined>,
      onCallback: (listener: () => void) => {
        const callback = () => listener();
        ipcRenderer.on("open-game:auth-callback", callback);
        return () => ipcRenderer.removeListener("open-game:auth-callback", callback);
      },
    }),
  }));
}
