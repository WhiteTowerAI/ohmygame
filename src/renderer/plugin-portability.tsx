import { useState } from "react";
import type { PluginDetail } from "../shared/plugins.js";
import { PLUGIN_ARCHIVE_MAX_BYTES } from "../shared/plugins.js";
import type {
  PluginArchivePreview,
  PluginDiagnostics,
} from "../shared/plugin-portability.js";
import {
  checkPluginDependencies,
  exportPluginArchive,
  inspectPluginArchive,
  restorePluginArchive,
} from "./api.js";
import { LoaderCircle, Wrench } from "./icons.js";
import { t } from "./i18n.js";
import { PluginFilePicker } from "./plugin-file-picker.js";

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

export function PluginImportDialog({
  onClose,
  onInstalled,
}: {
  onClose: () => void;
  onInstalled: (plugin: PluginDetail) => void;
}) {
  const [file, setFile] = useState<File>();
  const [preview, setPreview] = useState<PluginArchivePreview>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const review = (selected: File) => {
    setPreview(undefined);
    setError(undefined);
    if (selected.size > PLUGIN_ARCHIVE_MAX_BYTES) {
      setError(t("pluginPortability.tooLarge"));
      return;
    }
    setBusy(true);
    void inspectPluginArchive(selected)
      .then(setPreview)
      .catch((cause) => setError(message(cause)))
      .finally(() => setBusy(false));
  };
  return (
    <div
      className="plugin-install-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <form
        className="plugin-install-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="plugin-import-title"
        onSubmit={(event) => {
          event.preventDefault();
          if (!file || !preview || busy) return;
          if (
            preview.existingRevision &&
            !window.confirm(
              t("pluginPortability.confirmReplace", {
                name: preview.plugin.displayName,
              }),
            )
          )
            return;
          setBusy(true);
          setError(undefined);
          void restorePluginArchive(file, preview.existingRevision)
            .then(onInstalled)
            .catch((cause) => {
              setError(message(cause));
              setPreview(undefined);
            })
            .finally(() => setBusy(false));
        }}
      >
        <header>
          <h2 id="plugin-import-title">{t("pluginPortability.import")}</h2>
          <p>{t("pluginPortability.importHint")}</p>
        </header>
        <PluginFilePicker
          label={t("pluginPortability.chooseArchive")}
          inputLabel={t("pluginPortability.chooseArchive")}
          chooseLabel={t("common.chooseFile")}
          emptyLabel={t("common.noFileSelected")}
          file={file}
          accept=".zip,application/zip"
          disabled={busy}
          onChange={(selected) => {
            setPreview(undefined);
            setFile(selected);
            setError(undefined);
            if (selected) review(selected);
          }}
        />
        {file && !preview && !busy ? (
          <button
            className="plugin-detail-secondary"
            type="button"
            onClick={() => review(file)}
          >
            {t("pluginPortability.review")}
          </button>
        ) : null}
        {preview ? (
          <div>
            <strong>{preview.plugin.displayName}</strong>
            <p>{preview.plugin.description}</p>
            <p>
              {t(
                preview.existingRevision
                  ? "pluginPortability.replacesExisting"
                  : "pluginPortability.installsPersonal",
              )}
            </p>
            {preview.restoresSettings ? (
              <p>{t("pluginPortability.restoresSettings")}</p>
            ) : null}
          </div>
        ) : null}
        {error ? (
          <p className="plugins-inline-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer>
          <button
            className="plugin-detail-secondary"
            type="button"
            disabled={busy}
            onClick={onClose}
          >
            {t("common.cancel")}
          </button>
          <button
            className="plugin-install-submit"
            type="submit"
            disabled={busy || !preview}
          >
            {t(
              busy
                ? preview
                  ? "plugins.installing"
                  : "pluginPortability.inspecting"
                : "pluginPortability.restore",
            )}
          </button>
        </footer>
      </form>
    </div>
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
