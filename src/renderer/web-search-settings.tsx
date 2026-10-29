import { useReadyRuntimeGeneration } from "./runtime-connection.js";
import { useEffect, useState } from "react";
import type {
  UpdateWebSearchSettings,
  WebSearchProvider,
  WebSearchSettings,
} from "../shared/web-search.js";
import { getWebSearchSettings, updateWebSearchSettings } from "./api.js";
import { t } from "./i18n.js";
import { Button, Checkbox, Field, Input, RadioGroup, Switch } from "./ui/index.js";
import { SettingsBadge, SettingsGroup, SettingsNote, SettingsRow } from "./settings-parts.js";

interface FormState {
  enabled: boolean;
  provider: WebSearchProvider;
  fallback: boolean;
  exaApiKey: string;
  parallelApiKey: string;
  clearExaApiKey: boolean;
  clearParallelApiKey: boolean;
  customName: string;
  customEndpoint: string;
  customToolName: string;
  customApiKey: string;
  clearCustomApiKey: boolean;
}

export function WebSearchSettingsPanel() {
  const serviceGeneration = useReadyRuntimeGeneration();
  const [settings, setSettings] = useState<WebSearchSettings>();
  const [form, setForm] = useState<FormState>();
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    let disposed = false;
    void getWebSearchSettings()
      .then((next) => {
        if (disposed) return;
        setSettings(next);
        setError(undefined);
        setForm((current) => current ?? formFromSettings(next));
      })
      .catch((cause) => {
        if (!disposed) setError(errorMessage(cause));
      });
    return () => {
      disposed = true;
    };
  }, [serviceGeneration]);

  async function save() {
    if (!form || saving) return;
    setSaving(true);
    setError(undefined);
    setSaved(false);
    try {
      const next = await updateWebSearchSettings(updateFromForm(form));
      setSettings(next);
      setForm(formFromSettings(next));
      setSaved(true);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  if (!form || !settings) {
    return error ? <SettingsNote tone="danger">{error}</SettingsNote> : <div className="settings-loading-row">{t("webSearch.loading")}</div>;
  }

  function update(patch: Partial<FormState>) {
    setSaved(false);
    setForm((current) => (current ? { ...current, ...patch } : current));
  }

  return (
    <form
      className="settings-form settings-web-search-panel"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <SettingsGroup>
        <SettingsRow title={t("webSearch.toggle")} description={t("settings.webSearch.toggleHint")}>
          <Switch label={t("webSearch.toggle")} checked={form.enabled} onChange={(enabled) => update({ enabled })} />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("webSearch.provider")} description={t("webSearch.providerDescription")}>
        <div className="settings-pad">
          <RadioGroup
            label={t("webSearch.providerLabel")}
            value={form.provider}
            onChange={(provider) => update({ provider })}
            options={(
              [
                ["auto", t("webSearch.auto"), t("webSearch.autoDescription")],
                ["exa", "Exa", t("webSearch.exaDescription")],
                ["parallel", "Parallel", t("webSearch.parallelDescription")],
                ["custom", t("webSearch.customMcp"), t("webSearch.customDescription")],
              ] as const
            ).map(([value, label, description]) => ({ value, label, description, disabled: !form.enabled }))}
          />
        </div>
        <SettingsRow title={t("webSearch.fallback")} description={t("webSearch.fallbackDescription")}>
          <Switch
            label={t("webSearch.fallback")}
            checked={form.fallback}
            disabled={!form.enabled || form.provider !== "auto"}
            onChange={(fallback) => update({ fallback })}
          />
        </SettingsRow>
      </SettingsGroup>

      <SettingsGroup title={t("webSearch.apiKeys")} description={t("webSearch.apiKeysDescription")}>
        <div className="settings-pad settings-form">
          <SearchCredential
            label={t("webSearch.exaKey")}
            configured={settings.exaApiKeyConfigured}
            value={form.exaApiKey}
            clear={form.clearExaApiKey}
            disabled={!form.enabled}
            onChange={(exaApiKey) => update({ exaApiKey, clearExaApiKey: false })}
            onClear={(clearExaApiKey) => update({ clearExaApiKey, exaApiKey: "" })}
          />
          <SearchCredential
            label={t("webSearch.parallelKey")}
            configured={settings.parallelApiKeyConfigured}
            value={form.parallelApiKey}
            clear={form.clearParallelApiKey}
            disabled={!form.enabled}
            onChange={(parallelApiKey) => update({ parallelApiKey, clearParallelApiKey: false })}
            onClear={(clearParallelApiKey) => update({ clearParallelApiKey, parallelApiKey: "" })}
          />
        </div>
      </SettingsGroup>

      {form.provider === "custom" ? (
        <SettingsGroup className="settings-custom-search-section" title={t("webSearch.customMcp")} description={t("webSearch.customDescriptionLong")}>
          <div className="settings-pad settings-form">
            <Field label={t("webSearch.name")}>
              {(props) => <Input {...props} value={form.customName} disabled={!form.enabled} onChange={(event) => update({ customName: event.target.value })} />}
            </Field>
            <Field label={t("webSearch.endpoint")}>
              {(props) => <Input {...props} type="url" value={form.customEndpoint} disabled={!form.enabled} placeholder="https://search.example.com/mcp" onChange={(event) => update({ customEndpoint: event.target.value })} />}
            </Field>
            <Field label={t("webSearch.toolName")}>
              {(props) => <Input {...props} value={form.customToolName} disabled={!form.enabled} placeholder="web_search" onChange={(event) => update({ customToolName: event.target.value })} />}
            </Field>
            <SearchCredential
              label={t("webSearch.bearerToken")}
              configured={settings.custom?.apiKeyConfigured ?? false}
              value={form.customApiKey}
              clear={form.clearCustomApiKey}
              disabled={!form.enabled}
              onChange={(customApiKey) => update({ customApiKey, clearCustomApiKey: false })}
              onClear={(clearCustomApiKey) => update({ clearCustomApiKey, customApiKey: "" })}
            />
          </div>
        </SettingsGroup>
      ) : null}

      {error ? <SettingsNote tone="danger">{error}</SettingsNote> : null}
      {saved ? <SettingsNote tone="success" role="status">{t("webSearch.saved")}</SettingsNote> : null}
      <div className="settings-actions">
        <Button variant="primary" type="submit" disabled={saving}>
          {saving ? t("common.saving") : t("common.save")}
        </Button>
      </div>
    </form>
  );
}

