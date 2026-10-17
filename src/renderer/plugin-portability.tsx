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
    <section className="plugin-management">
      <h2>{t("pluginPortability.dependencies")}</h2>
      <p>{t("pluginPortability.dependenciesHint")}</p>
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
        {t(busy ? "pluginPortability.checking" : "pluginPortability.check")}
      </button>
      {diagnostics ? (
        <div role="status">
          {diagnostics.checks.length ? (
            <ul>
              {diagnostics.checks.map((check, index) => (
                <li key={index}>
                  <strong>
                    {t(`pluginPortability.status.${check.status}`)}
                  </strong>{" "}
                  ·{" "}
                  {t(`pluginPortability.checks.${check.code}`, {
                    target: check.target,
                  })}
                </li>
              ))}
            </ul>
          ) : (
            <p>{t("pluginPortability.noDependencies")}</p>
          )}
        </div>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
    </section>
  );
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : t("common.somethingWrong");
}
