import { randomUUID } from "node:crypto";
import { BrowserWindow, type NativeImage, type WebFrameMain } from "electron";
import {
  WEB_GAME_USE_CAPABILITIES,
  type GameRuntimeAdapter,
  type GameUseOpenTarget,
  type PlaytestAction,
  type PlaytestCapture,
  type PlaytestElement,
  type PlaytestFailedRequest,
  type PlaytestLog,
  type PlaytestRequest,
  type PlaytestResult,
  type PlaytestSnapshot,
  type PlaytestTarget,
  type PlaytestViewport,
  type PlaytestWatchState,
} from "../shared/playtest.js";

interface PlaytestSession {
  id: string;
  origin: string;
  window: BrowserWindow;
  ready: boolean;
  logs: PlaytestLog[];
  failedRequests: PlaytestFailedRequest[];
  idleTimer?: ReturnType<typeof setTimeout>;
}

/** A frame of the page and how its coordinates map to the window's. */
interface PlaytestFrame {
  frame: WebFrameMain;
  x: number;
  y: number;
  scaleX: number;
  scaleY: number;
}

type FrameElements = Pick<PlaytestSnapshot, "elements"> & { text: string };

const MAX_LOGS = 100;
const MAX_FAILED_REQUESTS = 100;
const MAX_SESSIONS = 4;
/** Sessions the agent leaves open are closed after this long without a request. */
const IDLE_TIMEOUT_MS = 10 * 60_000;
const MAX_ELEMENTS = 100;
const MAX_TEXT = 4_000;

export class ElectronPlaytestDriver implements GameRuntimeAdapter {
  readonly available = true;
  readonly capabilities = WEB_GAME_USE_CAPABILITIES;
  readonly #sessions = new Map<string, PlaytestSession>();
  readonly #closingSessions = new Set<string>();
  #visible = false;

  constructor(
    private readonly onWatchStateChange?: (state: PlaytestWatchState) => void,
    private readonly idleTimeoutMs = IDLE_TIMEOUT_MS,
  ) {}

