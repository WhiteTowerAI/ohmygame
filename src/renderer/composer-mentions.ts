import type { ConversationCapabilities, PluginMention } from "../shared/contracts.js";
import { pluginMentionRanges, pluginMentionToken, positionedMentions } from "../shared/plugins.js";

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
      .filter((plugin) => `${plugin.displayName} ${plugin.id} ${plugin.name} ${plugin.description}`.toLowerCase().includes(query.query))
      .map((value) => ({ type: "plugin" as const, value }))
    : [];
  return [...plugins, ...capabilities.skills
    .filter((skill) => `${skill.name} ${skillDisplayName(skill.name)} ${skill.pluginDisplayName ?? ""} ${skill.description}`.toLowerCase().includes(query.query))
    .map((value) => ({ type: "skill" as const, value }))];
}

export function insertMention(value: string, query: ComposerMentionQuery, mention: ComposerMention, mentions: readonly PluginMention[] = []) {
  const token = mention.type === "plugin" ? pluginMentionToken(mention.value) : `$${mention.value.name}`;
  const suffix = value.slice(query.end);
  const inserted = token + (suffix.startsWith(" ") ? "" : " ");
  const cursor = query.start + inserted.length;
  const occurrences = pluginMentionRanges(value, mentions).flatMap(({ start, end, mention }) =>
    end <= query.start ? [{ start, mention }] : start >= query.end ? [{ start: start + cursor - query.end, mention }] : []);
  if (mention.type === "plugin") {
    const { name, marketplaceId, displayName } = mention.value;
    occurrences.push({ start: query.start, mention: { name, marketplaceId, displayName } });
  }
  return { value: value.slice(0, query.start) + inserted + suffix, cursor, mentions: positionedMentions(occurrences) };
}