function SearchCredential({
  label,
  configured,
  value,
  clear,
  disabled,
  onChange,
  onClear,
}: {
  label: string;
  configured: boolean;
  value: string;
  clear: boolean;
  disabled: boolean;
  onChange: (value: string) => void;
  onClear: (value: boolean) => void;
}) {
  return (
    <div className="settings-search-credential">
      <Field label={<>{label}{configured && !clear ? <SettingsBadge tone="success">{t("common.saved")}</SettingsBadge> : null}</>}>
        {(props) => (
          <Input
            {...props}
            type="password"
            autoComplete="off"
            value={value}
            disabled={disabled || clear}
            placeholder={configured && !clear ? t("webSearch.replacePlaceholder") : t("webSearch.optional")}
            onChange={(event) => onChange(event.target.value)}
          />
        )}
      </Field>
      {configured ? (
        <Checkbox checked={clear} disabled={disabled} label={t("webSearch.removeKey")} onChange={onClear} />
      ) : null}
    </div>
  );
}

function formFromSettings(settings: WebSearchSettings): FormState {
  return {
    enabled: settings.enabled,
    provider: settings.provider,
    fallback: settings.fallback,
    exaApiKey: "",
    parallelApiKey: "",
    clearExaApiKey: false,
    clearParallelApiKey: false,
    customName: settings.custom?.name ?? "",
    customEndpoint: settings.custom?.endpoint ?? "",
    customToolName: settings.custom?.toolName ?? "web_search",
    customApiKey: "",
    clearCustomApiKey: false,
  };
}

function updateFromForm(form: FormState): UpdateWebSearchSettings {
  const secret = (value: string, clear: boolean): string | null | undefined =>
    clear ? null : value.trim() || undefined;
  return {
    enabled: form.enabled,
    provider: form.provider,
    fallback: form.fallback,
    exaApiKey: secret(form.exaApiKey, form.clearExaApiKey),
    parallelApiKey: secret(form.parallelApiKey, form.clearParallelApiKey),
    ...(form.provider === "custom"
      ? {
          custom: {
            name: form.customName,
            endpoint: form.customEndpoint,
            toolName: form.customToolName,
            apiKey: secret(form.customApiKey, form.clearCustomApiKey),
          },
        }
      : {}),
  };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
