import { useEffect, useState } from "react";
import type { PluginConfigurationValues, PluginConfigurationView } from "../shared/plugins.js";
import { Trash2 } from "./icons.js";
import { t } from "./i18n.js";

export function PluginEnabledSwitch({ plugin, disabled, onToggle }: {
  plugin: { displayName: string; enabled: boolean };
  disabled?: boolean;
  onToggle: (enabled: boolean) => void;
}) {
  const label = `${plugin.enabled ? t("common.disable") : t("common.enable")} ${plugin.displayName}`;
  return <button className="plugin-switch" type="button" role="switch" aria-checked={plugin.enabled}
    aria-label={label} title={label} disabled={disabled} onClick={() => onToggle(!plugin.enabled)}><span /></button>;
}

export function PluginUninstallButton({ plugin, disabled, compact = false, onUninstall }: {
  plugin: { displayName: string };
  disabled?: boolean;
  compact?: boolean;
  onUninstall: () => void;
}) {
  return <button className={compact ? "icon-button pane-header-action" : "plugin-detail-secondary"} type="button"
    disabled={disabled} title={t("pluginControls.uninstall")} aria-label={t("pluginControls.uninstall")} onClick={() => {
      if (window.confirm(t("pluginControls.confirmUninstall", { name: plugin.displayName }))) onUninstall();
    }}>{compact ? <Trash2 size={14} /> : t("pluginControls.uninstallShort")}</button>;
}

export function PluginConfigurationPanel({
  owner,
  compact = false,
  load,
  store,
  onChanged,
}: {
  /** Whose settings these are; another owner reads them again. */
  owner: string;
  compact?: boolean;
  load: () => Promise<PluginConfigurationView>;
  store: (values: PluginConfigurationValues) => Promise<PluginConfigurationView>;
  onChanged: () => void;
}) {
  const [config, setConfig] = useState<PluginConfigurationView>();
  const [values, setValues] = useState<PluginConfigurationValues>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [notice, setNotice] = useState<string>();
  useEffect(() => {
    let active = true;
    void load()
      .then((value) => {
        if (active) {
          setConfig(value);
          setValues({});
        }
      })
      .catch((cause) => {
        if (active) setError(message(cause));
      });
    return () => {
      active = false;
    };
  }, [owner]);
  if (config && !Object.keys(config.fields).length) return null;
  return (
    <section className="plugin-components plugin-configuration">
      {!compact ? <h2>{t("pluginControls.configuration")}</h2> : null}
      {config ? (
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void save();
          }}
        >
          {Object.entries(config.fields).map(([key, field]) => {
            const value =
              values[key] ?? config.values[key] ?? field.default ?? "";
            return (
              <label key={key} title={compact ? field.description : undefined}>
                <span>
                  {field.label}
                  {field.required ? " *" : ""}
                </span>
                {field.type === "boolean" ? (
                  <input
                    type="checkbox"
                    checked={value === true}
                    onChange={(event) =>
                      setValues((v) => ({ ...v, [key]: event.target.checked }))
                    }
                  />
                ) : field.type === "select" ? (
                  <select
                    value={String(value)}
                    onChange={(event) =>
                      setValues((v) => ({ ...v, [key]: event.target.value }))
                    }
                  >
                    <option value="">{t("pluginControls.chooseOption")}</option>
                    {field.options?.map((option) => (
                      <option key={option}>{option}</option>
                    ))}
                  </select>
                ) : (
                  <input
                    type={field.type === "secret" ? "password" : "text"}
                    autoComplete="off"
                    value={
                      field.type === "secret"
                        ? String(values[key] ?? "")
                        : String(value)
                    }
                    placeholder={
                      field.type === "secret" &&
                      config.configuredSecrets.includes(key)
                        ? t("pluginControls.configuredReplace")
                        : field.type === "path"
                          ? t("pluginControls.absolutePath")
                          : undefined
                    }
                    onChange={(event) =>
                      setValues((v) => ({ ...v, [key]: event.target.value }))
                    }
                  />
                )}
                {!compact && field.description ? <small>{field.description}</small> : null}
                {field.type === "secret" &&
                config.configuredSecrets.includes(key) ? (
                  <button
                    className="plugin-detail-secondary"
                    type="button"
                    onClick={() => setValues((v) => ({ ...v, [key]: null }))}
                  >
                    {values[key] === null
                      ? t("pluginControls.willClear")
                      : t("pluginControls.clearSaved")}
                  </button>
                ) : null}
              </label>
            );
          })}
          {config.missing.length ? (
            <p role="status">
              {t("pluginControls.needsConfiguration", {
                fields: config.missing
                  .map((key) => config.fields[key]?.label)
                  .join(", "),
              })}
            </p>
          ) : null}
          <button
            className="plugin-detail-primary"
            type="submit"
            disabled={busy || !Object.keys(values).length}
          >
            {busy ? t("common.saving") : t("pluginControls.saveConfiguration")}
          </button>
        </form>
      ) : (
        <p>{t("pluginControls.loadingConfiguration")}</p>
      )}
      {notice ? <p role="status">{notice}</p> : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
  async function save() {
    setBusy(true);
    setError(undefined);
    try {
      setConfig(await store(values));
      setValues({});
      setNotice(
        compact ? t("common.saved") : t("pluginControls.savedActive"),
      );
      onChanged();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : t("common.somethingWrong");
}
