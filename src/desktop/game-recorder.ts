import { createWriteStream, mkdtempSync, type WriteStream } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { BrowserWindow, ipcMain, session, webContents, type IpcMainEvent, type WebContents } from "electron";
import { GAME_RECORDING_MAX_BYTES, type GameRecorderSettings, type GameRecorderStarted, type GameRecordingSaved } from "../shared/game-recording.js";

const PARTITION = "ohmygame-game-recorder";
const SETTINGS: GameRecorderSettings = { bitrate: 4_000_000, frameRate: 30, maxEdge: 1280 };
/** How long the page may take to start recording, or to finish the file, before that counts as failed. */
const START_TIMEOUT_MS = 20_000;
const FINISH_TIMEOUT_MS = 20_000;

/** A finished recording, on disk, for the owner to keep. */
export interface GameRecordingFile extends GameRecorderStarted {
  path: string;
  title: string;
  duration: number;
  bytes: number;
}

export interface GameRecorderOptions {
  hostUrl: string;
  preloadPath: string;
  /** Keeps the finished file. It is deleted afterwards, unless this fails. */
  save: (file: GameRecordingFile) => Promise<GameRecordingSaved>;
  /** A recording stopped asking for more and is being saved. */
  onSaving?: (id: string) => void;
}

interface Recording {
  id: string;
  title: string;
  host: BrowserWindow;
  target: WebContents;
  directory: string;
  file: string;
  sink: WriteStream;
  bytes: number;
  started?: GameRecorderStarted;
  /** First the recording's time limit, then the limit on finishing the file. */
  timer?: ReturnType<typeof setTimeout>;
  stopRequested: boolean;
  /** Settles `finished` with the page's last word on this recording. */
  hostFinished: { resolve: (duration: number) => void; reject: (cause: Error) => void };
  finished: Promise<number>;
}

/**
 * Records a game's own page from a hidden window, so it works in Preview, in
 * Play, and while the window is hidden or the game moves between them.
 */
export class GameRecorder {
  readonly #recordings = new Map<string, Recording>();
  readonly #hosts = new Map<number, Recording>();
  #installed = false;

  constructor(private readonly options: GameRecorderOptions) {}

  /** From the start of a recording until it has been saved, because one id records one at a time. */
  isRecording(id: string): boolean {
    return this.#recordings.has(id);
  }

