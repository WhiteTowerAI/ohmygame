import {
  PROJECT_TYPE_IDS,
  type ProjectState,
  type ProjectType,
} from "./contracts.js";

export function isProjectType(value: unknown): value is ProjectType {
  return PROJECT_TYPE_IDS.some((type) => type === value);
}

/** These workspaces can use the platform's Web runtime when configured. */
export function isWebRuntimeProjectType(type: ProjectType): boolean {
  return type === "web-game" || type === "general";
}

/** Capability is independent of the preview process's readiness or errors. */
export function supportsWebPreview(
  project?: Pick<ProjectState, "type" | "webPreviewEnabled" | "pluginType">,
): boolean {
  return (
    buildsWebPreview(project) ||
    (project?.pluginType?.preview !== "native" &&
      (project?.type === "web-game" ||
        (project?.type === "general" && project.webPreviewEnabled === true)))
  );
}

/** A plugin builds the game's web version, which the panel serves; its startup settings don't apply. */
export function buildsWebPreview(
  project?: Pick<ProjectState, "pluginType">,
): boolean {
  return project?.pluginType?.preview === "web-build";
}


/** Only an unambiguous compatibility intersection may change a new workspace's
 * type. Asset/helper plugins with no restriction never choose its engine. */
/** App project kinds that are plugin types now; the app's own routing still names them. */
export const PLUGIN_PROJECT_KINDS = {
  "godot-game": "ohmygame/godot:godot-game",
} as const satisfies Record<string, string>;

/**
 * Whether a plugin suits a project type, by its `appliesTo` (none
 * means every type). An app kind that is a plugin type now matches either name.
 */
export function pluginAppliesTo(appliesTo: readonly string[] | undefined, type: string): boolean {
  if (!appliesTo) return true;
  const kinds: Record<string, string> = PLUGIN_PROJECT_KINDS;
  const names = [type, kinds[type], ...Object.keys(kinds).filter((kind) => kinds[kind] === type)];
  return names.some((name) => name !== undefined && appliesTo.includes(name));
}

/**
 * Whether a plugin that applies by itself suits a project. It goes by the
 * project's own kind (a Web game, an Asset Canvas), which the project file
 * doesn't keep apart from `general`, or by the plugin type the project is.
 */
export function appWidePluginSuits(
  appliesTo: readonly string[] | undefined,
  project: { type: string; pluginType?: { id: string } | undefined },
): boolean {
  return pluginAppliesTo(appliesTo, project.type) || Boolean(project.pluginType && appliesTo?.includes(project.pluginType.id));
}

/**
 * The type a project of this kind records in `ohmygame.json`, which plugins'
 * `appliesTo` is matched against: the app kinds that aren't project file
 * types (a Web game, an Asset Canvas) are `general` there.
 */
export function projectFileTypeFor(type: string): string {
  return type === "interactive-story" || type.includes(":") || type in PLUGIN_PROJECT_KINDS ? type : "general";
}

export function pluginProjectType(current: ProjectType, plugins: readonly { projectTypes?: ProjectType[] }[]): ProjectType | undefined {
  const compatible = PROJECT_TYPE_IDS.filter((type) => plugins.every((plugin) => !plugin.projectTypes?.length || plugin.projectTypes.includes(type)));
  return compatible.includes(current) ? current : compatible.length === 1 ? compatible[0] : undefined;
}

export function webPreviewSettingsChanged(
  before: ProjectState,
  after: ProjectState,
): boolean {
  const mode = before.previewMode ?? "auto";
  if (
    supportsWebPreview(before) !== supportsWebPreview(after) ||
    (before.startupDirectory ?? ".") !== (after.startupDirectory ?? ".") ||
    mode !== (after.previewMode ?? "auto") ||
    before.previewPort !== after.previewPort
  )
    return true;
  if (mode === "static") return false;
  if (mode === "command")
    return (
      (before.previewCommand ?? "").trim() !==
      (after.previewCommand ?? "").trim()
    );
  return (
    (before.startupScript ?? "dev") !== (after.startupScript ?? "dev") ||
    before.packageManager !== after.packageManager ||
    JSON.stringify(before.previewArguments) !==
      JSON.stringify(after.previewArguments)
  );
}
