import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { PLUGIN_SKILL_CONTENT_MAX_BYTES } from "../shared/plugins.js";

export interface PluginSkillRegistration {
  path: string;
  pluginDisplayName: string;
  marketplaceDisplayName: string;
}

export class PluginSkillContentError extends Error {
  readonly statusCode = 413;
}

/** A plugin as reading its Skills needs it. */
export type PluginWithSkills = { id: string; skills: ReadonlyArray<{ id: string }> };

export async function readPluginSkillContent(
  plugin: PluginWithSkills,
  skillId: string,
  root: string,
): Promise<string | undefined> {
  const target = await resolvePluginSkillFile(plugin, skillId, root);
  if (!target) return undefined;
  const details = await lstat(target).catch((cause) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  });
  if (!details?.isFile()) return undefined;
  if (details.size > PLUGIN_SKILL_CONTENT_MAX_BYTES) throw new PluginSkillContentError("Skill content is larger than 512 KB");
  return readFile(target, "utf8").catch((cause) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  });
}

export async function resolvePluginSkillFile(
  plugin: PluginWithSkills,
  skillId: string,
  root: string,
): Promise<string | undefined> {
  if (path.basename(skillId) !== "SKILL.md" || !plugin.skills.some((skill) => skill.id === skillId)) return undefined;
  const target = path.resolve(root, skillId);
  const relative = path.relative(root, target);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
  const details = await lstat(target).catch((cause) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  });
  return details?.isFile() ? target : undefined;
}

/** Coding agent CLIs stage a Skill's folder; Pi reads its SKILL.md path. */
export function pluginSkillFolders(skills: readonly PluginSkillRegistration[]): string[] {
  return skills.map((skill) => path.dirname(skill.path));
}
