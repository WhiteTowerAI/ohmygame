// The bridge between a plugin's sandboxed page and the app. The page loads in
// a frame with only `allow-scripts`, so its origin is opaque: no cookies, no
// storage of its own, no access to the app or the daemon. Once it loads, the
// host transfers one end of a MessageChannel to it; every request comes back
// on that port, so only that frame can make them, and each is checked against
// the plugin's capabilities before it runs.

export const PLUGIN_UI_PROTOCOL_VERSION = 1;

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
  /** How one of the plugin's own commands is going while it runs, by its id in the manifest. */
  | { event: "progress"; command: string; message: string };

export interface PluginUiCapabilities {
  "project.selection"?: boolean;
  composer?: boolean;
}

/** The capability a method needs beyond what every page has. */
const NEEDS: Partial<Record<PluginUiMethod, keyof PluginUiCapabilities>> = {
  "selection.get": "project.selection",
  "composer.fill": "composer",
};

const STORAGE_KEY = /^[A-Za-z0-9._-]{1,100}$/;

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
  }
  return { ok: true, request: { id: id as number, method: method as PluginUiMethod, ...(params ? { params: p } : {}) } };
}

/** Why a plugin may not call a method, or undefined when it may. */
export function pluginUiRefusal(
  method: PluginUiMethod,
  capabilities: PluginUiCapabilities,
): string | undefined {
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
