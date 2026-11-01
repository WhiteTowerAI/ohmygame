import { Type } from "typebox";
import { Check } from "typebox/value";
import type { PluginMention } from "./contracts.js";
import type { PluginCategory } from "./plugin-manifest.js";

export type PluginOrigin =
  | { type: "github"; repository: string; commit: string; release?: string }
  | { type: "npm"; package: string; version: string; registry: PluginNpmRegistry };

export const PLUGIN_NPM_REGISTRIES = ["npmjs", "npmmirror"] as const;
export type PluginNpmRegistry = (typeof PLUGIN_NPM_REGISTRIES)[number];

/** Where the Add plugin dialog gets a package. A `.tgz` file is uploaded, so it isn't one of these. */
export type PluginAddSource =
  | { type: "npm"; name: string; registry: PluginNpmRegistry; version?: string }
  | { type: "github"; url: string; commit?: string }
  | { type: "directory"; path: string };

/** A plugin published on npm that the market lists, at its newest version. */
export interface MarketPlugin {
  id: string;
  package: string;
  version: string;
  displayName: string;
  description: string;
  /** What it asks to be allowed. */
  asks: string[];
  /** How many of each list its manifest contributes, and how many Skills. */
  adds: Record<string, number>;
  publishedAt?: string;
  repository?: string;
  /** npm's provenance names the repository, or the repository's package.json names the package. */
  sourceVerified: boolean;
  /** Only when the source is verified. */
  stars?: number;
  weeklyDownloads?: number;
  featured: boolean;
}

/** One published version the maintainers blocked. */
export interface MarketBlock {
  package: string;
  version: string;
  reason: string;
}

export interface PluginMarketListing {
  /** `off`: no index is set up. `unavailable`: none could be read. `stale`: the last one, as a new one couldn't be read. */
  status: "off" | "unavailable" | "ready" | "stale";
  plugins: MarketPlugin[];
  blocked: MarketBlock[];
}

/** What the person reviews before adding a package. */
export interface PluginAddPreview {
  /** The same source, pinned to what was read: an npm version or a commit. */
  source?: PluginAddSource;
  /** Adding checks the package is still this one. */
  digest: string;
  id: string;
  version: string;
  displayName: string;
  description: string;
  appWide: boolean;
  asks: string[];
  skills: number;
  mcpServers: string[];
  settings: boolean;
  /** Versions already installed, so the dialog can say what adding this does to them. */
  installedVersions: string[];
  origin?: PluginOrigin;
}

export const PLUGIN_MANIFEST_PATH = ".ohmygame-plugin/plugin.json";
export const PLUGIN_ARCHIVE_MAX_ENTRIES = 5_000;
export const PLUGIN_ARCHIVE_MAX_BYTES = 50 * 1024 * 1024;
export const PLUGIN_SKILL_CONTENT_MAX_BYTES = 512 * 1024;
const PLUGIN_MENTION_PATTERN = /\[(@[^\]]+)\]\(plugin:\/\/([^@\s)]+)@([^\s)]+)\)/g;

export function pluginMentionToken(mention: Pick<PluginMention, "displayName">): string {
  return `@${mention.displayName.replace(/^@/, "")}`;
}

export function serializePluginMentions(prompt: string, mentions: readonly PluginMention[]): string {
  const tokens = pluginMentionTokens(mentions);
  if (!tokens) return prompt;
  return prompt.replace(tokens.pattern, (token) => {
    const mention = tokens.byToken.get(token)!;
    return `[${token}](plugin://${encodeURIComponent(mention.name)}@${encodeURIComponent(mention.marketplaceId)})`;
  });
}

/** Where each plugin mention sits in the prompt, `end` exclusive. */
export function pluginMentionRanges(prompt: string, mentions: readonly PluginMention[]): Array<{ start: number; end: number; mention: PluginMention }> {
  const tokens = pluginMentionTokens(mentions);
  if (!tokens) return [];
  return [...prompt.matchAll(tokens.pattern)].map((match) => ({
    start: match.index,
    end: match.index + match[0].length,
    mention: tokens.byToken.get(match[0])!,
  }));
}

/** The prompt cut at its plugin mentions, for showing each as itself. */
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

/** Longer names match first, so `@Foo Bar` is not read as `@Foo`. */
function pluginMentionTokens(mentions: readonly PluginMention[]): { pattern: RegExp; byToken: Map<string, PluginMention> } | undefined {
  const ordered = uniquePluginMentions(mentions)
    .sort((left, right) => pluginMentionToken(right).length - pluginMentionToken(left).length);
  if (ordered.length === 0) return undefined;
  const byToken = new Map(ordered.map((mention) => [pluginMentionToken(mention), mention]));
  return { pattern: new RegExp(`(?:${[...byToken.keys()].map(escapeRegExp).join("|")})(?=$|[\\s.,!?;:)}\\]])`, "g"), byToken };
}

