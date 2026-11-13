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
  /** API 2.6: an HTTPS authorization page, opened only by a settings action or explicit click. */
  link?: { title: string; url: string; expiresAt: number };
  /** Set by the host after an explicit action saves configuration; never includes credentials. */
  configurationChanged?: boolean;
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
  const validLink = (link: unknown) => {
    if (
      !object(link) ||
      !text(link.title, 100) ||
      !text(link.url, 8192) ||
      !Number.isSafeInteger(link.expiresAt) ||
      (link.expiresAt as number) <= 0 ||
      (link.expiresAt as number) > 8_640_000_000_000_000
    )
      return false;
    try {
      const url = new URL(link.url);
      return url.protocol === "https:" && !url.username && !url.password;
    } catch {
      return false;
    }
  };
  if (
    !object(value) ||
    !text(value.message, 500) ||
    (value.detail !== undefined && !text(value.detail, 2000)) ||
    (value.link !== undefined && !validLink(value.link)) ||
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
    ...(value.link === undefined
      ? {}
      : {
          link: {
            title: (value.link as PluginSettingsStatus["link"])!.title,
            url: (value.link as PluginSettingsStatus["link"])!.url,
            expiresAt: (value.link as PluginSettingsStatus["link"])!.expiresAt,
          },
        }),
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
