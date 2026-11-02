import { contextBridge, ipcRenderer } from "electron";
import type { GameRecorderHostBridge } from "../shared/game-recording.js";

// The hidden recorder page only hands over what it records.
contextBridge.exposeInMainWorld("ohMyGameRecorder", Object.freeze({
  chunk: (bytes) => ipcRenderer.send("ohmygame:game-recorder-chunk", bytes),
  finished: (duration) => ipcRenderer.send("ohmygame:game-recorder-finished", duration),
  failed: (message) => ipcRenderer.send("ohmygame:game-recorder-failed", message),
} satisfies GameRecorderHostBridge));
