import {
  DEFAULT_PREVIEW_IDLE_MINUTES,
  previewSettings,
  type PreviewMode,
} from "../shared/preview-settings.js";
import { LoaderCircle } from "./icons.js";
import { Button, Disclosure, Switch } from "./ui/index.js";
import { useEffect, useState } from "react";
import { isBuiltinPreviewViewport as isBuiltinViewport, PREVIEW_VIEWPORTS } from "../shared/contracts.js";
import type { ProjectPreviewDevice } from "../shared/plugins.js";
import type {
  BuiltinPreviewViewport,
  PreviewViewport,
  ProjectPackageManager,
  ProjectRunSettings,
  ProjectState,
} from "../shared/contracts.js";
import { inspectProjectPreview, updateProjectRunSettings } from "./api.js";
import { buildsWebPreview, supportsWebPreview } from "../shared/project-runtime.js";
import { t } from "./i18n.js";

const PREVIEW_VIEWPORT_LABEL_KEYS = {
  fit: "projectSettings.device.fit",
  tablet: "projectSettings.device.tablet",
  mobile: "projectSettings.device.mobile",
  "mobile-landscape": "projectSettings.device.mobileLandscape",
} as const satisfies Record<BuiltinPreviewViewport, string>;

/** The Preview tab of a web project's settings. */
export function ProjectPreviewSettings({
  project,
  previewActions,
  previewDevices = [],
  onClose,
  onBusyChange,
  onSaved,
}: {
  project: ProjectState;
  /** The preview devices the project's plugins add. */
  previewDevices?: readonly ProjectPreviewDevice[];
  previewActions?: {
    onReinstall: () => void;
    onStop?: () => void;
  };
  onClose: () => void;
  /** Saving; the settings stay open until it ends, so a failure can show. */
  onBusyChange?: (busy: boolean) => void;
  onSaved: (project: ProjectState) => Promise<void> | void;
}) {
  const [webPreviewEnabled, setWebPreviewEnabled] = useState(
    supportsWebPreview(project),
  );
  // Its plugin builds what the preview serves, so startup settings don't apply.
  const builtByPlugin = buildsWebPreview(project);
  const previewStartDisabled =
    project.preview.status === "starting" ||
    project.preview.status === "waiting";
  const [startupDirectory, setStartupDirectory] = useState(
    project.startupDirectory ?? ".",
  );
  const [startupScript, setStartupScript] = useState(
    project.startupScript ?? "dev",
  );
  const [packageManager, setPackageManager] = useState<
    ProjectPackageManager | "auto"
  >(project.packageManager ?? "auto");
  const [previewPath, setPreviewPath] = useState(project.previewPath ?? "/");
  const [previewViewport, setPreviewViewport] = useState<PreviewViewport>(
    project.previewViewport ?? "fit",
  );
  const [previewAutoStart, setPreviewAutoStart] = useState(
    project.previewAutoStart !== false,
  );
  const [previewMode, setPreviewMode] = useState<PreviewMode>(
    project.previewMode ?? "auto",
  );
  const [previewCommand, setPreviewCommand] = useState(
    project.previewCommand ?? "",
  );
  const [previewArguments, setPreviewArguments] = useState(
    project.previewArguments === undefined
      ? ""
      : JSON.stringify(project.previewArguments),
  );
  const [previewPort, setPreviewPort] = useState(
    project.previewPort?.toString() ?? "",
  );
  const [previewIdleMinutes, setPreviewIdleMinutes] = useState(
    project.previewIdleMinutes ?? DEFAULT_PREVIEW_IDLE_MINUTES,
  );
  const [inspection, setInspection] = useState<{
    manager?: string;
    source?: string;
    error?: string;
  }>();
  useEffect(() => {
    setInspection(undefined);
    if (!webPreviewEnabled || builtByPlugin) return;
    let disposed = false;
    const timer = setTimeout(() => {
      let settings: ProjectRunSettings;
      try {
        settings = startupSettings();
      } catch (cause) {
        setInspection({ error: errorMessage(cause) });
        return;
      }
      void inspectProjectPreview(project.id, settings)
        .then((next) => {
          if (!disposed) setInspection(next);
        })
        .catch((cause) => {
          if (!disposed) setInspection({ error: errorMessage(cause) });
        });
    }, 300);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [
    project.id,
    webPreviewEnabled,
    startupDirectory,
    startupScript,
    packageManager,
    previewMode,
    previewCommand,
    previewArguments,
    previewPort,
  ]);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    onBusyChange?.(saving);
    return () => onBusyChange?.(false);
  }, [saving, onBusyChange]);

  function startupSettings(): ProjectRunSettings {
    const saved: ProjectRunSettings = {
      ...previewSettings(project),
      startupDirectory: project.startupDirectory ?? ".",
      startupScript: project.startupScript ?? "dev",
      packageManager: project.packageManager,
      previewPath: project.previewPath ?? "/",
      previewViewport: project.previewViewport ?? "fit",
    };
    // Disabled controls and inactive mode drafts must not block saving.
    if (!webPreviewEnabled) return saved;
    const usesScript = previewMode === "auto" || previewMode === "script";
    let args = saved.previewArguments;
    if (usesScript) {
      try {
        args = previewArguments.trim()
          ? JSON.parse(previewArguments)
          : undefined;
      } catch {
        throw new Error(t("projectSettings.argumentsInvalid"));
      }
    }
    return {
      ...saved,
      startupDirectory: startupDirectory.trim() || ".",
      previewMode,
      ...(usesScript
        ? {
            startupScript: startupScript.trim() || "dev",
            packageManager:
              packageManager === "auto" ? undefined : packageManager,
            previewArguments: args,
          }
        : {}),
      ...(previewMode === "command"
        ? { previewCommand: previewCommand.trim() }
        : {}),
      ...(previewMode !== "static"
        ? { previewPort: previewPort.trim() ? Number(previewPort) : undefined }
        : {}),
    };
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(undefined);
    try {
      const nextProject = await updateProjectRunSettings(project.id, {
        ...startupSettings(),
        ...(webPreviewEnabled
          ? {
              previewAutoStart,
              previewIdleMinutes,
              previewPath: previewPath.trim() || "/",
              previewViewport,
            }
          : {}),
        ...(project.type === "general" ? { webPreviewEnabled } : {}),
      });
      await onSaved(nextProject);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  }

  return (
      <form
        className="project-settings-form project-run-settings"
        onSubmit={(event) => void submit(event)}
      >
        <div className="ui-dialog-body">
        <section
          className="project-settings-switches"
          aria-label={t("projectSettings.previewAccess")}
        >
          {project.type === "general" ? (
            <div className="project-settings-preview-toggle">
              <strong>{t("projectSettings.webPreview")}</strong>
              <Switch
                size="sm"
                label={t("projectSettings.webPreview")}
                checked={webPreviewEnabled}
                disabled={saving || project.pluginType?.preview === "native"}
                onChange={setWebPreviewEnabled}
              />
            </div>
          ) : null}
          <div className="project-settings-preview-toggle">
            <strong>{t("projectSettings.automaticPreview")}</strong>
            <Switch
              size="sm"
              label={t("projectSettings.automaticPreview")}
              checked={previewAutoStart}
              disabled={saving || !webPreviewEnabled}
              onChange={setPreviewAutoStart}
            />
          </div>
        </section>
        <section
          className="project-settings-group"
          aria-labelledby="preview-startup-heading"
        >
          <h3 id="preview-startup-heading">{t("projectSettings.startup")}</h3>
          <fieldset
            className="project-settings-section"
            disabled={saving || !webPreviewEnabled || builtByPlugin}
          >
            <div className="project-settings-field-row">
              <label>
                <span>{t("projectSettings.startupDirectory")}</span>
                <input
                  value={startupDirectory}
                  spellCheck={false}
                  placeholder="."
                  onChange={(event) => setStartupDirectory(event.target.value)}
                />
              </label>
              <label>
                <span>{t("projectSettings.previewModeField")}</span>
                <select
                  value={previewMode}
                  onChange={(event) =>
                    setPreviewMode(event.target.value as PreviewMode)
                  }
                >
                  <option value="auto">{t("projectSettings.mode.auto")}</option>
                  <option value="script">{t("projectSettings.mode.script")}</option>
                  <option value="static">{t("projectSettings.mode.static")}</option>
                  <option value="command">{t("projectSettings.mode.command")}</option>
                </select>
              </label>
            </div>
            {previewMode === "command" ? (
              <label>
                <span>{t("projectSettings.startupCommand")}</span>
                <input
                  value={previewCommand}
                  spellCheck={false}
                  placeholder="python3 -m http.server {port} --bind {host}"
                  onChange={(event) => setPreviewCommand(event.target.value)}
                />
                <small>
                  {t("projectSettings.portHint")}
                </small>
              </label>
            ) : null}
            {previewMode === "auto" || previewMode === "script" ? (
              <div className="project-settings-field-row">
                <label>
                  <span>{t("projectSettings.startupScript")}</span>
                  <input
                    value={startupScript}
                    spellCheck={false}
                    onChange={(event) => setStartupScript(event.target.value)}
                  />
                </label>
                <label>
                  <span>{t("projectSettings.packageManager")}</span>
                  <select
                    value={packageManager}
                    onChange={(event) =>
                      setPackageManager(
                        event.target.value as ProjectPackageManager | "auto",
                      )
                    }
                  >
                    <option value="auto">{t("projectSettings.mode.auto")}</option>
                    <option value="npm">npm</option>
                    <option value="pnpm">pnpm</option>
                    <option value="yarn">yarn</option>
                    <option value="bun">bun</option>
                  </select>
                </label>
              </div>
            ) : null}
            {inspection && (inspection.manager || inspection.error) ? (
              <p className="preview-config-hint" role="status">
                {inspection.manager
                  ? `${inspection.manager} · ${inspection.source}${inspection.error ? ". " : ""}`
                  : ""}
                {inspection.error}
              </p>
            ) : null}
            {previewMode !== "static" ? (
              <Disclosure
                summary={previewMode === "command"
                  ? t("projectSettings.serverPort")
                  : t("projectSettings.portArguments")}
              >
                <div className="project-settings-section">
                  <label>
                    <span>{t("projectSettings.serverPort")}</span>
                    <input
                      type="number"
                      min={1024}
                      max={65535}
                      value={previewPort}
                      placeholder={t("projectSettings.automatic")}
                      onChange={(event) => setPreviewPort(event.target.value)}
                    />
                  </label>
                  {previewMode === "script" || previewMode === "auto" ? (
                    <label>
                      <span>{t("projectSettings.scriptArguments")}</span>
                      <input
                        value={previewArguments}
                        spellCheck={false}
                        placeholder={t("projectSettings.argumentsPlaceholder")}
                        onChange={(event) =>
                          setPreviewArguments(event.target.value)
                        }
                      />
                      <small>{t("projectSettings.argumentsHint")}</small>
                    </label>
                  ) : null}
                </div>
              </Disclosure>
            ) : null}
          </fieldset>
        </section>
        <section
          className="project-settings-group"
          aria-labelledby="preview-playtest-heading"
        >
          <h3 id="preview-playtest-heading">{t("projectSettings.playtestDefaults")}</h3>
          <fieldset
            className="project-settings-section"
            disabled={saving || !webPreviewEnabled}
          >
            <div className="project-settings-field-row">
              <label>
                <span>{t("projectSettings.defaultRoute")}</span>
                <input
                  value={previewPath}
                  spellCheck={false}
                  onChange={(event) => setPreviewPath(event.target.value)}
                />
              </label>
              <label>
                <span>{t("projectSettings.deviceField")}</span>
                <select
                  value={previewViewport}
                  onChange={(event) =>
                    setPreviewViewport(event.target.value as PreviewViewport)
                  }
                >
                  {PREVIEW_VIEWPORTS.map((viewport) => (
                    <option key={viewport} value={viewport}>
                      {t(PREVIEW_VIEWPORT_LABEL_KEYS[viewport])}
                    </option>
                  ))}
                  {previewDevices.map((device) => (
                    <option key={device.id} value={device.id}>
                      {t("workspace.viewport.device", { title: device.title, width: device.width, height: device.height })}
                    </option>
                  ))}
                  {/* A device whose plugin is gone stays chosen until another is; the preview shows Fit. */}
                  {!isBuiltinViewport(previewViewport) && !previewDevices.some((device) => device.id === previewViewport) ? (
                    <option value={previewViewport}>{t("projectSettings.device.missing")}</option>
                  ) : null}
                </select>
              </label>
            </div>
          </fieldset>
        </section>
        <Disclosure variant="section" className="project-settings-fold" summary={t("projectSettings.cleanup")}>
          <fieldset
            className="project-settings-section"
            disabled={saving || !webPreviewEnabled}
          >
            <label>
              <span>{t("projectSettings.stopAfter")}</span>
              <select
                value={previewIdleMinutes}
                onChange={(event) =>
                  setPreviewIdleMinutes(Number(event.target.value))
                }
              >
                {[...new Set([1, 3, 5, 10, 30, 60, 0, previewIdleMinutes])].map(
                  (minutes) => (
                    <option key={minutes} value={minutes}>
                      {minutes
                        ? t("projectSettings.minutes", { count: minutes })
                        : t("projectSettings.keepRunning")}
                    </option>
                  ),
                )}
              </select>
            </label>
          </fieldset>
        </Disclosure>
        {previewActions ? (
          <Disclosure variant="section" className="project-settings-fold" summary={t("projectSettings.previewActions")}>
            <fieldset
              className="project-settings-preview-actions"
              disabled={saving}
            >
              {previewActions.onStop ? (
                <Button
                  size="sm"
                  disabled={
                    !["ready", "starting"].includes(project.preview.status)
                  }
                  onClick={previewActions.onStop}
                >
                  {project.preview.status === "starting"
                    ? t("projectSettings.cancelStartup")
                    : t("projectSettings.stopPreview")}
                </Button>
              ) : null}
              {(project.previewMode ?? "auto") !== "static" &&
              project.previewMode !== "command" &&
              project.preview.command !== "Serve static files" ? (
                <Button
                  size="sm"
                  disabled={previewStartDisabled}
                  onClick={previewActions.onReinstall}
                >
                  {t("projectSettings.reinstall")}
                </Button>
              ) : null}
            </fieldset>
          </Disclosure>
        ) : null}
        {error ? (
          <p className="project-settings-error" role="alert">
            {error}
          </p>
        ) : null}
        </div>
        <div className="ui-dialog-footer">
          <Button disabled={saving} onClick={onClose}>
            {t("common.cancel")}
          </Button>
          <Button
            variant="primary"
            type="submit"
            disabled={saving}
            icon={saving ? <LoaderCircle className="spin" size={14} /> : undefined}
          >
            {t("common.save")}
          </Button>
        </div>
      </form>
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
