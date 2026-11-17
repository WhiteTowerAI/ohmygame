import type { PluginMcpResult, PluginIcon, StorePlugin } from "./plugins.js";
import type { PluginIconMediaType } from "./plugin-icons.js";
export type PluginIconChange =
  | { icon: PluginIcon | null }
  | { image: { mediaType: PluginIconMediaType; data: string } };
export type PluginIconUpdate = PluginIconChange & { revision: string };
export type PluginSetupMode = "create" | "edit";
/** A workspace's title until its first message names it. */
export const NEW_PLUGIN_TITLE = "New plugin";

/**
 * The plugin id a workspace's draft runs under in its own workspace, as
 * `_draft/<workspace id>`. No installed plugin can have it, as ids have no
 * `_`, so a draft never shares a log, page storage or quarantine with the
 * plugin it may update.
 */
export const DRAFT_PLUGIN_PUBLISHER = "_draft";
/**
 * The folder of a workspace that a draft's pages and code take as their
 * project, so they never change the draft itself.
 */
export const DRAFT_PLAYGROUND = "playground";
const SETUP_ID = /^[0-9a-f-]{36}$/;

export function draftPlugin(setupId: string): string {
  return `${DRAFT_PLUGIN_PUBLISHER}/${setupId}`;
}

/** The workspace a draft's plugin id names, or undefined for any other plugin. */
export function draftSetupId(plugin: string): string | undefined {
  const [publisher, id, ...rest] = plugin.split("/");
  return publisher === DRAFT_PLUGIN_PUBLISHER && id && !rest.length && SETUP_ID.test(id) ? id : undefined;
}

export interface PluginSetupSummary {
  id: string;
  /** The hidden project that holds its conversations. */
  projectId: string;
  mode?: PluginSetupMode;
  pluginId?: string;
  title: string;
  /** Its draft's icon, in the list of workspaces. */
  icon?: PluginIcon;
  createdAt: number;
  updatedAt: number;
  status: "idle" | "working" | "ready" | "installed";
}

/** What a valid draft would install. */
export interface PluginDraftPlugin {
  id: string;
  version: string;
  displayName: string;
  description: string;
  icon?: PluginIcon;
  /** It only adds Skills, so it applies by itself to the projects it suits. */
  appWide: boolean;
  /** What it asks the person to allow. */
  asks: string[];
  skills: Array<{ id: string; name: string; description: string }>;
  mcpServers: Array<{ id: string; title: string }>;
  settings: boolean;
  adds: StorePlugin["adds"];
  /** What its native code can run in the workspace; absent without native code. */
  native?: PluginDraftNative;
}

/** A draft's native code, as the workspace can try it before it is installed. */
export interface PluginDraftNative {
  /** Changes whenever what the draft asks for does, so the person allows it again. */
  key: string;
  tools: Array<{ name: string; description?: string; input?: unknown }>;
  /** Commands that run the draft's code, directly or through a tool. */
  commands: Array<{ id: string; title: string; input?: unknown }>;
  hooks: string[];
}

/** What a draft run returns: its result or error, and what the draft logged meanwhile. */
export interface PluginDraftRun {
  ok: boolean;
  result?: unknown;
  error?: string;
  log: Array<{ at: string; level: string; source: string; text: string }>;
}

export interface PluginDraft {
  path?: string;
  revision?: string;
  installedRevision?: string;
  plugin?: PluginDraftPlugin;
  files: Array<{ path: string; size: number }>;
  errors: string[];
  checks?: Record<string, { revision: string; result: PluginMcpResult }>;
  /** The person allowed the draft's native code to run here, as it asks now. */
  runAllowed?: boolean;
  /** What installing the draft would change in the installed plugin; absent when nothing is installed or nothing changed. */
  update?: PluginDraftUpdate;
}

/** A draft compared with the version of its plugin that is installed. */
export interface PluginDraftUpdate {
  version: { from: string; to: string };
  /** Grants it asks for that the installed version doesn't, and those it no longer asks for. */
  asks: { added: string[]; removed: string[] };
  /** Package files by path; absent when the installed package's files couldn't be read. */
  files?: { added: string[]; removed: string[]; changed: string[] };
}
