export interface PlaytestViewport {
  width: number;
  height: number;
}

export type PlaytestTarget =
  | { selector: string }
  | { testId: string }
  | { text: string }
  | { role: string; name?: string }
  | { x: number; y: number };

export type PlaytestAction =
  | { type: "click"; target: PlaytestTarget }
  | { type: "type"; target: Exclude<PlaytestTarget, { x: number; y: number }>; text: string }
  | { type: "press"; key: string }
  | { type: "touch"; x: number; y: number }
  | { type: "wait"; milliseconds: number }
  | { type: "resize"; viewport: PlaytestViewport }
  | { type: "bridge"; method: "reset" }
  | { type: "bridge"; method: "setSeed" | "step"; value: number };

export interface PlaytestElement {
  index: number;
  tag: string;
  role?: string;
  name?: string;
  text?: string;
  testId?: string;
  disabled: boolean;
  box: { x: number; y: number; width: number; height: number };
}

export interface PlaytestCanvas {
  index: number;
  width: number;
  height: number;
  box: { x: number; y: number; width: number; height: number };
  visible: boolean;
}

export interface PlaytestLog {
  level: "debug" | "info" | "warning" | "error";
  message: string;
  source?: string;
  line?: number;
  timestamp: string;
}

export interface PlaytestFailedRequest {
  url: string;
  error: string;
  timestamp: string;
}

export interface PlaytestSnapshot {
  sessionId: string;
  url: string;
  title: string;
  readyState: string;
  viewport: PlaytestViewport;
  elements: PlaytestElement[];
  canvases: PlaytestCanvas[];
  logs: PlaytestLog[];
  failedRequests: PlaytestFailedRequest[];
  gameState?: unknown;
  bridgeCapabilities?: string[];
}

export interface PlaytestCapture {
  sessionId: string;
  mediaType: "image/png";
  data: string;
  width: number;
  height: number;
  analysis: {
    sampledPixels: number;
    opaqueRatio: number;
    luminanceMean: number;
    luminanceVariance: number;
    likelyBlank: boolean;
  };
}

export interface PlaytestWatchState {
  visible: boolean;
  activeSessions: number;
}

export type PlaytestRequest =
  | { operation: "open"; url: string; viewport: PlaytestViewport }
  | { operation: "inspect"; sessionId: string }
  | { operation: "act"; sessionId: string; actions: PlaytestAction[] }
  | { operation: "capture"; sessionId: string }
  | { operation: "close"; sessionId: string }
  | { operation: "closeAll" };

export type PlaytestResult =
  | { operation: "open"; snapshot: PlaytestSnapshot }
  | { operation: "inspect"; snapshot: PlaytestSnapshot }
  | { operation: "act"; snapshot: PlaytestSnapshot }
  | { operation: "capture"; capture: PlaytestCapture }
  | { operation: "close" | "closeAll" };

export interface PlaytestDriver {
  readonly available: boolean;
  request(request: PlaytestRequest, signal?: AbortSignal): Promise<PlaytestResult>;
  close(): void;
}

export type PlaytestIpcMessage =
  | { channel: "ohmygame:playtest-request"; id: string; request: PlaytestRequest }
  | { channel: "ohmygame:playtest-cancel"; id: string }
  | { channel: "ohmygame:playtest-response"; id: string; result?: PlaytestResult; error?: string };
