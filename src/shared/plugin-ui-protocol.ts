// The bridge between a plugin's sandboxed page and the app. The page loads in
// a frame with only `allow-scripts`, so its origin is opaque: no cookies, no
// storage of its own, no access to the app or the daemon. Once it loads, the
// host transfers one end of a MessageChannel to it; every request comes back
// on that port, so only that frame can make them, and each is checked against
// the plugin's capabilities before it runs.
import { THEME_TOKENS } from "./plugin-manifest.js";

export const PLUGIN_UI_PROTOCOL_VERSION = 1;

/**
 * The design tokens a page gets on its `:root`, with the values the app has
 * now: the colours a theme sets, then the roles, type, shape, space and motion
 * the app's own components use (`src/renderer/ui/tokens.css`). Pages and
 * `plugin-ui.css` use these names, so a release may add tokens but never
 * renames or removes one.
 */
export const PAGE_TOKENS = [
  ...THEME_TOKENS,
  ...[
    "app",
    "stage",
    "surface",
    "surface-raised",
    "hover",
    "selected",
    "border",
    "border-strong",
    "text",
    "text-secondary",
    "text-tertiary",
    "ink",
    "on-ink",
    "focus",
    "control-thumb",
    "success",
    "danger",
    "warning",
  ].map((role) => `--color-${role}`),
  "--shadow-hairline",
  "--shadow-float",
  "--font-sans",
  "--font-mono",
  ...["xs", "sm", "md", "lg", "xl"].map((size) => `--text-${size}`),
  ...["regular", "medium", "semibold"].map((weight) => `--weight-${weight}`),
  ...["sm", "md", "lg", "pill"].map((size) => `--radius-${size}`),
  ...[1, 2, 3, 4, 6].map((step) => `--space-${step}`),
  "--ease-out",
  "--duration-fast",
  "--duration-base",
] as const;

/** The handshake the host posts to the frame, with the port as its only transfer. */
export const PLUGIN_UI_HANDSHAKE = "ohmygame-plugin-ui";

/** A request or value larger than this is refused. */
export const PLUGIN_UI_MESSAGE_MAX_BYTES = 256 * 1024;
/** Each plugin's storage in a project, all keys together. */
export const PLUGIN_UI_STORAGE_MAX_BYTES = 1024 * 1024;

export const PLUGIN_UI_METHODS = [
  "theme.get",
  "project.info",
  "storage.get",
  "storage.set",
  "selection.get",
  "composer.fill",
  "command.run",
  "ui.toast",
  "ui.confirm",
  "files.list",
  "files.read",
  "files.write",
  "files.createFolder",
  "files.move",
  "files.delete",
] as const;

export type PluginUiMethod = (typeof PLUGIN_UI_METHODS)[number];

export interface PluginUiRequest {
  id: number;
  method: PluginUiMethod;
  params?: Record<string, unknown>;
}

export type PluginUiReply =
  | { id: number; result: unknown }
  | { id: number; error: string };

/** What the host tells a page without being asked. */
export type PluginUiEvent =
  | { event: "theme"; tokens: Record<string, string>; appearance: "dark" | "light" }
  | { event: "visibility"; visible: boolean }
  | { event: "files" }
  /** How one of the plugin's own commands is going while it runs, by its id in the manifest. */
  | { event: "progress"; command: string; message: string }
  /** A command the person ran from the panel's toolbar finished; it has `error` if it failed. */
  | { event: "command"; command: string; result?: unknown; error?: string };

export const PLUGIN_UI_TOAST_TONES = ["default", "success", "danger"] as const;
export type PluginUiToastTone = (typeof PLUGIN_UI_TOAST_TONES)[number];

/** What a page asks the person with `ui.confirm`. */
export interface PluginUiConfirm {
  title: string;
  message?: string;
  confirmLabel?: string;
}

/** A plugin's brand colour, or one for each appearance. */
export type PluginAccent = string | { light?: string; dark?: string };

export interface PluginUiCapabilities {
  "project.selection"?: boolean;
  composer?: boolean;
  "project.files"?: "read" | "write";
}

/** The capability a method needs beyond what every page has. */
const NEEDS: Partial<Record<PluginUiMethod, "project.selection" | "composer">> = {
  "selection.get": "project.selection",
  "composer.fill": "composer",
};

