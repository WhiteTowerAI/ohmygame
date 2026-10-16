import { useEffect, useRef, useState, type ReactNode } from "react";
import type { ProjectState } from "../shared/contracts.js";
import type {
  PluginIntegrationAction,
  PluginIntegrationState,
} from "../shared/plugin-integration.js";
import {
  cancelPluginIntegration,
  getPluginIntegration,
  runPluginIntegration,
  setProjectIntegration,
} from "./api.js";
import { LoaderCircle, X } from "./icons.js";
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
  }, [pluginId, projectId]);
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
  async function run(action: PluginIntegrationAction, remoteId?: string) {
    if (pending || state?.running) return;
    const current = generation.current;
    setPending(true);
    setError(undefined);
    try {
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
  onReady,
  children,
}: {
  pluginId: string;
  projectId?: string;
  initial?: PluginIntegrationState;
  onReady?: () => void;
  children?: ReactNode;
}) {
  const integration = useIntegration(pluginId, projectId, initial);
  return (
    <IntegrationContents
      {...integration}
      pluginId={pluginId}
      projectId={projectId}
      onReady={onReady}
    >
      {children}
    </IntegrationContents>
  );
}

function IntegrationContents({
  state,
  error,
  busy,
  run,
  pluginId,
  projectId,
  onReady,
  children,
}: ReturnType<typeof useIntegration> & {
  pluginId: string;
  projectId?: string;
  onReady?: () => void;
  children?: ReactNode;
}) {
  const [selected, setSelected] = useState("");
  const result = state?.result;
  const ready = result?.connection?.status === "ready";
  const bound = !!result?.project;
  return (
    <section
      className="plugin-integration-panel"
      aria-label={t("integration.title")}
    >
      <h2>{t("integration.title")}</h2>
      <p>{t("integration.description")}</p>
      {busy ? (
        <p role="status">
          <LoaderCircle size={14} className="spin" />{" "}
          {state?.message ?? t("integration.working")}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="plugins-inline-error">
          {error}
        </p>
      ) : null}
      {state?.authorizationUrl ? (
        <a href={state.authorizationUrl} target="_blank" rel="noreferrer">
          {t("integration.openAuthorization")}
        </a>
      ) : null}
      <div className="plugin-integration-actions">
        {result?.connection?.status === "needs-setup" ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run("prepare")}
          >
            {t("integration.prepare")}
          </button>
        ) : null}
        {["needs-auth", "ready"].includes(result?.connection?.status ?? "") ? (
          <button
            type="button"
            disabled={busy}
            onClick={() => void run("connect")}
          >
            {t("integration.connect")}
          </button>
        ) : null}
        {ready ? <span role="status">{t("integration.connected")}</span> : null}
        <button
          type="button"
          disabled={busy}
          onClick={() => void run("status")}
        >
          {t("integration.refresh")}
        </button>
        {busy ? (
          <button
            type="button"
            onClick={() =>
              void cancelPluginIntegration(pluginId, projectId).catch(() => {})
            }
          >
            {t("common.cancel")}
          </button>
        ) : null}
      </div>
      {projectId && ready ? (
        <div className="plugin-integration-binding">
          {bound ? (
            <p>
              {t("integration.bound", {
                id: result.project!.name ?? result.project!.id,
              })}
            </p>
          ) : (
            <>
              <p>{t("integration.chooseProject")}</p>
              <button
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
      {onReady ? (
        <button
          type="button"
          disabled={busy || !!error || !ready || (!!projectId && !bound)}
          onClick={onReady}
        >
          {t("integration.continue")}
        </button>
      ) : null}
      {children}
    </section>
  );
}

export function usePluginIntegrationGate(
  onUpdated?: (project: ProjectState) => void,
) {
  const [dialog, setDialog] = useState<{
    project: ProjectState;
    initial: PluginIntegrationState;
    resolve: (ready: boolean) => void;
  }>();
  const active = useRef<typeof dialog>(undefined);
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      active.current?.resolve(false);
    };
  }, []);
  async function ensure(
    project: ProjectState,
    pluginId = project.integration?.pluginId,
  ): Promise<ProjectState | undefined> {
    if (!pluginId) return project;
    if (!project.integration) {
      project = await setProjectIntegration(project.id, pluginId);
      onUpdated?.(project);
    }
    if (project.integration?.pluginId !== pluginId)
      throw new Error(t("integration.conflict"));
    let state = await getPluginIntegration(pluginId, project.id);
    if (!state.running && state.error)
      state = await runPluginIntegration(pluginId, "status", project.id);
    while (state.running && mounted.current) {
      await new Promise((resolve) => setTimeout(resolve, 500));
      state = await getPluginIntegration(pluginId, project.id);
    }
    if (!mounted.current) return undefined;
    if (
      state.result?.connection?.status === "ready" &&
      state.result.project &&
      !state.error
    ) {
      return project;
    }
    const ready = await new Promise<boolean>((resolve) => {
      active.current = { project, initial: state, resolve };
      setDialog(active.current);
    });
    if (ready) {
      return project;
    }
    return undefined;
  }
  function close(ready: boolean) {
    active.current?.resolve(ready);
    active.current = undefined;
    setDialog(undefined);
  }
  return {
    ensure,
    dialog: dialog ? (
      <IntegrationDialog onClose={() => close(false)}>
        <PluginIntegrationPanel
          pluginId={dialog.project.integration!.pluginId}
          projectId={dialog.project.id}
          initial={dialog.initial}
          onReady={() => close(true)}
        />
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
        className="project-create-dialog"
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

export function ExternalProjectPreview({ project }: { project: ProjectState }) {
  const pluginId = project.integration!.pluginId;
  const integration = useIntegration(pluginId, project.id);
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
      <IntegrationContents
        {...integration}
        pluginId={pluginId}
        projectId={project.id}
      />
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
            type="button"
            disabled={busy}
            onClick={() => void run("preview-install")}
          >
            {t("integration.installRuntime")}
          </button>
        ) : (
          <button
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
          type="button"
          disabled={busy || preview?.status !== "running"}
          onClick={() => void run("preview-stop")}
        >
          {t("integration.stop")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run("preview-status")}
        >
          {t("integration.refresh")}
        </button>
        <button
          type="button"
          disabled={busy}
          onClick={() => void run("preview-logs")}
        >
          {t("integration.logs")}
        </button>
      </div>
      {preview?.logs ? <pre>{preview.logs}</pre> : null}
    </section>
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
