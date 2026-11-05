import type { ImageHookRecord, PluginHook } from "../shared/plugin-hooks.js";
import { t } from "./i18n.js";

const KEYS = {
  "asset.added": "assetAdded",
  "turn.completed": "turnCompleted",
  "build.started": "buildStarted",
  "build.completed": "buildCompleted",
  "files.changed": "filesChanged",
  "image.beforeGenerate": "imageBeforeGenerate",
} as const satisfies Record<PluginHook, string>;

/** When a plugin's code runs for a hook, in the person's words; an unknown one shows as its name. */
export function hookLabel(hook: string): string {
  const key = (KEYS as Partial<Record<string, (typeof KEYS)[PluginHook]>>)[hook];
  return key ? t(`pluginHooks.${key}`) : hook;
}

/** One line per plugin that changed an image's request: who, and what. */
export function pluginChangeLines(changes: readonly ImageHookRecord[]): string[] {
  return changes.map((change) => t("pluginHooks.changedFields", {
    plugin: change.plugin,
    version: change.version,
    fields: change.fields.map((field) => t(`pluginHooks.field.${field}`)).join(t("pluginHooks.fieldSeparator")),
  }));
}
