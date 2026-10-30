export type Appearance = "system" | "light" | "dark";
type ResolvedAppearance = Exclude<Appearance, "system">;

const APPEARANCE_STORAGE_KEY = "ohmygame:appearance";
const SYSTEM_DARK_QUERY = "(prefers-color-scheme: dark)";
let stopWatchingSystemAppearance: (() => void) | undefined;

export function readAppearance(): Appearance {
  const stored = localStorage.getItem(APPEARANCE_STORAGE_KEY);
  return stored === "light" || stored === "dark" || stored === "system" ? stored : "system";
}

export function setAppearance(appearance: Appearance): void {
  localStorage.setItem(APPEARANCE_STORAGE_KEY, appearance);
  applyAppearance(appearance);
}

/**
 * Applies the appearance to this page and, unless `desktop` is false, tells the
 * desktop app, which themes its windows to match.
 */
export function applyAppearance(appearance: Appearance, { desktop = true }: { desktop?: boolean } = {}): void {
  stopWatchingSystemAppearance?.();
  stopWatchingSystemAppearance = undefined;

  const root = document.documentElement;
  if (desktop) void window.ohMyGameDesktop?.setAppearance(appearance).catch(() => undefined);
  const apply = () => { root.dataset.appearance = resolveAppearance(appearance); };
  apply();

  if (appearance !== "system") return;
  const media = window.matchMedia(SYSTEM_DARK_QUERY);
  const onChange = () => apply();
  media.addEventListener("change", onChange);
  stopWatchingSystemAppearance = () => media.removeEventListener("change", onChange);
}

function resolveAppearance(appearance: Appearance): ResolvedAppearance {
  if (appearance !== "system") return appearance;
  return window.matchMedia(SYSTEM_DARK_QUERY).matches ? "dark" : "light";
}

// The grey ramp and the chat's reading font (Settings → Appearance). Both are
// read by the ui tokens: data-palette swaps the greys, data-chat-font the font.
export type Palette = "neutral" | "warm" | "contrast";
export type ChatFont = "sans" | "serif";

const PALETTE_STORAGE_KEY = "ohmygame:palette";
const CHAT_FONT_STORAGE_KEY = "ohmygame:chat-font";

export function readPalette(): Palette {
  const stored = readStored(PALETTE_STORAGE_KEY);
  return stored === "warm" || stored === "contrast" ? stored : "neutral";
}

export function setPalette(palette: Palette): void {
  writeStored(PALETTE_STORAGE_KEY, palette === "neutral" ? undefined : palette);
  applyPalette(palette);
}

export function applyPalette(palette: Palette): void {
  if (palette === "neutral") delete document.documentElement.dataset.palette;
  else document.documentElement.dataset.palette = palette;
}

export function readChatFont(): ChatFont {
  return readStored(CHAT_FONT_STORAGE_KEY) === "serif" ? "serif" : "sans";
}

export function setChatFont(font: ChatFont): void {
  writeStored(CHAT_FONT_STORAGE_KEY, font === "sans" ? undefined : font);
  applyChatFont(font);
}

export function applyChatFont(font: ChatFont): void {
  if (font === "sans") delete document.documentElement.dataset.chatFont;
  else document.documentElement.dataset.chatFont = font;
}

function readStored(key: string): string | null {
  try { return localStorage.getItem(key); } catch { return null; }
}

function writeStored(key: string, value: string | undefined): void {
  try {
    if (value === undefined) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // Private windows may refuse storage; the choice still applies until reload.
  }
}
