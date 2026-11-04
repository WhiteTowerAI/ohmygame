import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import sharp from "sharp";
import { analyzeBitmap } from "../shared/capture-analysis.js";
import type { GameUseHookInput, GameUseHookResults } from "../shared/extension-host-protocol.js";
import {
  supportsGameUseOperation,
  type GameUseCapabilities,
  type GameUseOperation,
  type GameUseSnapshot,
  type GameRuntimeAdapter,
  type PlaytestCapture,
  type PlaytestRequest,
  type PlaytestResult,
  type PlaytestViewport,
  type PluginGameUseSpec,
} from "../shared/playtest.js";

// A game a plugin runs outside OhMyGame, as `game_use` sees it. The plugin's
// project type declares what it supports (`gameUse`), and its native
// `gameUse` hook does the work. The app owns the session ids the agent sees,
// ties each session to the plugin's version and the host process that
// opened it, and reads every capture from a file it chose. Native code is
// trusted, so these checks catch mistakes, not a plugin set on harm.

/** What the runtime needs from the plugins' native code. */
export interface PluginGameHooks {
  /** Runs the type's `gameUse` hook in the project. */
  call(input: GameUseHookInput, signal?: AbortSignal): Promise<unknown>;
  /** Which start of the project's extension host is running, if one is. */
  generation(): Promise<number | undefined>;
  /** Keeps the project's host running while a session is open. */
  hold(): Promise<(() => void) | undefined>;
  /**
   * The type's `gameUse` as the version the project uses now declares it, or
   * undefined when it no longer has one, or is no longer on.
   */
  current(): Promise<PluginGameUseSpec | undefined>;
}

export interface PluginGameRuntimeOptions {
  /** The project type, `publisher/name:type`. */
  provider: string;
  spec: PluginGameUseSpec;
  hooks: PluginGameHooks;
  /** Where per-capture folders are made; the system's temporary folder when left out. */
  temporaryDirectory?: string;
  /** A session unused for this long is closed. */
  idleMs?: number;
}

/** Sessions one project's game may have open at once, across conversations. */
const MAX_SESSIONS = 4;
const IDLE_MS = 10 * 60_000;
/** Larger files are refused before they are read. */
export const MAX_CAPTURE_BYTES = 32 * 1024 * 1024;
/** Larger images are refused while they are decoded. */
const MAX_CAPTURE_PIXELS = 8192 * 8192;
/** A capture is scaled down to fit this, as a model reads it. */
const CAPTURE_MAX_EDGE = 1568;
const CAPTURE_JPEG_QUALITY = 80;
const MAX_SESSION_ID = 200;
/** What a plugin says about a capture is cut to this many characters. */
const MAX_NOTES = 2_000;

interface Session {
  id: string;
  /** The plugin's own id for it. */
  plugin: string;
  generation: number | undefined;
  release: (() => void) | undefined;
  viewport: PlaytestViewport | undefined;
  /** Requests run one at a time. */
  queue: Promise<unknown>;
  idle: ReturnType<typeof setTimeout> | undefined;
}

export class PluginGameRuntime implements GameRuntimeAdapter {
  readonly available = true;
  readonly capabilities: GameUseCapabilities;
  readonly #options: PluginGameRuntimeOptions;
  readonly #sessions = new Map<string, Session>();
  /** Opens still waiting for the plugin, so the session limit counts them. */
  #opening = 0;
  #closed = false;

  constructor(options: PluginGameRuntimeOptions) {
    this.#options = options;
    this.capabilities = pluginGameCapabilities(options.spec);
  }

