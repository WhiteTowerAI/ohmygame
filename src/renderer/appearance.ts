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
