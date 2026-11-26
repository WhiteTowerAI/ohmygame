import { Type } from "typebox";
import { Check } from "typebox/value";
import type { PluginMention, ProviderCapability } from "./contracts.js";
import type { PluginCategory } from "./plugin-manifest.js";
import type { PreviewColorFilter } from "./preview-filter.js";
import type { GamepadKeyMap } from "./preview-input.js";

/**
 * What a plugin's model providers can make, as Settings → Providers names
 * them: chat (`language`), and the media kinds their adapters make.
 */
export const PROVIDER_KINDS = ["language", "image", "video", "audio", "3d"] as const satisfies readonly ProviderCapability[];

export type PluginOrigin =
  /**
   * `ref`: the branch or tag it was added from; without one, the default branch.
   * `release`: the tag of a release from the market, or one the app brought
   * along, which updates from the market rather than from a branch.
   */
  | { type: "github"; repository: string; commit: string; ref?: string; release?: string }
  /** No longer added or updated, but what was added from npm before keeps working. */
  | { type: "npm"; package: string; version: string; registry: PluginNpmRegistry }
  /** A folder on this computer being developed: it's added again whenever its files change. */
  | { type: "development"; folder: string };

export const PLUGIN_NPM_REGISTRIES = ["npmjs", "npmmirror"] as const;
/** A registry the app knew by name, or another npm registry by its address. */
export type PluginNpmRegistry = (typeof PLUGIN_NPM_REGISTRIES)[number] | `https://${string}`;

/** The GitHub owner whose releases OhMyGame's own plugins come from. */
export const OHMYGAME_GITHUB_OWNER = "WhiteTowerAI";

/** A repository (`owner/repo`) of OhMyGame's own, where only it releases. */
export const isOfficialRepository = (repository: string) => repository.toLowerCase().startsWith(`${OHMYGAME_GITHUB_OWNER.toLowerCase()}/`);

/**
 * Whether a release on the market, from this GitHub repository (`owner/repo`),
 * joins a plugin installed from `origin`: one from the same repository, or
 * OhMyGame's own from its npm scope, which it now releases on GitHub. Its
 * settings and grants carry over, as from the same source.
 */
export function releaseJoins(origin: PluginOrigin | undefined, repository: string): boolean {
  if (origin?.type === "github") return origin.repository.toLowerCase() === repository.toLowerCase();
  // compat: since beta.5.11, remove from beta.7 and 2026-12-30. OhMyGame's plugins installed from @ohmygame npm packages move to its GitHub releases.
  return origin?.type === "npm" && origin.package.startsWith("@ohmygame/") && (PLUGIN_NPM_REGISTRIES as readonly string[]).includes(origin.registry)
    && isOfficialRepository(repository);
}

/** Where the Add plugin dialog gets a package. A `.tgz` file is uploaded, so it isn't one of these. */
export type PluginAddSource =
  /** A version the market lists, which installs only as the market signed it. */
  | { type: "market"; id: string; version: string }
  | { type: "github"; url: string; commit?: string }
  /** `development`: the folder is added again whenever its files change. */
  | { type: "directory"; path: string; development?: true };

/** A plugin released on GitHub that the market lists, at its newest version. */
export interface MarketPlugin {
  id: string;
  version: string;
  displayName: string;
  description: string;
  /** What it asks to be allowed. */
  asks: string[];
  /** How many of each list its manifest contributes, and how many Skills. */
  adds: Record<string, number>;
  /** The categories this app knows, of those its manifest names. */
  categories?: PluginCategory[];
  /** Words to find it by, which its page shows. */
  keywords?: string[];
  /** The titles of the model providers and agents it adds, which search also reads. */
  names?: string[];
  /** What its model providers make, in the order of `PROVIDER_KINDS`. */
  providerKinds?: ProviderCapability[];
  /** The project types it works in; absent means every type. */
  appliesTo?: string[];
  beta?: boolean;
  longDescription?: string;
  /** Its icon, by its path beside the market's index, which `/plugin-market/images` reads. */
  icon?: string;
  /** Screenshots by their path beside the index, read the same way. */
  screenshots?: Array<{ path: string; caption?: string }>;
  /** GitHub's id for the publisher, whose avatar `/plugin-market/avatars/<id>` reads; only when the source is verified. */
  avatar?: string;
  /** When the listed version was published. */
  publishedAt?: string;
  /** When the package was first published. */
  createdAt?: string;
  /** The listed version's archive, in bytes. */
  size?: number;
  /** Its GitHub repository's page. */
  repository?: string;
  /** The main index checked that the repository's owner is the plugin's publisher. */
  sourceVerified: boolean;
  /** Only when the source is verified. */
  stars?: number;
  featured: boolean;
  /** The index it comes from, when that isn't the main one; its pictures are read from there. */
  source?: string;
}

