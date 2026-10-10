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

const SOURCE_LABELS: Record<EffectiveNetworkProxy["source"], string> = {
  manual: "Manual proxy",
  environment: "Environment",
  system: "System proxy",
  direct: "Direct connection",
};

export function NetworkSettingsPanel() {
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
        setForm(next.settings);
      })
      .catch((cause) => {
        if (!disposed) setError(errorMessage(cause));
      });
    return () => {
      disposed = true;
    };
  }, []);

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
          {error ?? "Loading network settings…"}
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
        <h3>Network</h3>
      </header>
      <fieldset className="settings-network-fields" disabled={Boolean(busy)}>
        <div className="settings-network-mode">
          <span className="settings-search-field-label">Proxy</span>
          <div
            className="settings-provider-options"
            role="radiogroup"
            aria-label="Network proxy mode"
          >
            {(
              [
                ["auto", "Automatic"],
                ["manual", "Manual"],
                ["direct", "Direct"],
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
            <span className="settings-search-field-label">Proxy URL</span>
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
              Clash HTTP / Mixed port.
            </small>
          </label>
        ) : null}
        <details>
          <summary>Advanced</summary>
          <div className="settings-network-advanced">
            <label className="settings-detail-field">
              <span className="settings-search-field-label">
                Bypass proxy for
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
                Comma-separated. Local addresses always bypass.
              </small>
            </label>
            {canDetect ? (
              <button
                className="settings-secondary-button"
                type="button"
                onClick={() => void perform("detect")}
              >
                {busy === "detect" ? "Detecting…" : "Detect system proxy"}
              </button>
            ) : null}
          </div>
        </details>
      </fieldset>
      {state.requiresRestart || saved || state.detected.warning ? (
        <div className="settings-network-status" aria-label="Network status">
          {state.requiresRestart ? (
            <div className="settings-network-restart">
              <p role="status">
                {saved ? "Saved. " : ""}
                {window.ohMyGameDesktop?.restartApp
                  ? "Restart to apply."
                  : `Restart ${window.ohMyGameDesktop ? "OhMyGame" : "the local service"} to apply.`}
              </p>
              {window.ohMyGameDesktop?.restartApp ? (
                <button
                  className="settings-secondary-button"
                  type="button"
                  disabled={Boolean(busy)}
                  onClick={() => void restart()}
                >
                  {busy === "restart" ? "Restarting…" : "Restart now"}
                </button>
              ) : null}
            </div>
          ) : saved ? (
            <p role="status">Saved.</p>
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
            ? `api.openai.com reachable · ${result.elapsedMs} ms`
            : (result.error ?? "Connection failed")}
        </p>
      ) : null}
      {error ? (
        <p className="settings-error" role="alert">
          {error}
        </p>
      ) : null}
      <div className="settings-form-actions">
        <button
          className="settings-secondary-button"
          type="button"
          disabled={Boolean(busy) || (manual && !form.proxyUrl.trim())}
          onClick={() => void perform("test")}
        >
          {busy === "test" ? "Testing…" : "Test connection"}
        </button>
        <button
          className="settings-primary-button"
          type="submit"
          disabled={Boolean(busy) || (manual && !form.proxyUrl.trim())}
        >
          {busy === "save" ? "Saving…" : "Save"}
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