  watchState(): PlaytestWatchState {
    return { visible: this.#visible, activeSessions: this.#sessions.size };
  }

  setVisible(visible: boolean): PlaytestWatchState {
    this.#visible = visible;
    for (const state of this.#sessions.values()) {
      if (state.window.isDestroyed() || !state.ready) continue;
      if (visible) {
        state.window.showInactive();
      } else {
        state.window.hide();
      }
    }
    return this.#publishWatchState();
  }

  async request(request: PlaytestRequest, signal?: AbortSignal): Promise<PlaytestResult> {
    signal?.throwIfAborted();
    switch (request.operation) {
      case "open": return { operation: "open", snapshot: await this.#open(request.target, request.viewport, signal) };
      case "inspect": return { operation: "inspect", snapshot: await this.#inspect(this.#activeSession(request.sessionId), signal) };
      case "act": return { operation: "act", snapshot: await this.#act(this.#activeSession(request.sessionId), request.actions, signal) };
      case "capture": return { operation: "capture", capture: await this.#capture(this.#activeSession(request.sessionId), signal) };
      case "close":
        this.#close(request.sessionId);
        return { operation: "close" };
      case "closeAll":
        this.close();
        return { operation: "closeAll" };
    }
  }

  close(): void {
    for (const id of [...this.#sessions.keys()]) this.#close(id);
  }

  async #open(target: GameUseOpenTarget, viewport: PlaytestViewport, signal?: AbortSignal): Promise<PlaytestSnapshot> {
    if (target.runtime !== "web") throw new Error(`Electron game use does not support the ${target.runtime} runtime`);
    const url = validatedPlaytestUrl(target.url);
    validateViewport(viewport);
    if (this.#sessions.size >= MAX_SESSIONS) {
      throw new Error(`Close an existing game session before opening more than ${MAX_SESSIONS}`);
    }
    url.searchParams.set("ohmygamePlaytest", "1");
    const id = randomUUID();
    const window = new BrowserWindow({
      width: viewport.width,
      height: viewport.height,
      useContentSize: true,
      show: false,
      title: "Agent Playtest - View only",
      autoHideMenuBar: true,
      resizable: true,
      maximizable: true,
      fullscreenable: true,
      minWidth: 240,
      minHeight: 240,
      backgroundColor: "#000000",
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        backgroundThrottling: false,
        partition: `ohmygame-playtest-${id}`,
      },
    });
    const state: PlaytestSession = { id, origin: url.origin, window, ready: false, logs: [], failedRequests: [] };
    this.#sessions.set(id, state);
    this.#resetIdleTimer(state);
    this.#publishWatchState();
    window.on("close", (event) => {
      if (this.#closingSessions.has(id)) return;
      event.preventDefault();
      this.setVisible(false);
    });
    window.once("closed", () => {
      clearTimeout(state.idleTimer);
      this.#closingSessions.delete(id);
      if (this.#sessions.delete(id)) this.#publishWatchState();
    });
    window.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    const preventCrossOriginNavigation = (event: { preventDefault(): void }, destination: string) => {
      if (!sameOrigin(destination, state.origin)) event.preventDefault();
    };
    window.webContents.on("will-navigate", preventCrossOriginNavigation);
    window.webContents.on("will-redirect", preventCrossOriginNavigation);
    window.webContents.on("page-title-updated", (event) => event.preventDefault());
    window.webContents.on("console-message", (details) => {
      state.logs.push({
        level: details.level,
        message: truncate(details.message, 4_000),
        ...(details.sourceId ? { source: details.sourceId } : {}),
        ...(details.lineNumber ? { line: details.lineNumber } : {}),
        timestamp: new Date().toISOString(),
      });
      if (state.logs.length > MAX_LOGS) state.logs.splice(0, state.logs.length - MAX_LOGS);
    });
    window.webContents.session.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
      const requestingUrl = details.requestingUrl ?? requestingOrigin;
      return contents === window.webContents && permission === "pointerLock" && details.isMainFrame &&
        sameOrigin(requestingUrl, state.origin);
    });
    window.webContents.session.setPermissionRequestHandler((contents, permission, callback, details) => {
      callback(contents === window.webContents && (permission === "pointerLock" || permission === "keyboardLock") &&
        details.isMainFrame && sameOrigin(details.requestingUrl, state.origin));
    });
    window.webContents.session.on("will-download", (event) => event.preventDefault());
    window.webContents.session.webRequest.onErrorOccurred((details) => {
      if (details.webContentsId !== undefined && details.webContentsId !== window.webContents.id) return;
      state.failedRequests.push({
        url: details.url,
        error: details.error,
        timestamp: new Date(details.timestamp).toISOString(),
      });
      if (state.failedRequests.length > MAX_FAILED_REQUESTS) {
        state.failedRequests.splice(0, state.failedRequests.length - MAX_FAILED_REQUESTS);
      }
    });

    try {
      window.webContents.debugger.attach("1.3");
      await window.loadURL(url.href);
      signal?.throwIfAborted();
      state.ready = true;
      if (this.#visible) window.showInactive();
      return await this.#inspect(state, signal);
    } catch (cause) {
      this.#close(id);
      throw cause;
    }
  }

  async #inspect(state: PlaytestSession, signal?: AbortSignal): Promise<PlaytestSnapshot> {
    signal?.throwIfAborted();
    this.#assertLive(state);
    const page = await state.window.webContents.executeJavaScript(PAGE_INSPECTION_SCRIPT, true) as Omit<PlaytestSnapshot, "sessionId" | "logs" | "failedRequests">;
    // Content in child frames, such as the sandbox that runs Playable Nodes,
    // is listed in window coordinates after the page's own.
    const elements = [...page.elements];
    const text = page.text ? [page.text] : [];
    for (const child of (await this.#frames(state)).slice(1)) {
      const found = await child.frame.executeJavaScript(FRAME_INSPECTION_SCRIPT, true).catch(() => undefined) as FrameElements | undefined;
      if (!found) continue;
      for (const element of found.elements) {
        if (elements.length >= MAX_ELEMENTS) break;
        elements.push({ ...element, index: elements.length, box: frameBox(child, element.box) });
      }
      if (found.text) text.push(found.text);
    }
    signal?.throwIfAborted();
    const visibleText = text.join("\n").slice(0, MAX_TEXT);
    return {
      ...page,
      elements,
      ...(visibleText ? { text: visibleText } : {}),
      sessionId: state.id,
      runtime: this.capabilities.runtime,
      capabilities: this.capabilities,
      logs: [...state.logs],
      failedRequests: [...state.failedRequests],
    };
  }

  async #act(state: PlaytestSession, actions: PlaytestAction[], signal?: AbortSignal): Promise<PlaytestSnapshot> {
    if (actions.length < 1 || actions.length > 20) throw new Error("Provide 1 to 20 playtest actions");
    for (const action of actions) {
      signal?.throwIfAborted();
      this.#assertLive(state);
      await this.#runAction(state, action, signal);
    }
    return this.#inspect(state, signal);
  }

  async #runAction(state: PlaytestSession, action: PlaytestAction, signal?: AbortSignal): Promise<void> {
    const debuggerApi = state.window.webContents.debugger;
    switch (action.type) {
      case "click": {
        const point = await this.#targetPoint(state, action.target);
        await debuggerApi.sendCommand("Input.dispatchMouseEvent", { type: "mouseMoved", ...point });
        await debuggerApi.sendCommand("Input.dispatchMouseEvent", { type: "mousePressed", ...point, button: "left", clickCount: 1 });
        await debuggerApi.sendCommand("Input.dispatchMouseEvent", { type: "mouseReleased", ...point, button: "left", clickCount: 1 });
        await abortableDelay(50, signal);
        return;
      }
      case "type": {
        const target = JSON.stringify(action.target);
        let focused = false;
        for (const frame of await this.#frames(state)) {
          focused = await frame.frame.executeJavaScript(`(${FOCUS_TARGET_SCRIPT})(${target})`, true).catch(() => false) === true;
          if (focused) break;
        }
        if (!focused) throw new Error("Playtest target was not found or is not editable");
        await debuggerApi.sendCommand("Input.insertText", { text: action.text });
        await abortableDelay(50, signal);
        return;
      }
      case "press": {
        const event = keyboardEvent(action.key);
        const duration = action.duration ?? 0;
        if (!Number.isInteger(duration) || duration < 0 || duration > 5_000) {
          throw new Error("Playtest key holds must be between 0 and 5000ms");
        }
        await debuggerApi.sendCommand("Input.dispatchKeyEvent", { type: "keyDown", ...event });
        try {
          await abortableDelay(duration, signal);
        } finally {
          await debuggerApi.sendCommand("Input.dispatchKeyEvent", { type: "keyUp", ...event });
        }
        await abortableDelay(50, signal);
        return;
      }
      case "touch":
        await debuggerApi.sendCommand("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ x: action.x, y: action.y }] });
        await debuggerApi.sendCommand("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await abortableDelay(50, signal);
        return;
      case "wait":
        if (!Number.isInteger(action.milliseconds) || action.milliseconds < 0 || action.milliseconds > 5_000) {
          throw new Error("Playtest waits must be between 0 and 5000ms");
        }
        await abortableDelay(action.milliseconds, signal);
        return;
      case "resize":
        validateViewport(action.viewport);
        state.window.setContentSize(action.viewport.width, action.viewport.height);
        await abortableDelay(100, signal);
        return;
      case "bridge": {
        const value = "value" in action ? action.value : undefined;
        const result = await state.window.webContents.executeJavaScript(`(${BRIDGE_ACTION_SCRIPT})(${JSON.stringify(action.method)}, ${JSON.stringify(value)})`, true);
        if (result !== true) throw new Error(`The game playtest bridge does not support ${action.method}`);
        await abortableDelay(50, signal);
      }
    }
  }

  async #targetPoint(state: PlaytestSession, target: PlaytestTarget): Promise<{ x: number; y: number }> {
    if ("x" in target) return checkedPoint(target);
    for (const frame of await this.#frames(state)) {
      const point = await frame.frame.executeJavaScript(`(${TARGET_POINT_SCRIPT})(${JSON.stringify(target)})`, true).catch(() => undefined) as unknown;
      if (point && typeof point === "object") {
        const { x, y } = point as { x: number; y: number };
        return checkedPoint({ x: frame.x + x * frame.scaleX, y: frame.y + y * frame.scaleY });
      }
    }
    throw new Error("Playtest target was not found or is not visible");
  }

  /**
   * The main frame and its direct child frames. Each child is matched to its
   * iframe element to find where, and at what scale, it is drawn.
   */
  async #frames(state: PlaytestSession): Promise<PlaytestFrame[]> {
    const main = state.window.webContents.mainFrame;
    const frames: PlaytestFrame[] = [{ frame: main, x: 0, y: 0, scaleX: 1, scaleY: 1 }];
    const children = main.frames;
    if (!children.length) return frames;
    const boxes = await main.executeJavaScript(IFRAME_BOXES_SCRIPT, true) as { url: string; x: number; y: number; scaleX: number; scaleY: number }[];
    const unmatched = new Set(boxes.keys());
    for (const frame of children) {
      const index = [...unmatched].find((candidate) => boxes[candidate]!.url === frame.url) ?? [...unmatched][0];
      if (index === undefined) break;
      unmatched.delete(index);
      const { x, y, scaleX, scaleY } = boxes[index]!;
      frames.push({ frame, x, y, scaleX, scaleY });
    }
    return frames;
  }

  async #capture(state: PlaytestSession, signal?: AbortSignal): Promise<PlaytestCapture> {
    signal?.throwIfAborted();
    this.#assertLive(state);
    const image = await state.window.webContents.capturePage();
    signal?.throwIfAborted();
    const { width, height } = image.getSize();
    return {
      sessionId: state.id,
      mediaType: "image/png",
      data: image.toPNG().toString("base64"),
      width,
      height,
      analysis: analyzeNativeImage(image),
    };
  }

  #session(id: string): PlaytestSession {
    const state = this.#sessions.get(id);
    if (!state) throw new Error(`Game session not found: ${id}`);
    return state;
  }

  #activeSession(id: string): PlaytestSession {
    const state = this.#session(id);
    this.#resetIdleTimer(state);
    return state;
  }

  #resetIdleTimer(state: PlaytestSession): void {
    clearTimeout(state.idleTimer);
    state.idleTimer = setTimeout(() => this.#close(state.id), this.idleTimeoutMs);
    state.idleTimer.unref?.();
  }

  #assertLive(state: PlaytestSession): void {
    if (state.window.isDestroyed() || state.window.webContents.isDestroyed()) {
      this.#sessions.delete(state.id);
      throw new Error(`Game session is no longer available: ${state.id}`);
    }
  }