/** One released version the maintainers blocked. */
export interface MarketBlock {
  /** Its GitHub repository, `owner/repo`. */
  repository: string;
  /** The plugin the version holds, when the index says; a repository can hold several. */
  id?: string;
  version: string;
  reason: string;
}

export interface PluginMarketListing {
  /** `off`: no index is set up. `unavailable`: none could be read. `stale`: the last one, as a new one couldn't be read. */
  status: "off" | "unavailable" | "ready" | "stale";
  plugins: MarketPlugin[];
  blocked: MarketBlock[];
  /** Each index read, the main one first, and whether it could be read. */
  sources?: Array<{ url: string; status: "unavailable" | "ready" | "stale" }>;
}

/**
 * Where a market plugin downloads from. `auto`: OhMyGame's mirror first in
 * Chinese or in mainland China, GitHub first elsewhere, then the other.
 * `proxy`: the person's prefix before the GitHub address.
 */
export const PLUGIN_DOWNLOAD_SOURCES = ["auto", "github", "mirror", "proxy"] as const;
export type PluginDownloadSource = (typeof PLUGIN_DOWNLOAD_SOURCES)[number];

/** Where the market reads from, and its plugins download from, as Discover's settings show it. */
export interface PluginMarketSettings {
  /** The main index's address; empty when there is no market. */
  index: string;
  /** The address the app reads by default. */
  defaultIndex: string;
  /** More indexes, after the main one. */
  extra: string[];
  download: PluginDownloadSource;
  /** The prefix for `proxy`, kept when another source is chosen; empty without one. */
  proxy: string;
}

/** What the person reviews before adding a package. */
export interface PluginAddPreview {
  /** The same source, pinned to what was read: a market version or a commit. */
  source?: PluginAddSource;
  /** Adding checks the package is still this one. */
  digest: string;
  id: string;
  version: string;
  displayName: string;
  description: string;
  appWide: boolean;
  asks: string[];
  /** What it adds, as its plugin page lists it. */
  adds: StorePlugin["adds"];
  settings: boolean;
  /** Versions already installed, so the dialog can say what adding this does to them. */
  installedVersions: string[];
  /** With a version installed: what it asks that the person hasn't allowed yet, the only part asked again. */
  newAsks?: string[];
  origin?: PluginOrigin;
}

export const PLUGIN_MANIFEST_PATH = ".ohmygame-plugin/plugin.json";
export const PLUGIN_ARCHIVE_MAX_ENTRIES = 5_000;
export const PLUGIN_ARCHIVE_MAX_BYTES = 50 * 1024 * 1024;
export const PLUGIN_SKILL_CONTENT_MAX_BYTES = 512 * 1024;
// An escaped @ marks a Markdown-escaped label; historical links keep their literal backslashes.
// A new mention opener ends an unfinished literal label in the surrounding text.
const PLUGIN_MENTION_PATTERN = /\[(?:@((?:[^[\]]|\[(?!\\?@))+)|\\@((?:[^\\[\]]|\\[\\[\]])+))\]\(plugin:\/\/([^@\s)]+)@([^\s)]+)\)/g;

export function pluginMentionToken(mention: Pick<PluginMention, "displayName">): string {
  return `@${mention.displayName.replace(/^@/, "")}`;
}

