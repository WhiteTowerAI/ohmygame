import { parse as parseYaml } from "yaml";

export interface SkillMetadata {
  name?: string;
  description?: string;
}

export function parseSkillMetadata(content: string): SkillMetadata {
  const frontmatter = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---(?:[ \t]*\r?\n|$)/.exec(content)?.[1];
  if (!frontmatter) return {};
  const value = parseYaml(frontmatter, { maxAliasCount: 0 });
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const metadata = value as Record<string, unknown>;
  return {
    ...(nonemptyString(metadata.name) ? { name: nonemptyString(metadata.name) } : {}),
    ...(nonemptyString(metadata.description) ? { description: nonemptyString(metadata.description) } : {}),
  };
}

function nonemptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}