export function hasPluginMentionToken(prompt: string, mention: Pick<PluginMention, "displayName">): boolean {
  return pluginTokenPattern(pluginMentionToken(mention)).test(prompt);
}

export function parsePluginMentions(prompt: string): { text: string; mentions: PluginMention[] } {
  const mentions: PluginMention[] = [];
  const text = prompt.replace(PLUGIN_MENTION_PATTERN, (match, label: string, encodedName: string, encodedMarketplaceId: string) => {
    try {
      const name = decodeURIComponent(encodedName);
      const marketplaceId = decodeURIComponent(encodedMarketplaceId);
      mentions.push({ name, marketplaceId, displayName: label.replace(/^@/, "") });
      return label;
    } catch {
      return match;
    }
  });
  return { text, mentions: uniquePluginMentions(mentions) };
}

function uniquePluginMentions(mentions: readonly PluginMention[]): PluginMention[] {
  return [...new Map(mentions.map((mention) => [`${mention.marketplaceId}:${mention.name}`, mention])).values()];
}

function pluginTokenPattern(token: string): RegExp {
  return new RegExp(`${escapeRegExp(token)}(?=$|[\\s.,!?;:)}\\]])`, "g");
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
  authorizationUrl?: string;
}

/** The npm name of a plugin, `@publisher/name`: captures the scope and the name. */
export const NPM_PLUGIN_PACKAGE = /^@([a-z0-9-]+)\/([a-z0-9][a-z0-9._-]*)$/;

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
  type: "text" | "secret" | "path" | "boolean" | "select";
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
  /** The person's decisions; `null` before any. */
  grants: { enabled: boolean; allowed: string[] } | null;
  /** Ships with the app, so it can't be uninstalled. */
  bundled: boolean;
  /** Installed with the app from another repository; it can be uninstalled. */
  preinstalled?: boolean;
  origin?: PluginOrigin;
  /** Only adds Skills, so it applies to every project it suits without a project turning it on. */
  appWide: boolean;
  categories?: PluginCategory[];
  /** Still being checked on real projects. */
  beta?: boolean;
  icon?: PluginIcon;
  iconRevision?: string;
  /** Shown under About. */
  longDescription?: string;
  /** Prompts its page offers to try it with. */
  examples: string[];
  /** The project types it works in; absent means every type. */
  appliesTo?: string[];
  homepage?: string;
  settings: StorePluginSetting[];
  /** Its Skills; each `id` reads its content from `/plugins/:id/skill-content`. */
  skills: Array<{ id: string; name: string; description: string }>;
  /** What it adds, by title; tools and skills are counted. */
  adds: { projectTypes: string[]; panels: string[]; commands: string[]; mcpServers: string[]; tools: number; skills: number };
}

/** What a plugin's settings page shows; secrets only say whether they are set. */
export type StorePluginConfiguration = Record<
  string,
  | { type: Exclude<StorePluginSetting["type"], "secret">; value: string | boolean | null }
  | { type: "secret"; configured: boolean }
>;

/** A plugin command a project offers (GET /projects/:id/plugin-commands). */
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
    | { openPanel: string }
    | { openSettings: true }
    | { url: string }
    | { native: string };
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
}

/** A plugin as one project sees it, for the project's Plugins sheet. */
export interface ProjectPluginItem {
  id: string;
  displayName: string;
  description: string;
  /** The newest installed version, offered when turning it on. */
  version: string;
  /** The version this project uses; absent while it is off here. */
  used?: string;
  /** Provides the project's type, so it stays on. */
  providesType: boolean;
  /** Why a plugin the project asks for is not running. */
  status?: "active" | "not-installed" | "version-not-installed" | "incompatible" | "disabled" | "not-applicable" | "needs-consent" | "needs-approval";
  /** What it asks to be allowed, such as `network:api.example.com`. */
  capabilities: string[];
  /** The person allowed what it asks for when it was installed. */
  consented: boolean;
}

/** A plugin a new project can turn on for itself, before the project exists (GET /project-plugins). */
export interface ProjectPluginChoice extends Pick<ProjectPluginItem, "id" | "displayName" | "description" | "version" | "capabilities" | "consented"> {
  /** The project types it adds, as `publisher/name:type`; a project of one of them has it on already. */
  providesTypes: string[];
  /** The project types it works in (`appliesTo`); absent means every type. */
  appliesTo?: string[];
}

export interface ProjectPluginsView {
  /** Plugins on for every project they work with; switched in Plugins. */
  global: Array<{ id: string; displayName: string; description: string; icon?: PluginIcon; iconRevision?: string }>;
  /** Plugins each project turns on for itself, recorded in its `ohmygame.json`. */
  plugins: ProjectPluginItem[];
}