export function isPluginMention(value: unknown): value is PluginMention {
  if (!value || typeof value !== "object") return false;
  const mention = value as Partial<PluginMention>;
  return typeof mention.name === "string" && typeof mention.displayName === "string" && typeof mention.marketplaceId === "string"
    && (mention.starts === undefined || (Array.isArray(mention.starts) && mention.starts.every((start) => Number.isSafeInteger(start) && start >= 0)));
}

type MentionRange = { start: number; end: number; mention: PluginMention };

/** Selected occurrences are authoritative, even next to punctuation or another word. */
export function pluginMentionRanges(prompt: string, mentions: readonly PluginMention[]): MentionRange[] {
  const ranges: MentionRange[] = [];
  const legacy = new Map<string, PluginMention | null>();
  for (const mention of mentions) {
    const token = pluginMentionToken(mention);
    if (mention.starts === undefined) {
      // compat: keep while positionless conversation history can be opened. An ambiguous label has no recoverable identity.
      const prior = legacy.get(token);
      if (prior === undefined) legacy.set(token, mention);
      else if (prior && (prior.name !== mention.name || prior.marketplaceId !== mention.marketplaceId)) legacy.set(token, null);
      continue;
    }
    for (const start of mention.starts) {
      if (Number.isSafeInteger(start) && start >= 0 && prompt.startsWith(token, start))
        ranges.push({ start, end: start + token.length, mention });
    }
  }
  if (legacy.size) {
    const tokens = [...legacy.keys()].sort((a, b) => b.length - a.length).map(escapeRegExp);
    const pattern = new RegExp(`(?:${tokens.join("|")})(?=$|[\\s\\p{P}])`, "gu");
    for (const match of prompt.matchAll(pattern)) {
      const mention = legacy.get(match[0]);
      if (mention) ranges.push({ start: match.index, end: match.index + match[0].length, mention });
    }
  }
  let end = 0;
  return ranges.sort((a, b) => a.start - b.start).filter((range) => {
    if (range.start < end) return false;
    end = range.end;
    return true;
  });
}

/** Reject missing or overlapping positions at the daemon boundary before sending a turn. */
export function checkedMentionPositions(prompt: string, mentions: readonly PluginMention[]): PluginMention[] {
  const ranges = pluginMentionRanges(prompt, mentions);
  const found = new Map<PluginMention, number>();
  for (const { mention } of ranges) found.set(mention, (found.get(mention) ?? 0) + 1);
  if (mentions.some((mention) => !found.has(mention) || (mention.starts && found.get(mention) !== mention.starts.length)))
    throw new Error("Plugin mention is missing from the prompt");
  return positionedMentions(ranges);
}

/** Keep one identity per plugin/label, with the positions of its individual chips. */
export function positionedMentions(occurrences: readonly { start: number; mention: PluginMention }[]): PluginMention[] {
  const mentions = new Map<string, PluginMention & { starts: number[] }>();
  for (const { start, mention } of occurrences) {
    const key = JSON.stringify([mention.marketplaceId, mention.name, mention.displayName]);
    const existing = mentions.get(key);
    if (existing) existing.starts.push(start);
    else mentions.set(key, { ...mention, starts: [start] });
  }
  return [...mentions.values()];
}

/** Carry intact chips through a plain-text replacement (revision, trimming or a list edit). */
export function mentionsAfterEdit(before: string, after: string, mentions: readonly PluginMention[], caret = after.length): PluginMention[] {
  if (!mentions.length) return [];
  if (before !== after && after === before.trim()) {
    const offset = before.length - before.trimStart().length;
    return positionedMentions(pluginMentionRanges(before, mentions).flatMap(({ start, end, mention }) =>
      start >= offset && end <= offset + after.length ? [{ start: start - offset, mention }] : []));
  }
  const delta = after.length - before.length;
  const prefixLimit = Math.min(caret, caret - delta);
  let prefix = 0;
  while (prefix < prefixLimit && prefix < before.length && before[prefix] === after[prefix]) prefix++;
  let suffix = before.length;
  while (suffix > prefix && suffix + delta > prefix && before[suffix - 1] === after[suffix + delta - 1]) suffix--;
  return positionedMentions(pluginMentionRanges(before, mentions).flatMap(({ start, end, mention }) =>
    end <= prefix ? [{ start, mention }] : start >= suffix ? [{ start: start + delta, mention }] : []));
}

