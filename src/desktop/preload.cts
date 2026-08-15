import { contextBridge } from "electron";

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
  }));
}
