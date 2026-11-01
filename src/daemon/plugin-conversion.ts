// Between the two plugin formats. A format 1 plugin that only adds Skills
// becomes a format 2 package (bundled plugins, by script); a format 2 package
// that only adds Skills is shown in the catalog as format 1 bundled plugins
// are, until the two catalogs merge.
import { PROJECT_TYPE_IDS, type ProjectType } from "../shared/contracts.js";
import { isAppWidePlugin, type PluginCategory, type PluginManifestV2 } from "../shared/plugin-manifest.js";
import type { PluginManifest, ResolvedPluginManifest } from "../shared/plugins.js";
import { localizePluginString, type PluginIndexEntry } from "./plugin-index.js";

export interface ConvertedPlugin {
  /** `.ohmygame-plugin/plugin.json`. */
  manifest: Record<string, unknown>;
  /** `locales/en.json`: the manifest's display strings. */
  strings: Record<string, string>;
}

/**
 * Format 2 manifest and strings for a format 1 plugin that only adds Skills.
 * Its Skills folder and icon keep their paths, so the files copy as they are.
 */
export function convertFormat1Manifest(
  manifest: PluginManifest,
  { publisher, categories }: { publisher: string; categories?: PluginCategory[] },
): ConvertedPlugin {
  const unsupported = (["mcpServers", "configuration", "connections", "requirements"] as const).filter((key) => manifest[key] !== undefined);
  if (unsupported.length) throw new Error(`${manifest.name} has ${unsupported.join(", ")}; only plugins that add Skills convert`);
  if (typeof manifest.skills !== "string") throw new Error(`${manifest.name} must keep its Skills in one folder`);
  const face = manifest.interface ?? {};
  const strings: Record<string, string> = {
    displayName: face.displayName ?? manifest.name,
    description: face.shortDescription ?? manifest.description,
  };
  if (face.longDescription) strings.longDescription = face.longDescription;
  const examples = (face.defaultPrompt ?? []).slice(0, 5);
  examples.forEach((prompt, index) => (strings[`example.${index + 1}`] = prompt));
  const icon = face.icon?.type === "asset" ? face.icon.path : undefined;
  return {
    manifest: {
      $schema: "https://ohmygame.dev/schema/plugin-2.json",
      id: `${publisher}/${manifest.name}`,
      version: manifest.version,
      engines: { "ohmygame-api": "^2.0.0" },
      displayName: "%displayName%",
      description: "%description%",
      ...(strings.longDescription ? { longDescription: "%longDescription%" } : {}),
      ...(examples.length ? { examples: examples.map((_, index) => `%example.${index + 1}%`) } : {}),
      ...(face.beta ? { beta: true } : {}),
      ...(icon ? { icon } : {}),
      ...(categories?.length ? { categories } : {}),
      ...(face.projectTypes?.length ? { appliesTo: face.projectTypes } : {}),
      contributes: { skills: manifest.skills },
    },
    strings,
  };
}

/**
 * The format 1 shape the catalog shows for a bundled format 2 plugin that
 * applies to every project it suits. Undefined for any other plugin, and for
 * one that suits only plugin types, which the catalog can't express.
 */
export function catalogManifest(
  entry: Pick<PluginIndexEntry, "manifest" | "strings">,
  { enabledByDefault }: { enabledByDefault: boolean },
): ResolvedPluginManifest | undefined {
  const { manifest } = entry;
  if (!isAppWidePlugin(manifest)) return undefined;
  const projectTypes = manifest.appliesTo?.filter((type): type is ProjectType => (PROJECT_TYPE_IDS as readonly string[]).includes(type));
  // An empty list would read as "every project type".
  if (manifest.appliesTo && !projectTypes?.length) return undefined;
  const text = (value: string) => localizePluginString(entry, value, "en");
  const name = manifest.id.slice(manifest.id.indexOf("/") + 1);
  return {
    name,
    version: manifest.version,
    description: text(manifest.description),
    skills: manifest.contributes!.skills!,
    enabledByDefault,
    interface: {
      displayName: text(manifest.displayName),
      shortDescription: text(manifest.description),
      ...(manifest.longDescription ? { longDescription: text(manifest.longDescription) } : {}),
      ...(manifest.examples ? { defaultPrompt: manifest.examples.map(text) } : {}),
      ...(manifest.beta ? { beta: true } : {}),
      ...(manifest.icon ? { icon: { type: "asset" as const, path: manifest.icon } } : {}),
      // The format 1 schema's literal union infers as never; the values are checked above.
      ...(projectTypes?.length ? { projectTypes: projectTypes as FormatOneProjectTypes } : {}),
    },
  };
}

type FormatOneProjectTypes = NonNullable<NonNullable<ResolvedPluginManifest["interface"]>["projectTypes"]>;