  /**
   * Resolves once frames are being recorded. `outcome` settles when the
   * recording has ended and been saved, however it ended.
   */
  async start(id: string, target: WebContents, { title, maxSeconds }: { title: string; maxSeconds: number }): Promise<{ outcome: Promise<GameRecordingSaved> }> {
    if (this.#recordings.has(id)) throw new Error("This game is already recording.");
    if (target.isDestroyed()) throw new Error("The game is no longer running.");
    this.#install();
    // Synchronous up to the map entry, so that a second start can't get past the check above.
    const directory = mkdtempSync(path.join(tmpdir(), "ohmygame-recording-"));
    const host = new BrowserWindow({
      show: false,
      title: "Game recorder",
      webPreferences: { partition: PARTITION, preload: this.options.preloadPath, sandbox: true, contextIsolation: true, nodeIntegration: false, backgroundThrottling: false },
    });
    let hostFinished!: Recording["hostFinished"];
    const finished = new Promise<number>((resolve, reject) => { hostFinished = { resolve, reject }; });
    finished.catch(() => undefined);
    const file = path.join(directory, "recording");
    const recording: Recording = { id, title, host, target, directory, file, sink: createWriteStream(file), bytes: 0, stopRequested: false, hostFinished, finished };
    recording.sink.on("error", (cause) => recording.hostFinished.reject(cause));
    this.#recordings.set(id, recording);
    this.#hosts.set(host.webContents.id, recording);
    host.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    host.webContents.on("will-navigate", (event) => event.preventDefault());
    host.webContents.on("render-process-gone", () => recording.hostFinished.reject(new Error("The recorder stopped unexpectedly.")));
    const stopWithGame = () => this.stop(id);
    target.once("destroyed", stopWithGame);
    let startLimit: ReturnType<typeof setTimeout> | undefined;
    try {
      recording.started = await Promise.race([
        this.#startPage(recording),
        new Promise<never>((_resolve, reject) => { startLimit = setTimeout(() => reject(new Error("The recording could not be started.")), START_TIMEOUT_MS); }),
        // The recorder crashing or the app closing ends the wait as well.
        recording.finished.then(() => new Promise<never>(() => {})),
      ]);
    } catch (cause) {
      clearTimeout(startLimit);
      target.removeListener("destroyed", stopWithGame);
      await this.#discard(recording);
      throw cause;
    }
    clearTimeout(startLimit);
    if (recording.stopRequested) this.#askToFinish(recording);
    else recording.timer = setTimeout(() => this.stop(id), maxSeconds * 1000);
    return {
      outcome: this.#outcome(recording).finally(() => {
        if (!target.isDestroyed()) target.removeListener("destroyed", stopWithGame);
      }),
    };
  }

  /** Ends a recording; its `outcome` reports the result. Stopping twice is harmless. */
  stop(id: string): void {
    const recording = this.#recordings.get(id);
    if (!recording || recording.stopRequested) return;
    recording.stopRequested = true;
    clearTimeout(recording.timer);
    this.options.onSaving?.(id);
    // A page still starting has nothing to stop yet; `start` asks once it does.
    if (recording.started) this.#askToFinish(recording);
  }

  async #startPage({ host }: Recording): Promise<GameRecorderStarted> {
    await host.loadURL(this.options.hostUrl);
    // Display capture needs a user gesture, which this stands in for: the
    // page is ours, and it only ever captures the target this class names.
    return await host.webContents.executeJavaScript(`window.startRecording(${JSON.stringify(SETTINGS)})`, true) as GameRecorderStarted;
  }

  #askToFinish(recording: Recording): void {
    recording.timer = setTimeout(() => recording.hostFinished.reject(new Error("The recording could not be finished.")), FINISH_TIMEOUT_MS);
    if (recording.host.isDestroyed()) {
      recording.hostFinished.reject(new Error("The recorder stopped unexpectedly."));
      return;
    }
    recording.host.webContents.executeJavaScript("window.stopRecording()").catch((cause: unknown) => {
      recording.hostFinished.reject(cause instanceof Error ? cause : new Error(String(cause)));
    });
  }

  /** Abandons every recording; only for shutting down. */
  close(): void {
    for (const recording of [...this.#recordings.values()]) {
      recording.hostFinished.reject(new Error("The app closed while recording."));
    }
  }

  async #outcome(recording: Recording): Promise<GameRecordingSaved> {
    let duration: number;
    try {
      duration = await recording.finished;
      clearTimeout(recording.timer);
      await this.#closeSink(recording);
    } catch (cause) {
      await this.#discard(recording);
      throw cause;
    }
    let saved: GameRecordingSaved;
    try {
      // The hidden window stays until this is done. Were it the last window,
      // closing it could quit the app, and stop the service, during the upload.
      saved = await this.options.save({ ...recording.started!, path: recording.file, title: recording.title, duration, bytes: recording.bytes });
    } catch (cause) {
      this.#forget(recording);
      // Five minutes of play are worth keeping when the Library can't take them.
      throw new Error(`${cause instanceof Error ? cause.message : String(cause)} The recording is still at ${recording.file}.`, { cause });
    }
    await rm(recording.directory, { recursive: true, force: true }).catch(() => undefined);
    this.#forget(recording);
    return saved;
  }

  #closeSink(recording: Recording): Promise<void> {
    return new Promise((resolve, reject) => {
      // A last write that fails, as on a full disk, must not pass as a whole file.
      if (recording.sink.errored) { reject(recording.sink.errored); return; }
      recording.sink.end((cause?: Error | null) => { if (cause) reject(cause); else resolve(); });
    });
  }

  #forget(recording: Recording): void {
    clearTimeout(recording.timer);
    if (this.#recordings.get(recording.id) === recording) this.#recordings.delete(recording.id);
    if (!recording.host.isDestroyed()) {
      this.#hosts.delete(recording.host.webContents.id);
      recording.host.destroy();
    } else {
      for (const [id, entry] of this.#hosts) if (entry === recording) this.#hosts.delete(id);
    }
  }

  async #discard(recording: Recording): Promise<void> {
    recording.sink.destroy();
    await rm(recording.directory, { recursive: true, force: true }).catch(() => undefined);
    this.#forget(recording);
  }

  #install(): void {
    if (this.#installed) return;
    this.#installed = true;
    session.fromPartition(PARTITION).setDisplayMediaRequestHandler((request, callback) => {
      const contents = request.frame ? webContents.fromFrame(request.frame) : undefined;
      const recording = contents ? this.#hosts.get(contents.id) : undefined;
      if (!recording || recording.target.isDestroyed()) {
        callback({});
        return;
      }
      const frame = recording.target.mainFrame;
      // The game keeps playing through the speakers while it is captured.
      callback({ video: frame, audio: frame, enableLocalEcho: true });
    });
    ipcMain.on("ohmygame:game-recorder-chunk", (event: IpcMainEvent, bytes: unknown) => {
      const recording = this.#hosts.get(event.sender.id);
      if (!recording || !(bytes instanceof Uint8Array) || recording.sink.writableEnded) return;
      recording.bytes += bytes.length;
      recording.sink.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.length));
      if (recording.bytes >= GAME_RECORDING_MAX_BYTES) this.stop(recording.id);
    });
    ipcMain.on("ohmygame:game-recorder-finished", (event: IpcMainEvent, duration: unknown) => {
      const recording = this.#hosts.get(event.sender.id);
      if (!recording) return;
      // The page also finishes by itself when the game goes away.
      if (!recording.stopRequested) this.stop(recording.id);
      recording.hostFinished.resolve(typeof duration === "number" && Number.isFinite(duration) ? duration : 0);
    });
    ipcMain.on("ohmygame:game-recorder-failed", (event: IpcMainEvent, message: unknown) => {
      this.#hosts.get(event.sender.id)?.hostFinished.reject(new Error(typeof message === "string" ? message : "The recording failed."));
    });
  }
}
