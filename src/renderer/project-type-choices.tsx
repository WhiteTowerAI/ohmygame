import { useEffect, useState } from "react";
import { PROJECT_TYPE_IDS, type ProjectType } from "../shared/contracts.js";
import { PLUGIN_PROJECT_KINDS } from "../shared/project-runtime.js";
import { listProjectPluginChoices, listProjectTypes, waitForRuntime, type AvailableProjectType } from "./api.js";
import type { ProjectPluginChoice } from "../shared/plugins.js";
import { Package, Plus } from "./icons.js";
import { t } from "./i18n.js";
import { pluginBrowseHash } from "./routes.js";
import { projectTypeDescription, projectTypeLabel, ProjectTypeMark } from "./project-types.js";
import type { SelectOption } from "./ui/index.js";

// What a new project can be: one of the app's own types, or a type a plugin
// adds, named `publisher/name:type`. Plugin types the app still names itself
// (Godot) appear only as the app's type.

/** The menu entry that leads to plugins adding more types rather than choosing one. */
export const MORE_TYPES = "more-types";

export function isAppProjectType(value: string): value is ProjectType {
  return (PROJECT_TYPE_IDS as readonly string[]).includes(value);
}

/** The types installed and enabled plugins add, besides those the app names itself; undefined while loading. */
export function usePluginProjectTypes(): AvailableProjectType[] | undefined {
  const [types, setTypes] = useState<AvailableProjectType[]>();
  useEffect(() => {
    let active = true;
    const named = new Set<string>(Object.values(PLUGIN_PROJECT_KINDS));
    void listProjectTypes()
      .then((all) => { if (active) setTypes(all.filter((type) => type.plugin && !named.has(type.id))); })
      .catch(() => { if (active) setTypes([]); });
    return () => { active = false; };
  }, []);
  return types;
}

/** The enabled format 2 plugins a new project can turn on; undefined while loading. */
export function useProjectPluginChoices(): ProjectPluginChoice[] | undefined {
  const [choices, setChoices] = useState<ProjectPluginChoice[]>();
  useEffect(() => {
    let active = true;
    void waitForRuntime()
      .then(() => listProjectPluginChoices())
      .then((result) => { if (active) setChoices(result); })
      .catch(() => { if (active) setChoices([]); });
    return () => { active = false; };
  }, []);
  return choices;
}

/** The type menu's options: the app's types, plugins' types, then 更多类型…. */
export function projectTypeOptions(appTypes: readonly ProjectType[], pluginTypes: readonly AvailableProjectType[]): SelectOption<string>[] {
  return [
    ...appTypes.map((type) => ({ value: type, label: projectTypeLabel(type), description: projectTypeDescription(type), icon: <ProjectTypeMark type={type} /> })),
    ...pluginTypes.map((type) => ({ value: type.id, label: type.title, ...(type.description ? { description: type.description } : {}), icon: <PluginTypeMark /> })),
    { value: MORE_TYPES, label: t("projectTypeChoice.more"), description: t("projectTypeChoice.moreHint"), icon: <span className="project-type-mark is-more" aria-hidden="true"><Plus size={13} /></span> },
  ];
}

/** The label of a chosen type, for a button that shows it. */
export function projectTypeChoiceLabel(value: string, pluginTypes: readonly AvailableProjectType[]): string {
  return isAppProjectType(value) ? projectTypeLabel(value) : pluginTypes.find((type) => type.id === value)?.title ?? value;
}

export function ProjectTypeChoiceMark({ value, size = 20 }: { value: string; size?: number }) {
  return isAppProjectType(value) ? <ProjectTypeMark type={value} size={size} /> : <PluginTypeMark size={size} />;
}

function PluginTypeMark({ size = 20 }: { size?: number }) {
  return <span className="project-type-mark is-plugin" style={{ width: size, height: size }} aria-hidden="true">
    <Package size={Math.round(size * 0.65)} />
  </span>;
}

/** Opens the marketplace at the plugins that add a project type. */
export function openMoreProjectTypes(): void {
  window.location.hash = pluginBrowseHash("projectType");
}
