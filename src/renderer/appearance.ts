import { THEME_TOKENS } from "../shared/plugin-manifest.js";
import type { PluginTheme } from "../shared/plugins.js";

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
  // A palette takes the place of a plugin's theme.
  writeStored(PLUGIN_THEME_STORAGE_KEY, undefined);
  applyPluginTheme(undefined);
}

// A plugin's theme, chosen in place of a palette: its values over the neutral
// greys, for the appearances it has values for. They are kept with the choice,
// so the theme applies at launch before the app reaches the daemon.
const PLUGIN_THEME_STORAGE_KEY = "ohmygame:plugin-theme";
const PLUGIN_THEME_STYLE_ID = "ohmygame-plugin-theme";

export function readPluginTheme(): PluginTheme | undefined {
  try {
    const value = JSON.parse(readStored(PLUGIN_THEME_STORAGE_KEY) ?? "null") as unknown;
    return value && typeof value === "object" && typeof (value as PluginTheme).id === "string" ? value as PluginTheme : undefined;
  } catch {
    return undefined;
  }
}

/** Chooses a plugin's theme, or none, in place of a palette. */
export function setPluginTheme(theme: PluginTheme | undefined): void {
  writeStored(PALETTE_STORAGE_KEY, undefined);
  applyPalette("neutral");
  writeStored(PLUGIN_THEME_STORAGE_KEY, theme ? JSON.stringify(theme) : undefined);
  applyPluginTheme(theme);
}

/** The theme's values for one appearance that name a theme token. */
export function pluginThemeValues(theme: Pick<PluginTheme, "dark" | "light">, appearance: "dark" | "light"): Array<[string, string]> {
  const tokens = new Set<string>(THEME_TOKENS);
  return Object.entries(theme[appearance] ?? {}).filter(([token, value]) => tokens.has(token) && typeof value === "string");
}

export function applyPluginTheme(theme: PluginTheme | undefined): void {
  document.getElementById(PLUGIN_THEME_STYLE_ID)?.remove();
  if (!theme) return;
  const style = document.createElement("style");
  style.id = PLUGIN_THEME_STYLE_ID;
  document.head.append(style);
  const sheet = style.sheet;
  if (!sheet) return;
  for (const appearance of ["dark", "light"] as const) {
    const values = pluginThemeValues(theme, appearance);
    if (!values.length) continue;
    // Set one by one: a value the browser can't read is dropped, and none can reach past its rule.
    const rule = sheet.cssRules[sheet.insertRule(`:root[data-appearance="${appearance}"] {}`, sheet.cssRules.length)] as CSSStyleRule;
    for (const [token, value] of values) rule.style.setProperty(token, value);
  }
}

/**
 * Keeps the chosen plugin theme to what its plugin now offers: its newest
 * values, or no theme once the plugin is gone or off.
 */
export async function syncPluginTheme(load: () => Promise<PluginTheme[]>): Promise<void> {
  const current = readPluginTheme();
  if (!current) return;
  const themes = await load().catch(() => undefined);
  // The person may have chosen something else meanwhile.
  if (!themes || JSON.stringify(readPluginTheme()) !== JSON.stringify(current)) return;
  const now = themes.find((theme) => theme.id === current.id);
  if (!now) setPluginTheme(undefined);
  else if (JSON.stringify(now) !== JSON.stringify(current)) setPluginTheme(now);
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
