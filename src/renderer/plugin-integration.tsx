import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ProjectState } from "../shared/contracts.js";
import type {
  PluginIntegrationAction,
  PluginIntegrationState,
} from "../shared/plugin-integration.js";
import {
  cancelPluginIntegration,
  clearProjectIntegration,
  getPluginIntegration,
  getProject,
  renameProject,
  runPluginIntegration,
  setProjectIntegration,
} from "./api.js";
import { Check, LoaderCircle, RefreshCw, X } from "./icons.js";
import { t } from "./i18n.js";

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
  return {
    state,
    error: error ?? state?.error,
    busy: pending || !!state?.running,
    run,
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
  creation?: { name: string; canCreate: boolean };
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
  creation?: { name: string; canCreate: boolean };
}) {
  const [selected, setSelected] = useState("");
  const [mode, setMode] = useState(creation?.canCreate ? "new" : "existing");
  const [name, setName] = useState(creation?.name ?? "");
  const result = state?.result;
  const ready = result?.connection?.status === "ready";
  const bound = !!result?.project;
  useEffect(() => {
    if (
      (creation || (!candidate && state?.action === "status")) &&
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
    ready,
    bound,
    projectId,
    busy,
    error,
    onReady,
  ]);
  return (
    <section
      className="plugin-integration-panel"
      aria-label={t("integration.title")}
    >
      <header>
        {!onReady ? <h2>{t("integration.title")}</h2> : null}
        <p>{t("integration.description")}</p>
      </header>
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
      <div className="plugin-integration-connection">
        {busy || ready ? (
          <p className="plugin-integration-status" role="status">
            {busy ? (
              <LoaderCircle size={14} className="spin" aria-hidden="true" />
            ) : (
              <Check size={14} aria-hidden="true" />
            )}
            {busy
              ? (state?.message ?? t("integration.working"))
              : t("integration.connected")}
          </p>
        ) : null}
        <div className="plugin-integration-actions">
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
          {["needs-auth", "ready"].includes(
            result?.connection?.status ?? "",
          ) ? (
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
                void cancelPluginIntegration(pluginId, projectId).catch(
                  () => {},
                )
              }
            >
              {t("common.cancel")}
            </button>
          ) : null}
        </div>
      </div>
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
                {t("common.name")}
                <input
                  autoFocus
                  value={name}
                  maxLength={120}
                  disabled={busy}
                  onChange={(event) => setName(event.target.value)}
                />
              </label>
              <p>{t("integration.newProjectHint")}</p>
              <button
                className="plugin-detail-primary"
                type="button"
                disabled={busy || !name.trim()}
                onClick={() =>
                  void run(
                    "create",
                    undefined,
                    name.trim() !== creation.name ? name.trim() : undefined,
                  )
                }
              >
                {t(
                  busy ? "integration.working" : "integration.createAndConnect",
                )}
              </button>
            </>
          ) : (
            <>
              <p>{t("integration.chooseProject")}</p>
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
                    onClick={() => void run("bind", selected)}
                  >
                    {t("integration.bind")}
                  </button>
                </>
              ) : null}
            </>
          )}
        </div>
      ) : null}
      {onReady && !creation ? (
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
    creation?: { canCreate: boolean };
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
    creation?: { canCreate: boolean },
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
    const ready = await new Promise<boolean>((resolve) => {
      resolveDialog.current = resolve;
      setDialog({ project, pluginId, initial: state, creation });
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
  return {
    ensure,
    creation: dialog?.creation ? (
      <section
        className="plugin-project-creation"
        aria-label={t("integration.createTitle")}
      >
        <header>
          <div>
            <h2>{t("integration.createTitle")}</h2>
            <p>{t("integration.creationHint")}</p>
          </div>
          <button
            className="plugin-detail-secondary plugin-integration-refresh"
            type="button"
            aria-label={t("common.cancel")}
            onClick={() => {
              void cancelPluginIntegration(
                dialog.pluginId,
                dialog.project.id,
              ).catch(() => {});
              close(false);
            }}
          >
            <X size={14} />
          </button>
        </header>
        {panel}
      </section>
    ) : null,
    dialog:
      dialog && !dialog.creation ? (
        <IntegrationDialog onClose={() => close(false)}>
          {panel}
        </IntegrationDialog>
      ) : null,
  };
}

function IntegrationDialog({
  children,
  onClose,
}: {
  children: ReactNode;
  onClose: () => void;
}) {
  const root = useRef<HTMLElement>(null);
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    const previous =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    root.current?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") close.current();
      if (event.key !== "Tab" || !root.current) return;
      const controls = [
        ...root.current.querySelectorAll<HTMLElement>(
          "button:not(:disabled), select:not(:disabled), a[href]",
        ),
      ];
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
      previous?.focus();
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
        className="project-create-dialog plugin-integration-dialog"
        role="dialog"
        aria-modal="true"
        aria-label={t("integration.title")}
        ref={root}
        tabIndex={-1}
      >
        <header>
          <h2>{t("integration.title")}</h2>
          <button
            type="button"
            aria-label={t("common.close")}
            onClick={onClose}
          >
            <X size={16} />
          </button>
        </header>
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
  const disconnect = (
    <IntegrationDisconnect
      projectId={project.id}
      onDisconnected={onProjectUpdated}
    />
  );
  const { state, busy, error, run } = integration;
  const ready =
    state?.result?.connection?.status === "ready" && !!state.result.project;
  const preview = state?.result?.preview;
  useEffect(() => {
    if (ready && !busy && !preview && state?.action === "status" && !error)
      void run("preview-status");
  }, [ready, busy, !!preview]);
  useEffect(() => {
    if (!ready) return;
    const timer = setInterval(() => {
      if (!busy) void run("preview-status");
    }, 10_000);
    return () => clearInterval(timer);
  }, [ready, busy]);
  if (!ready)
    return (
      <section className="external-project-preview">
        <IntegrationContents
          {...integration}
          pluginId={pluginId}
          projectId={project.id}
        />
        {disconnect}
      </section>
    );
  return (
    <section
      className="external-project-preview"
      aria-label={t("integration.preview")}
    >
      <h2>{t("integration.preview")}</h2>
      <p>{t("integration.externalWindow")}</p>
      <p role="status">
        {busy
          ? (state?.message ?? t("integration.working"))
          : t(`integration.previewStatus.${preview?.status ?? "stopped"}`)}
      </p>
      {error || preview?.message ? (
        <p role="alert">{error ?? preview?.message}</p>
      ) : null}
      <div className="plugin-integration-actions">
        {preview?.status === "missing" ? (
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
            disabled={busy || preview?.status === "error"}
            onClick={() =>
              void run(
                preview?.status === "running"
                  ? "preview-refresh"
                  : "preview-start",
              )
            }
          >
            {t(
              preview?.status === "running"
                ? "integration.restart"
                : "integration.start",
            )}
          </button>
        )}
        <button
          className="plugin-detail-secondary"
          type="button"
          disabled={busy || preview?.status !== "running"}
          onClick={() => void run("preview-stop")}
        >
          {t("integration.stop")}
        </button>
        <button
          className="plugin-detail-secondary"
          type="button"
          disabled={busy}
          onClick={() => void run("preview-status")}
        >
          {t("integration.refresh")}
        </button>
        <button
          className="plugin-detail-secondary"
          type="button"
          disabled={busy}
          onClick={() => void run("preview-logs")}
        >
          {t("integration.logs")}
        </button>
      </div>
      {preview?.logs ? <pre>{preview.logs}</pre> : null}
      {disconnect}
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
              onClick={() => void disconnect()}
            >
              {t("integration.disconnectConfirm")}
            </button>
            <button
              className="plugin-detail-secondary"
              type="button"
              disabled={pending}
              onClick={() => setConfirming(false)}
            >
              {t("common.cancel")}
            </button>
          </div>
        </>
      ) : (
        <button
          className="plugin-detail-secondary"
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
