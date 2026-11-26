import { useEffect, useState } from "react";
import type { ProjectType } from "../shared/contracts.js";
import { PLUGIN_PROJECT_KINDS } from "../shared/project-runtime.js";
import { listProjectTemplates, listProjectTypes, type AvailableProjectType } from "./api.js";
import type { ProjectTemplateSummary } from "../shared/examples.js";
import { Package, Plus } from "./icons.js";
import { PluginGlyph } from "./plugin-icons.js";
import { t } from "./i18n.js";
import { pluginBrowseHash } from "./routes.js";
import { isAppProjectType, projectTypeDescription, projectTypeLabel, ProjectTypeMark } from "./project-types.js";
import type { SelectOption } from "./ui/index.js";

// What a new project can be: one of the app's own types, or a type a plugin
// adds, named `publisher/name:type`. Plugin types the app still names itself
// (Godot) appear only as the app's type.

/** The menu entry that leads to plugins adding more types rather than choosing one. */
export const MORE_TYPES = "more-types";

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

/** Installed plugins' project templates: undefined while loading, none when they can't be read. */
export function useProjectTemplates(): ProjectTemplateSummary[] | undefined {
  const [templates, setTemplates] = useState<ProjectTemplateSummary[]>();
  useEffect(() => {
    let active = true;
    void listProjectTemplates().then((list) => { if (active) setTemplates(list); }).catch(() => { if (active) setTemplates([]); });
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

/** The type menu's options: the app's types, plugins' types, any others the caller adds, then 更多类型…. */
export function projectTypeOptions(appTypes: readonly ProjectType[], pluginTypes: readonly AvailableProjectType[], others: readonly SelectOption<string>[] = []): SelectOption<string>[] {
  return [
    ...appTypes.map((type) => ({ value: type, label: projectTypeLabel(type), description: projectTypeDescription(type), icon: <ProjectTypeMark type={type} /> })),
    ...pluginTypes.map((type) => ({ value: type.id, label: type.title, ...(type.description ? { description: type.description } : {}), icon: <PluginTypeMark /> })),
    ...others,
    { value: MORE_TYPES, label: t("projectTypeChoice.more"), description: t("projectTypeChoice.moreHint"), icon: <span className="project-type-mark is-more" aria-hidden="true"><Plus size={13} /></span> },
  ];
}

/** A template's value in the type menu, apart from plugins' types, which are also named `publisher/name:id`. */
const TEMPLATE_VALUE = "template:";

export function templateChoice(id: string): string {
  return `${TEMPLATE_VALUE}${id}`;
}

/** The template a type menu value names, if it names one. */
export function chosenTemplateId(value: string): string | undefined {
  return value.startsWith(TEMPLATE_VALUE) ? value.slice(TEMPLATE_VALUE.length) : undefined;
}

/** Plugins' templates as type menu options, after the types: choosing one starts the project from its files. */
export function templateOptions(templates: readonly ProjectTemplateSummary[]): SelectOption<string>[] {
  return templates.map((template) => ({
    value: templateChoice(template.id),
    label: template.name,
    ...(template.description ? { description: template.description } : {}),
    icon: <PluginGlyph plugin={template.plugin} size={20} name={template.plugin.displayName} />,
  }));
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