  get provider() { return this.#options.provider; }
  get spec() { return this.#options.spec; }

  async request(request: PlaytestRequest, signal?: AbortSignal): Promise<PlaytestResult> {
    signal?.throwIfAborted();
    if (request.operation === "closeAll") {
      await this.#closeAll();
      return { operation: "closeAll" };
    }
    if (this.#closed) throw new Error("This game runtime has closed");
    if (!supportsGameUseOperation(this.capabilities, request.operation))
      throw new Error(`${this.#options.provider} does not support ${request.operation} in game_use`);
    // The project may have moved to a version that dropped it since the tools were made.
    const current = await this.#options.hooks.current();
    if (!current || !supportsGameUseOperation(pluginGameCapabilities(current), request.operation))
      throw new Error(`${this.#options.provider} no longer supports ${request.operation} in game_use; start a new conversation`);
    if (request.operation === "open") {
      if (request.target.runtime !== "plugin" || request.target.provider !== this.#options.provider)
        throw new Error(`This game runtime opens ${this.#options.provider}`);
      return { operation: "open", snapshot: await this.#open(request.viewport, signal) };
    }
    const session = this.#session(request.sessionId);
    return this.#serial(session, async () => {
      // A session whose host restarted is let go without asking the new one.
      if (request.operation === "close") {
        await this.#close(session);
        return { operation: "close" };
      }
      await this.#assertLive(session);
      switch (request.operation) {
        case "inspect":
        case "act": {
          const result = await this.#call(
            request.operation === "act"
              ? { operation: "act", session: session.plugin, actions: request.actions }
              : { operation: "inspect", session: session.plugin },
            signal,
          ) as Partial<GameUseHookResults["act"]> | undefined;
          return { operation: request.operation, snapshot: this.#snapshot(session, result) };
        }
        case "capture":
          return { operation: "capture", capture: await this.#capture(session, undefined, signal) };
        case "captureFrame": {
          const max = current.maxFrame ?? 0;
          if (!Number.isInteger(request.frame) || request.frame < 1 || request.frame > max)
            throw new Error(`frame must be a whole number from 1 to ${max}`);
          return { operation: "captureFrame", capture: await this.#capture(session, request.frame, signal) };
        }
        case "recordStart":
        case "recordStop":
          throw new Error(`${this.#options.provider} does not record video`);
      }
    });
  }

  close(): void {
    void this.#closeAll().finally(() => { this.#closed = true; });
  }

  async #open(viewport: PlaytestViewport | undefined, signal?: AbortSignal): Promise<GameUseSnapshot> {
    if (viewport) validateViewport(viewport);
    if (this.#sessions.size + this.#opening >= MAX_SESSIONS)
      throw new Error(`At most ${MAX_SESSIONS} game sessions can be open in a project; close one first`);
    this.#opening += 1;
    let result: Partial<GameUseHookResults["open"]> | undefined;
    try {
      result = await this.#call(viewport ? { operation: "open", viewport } : { operation: "open" }, signal) as Partial<GameUseHookResults["open"]> | undefined;
    } finally {
      this.#opening -= 1;
    }
    const plugin = result?.session;
    if (typeof plugin !== "string" || !plugin || plugin.length > MAX_SESSION_ID)
      throw new Error(`${this.#options.provider} opened the game without naming its session`);
    const generation = await this.#options.hooks.generation();
    const release = await this.#options.hooks.hold();
    const session: Session = {
      id: `plugin-${randomUUID()}`,
      plugin,
      generation,
      release,
      viewport: viewportOf(result?.viewport) ?? viewport,
      queue: Promise.resolve(),
      idle: undefined,
    };
    // Cancelled while the plugin opened it: nobody holds the session, so it closes now.
    if (signal?.aborted || this.#closed) {
      await this.#close(session);
      signal?.throwIfAborted();
      throw new Error("This game runtime has closed");
    }
    this.#sessions.set(session.id, session);
    this.#touch(session);
    return this.#snapshot(session, result);
  }

  async #capture(session: Session, frame: number | undefined, signal?: AbortSignal): Promise<PlaytestCapture> {
    const folder = await mkdtemp(path.join(this.#options.temporaryDirectory ?? tmpdir(), "ohmygame-capture-"));
    try {
      const output = path.join(folder, "capture.image");
      const result = await this.#call(
        frame === undefined
          ? { operation: "capture", session: session.plugin, output }
          : { operation: "captureFrame", session: session.plugin, output, frame },
        signal,
      ) as Partial<GameUseHookResults["captureFrame"]> | undefined;
      signal?.throwIfAborted();
      const image = await readCapture(output);
      const captured = typeof result?.frame === "number" && Number.isInteger(result.frame) && result.frame > 0 ? result.frame : frame;
      const notes = typeof result?.notes === "string" ? result.notes.trim().slice(0, MAX_NOTES) : "";
      return {
        sessionId: session.id,
        ...image,
        ...(frame === undefined ? {} : { source: "fresh-run" as const, frame: captured }),
        ...(notes ? { notes } : {}),
      };
    } finally {
      await rm(folder, { recursive: true, force: true }).catch(() => {});
    }
  }

  async #close(session: Session): Promise<void> {
    this.#sessions.delete(session.id);
    clearTimeout(session.idle);
    try {
      // A host that restarted has forgotten the session already.
      if (session.generation === await this.#options.hooks.generation())
        await this.#call({ operation: "close", session: session.plugin });
    } finally {
      session.release?.();
    }
  }

  async #closeAll(): Promise<void> {
    await Promise.allSettled([...this.#sessions.values()].map((session) => this.#serial(session, () => this.#close(session))));
  }

  /** The host that opened the session must still be the one running. */
  async #assertLive(session: Session): Promise<void> {
    if (!this.#sessions.has(session.id)) throw new Error(`Game session not found: ${session.id}`);
    if (session.generation !== await this.#options.hooks.generation()) {
      this.#sessions.delete(session.id);
      clearTimeout(session.idle);
      session.release?.();
      throw new Error(`Game session ${session.id} ended because ${this.#options.provider}'s plugin restarted; open a new one`);
    }
    this.#touch(session);
  }

  #session(id: string): Session {
    const session = this.#sessions.get(id);
    if (!session) throw new Error(`Game session not found: ${id}`);
    return session;
  }

  #serial<T>(session: Session, task: () => Promise<T>): Promise<T> {
    const run = session.queue.then(task, task);
    session.queue = run.catch(() => {});
    return run;
  }

  #touch(session: Session): void {
    clearTimeout(session.idle);
    session.idle = setTimeout(() => {
      if (this.#sessions.get(session.id) === session) void this.#serial(session, () => this.#close(session)).catch(() => {});
    }, this.#options.idleMs ?? IDLE_MS);
    session.idle.unref?.();
  }

  #snapshot(session: Session, result: Partial<GameUseHookResults["act"]> | undefined): GameUseSnapshot {
    const viewport = viewportOf(result?.viewport);
    if (viewport) session.viewport = viewport;
    return {
      sessionId: session.id,
      runtime: "plugin",
      capabilities: this.capabilities,
      ...(session.viewport ? { viewport: session.viewport } : {}),
      ...(result?.gameState === undefined ? {} : { gameState: result.gameState }),
    };
  }

  async #call(input: GameUseHookInput, signal?: AbortSignal): Promise<unknown> {
    try {
      return await this.#options.hooks.call(input, signal);
    } catch (error) {
      if (signal?.aborted) throw error;
      const message = error instanceof Error ? error.message : String(error);
      throw new Error(`${this.#options.provider} could not ${input.operation} the game: ${message}`);
    }
  }
}

/** What `game_use` offers for a plugin's declared `gameUse`. */
export function pluginGameCapabilities(spec: PluginGameUseSpec): GameUseCapabilities {
  const captures = spec.operations.includes("capture") || spec.operations.includes("captureFrame");
  const operations: GameUseOperation[] = ["open", ...spec.operations, "close"];
  return {
    runtime: "plugin",
    projectTypes: [],
    input: spec.operations.includes("act") ? [...spec.input ?? []] : [],
    observation: captures ? ["screenshot"] : [],
    deterministic: [],
    watch: false,
    operations,
  };
}

/**
 * Reads the image a plugin wrote: a regular file, not a link, of bounded
 * size, PNG or JPEG of bounded pixels, scaled to fit a model and sent on as
 * JPEG with the same blank check as the web runtime's captures.
 */
export async function readCapture(file: string): Promise<Omit<PlaytestCapture, "sessionId">> {
  let bytes: Buffer;
  const handle = await open(file, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0)).catch((error: NodeJS.ErrnoException) => {
    throw new Error(error.code === "ENOENT" ? "The plugin did not write the capture" : `The capture could not be read: ${error.code ?? error.message}`);
  });
  try {
    const stat = await handle.stat();
    if (!stat.isFile()) throw new Error("The capture is not a file");
    if (stat.size > MAX_CAPTURE_BYTES) throw new Error(`The capture is larger than ${MAX_CAPTURE_BYTES / 1024 / 1024} MB`);
    if (stat.size === 0) throw new Error("The capture is empty");
    bytes = await handle.readFile();
  } finally {
    await handle.close();
  }
  const decode = () => sharp(bytes, { limitInputPixels: MAX_CAPTURE_PIXELS, failOn: "error" });
  const metadata = await decode().metadata().catch(() => undefined);
  if (!metadata || (metadata.format !== "png" && metadata.format !== "jpeg") || !metadata.width || !metadata.height)
    throw new Error("The capture is not a PNG or JPEG image");
  const scaled = () => decode().resize({ width: CAPTURE_MAX_EDGE, height: CAPTURE_MAX_EDGE, fit: "inside", withoutEnlargement: true });
  const [{ data: pixels, info }, jpeg] = await Promise.all([
    scaled().ensureAlpha().raw().toBuffer({ resolveWithObject: true }),
    scaled().flatten({ background: "#000000" }).jpeg({ quality: CAPTURE_JPEG_QUALITY }).toBuffer(),
  ]).catch(() => { throw new Error("The capture could not be decoded"); });
  const scaledDown = info.width !== metadata.width || info.height !== metadata.height;
  return {
    mediaType: "image/jpeg",
    data: jpeg.toString("base64"),
    width: info.width,
    height: info.height,
    ...(scaledDown ? { sourceWidth: metadata.width, sourceHeight: metadata.height } : {}),
    analysis: analyzeBitmap(pixels, info.width, info.height, "rgba"),
  };
}

function viewportOf(value: unknown): PlaytestViewport | undefined {
  if (!value || typeof value !== "object") return undefined;
  const { width, height } = value as Record<string, unknown>;
  return typeof width === "number" && typeof height === "number" && Number.isInteger(width) && Number.isInteger(height) && width > 0 && height > 0 && width <= 8192 && height <= 8192
    ? { width, height }
    : undefined;
}

function validateViewport(viewport: PlaytestViewport): void {
  if (!Number.isInteger(viewport.width) || !Number.isInteger(viewport.height) ||
      viewport.width < 240 || viewport.width > 4096 || viewport.height < 240 || viewport.height > 4096)
    throw new Error("Playtest viewport dimensions must be integers between 240 and 4096");
}
