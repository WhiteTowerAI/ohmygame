import { Type, type Static } from "typebox";
import { Check } from "typebox/value";
import type { PluginMention, ProjectType } from "./contracts.js";
import type { CommunityAuthor, CommunityStats } from "./publish-v1.js";

export const PLUGIN_MANIFEST_PATH = ".opengame-plugin/plugin.json";
export const PLUGIN_ARCHIVE_MAX_ENTRIES = 5_000;
export const PLUGIN_ARCHIVE_MAX_BYTES = 50 * 1024 * 1024;
export const PLUGIN_SKILL_CONTENT_MAX_BYTES = 512 * 1024;
export const PLUGIN_ARCHIVE_ALLOWED_HIDDEN_DIRECTORIES: readonly string[] = [
  ".agents",
  ".claude-plugin",
  ".codex-plugin",
  ".opengame-plugin",
];

export type PluginSource =
  | { type: "builtIn" }
  | { type: "directory" }
  | { type: "git"; url: string; commit: string }
  | { type: "catalog"; pluginId: string; releaseId: string };

export type InstallPluginRequest =
  | { type: "directory"; path: string; candidate?: string }
  | { type: "git"; url: string; candidate?: string };

export interface PluginInstallCandidate {
  key: string;
  name: string;
  displayName: string;
  description: string;
  skillCount: number;
  format: "opengame" | "codex" | "claude" | "pi" | "agent-skills";
  marketplace: PluginMarketplaceRef;
}

export interface PluginInstallInspection {
  candidates: PluginInstallCandidate[];
}

export interface PluginMarketplaceRef {
  id: string;
  displayName: string;
}

export const OPENGAME_MARKETPLACE: PluginMarketplaceRef = { id: "opengame", displayName: "OpenGame" };
export const PERSONAL_MARKETPLACE: PluginMarketplaceRef = { id: "personal", displayName: "Personal" };

const PLUGIN_MENTION_PATTERN = /\[(@[^\]]+)\]\(plugin:\/\/([^@\s)]+)@([^\s)]+)\)/g;

export function pluginMentionToken(mention: Pick<PluginMention, "displayName">): string {
  return `@${mention.displayName.replace(/^@/, "")}`;
}

export function serializePluginMentions(prompt: string, mentions: readonly PluginMention[]): string {
  const ordered = uniquePluginMentions(mentions)
    .sort((left, right) => pluginMentionToken(right).length - pluginMentionToken(left).length);
  if (ordered.length === 0) return prompt;
  const byToken = new Map(ordered.map((mention) => [pluginMentionToken(mention), mention]));
  const pattern = new RegExp(`(?:${[...byToken.keys()].map(escapeRegExp).join("|")})(?=$|[\\s.,!?;:)}\\]])`, "g");
  return prompt.replace(pattern, (token) => {
    const mention = byToken.get(token)!;
    return `[${token}](plugin://${encodeURIComponent(mention.name)}@${encodeURIComponent(mention.marketplaceId)})`;
  });
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

export interface PluginSummary {
  id: string;
  name: string;
  displayName: string;
  description: string;
  version?: string;
  marketplace: PluginMarketplaceRef;
  source: PluginSource;
  installed: boolean;
  enabled: boolean;
  latestVersion?: string;
  updateAvailable?: boolean;
  author?: CommunityAuthor;
  stats?: CommunityStats;
}

export interface PluginComponentSummary {
  id: string;
  name: string;
  description?: string;
  enabled: boolean;
}

export interface PluginConnectionSummary extends PluginComponentSummary {
  status?: "enabled" | "disabled" | "not-configured";
}

export type ConfigurablePluginComponentType = "skill";

export interface PluginSettings {
  enabled: boolean;
  components: Record<string, boolean>;
}

export function pluginComponentKey(type: ConfigurablePluginComponentType, id: string): string {
  return `${type}:${id}`;
}

export interface PluginDetail extends PluginSummary {
  longDescription?: string;
  skills: PluginComponentSummary[];
  connections: PluginConnectionSummary[];
  defaultPrompts?: string[];
  projectTypes?: ProjectType[];
}

export interface PluginSkillContent {
  id: string;
  content: string;
}

export interface PluginCatalog {
  plugins: PluginSummary[];
  errors: PluginMarketplaceError[];
}

export interface PluginMarketplaceError {
  marketplaceId: string;
  message: string;
}

const RelativePathSchema = Type.String({
  pattern: "^\\./(?!\\.\\.(?:/|$))(?!.*\\/\\.\\.(?:/|$))[^\\\\]+$",
  minLength: 3,
});
const IdentifierSchema = Type.String({ pattern: "^[a-z0-9]+(?:[-_.][a-z0-9]+)*$" });
const SemVerSchema = Type.String({
  pattern: "^(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)\\.(0|[1-9][0-9]*)(?:-(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*)(?:\\.(?:0|[1-9][0-9]*|[0-9]*[A-Za-z-][0-9A-Za-z-]*))*)?(?:\\+[0-9A-Za-z-]+(?:\\.[0-9A-Za-z-]+)*)?$",
  maxLength: 256,
});

const InterfaceSchema = Type.Object({
  displayName: Type.Optional(Type.String({ minLength: 1 })),
  shortDescription: Type.Optional(Type.String({ minLength: 1 })),
  longDescription: Type.Optional(Type.String({ minLength: 1 })),
  defaultPrompt: Type.Optional(Type.Array(Type.String({ minLength: 1 }), { minItems: 1 })),
  projectTypes: Type.Optional(Type.Array(Type.Union([
    Type.Literal("web-game"),
    Type.Literal("godot-game"),
    Type.Literal("interactive-drama"),
  ]), { minItems: 1, uniqueItems: true })),
}, { additionalProperties: false });

export const PluginManifestSchema = Type.Object({
  name: Type.String({ pattern: "^[a-z0-9]+(?:-[a-z0-9]+)*$" }),
  version: SemVerSchema,
  description: Type.String({ minLength: 1 }),
  skills: Type.Optional(Type.Union([RelativePathSchema, Type.Array(RelativePathSchema, { minItems: 1, uniqueItems: true })])),
  connections: Type.Optional(Type.Array(IdentifierSchema, { uniqueItems: true })),
  interface: Type.Optional(InterfaceSchema),
}, { additionalProperties: false });

export type PluginManifest = Static<typeof PluginManifestSchema>;
export type ResolvedPluginManifest = Omit<PluginManifest, "version"> & { version?: string };

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

export function isPluginManifest(value: unknown): value is PluginManifest {
  return Check(PluginManifestSchema, value);
}
