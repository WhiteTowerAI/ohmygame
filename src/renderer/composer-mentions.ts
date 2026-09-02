import type { ConversationCapabilities, PluginMention } from "../shared/contracts.js";
import { hasPluginMentionToken, pluginMentionToken } from "../shared/plugins.js";

export type ComposerMention =
  | { type: "plugin"; value: ConversationCapabilities["plugins"][number] }
  | { type: "skill"; value: ConversationCapabilities["skills"][number] };

export interface ComposerMentionQuery {
  start: number;
  end: number;
  trigger: "@" | "$";
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
  return name.split(/[._-]+/).filter(Boolean).map((part) => `${part[0]!.toUpperCase()}${part.slice(1)}`).join(" ");
}

export function mentionQuery(value: string, cursor: number): ComposerMentionQuery | undefined {
  const before = value.slice(0, cursor);
  const match = before.match(/(^|\s)([@$])([^\s@$]*)$/);
  if (!match) return undefined;
  const trigger = match[2] as "@" | "$";
  const start = cursor - match[2].length - match[3].length;
  if (trigger === "$" && value.slice(0, start).trim()) return undefined;
  return {
    start,
    end: cursor,
    trigger,
    query: match[3].toLowerCase(),
  };
}

export function matchingMentions(capabilities: ConversationCapabilities, query: ComposerMentionQuery): ComposerMention[] {
  if (query.trigger === "@") {
    return capabilities.plugins
      .filter((plugin) => `${plugin.displayName} ${plugin.name} ${plugin.description}`.toLowerCase().includes(query.query))
      .map((value) => ({ type: "plugin" as const, value }));
  }
  return capabilities.skills
    .filter((skill) => `${skill.name} ${skill.description}`.toLowerCase().includes(query.query))
    .map((value) => ({ type: "skill" as const, value }));
}

export function insertMention(value: string, query: ComposerMentionQuery, mention: ComposerMention): { value: string; cursor: number } {
  const token = mention.type === "plugin" ? pluginMentionToken(mention.value) : `$${mention.value.name}`;
  const suffix = value.slice(query.end);
  const separator = suffix.startsWith(" ") ? "" : " ";
  const next = `${value.slice(0, query.start)}${token}${separator}${suffix}`;
  return { value: next, cursor: query.start + token.length + separator.length };
}

export function toPluginMention(plugin: ConversationCapabilities["plugins"][number]): PluginMention {
  return {
    name: plugin.name,
    displayName: plugin.displayName,
    marketplaceId: plugin.marketplaceId,
  };
}

export function activePluginMentions(prompt: string, mentions: readonly PluginMention[]): PluginMention[] {
  return mentions.filter((mention) => hasPluginMentionToken(prompt, mention));
}
