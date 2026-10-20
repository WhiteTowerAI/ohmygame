import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import type { ProjectState } from "../shared/contracts.js";
import type { PluginSummary } from "../shared/plugins.js";
import type {
  PluginIntegrationAction,
  PluginIntegrationState,
} from "../shared/plugin-integration.js";
import {
  cancelPluginIntegration,
  clearProjectIntegration,
  getPluginIntegration,
  getProject,
  readPlugin,
  renameProject,
  runPluginIntegration,
  setProjectIntegration,
} from "./api.js";
import {
  Check,
  CircleX,
  Download,
  LoaderCircle,
  Monitor,
  Play,
  RefreshCw,
  Terminal,
  UserRound,
  X,
} from "./icons.js";
import { t } from "./i18n.js";
import { PluginGlyph } from "./plugin-icons.js";

type ProjectCreation = { name: string; canCreate: boolean };
type PluginIdentity = Pick<
  PluginSummary,
  "id" | "displayName" | "icon" | "iconRevision"
>;
type CreationOptions = { canCreate: boolean; embedded?: boolean };

function useIntegration(
  pluginId: string,
  projectId?: string,
  initial?: PluginIntegrationState,
) {
  const [state, setState] = useState(initial);
  const [error, setError] = useState<string>();
  const [pending, setPending] = useState(false);
  const generation = useRef(0);
  useEffect(() => {
    const current = ++generation.current;
    setState(initial);
    setPending(false);
    setError(undefined);
    if (!initial)
      void getPluginIntegration(pluginId, projectId)
        .then((value) => {
          if (current === generation.current) setState(value);
        })
        .catch((cause) => {
          if (current === generation.current)
            setError(String(cause.message ?? cause));
        });
    return () => {
      generation.current++;
    };
  }, [pluginId, projectId, initial]);
  useEffect(() => {
    if (!state?.running) return;
    let disposed = false;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const next = await getPluginIntegration(pluginId, projectId);
        if (disposed) return;
        setState(next);
        setError(undefined);
        if (next.running) timer = setTimeout(poll, 500);
      } catch (cause) {
        if (!disposed) {
          setError(String((cause as Error).message ?? cause));
          timer = setTimeout(poll, 2000);
        }
      }
    };
    timer = setTimeout(poll, 500);
    return () => {
      disposed = true;
      clearTimeout(timer);
    };
  }, [pluginId, projectId, state?.running]);
  async function run(
    action: PluginIntegrationAction,
    remoteId?: string,
    projectName?: string,
  ) {
    if (pending || state?.running) return;
    const current = generation.current;
    setPending(true);
    setError(undefined);
    try {
      if (action === "create" && projectId && projectName)
        await renameProject(projectId, projectName);
      // Cancelling setup while the name is saving must not start creation later.
      if (current !== generation.current) return;
      const next = await runPluginIntegration(
        pluginId,
        action,
        projectId,
        remoteId,
      );
      if (current === generation.current) setState(next);
    } catch (cause) {
      if (current === generation.current)
        setError(String((cause as Error).message ?? cause));
    } finally {
      if (current === generation.current) setPending(false);
    }
  }
  /** Reads the host's retained state without starting an adapter process. */
  async function reload() {
    const current = generation.current;
    try {
      const next = await getPluginIntegration(pluginId, projectId);
      if (current === generation.current) setState(next);
    } catch {
      // The next explicit action or poll reports a persistent failure.
    }
  }
  return {
    state,
    error: error ?? state?.error,
    busy: pending || !!state?.running,
    run,
    reload,
  };
}

export function PluginIntegrationPanel({
  pluginId,
  projectId,
  initial,
  candidate,
  onReady,
  creation,
}: {
  pluginId: string;
  projectId?: string;
  initial?: PluginIntegrationState;
  candidate?: boolean;
  onReady?: () => void;
  creation?: ProjectCreation;
}) {
  const integration = useIntegration(pluginId, projectId, initial);
  return (
    <IntegrationContents
      {...integration}
      pluginId={pluginId}
      projectId={projectId}
      candidate={candidate}
      onReady={onReady}
      creation={creation}
    />
  );
}

