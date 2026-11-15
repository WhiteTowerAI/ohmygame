import type { BrowserState } from "./browser.js";
import type { PlaytestAction, PlaytestElement } from "./playtest.js";

export type BrowserAction =
  | Extract<PlaytestAction, { type: "click" | "type" | "press" | "wait" }>
  | { type: "scroll"; x: number; y: number; deltaX?: number; deltaY: number };
export type BrowserUseOperation =
  "tabs" | "open" | "navigate" | "read" | "act" | "capture" | "close";
export interface BrowserUseRequest {
  projectId: string;
  operation: BrowserUseOperation;
  tabId?: string;
  url?: string;
  actions?: BrowserAction[];
}
export interface BrowserPage {
  url: string;
  title: string;
  viewport: { width: number; height: number };
  text: string;
  elements: PlaytestElement[];
}
export interface BrowserUseResult {
  state: BrowserState;
  page?: BrowserPage;
  screenshot?: { data: string; width: number; height: number };
}
export interface BrowserDriver {
  readonly available: boolean;
  request(
    request: BrowserUseRequest,
    signal?: AbortSignal,
  ): Promise<BrowserUseResult>;
  close(): void;
}
