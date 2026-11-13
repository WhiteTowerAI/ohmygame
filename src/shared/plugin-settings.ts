import type { PluginManifestV2 } from "./plugin-manifest.js";

/** App-host connection settings reuse the manifest's declared fields and commands. */
export interface PluginSettingsView {
  fields: string[];
  status: boolean;
  actions: Array<{ id: string; title: string; description?: string }>;
}

export interface PluginSettingsStatus {
  message: string;
  detail?: string;
  /** A short-lived message to copy to the external service. Reading never renews it. */
  code?: { text: string; expiresAt: number };
  /** Only these declared actions are currently available. */
  actions: string[];
}

export function pluginSettingsView(
  manifest: PluginManifestV2,
  text = (value: string) => value,
): PluginSettingsView | undefined {
  const settings = manifest.contributes?.settings;
  if (!manifest.capabilities?.sessions || !settings) return undefined;
  const rows = settings.groups.flatMap((group) => group.rows);
  return {
    fields: rows.flatMap((row) => ("field" in row ? [row.field] : [])),
    status: rows.some((row) => "widget" in row && row.widget === "status"),
    actions: rows.flatMap((row) =>
      "action" in row
        ? [
            {
              id: row.action.command,
              title: text(row.title),
              ...(row.description
                ? { description: text(row.description) }
                : {}),
            },
          ]
        : [],
    ),
  };
}

export function isPluginSettingsCommand(
  manifest: PluginManifestV2,
  command: string,
): boolean {
  const view = pluginSettingsView(manifest);
  return (
    !!view &&
    ((command === "settings-status" && view.status) ||
      view.actions.some((action) => action.id === command))
  );
}

/** Native results cross the host boundary; never expose arbitrary objects or unbounded text. */
export function readPluginSettingsStatus(
  value: unknown,
  view: PluginSettingsView,
): PluginSettingsStatus {
  const object = (v: unknown): v is Record<string, unknown> =>
    !!v && typeof v === "object" && !Array.isArray(v);
  const text = (v: unknown, max: number): v is string =>
    typeof v === "string" && v.length > 0 && v.length <= max;
  if (
    !object(value) ||
    !text(value.message, 500) ||
    (value.detail !== undefined && !text(value.detail, 2000)) ||
    !Array.isArray(value.actions) ||
    value.actions.length > 10 ||
    !value.actions.every(
      (id) =>
        typeof id === "string" &&
        view.actions.some((action) => action.id === id),
    ) ||
    (value.code !== undefined &&
      (!object(value.code) ||
        !text(value.code.text, 200) ||
        !Number.isSafeInteger(value.code.expiresAt) ||
        (value.code.expiresAt as number) <= 0 ||
        (value.code.expiresAt as number) > 8_640_000_000_000_000))
  )
    throw new Error("The plugin returned invalid settings status");
  return {
    message: value.message,
    ...(value.detail === undefined ? {} : { detail: value.detail as string }),
    ...(value.code === undefined
      ? {}
      : {
          code: {
            text: (value.code as Record<string, unknown>).text as string,
            expiresAt: (value.code as Record<string, unknown>)
              .expiresAt as number,
          },
        }),
    actions: [...new Set(value.actions as string[])],
  };
}