  #close(id: string): void {
    const state = this.#sessions.get(id);
    if (!state) return;
    clearTimeout(state.idleTimer);
    this.#sessions.delete(id);
    this.#publishWatchState();
    if (state.window.webContents.debugger.isAttached()) state.window.webContents.debugger.detach();
    if (!state.window.isDestroyed()) {
      this.#closingSessions.add(id);
      state.window.destroy();
    }
  }

  #publishWatchState(): PlaytestWatchState {
    const state = this.watchState();
    this.onWatchStateChange?.(state);
    return state;
  }
}

export function validatedPlaytestUrl(value: string): URL {
  const url = new URL(value);
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "http:" || !loopback || url.username || url.password) {
    throw new Error("Game use only supports local HTTP preview URLs");
  }
  return url;
}

export function analyzeBitmap(bitmap: Uint8Array, width: number, height: number) {
  const pixels = Math.min(width * height, Math.floor(bitmap.length / 4));
  if (pixels < 1) return { sampledPixels: 0, opaqueRatio: 0, luminanceMean: 0, luminanceVariance: 0, likelyBlank: true };
  const stride = Math.max(1, Math.floor(pixels / 10_000));
  let sampledPixels = 0;
  let opaquePixels = 0;
  let luminanceSum = 0;
  let squaredSum = 0;
  for (let pixel = 0; pixel < pixels; pixel += stride) {
    const offset = pixel * 4;
    const blue = bitmap[offset] ?? 0;
    const green = bitmap[offset + 1] ?? 0;
    const red = bitmap[offset + 2] ?? 0;
    const alpha = bitmap[offset + 3] ?? 0;
    const luminance = 0.2126 * red + 0.7152 * green + 0.0722 * blue;
    sampledPixels++;
    if (alpha > 8) opaquePixels++;
    luminanceSum += luminance;
    squaredSum += luminance * luminance;
  }
  const luminanceMean = luminanceSum / sampledPixels;
  const luminanceVariance = Math.max(0, squaredSum / sampledPixels - luminanceMean * luminanceMean);
  const opaqueRatio = opaquePixels / sampledPixels;
  return {
    sampledPixels,
    opaqueRatio: rounded(opaqueRatio),
    luminanceMean: rounded(luminanceMean),
    luminanceVariance: rounded(luminanceVariance),
    likelyBlank: opaqueRatio < 0.01 || luminanceVariance < 1,
  };
}

