import { LoaderCircle, X } from "./icons.js";
import { useEffect, useId, useRef, useState } from "react";
import type { ConversationCapabilities, ProjectState, ProjectType } from "../shared/contracts.js";
import { createProject, getHomeComposerCapabilities } from "./api.js";
import { usePluginIntegrationGate } from "./plugin-integration.js";
import { defaultProjectName, PROJECT_TYPES, ProjectTypeIcon, projectTypeLabel, type ProjectTypeOption } from "./project-types.js";
import { t } from "./i18n.js";

export function ProjectCreateDialog({ initialType = "web-game", fixedType, projectTypes = PROJECT_TYPES, onClose, onCreated }: {
  initialType?: ProjectType;
  fixedType?: ProjectType;
  projectTypes?: readonly ProjectTypeOption[];
  onClose: () => void;
  onCreated: (project: ProjectState) => void;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const creatingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const [name, setName] = useState("");
  const [type, setType] = useState<ProjectType>(fixedType ?? initialType);
  const [workspacePath, setWorkspacePath] = useState<string>();
  const [selectingWorkspace, setSelectingWorkspace] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  const [plugins, setPlugins] = useState<ConversationCapabilities["plugins"]>([]);
  const [pluginId, setPluginId] = useState("");
  const created = useRef<ProjectState | undefined>(undefined);
  const integrationGate = usePluginIntegrationGate();
  const integrationRef = useRef(integrationGate);
  integrationRef.current = integrationGate;
  const integrations = plugins.filter(plugin => plugin.integration && (!plugin.projectTypes?.length || plugin.projectTypes.includes(type)));
  creatingRef.current = creating;
  onCloseRef.current = onClose;
  useEffect(() => {
    let active = true;
    void getHomeComposerCapabilities().then(value => { if (active) setPlugins(value.plugins); }).catch(() => {});
    return () => { active = false; };
  }, []);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    const handleKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape" && integrationRef.current.creation) {
        event.preventDefault();
        integrationRef.current.cancelCreation();
        return;
      }
      if (event.key === "Escape" && !creatingRef.current) onCloseRef.current();
      if (event.key !== "Tab" || !dialog.current) return;
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), select:not(:disabled), a[href], summary, [tabindex]:not([tabindex='-1'])")]
        .filter(element => !element.closest('details:not([open])') || element.tagName === "SUMMARY");
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (document.activeElement === dialog.current || (!event.shiftKey && document.activeElement === last)) {
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
  }, []);

  useEffect(() => {
    if (!integrationGate.creation && !creating) nameInput.current?.focus();
  }, [!!integrationGate.creation, creating]);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (creating) return;
    setCreating(true);
    setError(undefined);
    try {
      const plugin = integrations.find(plugin => plugin.id === pluginId);
      created.current ??= await createProject({
        ...(name.trim() ? { name: name.trim() } : {}),
        type,
        ...(workspacePath ? { workspacePath } : {}),
        ...(plugin ? { pluginId: plugin.id } : {}),
      });
      const integrationId = plugin?.id ?? created.current.integration?.pluginId;
      const integration = plugins.find(plugin => plugin.id === integrationId)?.integration;
      const project = await integrationGate.ensure(created.current, integrationId, integrationId ? { canCreate: !!integration?.createProject, embedded: true } : undefined);
      if (!project) { setCreating(false); return; }
      onCreated(project);
    } catch (cause) {
      setError(errorMessage(cause));
      setCreating(false);
    }
  }

  async function chooseWorkspace(): Promise<void> {
    if (creating || selectingWorkspace) return;
    const selectDirectory = window.ohMyGameDesktop?.selectProjectDirectory;
    if (!selectDirectory) {
      setError(t("createDialog.restartForFolders"));
      return;
    }
    setSelectingWorkspace(true);
    setError(undefined);
    try {
      const selected = await selectDirectory();
      if (!selected) return;
      setWorkspacePath(selected);
      created.current = undefined;
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSelectingWorkspace(false);
    }
  }

  function clearWorkspace(): void {
    created.current = undefined;
    setWorkspacePath(undefined);
    setError(undefined);
  }

  return (
    <div className="project-create-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !creating) onClose();
    }}>
      <section ref={dialog} className="project-create-dialog" role="dialog" aria-modal="true" aria-labelledby={integrationGate.creation ? undefined : titleId} aria-label={integrationGate.creationTitle} tabIndex={-1}>
        {!integrationGate.creation ? <header>
          <h2 id={titleId}>{fixedType ? t("createDialog.newType", { type: projectTypeLabel(fixedType) }) : t("createDialog.newProject")}</h2>
          <button type="button" disabled={creating} onClick={onClose} aria-label={t("common.close")}><X size={16} /></button>
        </header> : null}
        {integrationGate.creation ? <div className="project-create-integration">{integrationGate.creation}</div> : <form onSubmit={(event) => void submit(event)} onChange={() => { created.current = undefined; }}>
          <label className="project-create-name">
            <span>{t("common.name")}</span>
            <input ref={nameInput} value={name} maxLength={120} disabled={creating} placeholder={defaultProjectName(type)} onChange={(event) => setName(event.target.value)} />
          </label>
          <fieldset className="project-create-workspace">
            <legend>{t("creator.workspace")}</legend>
            <div className="project-create-workspace-selection">
              {workspacePath ? <span className="is-selected" title={workspacePath}>{workspacePath}</span> : null}
              <div>
                <button type="button" disabled={creating || selectingWorkspace} onClick={() => void chooseWorkspace()}>
                  {selectingWorkspace ? t("createDialog.opening") : workspacePath ? t("createDialog.chooseAnother") : t("creator.chooseFolder")}
                </button>
                {workspacePath ? <button type="button" disabled={creating || selectingWorkspace} onClick={clearWorkspace}>{t("common.clear")}</button> : null}
              </div>
            </div>
          </fieldset>
          {!fixedType ? (
            <fieldset className="project-create-types">
              <legend>{t("createDialog.type")}</legend>
              {projectTypes.map((option) => (
                <button className={option.value === type ? "is-active" : undefined} type="button" key={option.value} aria-pressed={option.value === type} disabled={creating} onClick={() => { setType(option.value); setPluginId(""); created.current = undefined; }}>
                  <ProjectTypeIcon type={option.value} size={17} />
                  <span>{option.label}</span>
                </button>
              ))}
            </fieldset>
          ) : null}
          {integrations.length ? <label className="project-create-name">
            <span>{t("integration.plugin")}</span>
            <select value={pluginId} disabled={creating} onChange={event => setPluginId(event.target.value)}>
              <option value="">{t("integration.noPlugin")}</option>
              {integrations.map(plugin => <option key={plugin.id} value={plugin.id}>{plugin.displayName}</option>)}
            </select>
          </label> : null}
          {error ? <p className="project-create-error" role="alert">{error}</p> : null}
          <footer>
            <button type="button" disabled={creating} onClick={onClose}>{t("common.cancel")}</button>
            <button className="project-create-submit" type="submit" disabled={creating}>
              {creating ? <LoaderCircle className="spin" size={14} /> : null}
              {t("common.create")}
            </button>
          </footer>
        </form>}
      </section>
    </div>
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