export function serializePluginMentions(prompt: string, mentions: readonly PluginMention[]): string {
  return splitPluginMentions(prompt, mentions).map((part) => {
    if (typeof part === "string") return part;
    const label = /[[\]]/.test(part.displayName) || part.displayName.startsWith("@")
      ? "\\@" + part.displayName.replace(/[\\[\]]/g, "\\$&")
      : pluginMentionToken(part);
    return `[${label}](plugin://${encodeURIComponent(part.name)}@${encodeURIComponent(part.marketplaceId)})`;
  }).join("");
}

export function splitPluginMentions(prompt: string, mentions: readonly PluginMention[]): Array<string | PluginMention> {
  const parts: Array<string | PluginMention> = [];
  let end = 0;
  for (const range of pluginMentionRanges(prompt, mentions)) {
    if (range.start > end) parts.push(prompt.slice(end, range.start));
    parts.push(range.mention);
    end = range.end;
  }
  if (end < prompt.length) parts.push(prompt.slice(end));
  return parts;
}

export function parsePluginMentions(prompt: string): { text: string; mentions: PluginMention[] } {
  const occurrences: { start: number; mention: PluginMention }[] = [];
  let removed = 0;
  const text = prompt.replace(PLUGIN_MENTION_PATTERN, (match, literal: string | undefined, escaped: string | undefined, encodedName: string, encodedMarketplaceId: string, offset: number) => {
    try {
      const name = decodeURIComponent(encodedName);
      const marketplaceId = decodeURIComponent(encodedMarketplaceId);
      const displayName = literal ?? escaped!.replace(/\\([\\[\]])/g, "$1");
      const mention = { name, marketplaceId, displayName };
      const token = pluginMentionToken(mention);
      occurrences.push({ start: offset - removed, mention });
      removed += match.length - token.length;
      return token;
    } catch {
      return match;
    }
  });
  return { text, mentions: positionedMentions(occurrences) };
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** What a plugin adds, for its card's tags and the browse page's category filter. */
export type PluginContribution = "projectType" | "skills" | "mcp" | "service";
export const PLUGIN_CONTRIBUTIONS: readonly PluginContribution[] = ["projectType", "skills", "mcp", "service"];

export interface PluginSkillContent {
  id: string;
  content: string;
}

const SemVerSchema = Type.String({
  pattern: "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$",
  maxLength: 256,
});

export const PluginIconSchema = Type.Object({
  type: Type.Literal("asset"),
  path: Type.String({ pattern: "^\\./(?!\\.\\.(?:/|$))(?!.*\\/\\.\\.(?:/|$))[^\\\\]+\\.(?:png|webp|svg)$", maxLength: 1000 }),
}, { additionalProperties: false });
export type PluginIcon = { type: "asset"; path: string };

export function isPluginIcon(value: unknown): value is PluginIcon {
  return Check(PluginIconSchema, value);
}

export interface PluginConfigurationField {
  type: "text" | "secret" | "path" | "boolean" | "select";
  label: string;
  description?: string;
  required?: boolean;
  default?: string | boolean;
  options?: string[];
}
export type PluginConfigurationValues = Record<string, string | boolean | null>;
export interface PluginConfigurationView {
  fields: Record<string, PluginConfigurationField>;
  values: Record<string, string | boolean>;
  configuredSecrets: string[];
  missing: string[];
}
export type McpServerDefinition = Record<string, unknown> & { command?: string; url?: string; disabled?: boolean };
export interface PluginMcpResult {
  status: "connected" | "failed" | "needs-auth";
  toolCount: number;
  message?: string;
  /** Settings to fill in before the server can start, by their titles. */
  missingSettings?: string[];
  authorizationUrl?: string;
}

/** The npm name of a plugin, `@publisher/name`: captures the scope and the name. */
export const NPM_PLUGIN_PACKAGE = /^@([a-z0-9-]+)\/([a-z0-9][a-z0-9._-]*)$/;

/**
 * The plugin ids an npm package may hold: its scope is what npm vouches for,
 * so it's the publisher, and `ohmygame-plugin-` may lead the name. The last
 * is the one to suggest. Undefined for a name that can't be a plugin's.
 */
export function npmPackagePluginIds(packageName: string): string[] | undefined {
  const match = NPM_PLUGIN_PACKAGE.exec(packageName);
  if (!match) return undefined;
  const [, scope, name] = match as unknown as [string, string, string];
  return [`${scope}/${name}`, `${scope}/${name.replace(/^ohmygame-plugin-/, "")}`];
}

export function isPluginVersion(value: unknown): value is string {
  return Check(SemVerSchema, value);
}

export function isNewerPluginVersion(candidate: string, current: string): boolean {
  const left = parsedVersion(candidate);
  const right = parsedVersion(current);
  if (!left || !right) return false;
  for (let index = 0; index < 3; index += 1) {
    if (left.core[index] !== right.core[index]) return left.core[index]! > right.core[index]!;
  }
  if (!left.prerelease || !right.prerelease) return !left.prerelease && Boolean(right.prerelease);
  const length = Math.max(left.prerelease.length, right.prerelease.length);
  for (let index = 0; index < length; index += 1) {
    const a = left.prerelease[index];
    const b = right.prerelease[index];
    if (a === b) continue;
    if (a === undefined || b === undefined) return b === undefined;
    const aNumber = /^\d+$/.test(a) ? Number(a) : undefined;
    const bNumber = /^\d+$/.test(b) ? Number(b) : undefined;
    if (aNumber !== undefined && bNumber !== undefined) return aNumber > bNumber;
    if (aNumber !== undefined || bNumber !== undefined) return bNumber !== undefined;
    return a > b;
  }
  return false;
}

function parsedVersion(value: string): { core: number[]; prerelease?: string[] } | undefined {
  const match = /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(value);
  return match ? {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    ...(match[4] ? { prerelease: match[4].split(".") } : {}),
  } : undefined;
}

/** A setting a plugin asks for, as its settings page shows it. */
export interface StorePluginSetting {
  name: string;
  type: "text" | "secret" | "path" | "boolean" | "select" | "json";
  title: string;
  description?: string;
  required?: boolean;
  options?: string[];
}

/** One installed version of a plugin (GET /plugin-store/plugins). */
export interface StorePlugin {
  /** `publisher/name`. */
  id: string;
  version: string;
  /** Changes with the installed package, even at the same version. */
  revision: string;
  displayName: string;
  description: string;
  /** What it asks to be allowed, such as `network:api.example.com`. */
  capabilities: string[];
  /** The person's decisions; `null` before any. `enabled` false stops it everywhere. */
  grants: { enabled: boolean; allowed: string[]; everyProject?: boolean } | null;
  /** Ships with the app, so it can't be uninstalled. */
  bundled: boolean;
  /** Installed with the app from another repository; it can be uninstalled. */
  preinstalled?: boolean;
  origin?: PluginOrigin;
  /** Why its folder, in development, couldn't be added again the last time it changed. */
  developmentError?: string;
  /** On in every project it suits, unless a project turns it off. */
  everyProject: boolean;
  /** It stopped its extension host too often, so it is off until turned on again or OhMyGame restarts. */
  quarantined?: true;
  categories?: PluginCategory[];
  /** Words to find it by, which its page shows. */
  keywords?: string[];
  /** Still being checked on real projects. */
  beta?: boolean;
  icon?: PluginIcon;
  iconRevision?: string;
  /** Shown under About. */
  longDescription?: string;
  /** Prompts its page offers to try it with. */
  examples: string[];
  /** Its screenshots in order; each reads from `/plugins/:id/screenshots/:index`. */
  screenshots?: Array<{ caption?: string }>;
  /** The project types it works in; absent means every type. */
  appliesTo?: string[];
  homepage?: string;
  settings: StorePluginSetting[];
  settingsView?: import("./plugin-settings.js").PluginSettingsView;
  /** Its checks may run now, outside projects: on, and allowed what it asks for (`PluginServices.settingsPlugin`). */
  runnable?: true;
  /** Its MCP servers, to test from its Settings: an HTTP server's URL with the saved settings, and how to get each running. */
  mcpServers?: Array<{ id: string; title: string; url?: string; setup?: string; docs?: string }>;
  /** Its Skills; each `id` reads its content from `/plugins/:id/skill-content`. */
  skills: Array<{ id: string; name: string; description: string }>;
  /** It adds only model providers and agents, which join the app itself whatever projects turn on. */
  appOnly?: true;
  /** What it adds, by title; tools and skills are counted. */
  adds: { projectTypes: string[]; templates?: string[]; panels: string[]; commands: string[]; mcpServers: string[]; modelProviders: string[]; agents: string[]; tools: number; skills: number; hooks?: string[]; instructions?: string };
}

/** What a plugin's settings page shows; secrets only say whether they are set. */
export type StorePluginConfiguration = Record<
  string,
  | { type: Exclude<StorePluginSetting["type"], "secret">; value: string | boolean | null }
  | { type: "secret"; configured: boolean }
>;

/** A plugin command a project offers (GET /projects/:id/plugin-commands). */
/** A theme a plugin adds: values for the theme tokens, in dark, light or both. */
export interface PluginTheme {
  /** `publisher/name:theme`. */
  id: string;
  plugin: string;
  title: string;
  dark?: Record<string, string>;
  light?: Record<string, string>;
}

export interface ProjectPluginCommand {
  /** `publisher/name:command`. */
  id: string;
  plugin: string;
  title: string;
  slash?: string;
  slots: Array<{ slot: string; when?: string }>;
  run:
    | { prompt: string; skill?: string; insert?: boolean }
    | { tool: string; input?: unknown }
    | { openPanel: string; state?: unknown }
    | { openSettings: true }
    | { url: string }
    /** `build: "web"`: the app builds the game for the command first. `input`: the JSON Schema of what it takes. */
    | { native: string; input?: string; build?: "web" };
}

/** A canvas node a project's plugin adds (GET /projects/:id/plugin-canvas). */
export interface ProjectCanvasNode {
  /** `publisher/name:node`. */
  id: string;
  plugin: string;
  /** The plugin's name, in the asked language. */
  pluginName: string;
  title: string;
  description?: string;
  inputs: Array<{ id: string; title: string; accepts: CanvasNodeMedia; multiple?: boolean; optional?: boolean }>;
  params: PluginParamView[];
  output: CanvasNodeMedia;
}

/** A setting of a plugin's canvas node or media model, in the asked language. */
export interface PluginParamView {
  key: string;
  type: "text" | "number" | "boolean" | "select";
  title: string;
  description?: string;
  default?: string | number | boolean;
  /** A select's choices: the value sent, and the title shown. */
  options?: Array<{ value: string; title: string }>;
  minimum?: number;
  maximum?: number;
}
export type CanvasNodeMedia = "image" | "text" | "audio" | "video" | "model";

/** What a project's plugins add to Asset Canvas. */
export interface ProjectPluginCanvas {
  nodes: ProjectCanvasNode[];
  presets: ProjectCanvasPreset[];
}

/** A group of nodes a plugin offers to add to a board (GET …/plugin-canvas/presets/:publisher/:name/:preset). */
export interface ProjectCanvasPreset {
  /** `publisher/name:preset`. */
  id: string;
  plugin: string;
  pluginName: string;
  title: string;
  description?: string;
  /** The plugin gives a picture of what it makes (GET …/plugin-canvas/presets/:publisher/:name/:preset/preview). */
  preview?: true;
}

/** A preview device a project's plugin adds (GET /projects/:id/plugin-preview). */
export interface ProjectPreviewDevice {
  /** `publisher/name:device`, as a project's `previewViewport` names it. */
  id: `${string}/${string}:${string}`;
  plugin: string;
  title: string;
  width: number;
  height: number;
}

/** A preview filter a project's plugin adds. */
export interface ProjectPreviewFilter extends PreviewColorFilter {
  /** `publisher/name:filter`. */
  id: string;
  plugin: string;
  title: string;
  /** Where its coefficients come from. */
  source: string;
}

/** A gamepad input map a project's plugin adds, ready for the preview's bridge. */
export interface ProjectInputMap {
  /** `publisher/name:map`. */
  id: string;
  plugin: string;
  title: string;
  map: GamepadKeyMap;
}

/** What a project's plugins add to its preview. */
export interface ProjectPluginPreview {
  devices: ProjectPreviewDevice[];
  filters: ProjectPreviewFilter[];
  inputMaps: ProjectInputMap[];
}

/** Something a plugin changed in a project outside a turn (GET /projects/:id/plugin-changes). */
export interface ProjectPluginChange {
  id: string;
  plugin: string;
  action: string;
  title: string;
  changed: string[];
  at: string;
  undone?: boolean;
  failed?: string;
  /** Recorded after the fact, so it may hold other changes made by then. */
  late?: boolean;
  /** Ran, but not recorded yet, so it can't be undone yet. */
  unrecorded?: boolean;
}

/** A newer package where an installed plugin came from: the market's newest version, or a new commit on its GitHub branch or tag. */
export interface PluginSourceUpdate {
  id: string;
  /** The market's version, or for GitHub the commit, it would read. */
  version?: string;
  commit?: string;
  /** Read and reviewed in the Add plugin dialog, like any package. */
  source: PluginAddSource;
}

/** One line of a plugin's log: what its native code printed, or something of its that failed. */
export interface PluginLogEntry {
  /** ISO time. */
  at: string;
  level: "info" | "warn" | "error";
  /** `native`: its code printed it; `call`: a tool, command or hook failed; `host`: its extension host stopped; `mcp`: an MCP service failed; `panel`: a page hit an uncaught error. */
  source: "native" | "call" | "host" | "mcp" | "panel";
  text: string;
}

/** A plugin's log, credentials redacted, and whether it is quarantined. */
export interface PluginLogView {
  entries: PluginLogEntry[];
  /** It stopped its extension host too often; it stays off until it is turned on again or OhMyGame restarts. */
  quarantined: boolean;
}

/** What uninstalling a version, or a plugin's every version, removes and leaves. */
export interface PluginUninstallPreview {
  /** No version is left after it, so its permissions go too. */
  last: boolean;
  /** Saved settings and sign-ins removed with the last version, unless kept. */
  settings: number;
  /** The size of its data folder, removed with the last version unless kept. */
  dataBytes: number;
  /** Files its manifest says it leaves in projects; uninstalling doesn't touch them. */
  projectFiles: string[];
  /** Projects that use the removed version, which stop running it. */
  projects: string[];
}

/** A plugin as one project sees it, for the project's Plugins sheet. */
export interface ProjectPluginItem {
  id: string;
  displayName: string;
  description: string;
  /** The newest installed version that works in the project, which turning it on gives. */
  version: string;
  /** The version this project uses; absent while it is off here. */
  used?: string;
  /** Installed versions that work in the project, newest first, to update or go back to. */
  versions: string[];
  /** Provides the project's type, so it stays on. */
  providesType: boolean;
  /** On in every project it suits, as set on the Plugins page. */
  everyProject: boolean;
  /** On here by itself, because the folder has the files its `activation` names, such as a Unity project's. */
  detected?: true;
  /** Has a command for the Game panel's `game.start` slot, as an engine's plugin does. */
  startsGame?: true;
  icon?: PluginIcon;
  iconRevision?: string;
  /** The project carries its own copy in `.ohmygame/plugins/`, used here in place of the installed one. */
  copy?: true;
  /** An installed version can be copied into the project, or over its copy. */
  canCopy?: true;
  /** Why a plugin on here is not running. `invalid` is a copy the app can't use; see `issues`. */
  status?: "active" | "not-installed" | "version-not-installed" | "incompatible" | "disabled" | "not-applicable" | "needs-consent" | "invalid";
  /** What is wrong with an `invalid` copy. */
  issues?: string[];
  /** What it asks to be allowed, such as `network:api.example.com`. */
  capabilities: string[];
  /** The person allowed what it asks for when it was installed. */
  consented: boolean;
}

export interface ProjectPluginsView {
  /** Every plugin that suits the project, and any its file asks for; the type's plugin first. */
  plugins: ProjectPluginItem[];
}