function analyzeNativeImage(image: NativeImage): PlaytestCapture["analysis"] {
  const { width, height } = image.getSize();
  return analyzeBitmap(image.toBitmap(), width, height);
}

function validateViewport(viewport: PlaytestViewport): void {
  if (!Number.isInteger(viewport.width) || !Number.isInteger(viewport.height) ||
      viewport.width < 240 || viewport.width > 4096 || viewport.height < 240 || viewport.height > 4096) {
    throw new Error("Playtest viewport dimensions must be integers between 240 and 4096");
  }
}

function sameOrigin(value: string, origin: string): boolean {
  try { return new URL(value).origin === origin; } catch { return false; }
}

function frameBox(frame: PlaytestFrame, box: PlaytestElement["box"]): PlaytestElement["box"] {
  return {
    x: Math.round(frame.x + box.x * frame.scaleX),
    y: Math.round(frame.y + box.y * frame.scaleY),
    width: Math.round(box.width * frame.scaleX),
    height: Math.round(box.height * frame.scaleY),
  };
}

function checkedPoint(value: { x: number; y: number }): { x: number; y: number } {
  if (!Number.isFinite(value.x) || !Number.isFinite(value.y) || value.x < 0 || value.y < 0 || value.x > 8192 || value.y > 8192) {
    throw new Error("Playtest coordinates must be between 0 and 8192");
  }
  return { x: Math.round(value.x), y: Math.round(value.y) };
}

