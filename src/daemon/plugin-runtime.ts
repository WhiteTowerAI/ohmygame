import { lstat, readFile } from "node:fs/promises";
import path from "node:path";
import { pluginComponentKey, type PluginDetail } from "../shared/plugins.js";
import type { PluginSettingsStore } from "./plugin-settings.js";

export interface PluginSkillSource {
  list(): Promise<PluginDetail[] | { plugins: PluginDetail[] }> | PluginDetail[] | { plugins: PluginDetail[] };
  installedPath(id: string): Promise<string | undefined> | string | undefined;
}

export interface PluginSkillRegistration {
  path: string;
  pluginDisplayName: string;
  marketplaceDisplayName: string;
}

const MAX_SKILL_CONTENT_SIZE = 512 * 1024;

export class PluginSkillContentError extends Error {
  readonly statusCode = 413;
}

export async function readPluginSkillContent(
  plugin: PluginDetail,
  skillId: string,
  sources: readonly PluginSkillSource[],
): Promise<string | undefined> {
  const target = await resolvePluginSkillFile(plugin, skillId, sources);
  if (!target) return undefined;
  const details = await lstat(target).catch((cause) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  });
  if (!details?.isFile()) return undefined;
  if (details.size > MAX_SKILL_CONTENT_SIZE) throw new PluginSkillContentError("Skill content is larger than 512 KB");
  return readFile(target, "utf8").catch((cause) => {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw cause;
  });
}

export async function resolvePluginSkillFile(
  plugin: PluginDetail,
  skillId: string,
  sources: readonly PluginSkillSource[],
): Promise<string | undefined> {
  if (path.basename(skillId) !== "SKILL.md" || !plugin.skills.some((skill) => skill.id === skillId)) return undefined;
  for (const source of sources) {
    const root = await source.installedPath(plugin.id);
    if (!root) continue;
    const target = path.resolve(root, skillId);
    const relative = path.relative(root, target);
    if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) return undefined;
    const details = await lstat(target).catch((cause) => {
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw cause;
    });
    if (details?.isFile()) return target;
  }
  return undefined;
}

export async function resolvePluginSkillPaths(
  sources: readonly PluginSkillSource[],
  settings: PluginSettingsStore,
): Promise<string[]> {
  return (await resolvePluginSkills(sources, settings)).map((skill) => skill.path);
}

export async function resolvePluginSkills(
  sources: readonly PluginSkillSource[],
  settings: PluginSettingsStore,
): Promise<PluginSkillRegistration[]> {
  const skills: PluginSkillRegistration[] = [];
  for (const source of sources) {
    const listed = await source.list();
    const plugins = Array.isArray(listed) ? listed : listed.plugins;
    for (const plugin of plugins) {
      const root = await source.installedPath(plugin.id);
      const resolved = settings.resolve(plugin);
      if (!root || !resolved.enabled) continue;
      for (const skill of plugin.skills) {
        if (!resolved.components[pluginComponentKey("skill", skill.id)]) continue;
        skills.push({
          path: path.join(root, skill.id),
          pluginDisplayName: plugin.displayName,
          marketplaceDisplayName: plugin.marketplace.displayName,
        });
      }
    }
  }
  return [...new Map(skills.map((skill) => [skill.path, skill])).values()];
}
