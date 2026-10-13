import { previewPageUrl } from "../shared/preview-page.js";
import {
  previewSettings,
  type PreviewMode,
} from "../shared/preview-settings.js";
import { ChevronDown, ExternalLink, LoaderCircle, X } from "./icons.js";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type {
  PreviewViewport,
  ProjectPackageManager,
  ProjectRunSettings,
  ProjectState,
} from "../shared/contracts.js";
import { inspectProjectPreview, updateProjectRunSettings } from "./api.js";
import { supportsWebPreview } from "../shared/project-runtime.js";

export function ProjectSettingsDialogFrame({
  children,
  busy = false,
  initialFocusRef,
  onClose,
}: {
  children: ReactNode;
  busy?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLElement>(null);
  const busyRef = useRef(busy);
  const onCloseRef = useRef(onClose);
  busyRef.current = busy;
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    const initialFocus = initialFocusRef?.current ?? dialog.current;
    initialFocus?.focus();
    if (initialFocus instanceof HTMLInputElement) initialFocus.select();
    const handleKeyboard = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape" && !busyRef.current) onCloseRef.current();
      if (event.key !== "Tab" || !dialog.current) return;
      const focusable = [
        ...dialog.current.querySelectorAll<HTMLElement>(
          "summary, button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
        ),
      ].filter((element) => element.getClientRects().length > 0);
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        dialog.current.focus();
        return;
      }
      if (
        !dialog.current.contains(document.activeElement) ||
        document.activeElement === dialog.current ||
        (!event.shiftKey && document.activeElement === last)
      ) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    };
    window.addEventListener("keydown", handleKeyboard);
    return () => {
      window.removeEventListener("keydown", handleKeyboard);
      previousFocus?.focus();
    };
  }, [initialFocusRef]);

  return (
    <div
      className="project-settings-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        ref={dialog}
        className="project-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header>
          <h2 id={titleId}>Project settings</h2>
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

export function ProjectSettingsDialog({
  project,
  previewUrl: currentPreviewUrl,
  previewActions,
  onClose,
  onSaved,
}: {
  project: ProjectState;
  previewUrl?: string;
  previewActions?: {
    onRestart: (reinstall?: boolean) => void;
    onStop?: () => void;
    onLogs: () => void;
  };
  onClose: () => void;
  onSaved: (project: ProjectState) => Promise<void> | void;
}) {
  const previewToggle = useRef<HTMLInputElement>(null);
  const automaticToggle = useRef<HTMLInputElement>(null);
  const [webPreviewEnabled, setWebPreviewEnabled] = useState(
    supportsWebPreview(project),
  );
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
    project.previewIdleMinutes ?? 5,
  );
  const [inspection, setInspection] = useState<{
    manager?: string;
    source?: string;
    error?: string;
  }>();
  useEffect(() => {
    setInspection(undefined);
    if (!webPreviewEnabled) return;
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
  const previewUrl =
    currentPreviewUrl ??
    (project.preview.status === "ready" ? project.preview.url : undefined);

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
        throw new Error("Arguments must be a JSON array of strings.");
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
    <ProjectSettingsDialogFrame
      busy={saving}
      initialFocusRef={
        project.type === "general" ? previewToggle : automaticToggle
      }
      onClose={onClose}
    >
      <form
        className="project-run-settings"
        onSubmit={(event) => void submit(event)}
      >
        <section className="project-settings-project" aria-label="Project">
          <span>Project</span>
          <strong title={project.name}>{project.name}</strong>
        </section>
        <section
          className="project-settings-switches"
          aria-label="Preview access"
        >
          {project.type === "general" ? (
            <div className="project-settings-preview-toggle">
              <strong>Web preview</strong>
              <label className="settings-toggle">
                <input
                  ref={previewToggle}
                  type="checkbox"
                  role="switch"
                  aria-label="Web preview"
                  checked={webPreviewEnabled}
                  disabled={saving}
                  onChange={(event) =>
                    setWebPreviewEnabled(event.target.checked)
                  }
                />
                <span aria-hidden="true" />
              </label>
            </div>
          ) : null}
          <div className="project-settings-preview-toggle">
            <strong>Automatic preview</strong>
            <label className="settings-toggle">
              <input
                ref={automaticToggle}
                type="checkbox"
                role="switch"
                aria-label="Automatic preview"
                checked={previewAutoStart}
                disabled={saving || !webPreviewEnabled}
                onChange={(event) => setPreviewAutoStart(event.target.checked)}
              />
              <span aria-hidden="true" />
            </label>
          </div>
        </section>
        <section
          className="project-settings-group"
          aria-labelledby="preview-startup-heading"
        >
          <h3 id="preview-startup-heading">Startup configuration</h3>
          <fieldset
            className="project-settings-section"
            disabled={saving || !webPreviewEnabled}
          >
            <div className="project-settings-field-row">
              <label>
                <span>Startup directory</span>
                <input
                  value={startupDirectory}
                  spellCheck={false}
                  placeholder="."
                  onChange={(event) => setStartupDirectory(event.target.value)}
                />
              </label>
              <label>
                <span>Preview mode</span>
                <select
                  value={previewMode}
                  onChange={(event) =>
                    setPreviewMode(event.target.value as PreviewMode)
                  }
                >
                  <option value="auto">Auto</option>
                  <option value="script">Package script</option>
                  <option value="static">Static files</option>
                  <option value="command">Custom command</option>
                </select>
              </label>
            </div>
            {previewMode === "command" ? (
              <label>
                <span>Startup command</span>
                <input
                  value={previewCommand}
                  spellCheck={false}
                  placeholder="python3 -m http.server {port} --bind {host}"
                  onChange={(event) => setPreviewCommand(event.target.value)}
                />
                <small>
                  Use {"{port}"} and {"{host}"} for the local server address.
                </small>
              </label>
            ) : null}
            {previewMode === "auto" || previewMode === "script" ? (
              <div className="project-settings-field-row">
                <label>
                  <span>Startup script</span>
                  <input
                    value={startupScript}
                    spellCheck={false}
                    onChange={(event) => setStartupScript(event.target.value)}
                  />
                </label>
                <label>
                  <span>Package manager</span>
                  <select
                    value={packageManager}
                    onChange={(event) =>
                      setPackageManager(
                        event.target.value as ProjectPackageManager | "auto",
                      )
                    }
                  >
                    <option value="auto">Auto</option>
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
              <details className="project-settings-fold is-nested">
                <summary>
                  {previewMode === "command"
                    ? "Server port"
                    : "Port & arguments"}
                  <ChevronDown size={14} aria-hidden="true" />
                </summary>
                <div className="project-settings-section">
                  <label>
                    <span>Server port</span>
                    <input
                      type="number"
                      min={1024}
                      max={65535}
                      value={previewPort}
                      placeholder="Automatic"
                      onChange={(event) => setPreviewPort(event.target.value)}
                    />
                  </label>
                  {previewMode === "script" || previewMode === "auto" ? (
                    <label>
                      <span>Script arguments</span>
                      <input
                        value={previewArguments}
                        spellCheck={false}
                        placeholder='Automatic, or ["--port", "{port}"]'
                        onChange={(event) =>
                          setPreviewArguments(event.target.value)
                        }
                      />
                      <small>JSON array; [] disables extra arguments.</small>
                    </label>
                  ) : null}
                </div>
              </details>
            ) : null}
          </fieldset>
        </section>
        <section
          className="project-settings-group"
          aria-labelledby="preview-playtest-heading"
        >
          <h3 id="preview-playtest-heading">Playtest defaults</h3>
          <fieldset
            className="project-settings-section"
            disabled={saving || !webPreviewEnabled}
          >
            <div className="project-settings-field-row">
              <label>
                <span>Default route</span>
                <input
                  value={previewPath}
                  spellCheck={false}
                  onChange={(event) => setPreviewPath(event.target.value)}
                />
              </label>
              <label>
                <span>Device</span>
                <select
                  value={previewViewport}
                  onChange={(event) =>
                    setPreviewViewport(event.target.value as PreviewViewport)
                  }
                >
                  <option value="fit">Fit</option>
                  <option value="tablet">Tablet</option>
                  <option value="mobile">Mobile</option>
                </select>
              </label>
            </div>
          </fieldset>
        </section>
        <details className="project-settings-fold">
          <summary>
            Background cleanup
            <ChevronDown size={14} aria-hidden="true" />
          </summary>
          <fieldset
            className="project-settings-section"
            disabled={saving || !webPreviewEnabled}
          >
            <label>
              <span>Stop unused preview after</span>
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
                        ? `${minutes} ${minutes === 1 ? "minute" : "minutes"}`
                        : "Keep running"}
                    </option>
                  ),
                )}
              </select>
            </label>
          </fieldset>
        </details>
        {previewActions ? (
          <details className="project-settings-fold">
            <summary>
              Preview actions
              <ChevronDown size={14} aria-hidden="true" />
            </summary>
            <fieldset
              className="project-settings-preview-actions"
              disabled={saving}
            >
              <button
                className="project-settings-browser"
                type="button"
                disabled={previewStartDisabled}
                onClick={() => previewActions.onRestart()}
              >
                {project.preview.status === "ready"
                  ? "Restart preview service"
                  : "Start preview"}
              </button>
              {previewActions.onStop ? (
                <button
                  className="project-settings-browser"
                  type="button"
                  disabled={
                    !["ready", "starting"].includes(project.preview.status)
                  }
                  onClick={previewActions.onStop}
                >
                  {project.preview.status === "starting"
                    ? "Cancel startup"
                    : "Stop preview"}
                </button>
              ) : null}
              <button
                className="project-settings-browser"
                type="button"
                onClick={previewActions.onLogs}
              >
                Preview logs
              </button>
              {(project.previewMode ?? "auto") !== "static" &&
              project.previewMode !== "command" &&
              project.preview.command !== "Serve static files" ? (
                <button
                  className="project-settings-browser"
                  type="button"
                  disabled={previewStartDisabled}
                  onClick={() => previewActions.onRestart(true)}
                >
                  Reinstall dependencies and restart
                </button>
              ) : null}
            </fieldset>
          </details>
        ) : null}
        {webPreviewEnabled && previewUrl ? (
          <button
            className="project-settings-browser"
            type="button"
            disabled={saving}
            onClick={() =>
              window.open(
                previewPageUrl(previewUrl, "external"),
                "_blank",
                "noopener,noreferrer",
              )
            }
          >
            <ExternalLink size={14} />
            Open preview in browser
          </button>
        ) : null}
        {error ? (
          <p className="project-settings-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer>
          <button type="button" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button
            className="project-settings-submit"
            type="submit"
            disabled={saving}
          >
            {saving ? <LoaderCircle className="spin" size={14} /> : null}
            Save
          </button>
        </footer>
      </form>
    </ProjectSettingsDialogFrame>
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