function IntegrationContents({
  state,
  error,
  busy,
  run,
  pluginId,
  projectId,
  candidate,
  onReady,
  creation,
}: ReturnType<typeof useIntegration> & {
  pluginId: string;
  projectId?: string;
  /** The project selects the plugin only when the user continues. */
  candidate?: boolean;
  onReady?: () => void;
  creation?: ProjectCreation;
}) {
  const [selected, setSelected] = useState("");
  const [mode, setMode] = useState(creation?.canCreate ? "new" : "existing");
  const [name, setName] = useState(creation?.name ?? "");
  const [projectSubmitted, setProjectSubmitted] = useState(false);
  const panel = useRef<HTMLElement>(null);
  const result = state?.result;
  const ready = result?.connection?.status === "ready";
  const bound = !!result?.project;
  const projectOperation =
    state?.action === "create" || state?.action === "bind";
  useEffect(() => {
    if (busy) panel.current?.closest<HTMLElement>('[role="dialog"]')?.focus();
  }, [busy]);
  useEffect(() => {
    if (
      ((!candidate && (creation || state?.action === "status")) ||
        (creation && projectSubmitted && projectOperation)) &&
      ready &&
      (!projectId || bound) &&
      !busy &&
      !error
    )
      onReady?.();
  }, [
    candidate,
    creation,
    state?.action,
    projectOperation,
    projectSubmitted,
    ready,
    bound,
    projectId,
    busy,
    error,
    onReady,
  ]);
  // The plugin page shows the connection like its other component sections.
  const pluginPage = !projectId && !onReady && !creation;
  const showProgress = busy && !(creation && projectOperation);
  const connection = result?.connection?.status;
  const connectionStatus = showProgress
    ? (state?.message ?? t("integration.working"))
    : ready
      ? t("integration.connected")
      : connection === "needs-auth"
        ? t("integration.needsAuth")
        : connection === "needs-setup"
          ? t("integration.needsSetup")
          : t("integration.unchecked");
  const connectionActions = (
    <div className="plugin-integration-actions plugin-mcp-actions">
      {result?.connection?.status === "needs-setup" ? (
        <button
          className="plugin-detail-primary"
          type="button"
          disabled={busy}
          onClick={() => void run("prepare")}
        >
          {t("integration.prepare")}
        </button>
      ) : null}
      {["needs-auth", "ready"].includes(result?.connection?.status ?? "") ? (
        <button
          className={
            ready ? "plugin-detail-secondary" : "plugin-detail-primary"
          }
          type="button"
          disabled={busy}
          onClick={() => void run("connect")}
        >
          {t(ready ? "integration.reconnect" : "integration.connect")}
        </button>
      ) : null}
      <button
        className="plugin-detail-secondary plugin-integration-refresh"
        type="button"
        aria-label={t("integration.refresh")}
        title={t("integration.refresh")}
        disabled={busy}
        onClick={() => void run("status")}
      >
        <RefreshCw size={14} aria-hidden="true" />
      </button>
      {state?.running ? (
        <button
          className="plugin-detail-secondary"
          type="button"
          onClick={() =>
            void cancelPluginIntegration(pluginId, projectId).catch(() => {})
          }
        >
          {t("common.cancel")}
        </button>
      ) : null}
    </div>
  );
  return (
    <section
      className={`plugin-integration-panel${pluginPage ? " plugin-components" : ""}`}
      ref={panel}
      aria-label={t("integration.title")}
    >
      {pluginPage ? (
        <h2>{t("integration.title")}</h2>
      ) : !creation ? (
        <header>
          {!onReady ? <h2>{t("integration.title")}</h2> : null}
          <p>{t("integration.description")}</p>
        </header>
      ) : null}
      {candidate ? (
        <p className="plugin-integration-notice">
          {t("integration.candidate")}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="plugins-inline-error">
          {error}
        </p>
      ) : null}
      {state?.authorizationUrl ? (
        <a
          className="plugin-detail-secondary plugin-integration-authorization"
          href={state.authorizationUrl}
          target="_blank"
          rel="noreferrer"
        >
          {t("integration.openAuthorization")}
        </a>
      ) : null}
      {creation ? (
        <div className="plugin-integration-connection">
          {busy || ready ? (
            <p className="plugin-integration-status" role="status">
              {showProgress ? (
                <LoaderCircle size={14} className="spin" aria-hidden="true" />
              ) : (
                <Check size={14} aria-hidden="true" />
              )}
              {showProgress
                ? (state?.message ?? t("integration.working"))
                : t("integration.connected")}
            </p>
          ) : null}
          {ready ? (
            <details className="plugin-integration-account-options">
              <summary>{t("integration.accountOptions")}</summary>
              {connectionActions}
            </details>
          ) : (
            connectionActions
          )}
        </div>
      ) : (
        <div className="plugin-integration-connection">
          <div className="plugin-component-row plugin-mcp-row">
            <span
              className={`plugin-component-icon${ready && !showProgress ? " is-ready" : ""}`}
            >
              {showProgress ? (
                <LoaderCircle size={15} className="spin" aria-hidden="true" />
              ) : ready ? (
                <Check size={15} aria-hidden="true" />
              ) : (
                <UserRound size={15} aria-hidden="true" />
              )}
            </span>
            <span className="plugin-row-copy">
              <strong>{t("integration.account")}</strong>
              <span role="status">{connectionStatus}</span>
            </span>
            {connectionActions}
          </div>
        </div>
      )}
      {projectId && ready ? (
        <div className="plugin-integration-binding">
          {creation?.canCreate && !bound ? (
            <div
              className="plugin-project-choices"
              role="group"
              aria-label={t("integration.projectSource")}
            >
              <button
                className="plugin-detail-secondary"
                type="button"
                aria-pressed={mode === "new"}
                disabled={busy}
                onClick={() => setMode("new")}
              >
                {t("integration.newProject")}
              </button>
              <button
                className="plugin-detail-secondary"
                type="button"
                aria-pressed={mode === "existing"}
                disabled={busy}
                onClick={() => setMode("existing")}
              >
                {t("integration.existingProject")}
              </button>
            </div>
          ) : null}
          {bound ? (
            <p>
              {t("integration.bound", {
                id: result.project!.name ?? result.project!.id,
              })}
            </p>
          ) : creation && mode === "new" ? (
            <>
              <label>
                {t("integration.projectName")}
                <input
                  autoFocus
                  value={name}
                  maxLength={120}
                  disabled={busy}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <button
                className="plugin-detail-primary"
                type="button"
                disabled={busy || !name.trim()}
                onClick={() => {
                  setProjectSubmitted(true);
                  void run(
                    "create",
                    undefined,
                    name.trim() !== creation.name ? name.trim() : undefined,
                  );
                }}
              >
                {t(
                  busy ? "integration.working" : "integration.createAndConnect",
                )}
              </button>
            </>
          ) : (
            <>
              {!creation ? <p>{t("integration.chooseProject")}</p> : null}
              <button
                className="plugin-detail-secondary"
                type="button"
                disabled={busy}
                onClick={() => void run("projects")}
              >
                {t("integration.loadProjects")}
              </button>
              {result?.projects ? (
                <>
                  <label>
                    {t("integration.project")}
                    <select
                      value={selected}
                      disabled={busy}
                      onChange={(event) => setSelected(event.target.value)}
                    >
                      <option value="">{t("integration.selectProject")}</option>
                      {result.projects.map((item) => (
                        <option key={item.id} value={item.id}>
                          {item.name ?? item.id}
                        </option>
                      ))}
                    </select>
                  </label>
                  {!result.projects.length ? (
                    <p>{t("integration.noProjects")}</p>
                  ) : null}
                  <button
                    className="plugin-detail-secondary"
                    type="button"
                    disabled={busy || !selected}
                    onClick={() => {
                      setProjectSubmitted(true);
                      void run("bind", selected);
                    }}
                  >
                    {t(
                      creation
                        ? "integration.connectAndStart"
                        : "integration.bind",
                    )}
                  </button>
                </>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      {creation && busy && projectOperation ? (
        <p className="plugin-project-progress" role="status">
          <LoaderCircle size={14} className="spin" aria-hidden="true" />
          {t(
            state?.action === "bind"
              ? "integration.connectingProject"
              : "integration.preparingProject",
          )}
        </p>
      ) : null}
      {onReady && (!creation || (candidate && bound)) ? (
        <div className="plugin-integration-footer">
          <button
            className="plugin-detail-primary"
            type="button"
            disabled={busy || !!error || !ready || (!!projectId && !bound)}
            onClick={onReady}
          >
            {t("integration.continue")}
          </button>
        </div>
      ) : null}
    </section>
  );
}

export function usePluginIntegrationGate(
  onUpdated?: (project: ProjectState) => void,
) {
  const [dialog, setDialog] = useState<{
    project: ProjectState;
    pluginId: string;
    initial: PluginIntegrationState;
    creation?: CreationOptions;
    plugin?: PluginIdentity;
  }>();
  const resolveDialog = useRef<((ready: boolean) => void) | undefined>(
    undefined,
  );
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      resolveDialog.current?.(false);
    };
  }, []);
  async function ensure(
    project: ProjectState,
    pluginId = project.integration?.pluginId,
    creation?: CreationOptions,
  ): Promise<ProjectState | undefined> {
    if (!pluginId) return project;
    if (creation) project = await getProject(project.id);
    if (project.integration && project.integration.pluginId !== pluginId)
      throw new Error(t("integration.conflict"));
    let state = await getPluginIntegration(pluginId, project.id);
    if (!state.running && state.error)
      state = await runPluginIntegration(pluginId, "status", project.id);
    if (!mounted.current) return undefined;
    if (
      project.integration &&
      !state.running &&
      state.result?.connection?.status === "ready" &&
      state.result.project &&
      !state.error
    ) {
      return project;
    }
    const plugin = creation ? await readPlugin(pluginId) : undefined;
    if (!mounted.current) return undefined;
    const ready = await new Promise<boolean>((resolve) => {
      resolveDialog.current = resolve;
      setDialog({ project, pluginId, initial: state, creation, plugin });
    });
    if (!ready || !mounted.current) return undefined;
    if (project.integration) return creation ? getProject(project.id) : project;
    // Continuing is the user's consent to switch this existing project over.
    const updated = await setProjectIntegration(project.id, pluginId);
    onUpdated?.(updated);
    return updated;
  }
  function close(ready: boolean) {
    resolveDialog.current?.(ready);
    resolveDialog.current = undefined;
    setDialog(undefined);
  }
  function dismiss() {
    if (dialog?.creation)
      void cancelPluginIntegration(dialog.pluginId, dialog.project.id).catch(
        () => {},
      );
    close(false);
  }
  const pluginName = dialog?.plugin?.displayName ?? t("integration.plugin");
  const creationTitle = dialog?.creation
    ? t("integration.createTitle", { plugin: pluginName })
    : undefined;
  const panel = dialog ? (
    <PluginIntegrationPanel
      pluginId={dialog.pluginId}
      projectId={dialog.project.id}
      initial={dialog.initial}
      candidate={!dialog.project.integration}
      creation={
        dialog.creation
          ? { ...dialog.creation, name: dialog.project.name }
          : undefined
      }
      onReady={() => close(true)}
    />
  ) : null;
  const creationContent = dialog?.creation ? (
    <section className="plugin-project-creation">
      <header>
        <div className="plugin-project-identity">
          {dialog.plugin ? (
            <span className="plugin-project-icon">
              <PluginGlyph plugin={dialog.plugin} size={32} />
            </span>
          ) : null}
          <h2>{creationTitle}</h2>
        </div>
        <button
          className="plugin-detail-secondary plugin-integration-refresh"
          type="button"
          aria-label={t("common.cancel")}
          onClick={dismiss}
        >
          <X size={14} />
        </button>
      </header>
      {panel}
    </section>
  ) : null;
  return {
    ensure,
    creation: dialog?.creation?.embedded ? creationContent : null,
    creationTitle,
    cancelCreation: dismiss,
    dialog:
      dialog && !dialog.creation?.embedded ? (
        <IntegrationDialog
          onClose={dismiss}
          creation={!!dialog.creation}
          title={creationTitle ?? t("integration.title")}
        >
          {creationContent ?? panel}
        </IntegrationDialog>
      ) : null,
  };
}

function IntegrationDialog({
  children,
  onClose,
  creation,
  title,
}: {
  children: ReactNode;
  onClose: () => void;
  creation?: boolean;
  title: string;
}) {
  const titleId = useId();
  const root = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    (
      root.current?.querySelector<HTMLElement>(
        "input:not(:disabled), select:not(:disabled)",
      ) ?? root.current
    )?.focus();
    const inertElements: Array<[HTMLElement, boolean]> = [];
    let overlay = root.current?.parentElement;
    while (overlay && overlay !== document.body) {
      for (const sibling of overlay.parentElement?.children ?? []) {
        if (sibling !== overlay && sibling instanceof HTMLElement) {
          inertElements.push([sibling, sibling.inert]);
          sibling.inert = true;
        }
      }
      overlay = overlay.parentElement;
    }
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        close.current();
      }
      if (event.key !== "Tab" || !root.current) return;
      const controls = [
        ...root.current.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), textarea:not(:disabled), select:not(:disabled), a[href], summary",
        ),
      ].filter(
        (element) =>
          !element.closest("details:not([open])") ||
          element.tagName === "SUMMARY",
      );
      const first = controls[0],
        last = controls.at(-1);
      if (
        !event.shiftKey &&
        (document.activeElement === last ||
          document.activeElement === root.current)
      ) {
        event.preventDefault();
        first?.focus();
      } else if (
        event.shiftKey &&
        (document.activeElement === first ||
          document.activeElement === root.current)
      ) {
        event.preventDefault();
        last?.focus();
      }
    };
    window.addEventListener("keydown", keyboard);
    return () => {
      window.removeEventListener("keydown", keyboard);
      for (const [element, wasInert] of inertElements) element.inert = wasInert;
      requestAnimationFrame(() => previous?.focus());
    };
  }, []);
  return (
    <div
      className="project-create-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className={`project-create-dialog plugin-integration-dialog${creation ? " plugin-project-dialog" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={creation ? title : undefined}
        aria-labelledby={creation ? undefined : titleId}
        ref={root}
        tabIndex={-1}
      >
        {!creation ? (
          <header>
            <h2 id={titleId}>{title}</h2>
            <button
              type="button"
              aria-label={t("common.close")}
              onClick={onClose}
            >
              <X size={16} />
            </button>
          </header>
        ) : null}
        {children}
      </section>
    </div>
  );
}