function keyboardEvent(key: string): { key: string; code: string; text?: string } {
  if (!key || key.length > 40) throw new Error("Invalid playtest key");
  const aliases: Record<string, string> = { " ": "Space", Escape: "Escape", Enter: "Enter", Tab: "Tab" };
  return { key, code: aliases[key] ?? key, ...(key.length === 1 ? { text: key } : {}) };
}

async function abortableDelay(milliseconds: number, signal?: AbortSignal): Promise<void> {
  if (signal?.aborted) throw new DOMException("Game use request aborted", "AbortError");
  await new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(done, milliseconds);
    const onAbort = () => done(new DOMException("Game use request aborted", "AbortError"));
    signal?.addEventListener("abort", onAbort, { once: true });
    function done(error?: Error) {
      clearTimeout(timeout);
      signal?.removeEventListener("abort", onAbort);
      if (error) reject(error);
      else resolve();
    }
  });
}

function truncate(value: string, limit: number): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}...`;
}

function rounded(value: number): number {
  return Math.round(value * 1_000) / 1_000;
}

const TARGET_HELPERS = String.raw`
const INTERACTIVE = "button, a, input, textarea, select, [role], [data-testid], [onclick], [tabindex]:not([tabindex=\"-1\"])";
const deepQueryAll = (selector) => {
  const found = [];
  const visit = (root) => {
    found.push(...root.querySelectorAll(selector));
    for (const element of root.querySelectorAll("*")) if (element.shadowRoot) visit(element.shadowRoot);
  };
  visit(document);
  return found;
};
const roleFor = (element) => element.getAttribute("role") || ({
  A: "link", BUTTON: "button", INPUT: element.type === "checkbox" ? "checkbox" : element.type === "radio" ? "radio" : "textbox",
  SELECT: "combobox", TEXTAREA: "textbox",
}[element.tagName] || "");
const nameFor = (element) => element.getAttribute("aria-label") || element.getAttribute("alt") || element.getAttribute("title") || element.innerText || element.value || "";
const isVisible = (element) => {
  const box = element.getBoundingClientRect();
  return box.width > 0 && box.height > 0 && (!element.checkVisibility || element.checkVisibility({ opacityProperty: true, visibilityProperty: true }));
};
const matches = (element, target) => {
  if (target.testId) return element.getAttribute("data-testid") === target.testId;
  if (target.text) return (element.innerText || element.textContent || "").trim().includes(target.text);
  if (target.role) return roleFor(element) === target.role && (!target.name || nameFor(element).trim().includes(target.name));
  return false;
};
const findTarget = (target) => {
  if (target.selector) { try { return deepQueryAll(target.selector).find(isVisible) || deepQueryAll(target.selector)[0] || null; } catch { return null; } }
  const candidates = deepQueryAll(INTERACTIVE + ", canvas").filter((element) => matches(element, target));
  return candidates.find(isVisible) || candidates[0] || null;
};
const clean = (value, limit = 300) => String(value || "").replace(/\s+/g, " ").trim().slice(0, limit);
const listElements = () => deepQueryAll(INTERACTIVE)
  .filter(isVisible)
  .slice(0, 100)
  .map((element, index) => {
    const box = element.getBoundingClientRect();
    const role = roleFor(element);
    const name = clean(nameFor(element));
    const text = clean(element.innerText || element.textContent);
    const testId = element.getAttribute("data-testid") || "";
    return {
      index,
      tag: element.tagName.toLowerCase(),
      ...(role ? { role } : {}),
      ...(name ? { name } : {}),
      ...(text ? { text } : {}),
      ...(testId ? { testId } : {}),
      disabled: Boolean(element.disabled || element.getAttribute("aria-disabled") === "true"),
      box: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
    };
  });
