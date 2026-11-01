import { useState } from "react";
import type { PluginDetail } from "../shared/plugins.js";
import type { PluginDiagnostics } from "../shared/plugin-portability.js";
import {
  checkPluginDependencies,
  exportPluginArchive,
} from "./api.js";
import { LoaderCircle, Wrench } from "./icons.js";
import { t } from "./i18n.js";

export function PluginExportButton({ plugin }: { plugin: PluginDetail }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <>
      <button
        className="plugin-detail-secondary"
        type="button"
        disabled={busy}
        onClick={() => {
          setBusy(true);
          setError(undefined);
          void exportPluginArchive(plugin.id)
            .then((blob) => {
              const url = URL.createObjectURL(blob);
              const anchor = document.createElement("a");
              anchor.href = url;
              anchor.download = `${plugin.name}-${plugin.version ?? "plugin"}.zip`;
              document.body.appendChild(anchor);
              anchor.click();
              anchor.remove();
              window.setTimeout(() => URL.revokeObjectURL(url), 1000);
            })
            .catch((cause) => setError(message(cause)))
            .finally(() => setBusy(false));
        }}
      >
        {t(busy ? "pluginPortability.exporting" : "pluginPortability.export")}
      </button>
      {error ? <p role="alert">{error}</p> : null}
    </>
  );
}

export function PluginDependencyPanel({ plugin }: { plugin: PluginDetail }) {
  const [diagnostics, setDiagnostics] = useState<PluginDiagnostics>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  return (
    <section className="plugin-components plugin-dependencies">
      <h2>{t("pluginPortability.dependencies")}</h2>
      <div>
        <div className="plugin-component-row plugin-mcp-row">
          <span className="plugin-component-icon">
            {busy ? (
              <LoaderCircle size={15} className="spin" aria-hidden="true" />
            ) : (
              <Wrench size={15} aria-hidden="true" />
            )}
          </span>
          <span className="plugin-row-copy">
            <strong>{t("pluginPortability.localTools")}</strong>
            <span role="status">
              {busy
                ? t("pluginPortability.checking")
                : diagnostics && !diagnostics.checks.length
                  ? t("pluginPortability.noDependencies")
                  : diagnostics
                    ? t(`pluginPortability.status.${worstStatus(diagnostics)}`)
                    : t("pluginPortability.dependenciesHint")}
            </span>
          </span>
          <div className="plugin-mcp-actions">
            <button
              className="plugin-detail-secondary"
              type="button"
              disabled={busy}
              onClick={() => {
                setBusy(true);
                setError(undefined);
                void checkPluginDependencies(plugin.id)
                  .then(setDiagnostics)
                  .catch((cause) => setError(message(cause)))
                  .finally(() => setBusy(false));
              }}
            >
              {t("pluginPortability.check")}
            </button>
          </div>
        </div>
        {diagnostics?.checks.length ? (
          <ul className="plugin-dependency-checks">
            {diagnostics.checks.map((check, index) => (
              <li key={index} className={`is-${check.status}`}>
                <strong>{t(`pluginPortability.status.${check.status}`)}</strong>
                <span>
                  {t(`pluginPortability.checks.${check.code}`, {
                    target: check.target,
                  })}
                </span>
              </li>
            ))}
          </ul>
        ) : null}
      </div>
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

function worstStatus(diagnostics: PluginDiagnostics) {
  const statuses = diagnostics.checks.map((check) => check.status);
  return statuses.includes("error")
    ? "error"
    : statuses.includes("warning")
      ? "warning"
      : "ok";
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : t("common.somethingWrong");
}