export function ExternalProjectPreview({
  project,
  onProjectUpdated,
}: {
  project: ProjectState;
  onProjectUpdated?: (project: ProjectState) => void;
}) {
  const pluginId = project.integration!.pluginId;
  const integration = useIntegration(pluginId, project.id);
  const [plugin, setPlugin] = useState<PluginIdentity>();
  const [logs, setLogs] = useState<string>();
  const { state, busy, error, run, reload } = integration;
  const ready =
    state?.result?.connection?.status === "ready" && !!state.result.project;
  const preview = state?.result?.preview;
  const status = preview?.status ?? "stopped";
  const running = status === "running";
  const checkPreview =
    ready && !busy && !preview && state?.action === "status" && !error;
  useEffect(() => {
    let active = true;
    void readPlugin(pluginId)
      .then((value) => {
        if (active) setPlugin(value);
      })
      .catch(() => {});
    return () => {
      active = false;
    };
  }, [pluginId]);
  useEffect(() => {
    if (checkPreview) void run("preview-status");
  }, [checkPreview]);
  // Only a running window can close on its own and needs the adapter. Other
  // changes, such as an agent's project_preview call, are in the host state.
  useEffect(() => {
    if (!ready || busy) return;
    const timer = setInterval(
      () => void (running ? run("preview-status") : reload()),
      10_000,
    );
    return () => clearInterval(timer);
  }, [ready, busy, running]);
  // Keep loaded logs while later status checks replace the preview result.
  useEffect(() => {
    if (preview?.logs !== undefined) setLogs(preview.logs);
  }, [preview?.logs]);
  const header = (
    <header className="external-preview-header">
      <span className="plugin-project-icon">
        {plugin ? <PluginGlyph plugin={plugin} size={24} /> : null}
      </span>
      <div>
        <h2>{plugin?.displayName ?? t("integration.preview")}</h2>
        <p>{t("integration.externalWindow")}</p>
      </div>
    </header>
  );
  // Disconnecting is only offered while the connection cannot be used, such
  // as after the plugin is disabled or removed; otherwise the project is stuck.
  if (!ready)
    return (
      <section className="external-project-preview">
        {header}
        <IntegrationContents
          {...integration}
          pluginId={pluginId}
          projectId={project.id}
        />
        <IntegrationDisconnect
          projectId={project.id}
          onDisconnected={onProjectUpdated}
        />
      </section>
    );
  return (
    <section
      className="external-project-preview"
      aria-label={t("integration.preview")}
    >
      {header}
      <div className="plugin-component-row plugin-mcp-row external-preview-row">
        <span
          className={`plugin-component-icon external-preview-state is-${busy ? "busy" : status}`}
          aria-hidden="true"
        >
          {busy ? (
            <LoaderCircle size={15} className="spin" />
          ) : running ? (
            <Monitor size={15} />
          ) : status === "missing" ? (
            <Download size={15} />
          ) : status === "error" ? (
            <CircleX size={15} />
          ) : (
            <Play size={15} />
          )}
        </span>
        <span className="plugin-row-copy">
          <strong>{t("integration.preview")}</strong>
          <span role="status">
            {busy
              ? (state?.message ?? t("integration.working"))
              : t(`integration.previewStatus.${status}`)}
          </span>
        </span>
        <div className="plugin-integration-actions plugin-mcp-actions">
          {running ? (
            <button
              className="plugin-detail-secondary"
              type="button"
              disabled={busy}
              onClick={() => void run("preview-stop")}
            >
              {t("integration.stop")}
            </button>
          ) : null}
          {status === "missing" ? (
            <button
              className="plugin-detail-primary"
              type="button"
              disabled={busy}
              onClick={() => void run("preview-install")}
            >
              {t("integration.installRuntime")}
            </button>
          ) : (
            <button
              className="plugin-detail-primary"
              type="button"
              disabled={busy || status === "error"}
              onClick={() =>
                void run(running ? "preview-refresh" : "preview-start")
              }
            >
              {t(running ? "integration.restart" : "integration.start")}
            </button>
          )}
        </div>
      </div>
      {error || preview?.message ? (
        <p role="alert" className="external-preview-error">
          {error ?? preview?.message}
        </p>
      ) : null}
      <div className="external-preview-logs">
        <header>
          <span>{t("integration.logsTitle")}</span>
          <div className="external-preview-tools">
            <button
              className="external-preview-tool"
              type="button"
              disabled={busy}
              onClick={() => void run("preview-status")}
            >
              <RefreshCw size={13} aria-hidden="true" />
              {t("integration.refresh")}
            </button>
            <button
              className="external-preview-tool"
              type="button"
              disabled={busy}
              onClick={() => void run("preview-logs")}
            >
              <Terminal size={13} aria-hidden="true" />
              {t("integration.logs")}
            </button>
          </div>
        </header>
        {logs !== undefined ? (
          <pre>{logs || t("integration.noLogs")}</pre>
        ) : (
          <p>{t("integration.logsHint")}</p>
        )}
      </div>
    </section>
  );
}

