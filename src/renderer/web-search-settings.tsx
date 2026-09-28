import { useEffect, useState } from "react";
import type {
  UpdateWebSearchSettings,
  WebSearchProvider,
  WebSearchSettings,
} from "../shared/web-search.js";
import { getWebSearchSettings, updateWebSearchSettings } from "./api.js";

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
        setForm(formFromSettings(next));
      })
      .catch((cause) => {
        if (!disposed) setError(errorMessage(cause));
      });
    return () => {
      disposed = true;
    };
  }, []);

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
    return (
      <section className="settings-panel settings-overview-panel">
        <p className={error ? "settings-error" : "settings-loading"}>
          {error ?? "Loading web search settings..."}
        </p>
      </section>
    );
  }

  function update(patch: Partial<FormState>) {
    setSaved(false);
    setForm((current) => (current ? { ...current, ...patch } : current));
  }

  return (
    <form
      className="settings-panel settings-overview-panel settings-web-search-panel"
      onSubmit={(event) => {
        event.preventDefault();
        void save();
      }}
    >
      <header className="settings-panel-header">
        <h3>Web Search</h3>
      </header>
      <div className="settings-search-row">
        <strong>Web search</strong>
        <label className="settings-toggle">
          <input
            type="checkbox"
            checked={form.enabled}
            onChange={(event) => update({ enabled: event.target.checked })}
          />
          <span />
        </label>
      </div>

      <section className="settings-search-section">
        <div className="settings-search-section-header">
          <h4>Provider</h4>
          <p>Choose the service that runs web searches.</p>
        </div>
        <div
          className="settings-provider-options"
          role="radiogroup"
          aria-label="Web search provider"
        >
          {(
            [
              ["auto", "Auto", "Select Exa or Parallel automatically"],
              ["exa", "Exa", "Always use Exa"],
              ["parallel", "Parallel", "Always use Parallel"],
              ["custom", "Custom MCP", "Use a compatible MCP server"],
            ] as const
          ).map(([value, label, description]) => (
            <label className="settings-provider-option" key={value}>
              <input
                type="radio"
                name="web-search-provider"
                value={value}
                checked={form.provider === value}
                disabled={!form.enabled}
                onChange={() => update({ provider: value })}
              />
              <span className="settings-provider-option-label">{label}</span>
              <span className="settings-provider-option-description">
                {description}
              </span>
            </label>
          ))}
        </div>
        <div className="settings-search-option-row">
          <span>
            <strong>Use fallback provider</strong>
            <small>
              Retry with the other public provider when automatic search fails.
            </small>
          </span>
          <label className="settings-toggle">
            <input
              type="checkbox"
              checked={form.fallback}
              disabled={!form.enabled || form.provider !== "auto"}
              onChange={(event) => update({ fallback: event.target.checked })}
            />
            <span />
          </label>
        </div>
      </section>

      <section className="settings-search-section">
        <div className="settings-search-section-header">
          <h4>API keys</h4>
          <p>Add credentials for the public providers you use.</p>
        </div>
        <div className="settings-search-credentials">
          <SearchCredential
            label="Exa API key"
            configured={settings.exaApiKeyConfigured}
            value={form.exaApiKey}
            clear={form.clearExaApiKey}
            disabled={!form.enabled}
            onChange={(exaApiKey) =>
              update({ exaApiKey, clearExaApiKey: false })
            }
            onClear={(clearExaApiKey) =>
              update({ clearExaApiKey, exaApiKey: "" })
            }
          />
          <SearchCredential
            label="Parallel API key"
            configured={settings.parallelApiKeyConfigured}
            value={form.parallelApiKey}
            clear={form.clearParallelApiKey}
            disabled={!form.enabled}
            onChange={(parallelApiKey) =>
              update({ parallelApiKey, clearParallelApiKey: false })
            }
            onClear={(clearParallelApiKey) =>
              update({ clearParallelApiKey, parallelApiKey: "" })
            }
          />
        </div>
      </section>

      {form.provider === "custom" ? (
        <section className="settings-search-section settings-custom-search-section">
          <div className="settings-search-section-header">
            <h4>Custom MCP</h4>
            <p>Connect a compatible server for web search.</p>
          </div>
          <div className="settings-search-fields">
            <label>
              <span className="settings-search-field-label">Name</span>
              <input
                className="settings-search-input"
                value={form.customName}
                disabled={!form.enabled}
                onChange={(event) => update({ customName: event.target.value })}
              />
            </label>
            <label>
              <span className="settings-search-field-label">Endpoint</span>
              <input
                className="settings-search-input"
                type="url"
                value={form.customEndpoint}
                disabled={!form.enabled}
                placeholder="https://search.example.com/mcp"
                onChange={(event) =>
                  update({ customEndpoint: event.target.value })
                }
              />
            </label>
            <label>
              <span className="settings-search-field-label">Tool name</span>
              <input
                className="settings-search-input"
                value={form.customToolName}
                disabled={!form.enabled}
                placeholder="web_search"
                onChange={(event) =>
                  update({ customToolName: event.target.value })
                }
              />
            </label>
            <SearchCredential
              label="Bearer token"
              configured={settings.custom?.apiKeyConfigured ?? false}
              value={form.customApiKey}
              clear={form.clearCustomApiKey}
              disabled={!form.enabled}
              onChange={(customApiKey) =>
                update({ customApiKey, clearCustomApiKey: false })
              }
              onClear={(clearCustomApiKey) =>
                update({ clearCustomApiKey, customApiKey: "" })
              }
            />
          </div>
        </section>
      ) : null}

      {error ? (
        <p className="settings-error" role="alert">
          {error}
        </p>
      ) : null}
      {saved ? (
        <p className="settings-success">Web search settings saved.</p>
      ) : null}
      <div className="settings-form-actions">
        <button
          className="settings-primary-button"
          type="submit"
          disabled={saving}
        >
          {saving ? "Saving..." : "Save"}
        </button>
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
      <label>
        <span className="settings-search-field-label">
          <span>{label}</span>
          {configured && !clear ? (
            <span className="settings-search-field-status">Saved</span>
          ) : null}
        </span>
        <input
          className="settings-search-input"
          type="password"
          autoComplete="off"
          value={value}
          disabled={disabled || clear}
          placeholder={
            configured && !clear
              ? "Saved - enter a new value to replace"
              : "Optional"
          }
          onChange={(event) => onChange(event.target.value)}
        />
      </label>
      {configured ? (
        <label className="settings-checkbox-row">
          <input
            type="checkbox"
            checked={clear}
            disabled={disabled}
            onChange={(event) => onClear(event.target.checked)}
          />
          <span>Remove saved key</span>
        </label>
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
