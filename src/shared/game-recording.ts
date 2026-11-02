/** A person's recording stops itself after this long. */
export const GAME_RECORDING_MAX_SECONDS = 5 * 60;
/** An agent's recording stops itself after this long. */
export const AGENT_RECORDING_MAX_SECONDS = 60;
/** Stops early enough for the file to fit the Library's 200 MB upload limit. */
export const GAME_RECORDING_MAX_BYTES = 190 * 1024 * 1024;

/** A finished recording, as saved to the Library. */
export interface GameRecordingSaved {
  assetId: string;
  name: string;
  /** Seconds. */
  duration: number;
  bytes: number;
}

export interface GameRecordingState {
  projectId: string;
  status: "idle" | "recording" | "saving";
  /** While recording: when it started, in milliseconds since the epoch. */
  startedAt?: number;
  /** While recording: when it will stop by itself, in seconds from the start. */
  maxSeconds?: number;
  /** How the recording that just ended came out; announced once. */
  saved?: GameRecordingSaved;
  error?: string;
}

export interface GameRecordingBridge {
  start(projectId: string): Promise<void>;
  stop(projectId: string): Promise<void>;
  state(projectId: string): Promise<GameRecordingState>;
  onState(listener: (state: GameRecordingState) => void): () => void;
  /** Any recording reached the Library, a person's or an agent's. */
  onSaved(listener: () => void): () => void;
}

/** What the desktop asks the hidden recorder page to record. */
export interface GameRecorderSettings {
  /** Bits per second of video. */
  bitrate: number;
  frameRate: number;
  /** The longest side of the video; the game's own shape sets the other. */
  maxEdge: number;
}

export interface GameRecorderStarted {
  mediaType: "video/mp4" | "video/webm";
  extension: "mp4" | "webm";
}

/** What the hidden recorder page may tell the desktop. */
export interface GameRecorderHostBridge {
  chunk(bytes: Uint8Array): void;
  /** Every chunk has been sent. */
  finished(duration: number): void;
  failed(message: string): void;
}

/** The Library's name for a recording, safe on every platform. */
export function gameRecordingFileName(title: string, at: Date, extension: GameRecorderStarted["extension"]): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  const stamp = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}-${pad(at.getMinutes())}-${pad(at.getSeconds())}`;
  // eslint-disable-next-line no-control-regex -- control characters are what this removes.
  const name = title.replace(/[\\/:*?"<>|\u0000-\u001f]/g, "-").replace(/^[.\s]+/, "").trim().slice(0, 120).trim();
  return `${name || "Game"} ${stamp}.${extension}`;
}
