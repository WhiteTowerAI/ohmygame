import { contextBridge, ipcRenderer } from "electron";

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
