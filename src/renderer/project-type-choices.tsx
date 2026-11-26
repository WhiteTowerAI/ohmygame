import { useEffect, useState } from "react";
import type { ProjectType } from "../shared/contracts.js";
import { PLUGIN_PROJECT_KINDS } from "../shared/project-runtime.js";
import { listProjectTemplates, listProjectTypes, type AvailableProjectType } from "./api.js";
import type { ProjectTemplateSummary } from "../shared/examples.js";
import { Package } from "./icons.js";
import { isAppProjectType, projectTypeDescription, projectTypeLabel, ProjectTypeMark } from "./project-types.js";
import type { SelectOption } from "./ui/index.js";

// What a new project can be: one of the app's own types, or a type a plugin
// adds, named `publisher/name:type`. Plugin types the app still names itself
// (Godot) appear only as the app's type.

/**
 * The types installed and enabled plugins add, besides those the app names
 * itself. `types` is undefined until they load, and stays so when loading
 * failed, so a plugin's type is never swapped for another one unseen.
 */
export function usePluginProjectTypes(): { types?: AvailableProjectType[]; failed: boolean; retry: () => void } {
  const [types, setTypes] = useState<AvailableProjectType[]>();
  const [failed, setFailed] = useState(false);
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    const named = new Set<string>(Object.values(PLUGIN_PROJECT_KINDS));
    setFailed(false);
    void listProjectTypes()
      .then((all) => { if (active) setTypes(all.filter((type) => type.plugin && !named.has(type.id))); })
      .catch(() => { if (active) setFailed(true); });
    return () => { active = false; };
  }, [attempt]);
  return { types, failed, retry: () => setAttempt((value) => value + 1) };
}

/** Installed plugins' project templates; none while loading or when they can't be read. */
export function useProjectTemplates(): ProjectTemplateSummary[] {
  const [templates, setTemplates] = useState<ProjectTemplateSummary[]>([]);
  useEffect(() => {
    let active = true;
    void listProjectTemplates().then((list) => { if (active) setTemplates(list); }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  return templates;
}

/** What a new project of a type will be, for matching plugins' `appliesTo`: a plugin's type is a general project its plugin runs. */
export function newProjectKind(type: string): { type: string; pluginType?: { id: string } } {
  if (isAppProjectType(type)) {
    const kinds: Record<string, string> = PLUGIN_PROJECT_KINDS;
    return kinds[type] ? { type, pluginType: { id: kinds[type] } } : { type };
  }
  return { type: "general", pluginType: { id: type } };
}

/** The type menu's options: the app's types, plugins' types. */
export function projectTypeOptions(appTypes: readonly ProjectType[], pluginTypes: readonly AvailableProjectType[]): SelectOption<string>[] {
  return [
    ...appTypes.map((type) => ({ value: type, label: projectTypeLabel(type), description: projectTypeDescription(type), icon: <ProjectTypeMark type={type} /> })),
    ...pluginTypes.map((type) => ({ value: type.id, label: type.title, ...(type.description ? { description: type.description } : {}), icon: <PluginTypeMark /> })),
  ];
}

/** The label of a chosen type, for a button that shows it. */
export function projectTypeChoiceLabel(value: string, pluginTypes: readonly AvailableProjectType[]): string {
  return isAppProjectType(value) ? projectTypeLabel(value) : pluginTypes.find((type) => type.id === value)?.title ?? value;
}

function PluginTypeMark({ size = 20 }: { size?: number }) {
  return <span className="project-type-mark is-plugin" style={{ width: size, height: size }} aria-hidden="true">
    <Package size={Math.round(size * 0.65)} />
  </span>;
}
