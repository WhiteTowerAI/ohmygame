export interface WebGamePlayerRequest {
  path: string;
  viewport: { width: number; height: number };
}

export interface WebGamePlayerState {
  projectId: string;
  open: boolean;
  /** The desktop game keeps its client identity when it moves between windows. */
  client?: string;
  error?: string;
}

export interface WebGamePreviewLayout {
  bounds: { x: number; y: number; width: number; height: number };
  visible: boolean;
}

export interface DesktopWebGamePreviewBridge {
  attach(projectId: string, attachment: string, url: string, layout: WebGamePreviewLayout): Promise<void>;
  layout(projectId: string, attachment: string, layout: WebGamePreviewLayout): Promise<void>;
  detach(projectId: string, attachment: string): Promise<void>;
  capture(projectId: string): Promise<Uint8Array>;
}

export interface WebGamePlayerBridge {
  preview?: DesktopWebGamePreviewBridge;
  open(projectId: string, request: WebGamePlayerRequest): Promise<void>;
  state(projectId: string): Promise<WebGamePlayerState>;
  close(projectId: string): Promise<void>;
  /** Follows a restarted development server without resetting a running game otherwise. */
  refresh(projectId: string, reload?: boolean): Promise<void>;
  onState(listener: (state: WebGamePlayerState) => void): () => void;
}

/** User games run on the project's server without enabling the AI test bridge. */
export function webGamePlayerUrl(baseValue: string, path = "/"): string {
  const base = new URL(baseValue);
  const loopback = ["127.0.0.1", "localhost", "[::1]"].includes(base.hostname);
  if (base.protocol !== "http:" || !loopback || base.username || base.password) {
    throw new Error("Play requires a local game server.");
  }
  const url = new URL(path, base);
  if (url.origin !== base.origin || url.username || url.password) {
    throw new Error("Play must stay on the project's game server.");
  }
  url.searchParams.delete("ohmygamePlaytest");
  return url.href;
}