/** How much of `project.files` a method needs; writing covers reading. */
const FILE_NEEDS: Partial<Record<PluginUiMethod, "read" | "write">> = {
  "files.list": "read",
  "files.read": "read",
  "files.write": "write",
  "files.createFolder": "write",
  "files.move": "write",
  "files.delete": "write",
};

/** A path a page gave, of a sane length; the daemon decides whether it may use it. */
const filePath = (value: unknown) => typeof value === "string" && value.length > 0 && value.length <= 1000 && !value.includes("\0");

const STORAGE_KEY = /^[A-Za-z0-9._-]{1,100}$/;

/** Text with something to read, of at most `max` characters. */
const text = (value: unknown, max: number) => typeof value === "string" && value.trim().length > 0 && value.length <= max;

/**
 * Checks a message from a page: its shape, size and parameters. Returns the
 * request, or why it is refused. A refused message with a usable id gets an
 * error reply; one without is dropped.
 */
export function readPluginUiRequest(
  value: unknown,
): { ok: true; request: PluginUiRequest } | { ok: false; id?: number; error: string } {
  if (!value || typeof value !== "object") return { ok: false, error: "not a request" };
  const { id, method, params } = value as Record<string, unknown>;
  if (!Number.isSafeInteger(id) || (id as number) < 0) return { ok: false, error: "no id" };
  const fail = (error: string) => ({ ok: false as const, id: id as number, error });
  if (!(PLUGIN_UI_METHODS as readonly unknown[]).includes(method)) return fail(`unknown method ${String(method)}`);
  if (params !== undefined && (typeof params !== "object" || params === null || Array.isArray(params)))
    return fail("params must be an object");
  let size: number;
  try {
    size = new TextEncoder().encode(JSON.stringify(value)).length;
  } catch {
    return fail("the request can't be sent as JSON");
  }
  if (size > PLUGIN_UI_MESSAGE_MAX_BYTES) return fail("the request is too large");
  const p = (params ?? {}) as Record<string, unknown>;
  switch (method as PluginUiMethod) {
    case "storage.get":
      if (typeof p.key !== "string" || !STORAGE_KEY.test(p.key)) return fail("storage keys are 1-100 letters, digits, dots, dashes or underscores");
      break;
    case "storage.set":
      if (typeof p.key !== "string" || !STORAGE_KEY.test(p.key)) return fail("storage keys are 1-100 letters, digits, dots, dashes or underscores");
      if (!("value" in p)) return fail("storage.set needs a value; null removes the key");
      break;
    case "composer.fill":
      if (typeof p.text !== "string" || p.text.length > 20_000) return fail("composer.fill needs text of at most 20,000 characters");
      break;
    case "command.run":
      if (typeof p.command !== "string" || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(p.command)) return fail("command.run needs one of the plugin's command ids");
      break;
    case "ui.toast":
      if (!text(p.message, 500)) return fail("ui.toast needs a message of at most 500 characters");
      if (p.tone !== undefined && !(PLUGIN_UI_TOAST_TONES as readonly unknown[]).includes(p.tone)) return fail(`ui.toast's tone is one of ${PLUGIN_UI_TOAST_TONES.join(", ")}`);
      break;
    case "ui.confirm":
      if (!text(p.title, 200)) return fail("ui.confirm needs a title of at most 200 characters");
      if (p.message !== undefined && !text(p.message, 1000)) return fail("ui.confirm's message is at most 1,000 characters");
      if (p.confirmLabel !== undefined && !text(p.confirmLabel, 40)) return fail("ui.confirm's confirmLabel is at most 40 characters");
      break;
    case "files.list":
      if (p.path !== undefined && !filePath(p.path)) return fail("files.list's path is a path in the project");
      if (p.recursive !== undefined && typeof p.recursive !== "boolean") return fail("files.list's recursive is true or false");
      break;
    case "files.read":
    case "files.createFolder":
    case "files.delete":
      if (!filePath(p.path)) return fail(`${String(method)} needs a path in the project`);
      break;
    case "files.write":
      if (!filePath(p.path)) return fail("files.write needs a path in the project");
      // A blob isn't in the size above: it is the point of sending one.
      if (typeof p.data !== "string" && !(typeof Blob !== "undefined" && p.data instanceof Blob)) return fail("files.write's data is a string or a Blob");
      break;
    case "files.move":
      if (!filePath(p.from) || !filePath(p.to)) return fail("files.move needs from and to, paths in the project");
      break;
  }
  return { ok: true, request: { id: id as number, method: method as PluginUiMethod, ...(params ? { params: p } : {}) } };
}

