import type { ConversationCapabilities, PluginMention } from "../shared/contracts.js";
import { hasPluginMentionToken, pluginMentionToken } from "../shared/plugins.js";

export type ComposerMention =
  | { type: "plugin"; value: ConversationCapabilities["plugins"][number] }
  | { type: "skill"; value: ConversationCapabilities["skills"][number] };

export interface ComposerMentionQuery {
  start: number;
  end: number;
  trigger: "@" | "$" | "/";
  query: string;
}

export interface SkillInvocation {
  name: string;
  prompt: string;
}

export function parseSkillInvocation(value: string): SkillInvocation | undefined {
  const match = value.match(/^\$([a-zA-Z0-9][a-zA-Z0-9._-]*)(?:\s+([\s\S]*))?$/);
  return match ? { name: match[1]!, prompt: match[2] ?? "" } : undefined;
}

export function formatSkillInvocation(name: string | undefined, prompt: string): string {
  return name ? `$${name}${prompt ? ` ${prompt}` : ""}` : prompt;
}

export function extractLeadingPluginMention(value: string, mentions: readonly PluginMention[]): { prompt: string; mention?: PluginMention } {
  const mention = [...mentions]
    .sort((left, right) => pluginMentionToken(right).length - pluginMentionToken(left).length)
    .find((item) => {
      const token = pluginMentionToken(item);
      return value === token || (value.startsWith(token) && /^\s/.test(value[token.length] ?? ""));
    });
  if (!mention) return { prompt: value };
  return { prompt: value.slice(pluginMentionToken(mention).length).trimStart(), mention };
}

export function formatPluginInvocation(mention: PluginMention | undefined, prompt: string): string {
  return mention ? `${pluginMentionToken(mention)}${prompt ? ` ${prompt}` : ""}` : prompt;
}

export function skillDisplayName(name: string): string {
  return name.split(/[._-]+/).filter(Boolean).map((part) => {
    const normalized = part.toLowerCase();
    return SKILL_DISPLAY_TERMS[normalized] ?? `${part[0]!.toUpperCase()}${part.slice(1)}`;
  }).join(" ");
}

const SKILL_DISPLAY_TERMS: Record<string, string> = {
  "2d": "2D",
  "3d": "3D",
  ai: "AI",
  api: "API",
  gdscript: "GDScript",
  mcp: "MCP",
  ui: "UI",
};

export function mentionQuery(value: string, cursor: number): ComposerMentionQuery | undefined {
  const before = value.slice(0, cursor);
  const match = before.match(/(^|\s)([@$/])([^\s@$]*)$/);
  if (!match) return undefined;
  const trigger = match[2] as "@" | "$" | "/";
  const start = cursor - match[2].length - match[3].length;
  // Skills and plugins can be named anywhere; "/" opens the commands only at the start.
  if (trigger === "/" && value.slice(0, start).trim()) return undefined;
  return {
    start,
    end: cursor,
    trigger,
    query: match[3].toLowerCase(),
  };
}

export function slashCommandQuery(value: string, cursor: number): ComposerMentionQuery | undefined {
  if (cursor !== value.length || !value.startsWith("/") || value.includes("\n") || !/\s/.test(value.slice(1))) return undefined;
  return { start: 0, end: cursor, trigger: "/", query: value.slice(1).toLowerCase() };
}

export function matchingMentions(capabilities: ConversationCapabilities, query: ComposerMentionQuery): ComposerMention[] {
  const plugins: ComposerMention[] = query.trigger === "@"
    ? capabilities.plugins
      .filter((plugin) => `${plugin.displayName} ${plugin.id} ${plugin.description}`.toLowerCase().includes(query.query))
      .map((value) => ({ type: "plugin" as const, value }))
    : [];
  return [...plugins, ...capabilities.skills
    .filter((skill) => `${skill.name} ${skillDisplayName(skill.name)} ${skill.pluginDisplayName ?? ""} ${skill.description}`.toLowerCase().includes(query.query))
    .map((value) => ({ type: "skill" as const, value }))];
}

/** `plugins` are the ones the picker offers, so a plugin's label tells it apart from them; `plugin` is the mention to keep. */
export function insertMention(value: string, query: ComposerMentionQuery, mention: ComposerMention, plugins: readonly MentionablePlugin[] = []): { value: string; cursor: number; plugin?: PluginMention } {
  const plugin = mention.type === "plugin" ? toPluginMention(mention.value, plugins) : undefined;
  const token = plugin ? pluginMentionToken(plugin) : `$${mention.value.name}`;
  const suffix = value.slice(query.end);
  const separator = suffix.startsWith(" ") ? "" : " ";
  const next = `${value.slice(0, query.start)}${token}${separator}${suffix}`;
  return { value: next, cursor: query.start + token.length + separator.length, plugin };
}

type MentionablePlugin = ConversationCapabilities["plugins"][number];

/** A name another of `plugins` shares gets the publisher, or the ID, so its token stays unique. */
export function toPluginMention(plugin: MentionablePlugin, plugins: readonly MentionablePlugin[] = []): PluginMention {
  return {
    name: plugin.name,
    displayName: pluginMentionLabel(plugin, plugins),
    marketplaceId: plugin.marketplaceId,
  };
}

function pluginMentionLabel(plugin: MentionablePlugin, plugins: readonly MentionablePlugin[]): string {
  const name = plugin.displayName.replace(/^@/, "");
  const others = new Set(plugins.filter((other) => other.id !== plugin.id).map((other) => other.displayName.replace(/^@/, "")));
  if (!others.has(name)) return name;
  const publisher = `${name} (${plugin.marketplaceId})`;
  const shared = plugins.some((other) => other.id !== plugin.id && other.marketplaceId === plugin.marketplaceId && other.displayName.replace(/^@/, "") === name);
  return shared || others.has(publisher) ? `${name} (${plugin.id})` : publisher;
}

export function activePluginMentions(prompt: string, mentions: readonly PluginMention[]): PluginMention[] {
  return mentions.filter((mention) => hasPluginMentionToken(prompt, mention));
}