const visibleText = () => {
  const parts = [];
  const visit = (root) => {
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_ELEMENT | NodeFilter.SHOW_TEXT);
    for (let node = walker.nextNode(); node; node = walker.nextNode()) {
      if (node.nodeType === Node.ELEMENT_NODE) {
        if (node.shadowRoot) visit(node.shadowRoot);
        continue;
      }
      const parent = node.parentElement;
      const value = clean(node.textContent, 1000);
      if (value && parent && !["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE"].includes(parent.tagName) && isVisible(parent)) parts.push(value);
    }
  };
  if (document.body) visit(document.body);
  return clean(parts.join(" "), 4000);
};`;

const TARGET_POINT_SCRIPT = `(target) => { ${TARGET_HELPERS}
  const element = findTarget(target);
  if (!element) return null;
  const box = element.getBoundingClientRect();
  if (box.width <= 0 || box.height <= 0) return null;
  return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
}`;

const FOCUS_TARGET_SCRIPT = `(target) => { ${TARGET_HELPERS}
  const element = findTarget(target);
  if (!(element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement || element instanceof HTMLSelectElement || element?.isContentEditable)) return false;
  element.focus();
  if (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement) element.select();
  return true;
}`;

const BRIDGE_ACTION_SCRIPT = `async (method, value) => {
  const bridge = globalThis.__OHMYGAME_PLAYTEST__;
  if (!bridge || typeof bridge[method] !== "function") return false;
  await bridge[method](value);
  return true;
}`;

/** Where each iframe's content is drawn, including any CSS scale. */
const IFRAME_BOXES_SCRIPT = `(() => { ${TARGET_HELPERS}
  return deepQueryAll("iframe").map((frame) => {
    const box = frame.getBoundingClientRect();
    const scaleX = frame.offsetWidth ? box.width / frame.offsetWidth : 1;
    const scaleY = frame.offsetHeight ? box.height / frame.offsetHeight : 1;
    return { url: frame.src, x: box.x + frame.clientLeft * scaleX, y: box.y + frame.clientTop * scaleY, scaleX, scaleY };
  });
})()`;

const FRAME_INSPECTION_SCRIPT = `(() => { ${TARGET_HELPERS}
  return { elements: listElements(), text: visibleText() };
})()`;

const PAGE_INSPECTION_SCRIPT = `(async () => { ${TARGET_HELPERS}
  const elements = listElements();
  const canvases = Array.from(document.querySelectorAll("canvas")).map((canvas, index) => {
    const box = canvas.getBoundingClientRect();
    const style = getComputedStyle(canvas);
    return {
      index,
      width: canvas.width,
      height: canvas.height,
      box: { x: Math.round(box.x), y: Math.round(box.y), width: Math.round(box.width), height: Math.round(box.height) },
      visible: box.width > 0 && box.height > 0 && style.visibility !== "hidden" && style.display !== "none" && Number(style.opacity) > 0,
    };
  });
  const bridge = globalThis.__OHMYGAME_PLAYTEST__;
  const capabilities = bridge && typeof bridge === "object"
    ? ["snapshot", "reset", "setSeed", "step"].filter((name) => typeof bridge[name] === "function")
    : [];
  let gameState;
  if (capabilities.includes("snapshot")) {
    try { gameState = JSON.parse(JSON.stringify(await bridge.snapshot())); }
    catch (error) { gameState = { playtestBridgeError: error instanceof Error ? error.message : String(error) }; }
  }
  const text = visibleText();
  return {
    url: location.href,
    title: document.title,
    readyState: document.readyState,
    viewport: { width: innerWidth, height: innerHeight },
    elements,
    canvases,
    ...(text ? { text } : {}),
    ...(gameState !== undefined ? { gameState } : {}),
    ...(capabilities.length ? { bridgeCapabilities: capabilities } : {}),
  };
})()`;