/** Why a plugin may not call a method, or undefined when it may. */
export function pluginUiRefusal(
  method: PluginUiMethod,
  capabilities: PluginUiCapabilities,
): string | undefined {
  const files = FILE_NEEDS[method];
  if (files) {
    const allowed = capabilities["project.files"];
    return allowed === "write" || allowed === files ? undefined : `${method} needs the project.files capability set to ${files}`;
  }
  const needed = NEEDS[method];
  return needed && capabilities[needed] !== true
    ? `${method} needs the ${needed} capability`
    : undefined;
}

/**
 * Whether a frame showing a plugin page may go to `to`: only to another file
 * of the same plugin version, so a page can't swap itself for one outside
 * its policy, or carry what it read away in a URL. Frames that don't show a
 * plugin page are not this rule's concern.
 */
export function pluginFrameNavigationAllowed(from: string, to: string, pluginUiOrigin: string): boolean {
  let source: URL;
  try {
    source = new URL(from);
  } catch {
    return true;
  }
  if (source.origin !== pluginUiOrigin) return true;
  const prefix = source.pathname.split("/").slice(0, 4).join("/");
  try {
    const target = new URL(to);
    return target.origin === pluginUiOrigin && prefix.split("/").length === 4 && target.pathname.startsWith(`${prefix}/`);
  } catch {
    return false;
  }
}

/** The contrast a brand colour needs against the panel's surface, as any control does (WCAG 1.4.11). */
export const PLUGIN_ACCENT_MIN_CONTRAST = 3;

/** A `#rgb`, `#rrggbb` or `rgb()` colour's channels, 0 to 255. Other forms aren't read. */
function channels(color: string): [number, number, number] | undefined {
  const value = color.trim();
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(value)?.[1];
  if (hex) {
    const full = hex.length === 3 ? [...hex].map((digit) => digit + digit).join("") : hex;
    return [0, 2, 4].map((at) => Number.parseInt(full.slice(at, at + 2), 16)) as [number, number, number];
  }
  const rgb = /^rgba?\(\s*(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)[\s,]+(\d+(?:\.\d+)?)\s*(?:[,/]\s*1(?:\.0+)?\s*|[,/]\s*100%\s*)?\)$/i.exec(value);
  return rgb ? [Number(rgb[1]), Number(rgb[2]), Number(rgb[3])] : undefined;
}

/** WCAG's contrast between two colours, from 1 to 21. */
function contrast(a: [number, number, number], b: [number, number, number]): number {
  const luminance = (color: [number, number, number]) => {
    const [red, green, blue] = color.map((channel) => {
      const value = channel / 255;
      return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
    }) as [number, number, number];
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue;
  };
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

const WHITE: [number, number, number] = [255, 255, 255];
const BLACK: [number, number, number] = [0, 0, 0];

/**
 * `--omg-accent` and the text that goes on it, for a page in this appearance:
 * the plugin's brand colour if it stands out from the surface, otherwise the
 * app's accent, so no plugin's colour makes its progress hard to see. A
 * surface it can't read counts as not standing out.
 */
export function accentTokens(
  accent: PluginAccent | undefined,
  appearance: "dark" | "light",
  tokens: Record<string, string>,
): Record<string, string> {
  const wanted = typeof accent === "string" ? accent : accent?.[appearance];
  const brand = wanted ? channels(wanted) : undefined;
  const surface = channels(tokens["--color-surface"] ?? "");
  if (wanted && brand && surface && contrast(brand, surface) >= PLUGIN_ACCENT_MIN_CONTRAST)
    return { "--omg-accent": wanted, "--omg-on-accent": contrast(brand, WHITE) >= contrast(brand, BLACK) ? "#ffffff" : "#000000" };
  return { "--omg-accent": tokens["--color-accent"] ?? "", "--omg-on-accent": tokens["--color-on-accent"] ?? "" };
}