/** Available even when the plugin is disabled, so a project is never stuck. */
function IntegrationDisconnect({
  projectId,
  onDisconnected,
}: {
  projectId: string;
  onDisconnected?: (project: ProjectState) => void;
}) {
  const [confirming, setConfirming] = useState(false);
  const [pending, setPending] = useState(false);
  const [error, setError] = useState<string>();
  async function disconnect() {
    setPending(true);
    setError(undefined);
    try {
      onDisconnected?.(await clearProjectIntegration(projectId));
    } catch (cause) {
      setError(String((cause as Error).message ?? cause));
      setPending(false);
    }
  }
  return (
    <div className="plugin-integration-disconnect">
      {confirming ? (
        <>
          <p>{t("integration.disconnectNotice")}</p>
          <div className="plugin-integration-actions">
            <button
              className="plugin-detail-secondary"
              type="button"
              disabled={pending}
              onClick={() => setConfirming(false)}
            >
              {t("common.cancel")}
            </button>
            <button
              className="plugin-detail-primary"
              type="button"
              disabled={pending}
              onClick={() => void disconnect()}
            >
              {t("integration.disconnectConfirm")}
            </button>
          </div>
        </>
      ) : (
        <button
          className="external-preview-tool"
          type="button"
          onClick={() => setConfirming(true)}
        >
          {t("integration.disconnect")}
        </button>
      )}
      {error ? (
        <p role="alert" className="plugins-inline-error">
          {error}
        </p>
      ) : null}
    </div>
  );
}

export function referencedIntegration(
  mentions: readonly { name: string; marketplaceId: string }[],
  plugins: readonly {
    id: string;
    name: string;
    marketplaceId: string;
    integration?: unknown;
  }[],
): string | undefined {
  const integrations = plugins.filter(
    (plugin) =>
      plugin.integration &&
      mentions.some(
        (mention) =>
          mention.name === plugin.name &&
          mention.marketplaceId === plugin.marketplaceId,
      ),
  );
  if (integrations.length > 1) throw new Error(t("integration.conflict"));
  return integrations[0]?.id;
}
