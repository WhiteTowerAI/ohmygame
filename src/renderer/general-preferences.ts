// Settings → General: choices that stay on this computer. The desktop app
// hears the ones it acts on (keeping the computer awake, updating) from here.

export type OpenTo = "home" | "last";
export type SendKey = "enter" | "mod-enter";

export interface GeneralPreferences {
  /** Where the app opens: Home, or the project open when it last closed. */
  openTo: OpenTo;
  /** Enter sends and Shift + Enter breaks a line, or ⌘/Ctrl + Enter sends and Enter breaks one. */
  sendKey: SendKey;
  /** A system notification when an agent finishes while the window is in the background. */
  runNotifications: boolean;
  /** A short sound at the same moment. */
  runSound: boolean;
  /** No system sleep while an agent works. */
  keepAwake: boolean;
  /** Download a found release in the background and install it on quit. */
  autoUpdate: boolean;
}

const DEFAULTS: GeneralPreferences = {
  openTo: "home",
  sendKey: "enter",
  runNotifications: true,
  runSound: false,
  keepAwake: true,
  autoUpdate: false,
};

const KEYS: Record<keyof GeneralPreferences, string> = {
  openTo: "ohmygame:open-to",
  sendKey: "ohmygame:send-key",
  runNotifications: "ohmygame:run-notifications",
  runSound: "ohmygame:run-sound",
  keepAwake: "ohmygame:keep-awake",
  autoUpdate: "ohmygame:auto-update",
};

const LAST_PROJECT_KEY = "ohmygame:last-project";
export const GENERAL_PREFERENCES_EVENT = "ohmygame:general-preferences";

export function readGeneralPreferences(): GeneralPreferences {
  const openTo = readStored(KEYS.openTo);
  const sendKey = readStored(KEYS.sendKey);
  return {
    openTo: openTo === "last" ? "last" : DEFAULTS.openTo,
    sendKey: sendKey === "mod-enter" ? "mod-enter" : DEFAULTS.sendKey,
    runNotifications: readFlag(KEYS.runNotifications, DEFAULTS.runNotifications),
    runSound: readFlag(KEYS.runSound, DEFAULTS.runSound),
    keepAwake: readFlag(KEYS.keepAwake, DEFAULTS.keepAwake),
    autoUpdate: readFlag(KEYS.autoUpdate, DEFAULTS.autoUpdate),
  };
}

export function setGeneralPreference<K extends keyof GeneralPreferences>(key: K, value: GeneralPreferences[K]): void {
  const stored = value === DEFAULTS[key] ? undefined : typeof value === "boolean" ? (value ? "on" : "off") : String(value);
  writeStored(KEYS[key], stored);
  if (key === "autoUpdate") applyAutoUpdate(value as boolean);
  window.dispatchEvent(new Event(GENERAL_PREFERENCES_EVENT));
}

/** Tells the desktop app whether to update by itself; it asks again each launch. */
export function applyAutoUpdate(enabled = readGeneralPreferences().autoUpdate): void {
  void window.ohMyGameDesktop?.updates?.setAutomatic?.(enabled).catch(() => undefined);
}

/** Whether a key press in a message box sends the message. */
export function sendsMessage(event: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean }, sendKey = readGeneralPreferences().sendKey): boolean {
  if (event.key !== "Enter" || event.shiftKey || event.altKey) return false;
  const modifier = navigator.platform.toLowerCase().includes("mac") ? event.metaKey : event.ctrlKey;
  return sendKey === "enter" || modifier;
}

export function rememberLastProject(projectId: string): void {
  writeStored(LAST_PROJECT_KEY, projectId);
}

export function forgetLastProject(projectId: string): void {
  if (readStored(LAST_PROJECT_KEY) === projectId) writeStored(LAST_PROJECT_KEY, undefined);
}

/** The project to reopen at launch, when the person asked for that and one was open. */
export function launchProject(): string | undefined {
  if (readGeneralPreferences().openTo !== "last") return undefined;
  return readStored(LAST_PROJECT_KEY) ?? undefined;
}

function readFlag(key: string, fallback: boolean): boolean {
  const stored = readStored(key);
  return stored === "on" ? true : stored === "off" ? false : fallback;
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
