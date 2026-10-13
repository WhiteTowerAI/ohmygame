import { useReadyRuntimeGeneration } from "./runtime-connection.js";
import { useEffect, useState } from "react";
import type {
  EffectiveNetworkProxy,
  NetworkConnectionTest,
  NetworkSettings,
  NetworkSettingsState,
} from "../shared/network-settings.js";
import {
  detectNetworkProxy,
  getNetworkSettings,
  testNetworkConnection,
  updateNetworkSettings,
} from "./api.js";
import { t } from "./i18n.js";

const SOURCE_LABELS: Record<EffectiveNetworkProxy["source"], string> = {
  manual: t("network.source.manual"),
  environment: t("network.source.environment"),
  system: t("network.source.system"),
  direct: t("network.source.direct"),
};

export function NetworkSettingsPanel() {
  const serviceGeneration = useReadyRuntimeGeneration();
  const [state, setState] = useState<NetworkSettingsState>();
  const [form, setForm] = useState<NetworkSettings>();
  const [busy, setBusy] = useState<"save" | "detect" | "test" | "restart">();
  const [error, setError] = useState<string>();
  const [saved, setSaved] = useState(false);
  const [result, setResult] = useState<NetworkConnectionTest>();

  useEffect(() => {
    let disposed = false;
    void getNetworkSettings()
      .then((next) => {
        if (disposed) return;
        setState(next);
        setError(undefined);
        setForm((current) => current ?? next.settings);
      })
      .catch((cause) => {
        if (!disposed) setError(errorMessage(cause));
      });
    return () => {
      disposed = true;
    };
  }, [serviceGeneration]);

  function update(patch: Partial<NetworkSettings>) {
    setForm((current) => (current ? { ...current, ...patch } : current));
    setSaved(false);
    setResult(undefined);
    setError(undefined);
  }

  async function perform(action: "save" | "detect" | "test") {
    if (!form || busy) return;
    setBusy(action);
    setError(undefined);
    setSaved(false);
    try {
      if (action === "save") {
        const next = await updateNetworkSettings(form);
        setState(next);
        setForm(next.settings);
        setSaved(true);
        setResult(undefined);
      } else if (action === "detect") {
        setState(await detectNetworkProxy());
        setResult(undefined);
      } else {
        setResult(await testNetworkConnection(form));
      }
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(undefined);
    }
  }

  async function restart() {
    if (busy || !window.ohMyGameDesktop?.restartApp) return;
    setBusy("restart");
    setError(undefined);
    try {
      await window.ohMyGameDesktop.restartApp();
    } catch (cause) {
      setError(errorMessage(cause));
      setBusy(undefined);
    }
  }

  if (!state || !form)
    return (
      <section className="settings-panel settings-overview-panel">
        <p className={error ? "settings-error" : "settings-loading"}>
          {error ?? t("network.loading")}
        </p>
      </section>
    );

  const manual = form.mode === "manual";
  const canDetect =
    state.systemProxyAvailable &&
    state.settings.mode === "auto" &&
    form.mode === "auto";
  return (
    <form
      className="settings-panel settings-overview-panel settings-network-panel"
      onSubmit={(event) => {
        event.preventDefault();
        void perform("save");
      }}
    >
      <header className="settings-panel-header">
        <h3>{t("network.title")}</h3>
      </header>
      <fieldset className="settings-network-fields" disabled={Boolean(busy)}>
        <div className="settings-network-mode">
          <span className="settings-search-field-label">{t("network.proxy")}</span>
          <div
            className="settings-provider-options"
            role="radiogroup"
            aria-label={t("network.modeLabel")}
          >
            {(
              [
                ["auto", t("network.automatic")],
                ["manual", t("network.manual")],
                ["direct", t("network.direct")],
              ] as const
            ).map(([mode, label]) => (
              <label className="settings-provider-option" key={mode}>
                <input
                  type="radio"
                  name="network-proxy-mode"
                  value={mode}
                  checked={form.mode === mode}
                  onChange={() => update({ mode })}
                />
                <span className="settings-provider-option-label">{label}</span>
              </label>
            ))}
          </div>
        </div>
        {manual ? (
          <label className="settings-detail-field">
            <span className="settings-search-field-label">{t("network.proxyUrl")}</span>
            <input
              className="settings-search-input"
              type="url"
              required
              placeholder="http://127.0.0.1:7890"
              value={form.proxyUrl}
              onChange={(event) => update({ proxyUrl: event.target.value })}
              spellCheck={false}
              autoComplete="off"
            />
            <small className="settings-detail-hint">
              {t("network.clashHint")}
            </small>
          </label>
        ) : null}
        <details>
          <summary>{t("common.advanced")}</summary>
          <div className="settings-network-advanced">
            <label className="settings-detail-field">
              <span className="settings-search-field-label">
                {t("network.bypass")}
              </span>
              <input
                className="settings-search-input"
                value={form.noProxy}
                onChange={(event) => update({ noProxy: event.target.value })}
                placeholder="example.com, .internal.example"
                spellCheck={false}
                autoComplete="off"
              />
              <small className="settings-detail-hint">
                {t("network.bypassHint")}
              </small>
            </label>
            {canDetect ? (
              <button
                className="settings-add-button"
                type="button"
                onClick={() => void perform("detect")}
              >
                {busy === "detect" ? t("network.detecting") : t("network.detect")}
              </button>
            ) : null}
          </div>
        </details>
      </fieldset>
      {state.requiresRestart || saved || state.detected.warning ? (
        <div className="settings-network-status" aria-label={t("network.status")}>
          {state.requiresRestart ? (
            <div className="settings-network-restart">
              <p role="status">
                {saved ? t("network.savedPrefix") : ""}
                {window.ohMyGameDesktop?.restartApp
                  ? t("network.restartToApply")
                  : window.ohMyGameDesktop ? t("network.restartAppToApply") : t("network.restartServiceToApply")}
              </p>
              {window.ohMyGameDesktop?.restartApp ? (
                <button
                  className="settings-secondary-button"
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => void restart()}
                >
                  {busy === "restart" ? t("network.restarting") : t("network.restartNow")}
                </button>
              ) : null}
            </div>
          ) : saved ? (
            <p role="status">{t("network.saved")}</p>
          ) : null}
          {state.detected.warning ? <p>{state.detected.warning}</p> : null}
        </div>
      ) : null}
      {result ? (
        <p
          className={result.reachable ? "settings-success" : "settings-error"}
          role="status"
          title={`HTTP ${result.statusCode ?? "—"} · ${proxyDescription(result.route)}`}
        >
          {result.reachable
            ? t("network.reachable", { ms: result.elapsedMs })
            : (result.error ?? t("providers.status.failed"))}
        </p>
      ) : null}
      {error ? (
        <p className="settings-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="settings-form-actions">
        <button
          className="settings-add-button"
          type="button"
          disabled={Boolean(busy) || (manual && !form.proxyUrl.trim())}
          onClick={() => void perform("test")}
        >
          {busy === "test" ? t("network.testing") : t("network.test")}
        </button>
        <button
          className="settings-primary-button"
          type="submit"
          disabled={Boolean(busy) || (manual && !form.proxyUrl.trim())}
        >
          {busy === "save" ? t("common.saving") : t("common.save")}
        </button>
      </div>
    </form>
  );
}

function proxyDescription(proxy: EffectiveNetworkProxy): string {
  if (!proxy.httpProxy) return SOURCE_LABELS[proxy.source];
  return `${SOURCE_LABELS[proxy.source]} · ${proxy.httpProxy}${proxy.httpsProxy !== proxy.httpProxy ? ` / ${proxy.httpsProxy}` : ""}`;
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
