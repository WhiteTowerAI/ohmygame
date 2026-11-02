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
import { Button, Field, Input, SegmentedControl } from "./ui/index.js";
import { SettingsGroup, SettingsNote, SettingsRow } from "./settings-parts.js";

const SOURCE_LABELS: Record<EffectiveNetworkProxy["source"], string> = {
  manual: t("network.source.manual"),
  environment: t("network.source.environment"),
  system: t("network.source.system"),
  direct: t("network.source.direct"),
};

const MODE_HINTS: Record<NetworkSettings["mode"], string> = {
  direct: t("network.hints.direct"),
  manual: t("network.hints.manual"),
  auto: t("network.hints.auto"),
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
    return error ? <SettingsNote tone="danger">{error}</SettingsNote> : <div className="settings-loading-row">{t("network.loading")}</div>;

  const manual = form.mode === "manual";
  const dirty =
    form.mode !== state.settings.mode ||
    form.proxyUrl !== state.settings.proxyUrl ||
    form.noProxy !== state.settings.noProxy;
  const canDetect =
    state.systemProxyAvailable &&
    state.detected.source !== "environment" &&
    state.settings.mode === "auto" &&
    form.mode === "auto";
  const locked = Boolean(busy);
  return (
    <form
      className="settings-form settings-network-panel"
      onSubmit={(event) => {
        event.preventDefault();
        void perform("save");
      }}
    >
      <SettingsGroup title={t("network.proxy")}>
        <SettingsRow title={t("settings.network.mode")} description={MODE_HINTS[form.mode]}>
          <SegmentedControl
            size="sm"
            label={t("network.modeLabel")}
            value={form.mode}
            onChange={(mode) => update({ mode })}
            options={[
              { value: "auto", label: t("network.automatic"), disabled: locked },
              { value: "manual", label: t("network.manual"), disabled: locked },
              { value: "direct", label: t("network.direct"), disabled: locked },
            ]}
          />
        </SettingsRow>
        {form.mode === "auto" ? (
          <SettingsRow title={t("settings.network.currentSource")} description={proxyDescription(state.detected)}>
            {canDetect ? (
              <Button size="sm" disabled={locked} onClick={() => void perform("detect")}>
                {busy === "detect" ? t("network.detecting") : t("network.detect")}
              </Button>
            ) : null}
          </SettingsRow>
        ) : null}
        {/* Direct connections use no proxy, so there is nothing to bypass. */}
        {form.mode !== "direct" ? <div className="settings-pad settings-form">
          {manual ? (
            <Field label={t("network.proxyUrl")} hint={t("network.clashHint")}>
              {(props) => (
                <Input
                  {...props}
                  type="url"
                  required
                  placeholder="http://127.0.0.1:7890"
                  value={form.proxyUrl}
                  disabled={locked}
                  onChange={(event) => update({ proxyUrl: event.target.value })}
                  spellCheck={false}
                  autoComplete="off"
                />
              )}
            </Field>
          ) : null}
          <Field label={t("network.bypass")} hint={t("network.bypassHint")}>
            {(props) => (
              <Input
                {...props}
                value={form.noProxy}
                disabled={locked}
                onChange={(event) => update({ noProxy: event.target.value })}
                placeholder="example.com, .internal.example"
                spellCheck={false}
                autoComplete="off"
              />
            )}
          </Field>
        </div> : null}
      </SettingsGroup>
      {dirty || state.requiresRestart || saved || state.detected.warning ? (
        <div className="settings-form" aria-label={t("network.status")} role="group">
          {dirty ? <SettingsNote>{t("network.unsaved")}</SettingsNote> : null}
          {state.requiresRestart ? (
            <SettingsNote role="status">
              <span className="settings-note-row">
                <span>
                  {saved ? t("network.savedPrefix") : ""}
                  {window.ohMyGameDesktop?.restartApp
                    ? t("network.restartToApply")
                    : window.ohMyGameDesktop ? t("network.restartAppToApply") : t("network.restartServiceToApply")}
                </span>
                {window.ohMyGameDesktop?.restartApp ? (
                  <Button size="sm" disabled={locked} onClick={() => void restart()}>
                    {busy === "restart" ? t("network.restarting") : t("network.restartNow")}
                  </Button>
                ) : null}
              </span>
            </SettingsNote>
          ) : saved ? (
            <SettingsNote tone="success" role="status">{t("network.saved")}</SettingsNote>
          ) : null}
          {state.detected.warning ? <SettingsNote>{state.detected.warning}</SettingsNote> : null}
        </div>
      ) : null}
      <SettingsGroup title={t("settings.network.status")}>
        <SettingsRow title={t("network.test")} description={t("network.testHint")}>
          <Button
            disabled={locked || (manual && !form.proxyUrl.trim())}
            onClick={() => void perform("test")}
          >
            {busy === "test" ? t("network.testing") : t("network.test")}
          </Button>
        </SettingsRow>
        {result ? (
          <div className="settings-pad">
            <SettingsNote tone={result.reachable ? "success" : "danger"} role="status">
              <span title={`HTTP ${result.statusCode ?? "—"} · ${proxyDescription(result.route)}`}>
                {result.reachable
                  ? t("network.reachable", { ms: result.elapsedMs })
                  : (result.error ?? t("providers.status.failed"))}
              </span>
            </SettingsNote>
          </div>
        ) : null}
      </SettingsGroup>
      {error ? <SettingsNote tone="danger">{error}</SettingsNote> : null}
      <div className="settings-actions">
        <Button
          variant="primary"
          type="submit"
          disabled={locked || !dirty || (manual && !form.proxyUrl.trim())}
        >
          {busy === "save" ? t("common.saving") : t("common.save")}
        </Button>
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
