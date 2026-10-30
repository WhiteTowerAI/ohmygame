import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { consentToPlugin, createConversation, createProject, getHomeComposerCapabilities, getProjectLocation, listProjects, setProjectPluginVersion } from "./api.js";
import { uploadAttachments, type ComposerAttachment } from "./composer-attachments.js";
import { activePluginMentions } from "./composer-mentions.js";
import { LoaderCircle } from "./icons.js";
import { referencedIntegration, usePluginIntegrationGate } from "./plugin-integration.js";
import { saveHomePrompt } from "./prompt-history.js";
import { defaultProjectName, PROJECT_TYPES } from "./project-types.js";
import { isAppProjectType, MORE_TYPES, openMoreProjectTypes, projectTypeOptions, usePluginProjectTypes, useProjectPluginChoices } from "./project-type-choices.js";
import { Button, Dialog, Field, Input, Select, Textarea } from "./ui/index.js";
import type {
  ConversationCapabilities,
  PluginMention,
  ProjectState,
  ProjectType,
  PromptAttachment,
  PromptMode,
} from "../shared/contracts.js";
import { pluginProjectType } from "../shared/project-runtime.js";
import type { ProjectPluginChoice } from "../shared/plugins.js";
import { t } from "./i18n.js";
import "./project-create-dialog.css";

/** What Home's prompt box hands over: it becomes the project's first message. */
export interface FirstMessage {
  prompt: string;
  mentions: PluginMention[];
  attachments: ComposerAttachment[];
  mode: PromptMode;
  /** The type chosen on Home: one of the app's, or a plugin's `publisher/name:type`. */
  type?: string;
  /** Plugins to turn on for this project alone once it exists. */
  projectPlugins?: ProjectPluginChoice[];
}

/** The first message, sent in the new project's first conversation. */
export interface ProjectStart {
  conversationId: string;
  prompt: string;
  mentions: PluginMention[];
  mode: PromptMode;
  attachments: PromptAttachment[];
}

type Plugin = ConversationCapabilities["plugins"][number];

/**
 * Asks for an existing folder (desktop app only). It comes back as the project
 * that already uses it, or as a path for a new project; undefined if cancelled.
 */
export async function pickProjectFolder(): Promise<{ owner: ProjectState } | { path: string } | undefined> {
  const selectDirectory = window.ohMyGameDesktop?.selectProjectDirectory;
  if (!selectDirectory) throw new Error(t("createDialog.restartForFolders"));
  const selected = await selectDirectory();
  if (!selected) return undefined;
  const owner = (await listProjects()).find((project) => project.workspacePath === selected);
  return owner ? { owner } : { path: selected };
}

/**
 * One dialog for every new project: from Home's prompt (with the prompt as the
 * first message), Start blank, Import folder and the Projects page. It asks
 * only what the folder needs; the agent asks the rest in the project.
 */
export function ProjectCreateDialog({
  initialType = "web-game",
  initialWorkspacePath,
  firstMessage,
  onClose,
  onCreated,
  onOpenProject,
}: {
  initialType?: ProjectType;
  initialWorkspacePath?: string;
  firstMessage?: FirstMessage;
  onClose: () => void;
  onCreated: (project: ProjectState, start?: ProjectStart) => void;
  onOpenProject?: (projectId: string) => void;
}) {
  const [prompt, setPrompt] = useState(firstMessage?.prompt ?? "");
  const [name, setName] = useState("");
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  // The type and integration come from the plugins, so creating waits for them.
  const [pluginsPhase, setPluginsPhase] = useState<"loading" | "ready" | "error">("loading");
  const [pluginsRetry, setPluginsRetry] = useState(0);
  const mentions = activePluginMentions(prompt, firstMessage?.mentions ?? []);
  const referenced = plugins.filter((plugin) =>
    mentions.some((mention) => mention.name === plugin.name && mention.marketplaceId === plugin.marketplaceId),
  );
  // Types the mentioned plugins can work in; a plugin that names no types fits all of them.
  const types = PROJECT_TYPES.filter(({ value }) => pluginProjectType(value, referenced) === value);
  // Plugins' own types, unless a mentioned plugin works only in some of the app's.
  const installedPluginTypes = usePluginProjectTypes();
  const pluginTypes = referenced.every((plugin) => !plugin.projectTypes?.length) ? installedPluginTypes.types ?? [] : [];
  const offered = (value: string | undefined): value is string =>
    Boolean(value) && (types.some((option) => option.value === value) || pluginTypes.some((option) => option.id === value));
  const [chosenType, setChosenType] = useState<string>();
  const preferred = firstMessage?.type ?? initialType;
  const type: string = offered(chosenType) ? chosenType
    : offered(preferred) ? preferred
    : pluginProjectType(isAppProjectType(preferred) ? preferred : initialType, referenced) ?? referenced.find((plugin) => plugin.projectTypes?.length)?.projectTypes?.[0] ?? types[0]?.value ?? initialType;
  // The type asked for: the person's choice here, else Home's. Only a plugin's waits for plugins' types.
  const wanted = chosenType ?? preferred;
  // A plugin's type is recorded as a general project that its plugin runs.
  const kind: ProjectType = isAppProjectType(type) ? type : "general";
  // The plugin that adds the type turns on with the project, so creating allows what it asks for.
  const { choices: pluginChoices, failed: pluginChoicesFailed, retry: retryPluginChoices } = useProjectPluginChoices();
  const typePluginId = pluginTypes.find((option) => option.id === type)?.plugin?.id;
  const typePlugin = pluginChoices?.find((plugin) => plugin.id === typePluginId);
  // A plugin is allowed once even when it asks for nothing beyond its files.
  const typePluginConsent = typePlugin && !typePlugin.consented ? typePlugin : undefined;
  // Home's plugin type and that type's plugin load apart from the plugins.
  const ready = pluginsPhase === "ready"
    && (isAppProjectType(wanted) || installedPluginTypes.types !== undefined)
    && (isAppProjectType(type) || pluginChoices !== undefined);
  const [workspacePath, setWorkspacePath] = useState(initialWorkspacePath);
  // Settings → General → Project location, where a project without a chosen folder goes.
  const [defaultLocation, setDefaultLocation] = useState<string>();
  useEffect(() => {
    let active = true;
    void getProjectLocation().then((value) => { if (active) setDefaultLocation(value.location); }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  const [selectingWorkspace, setSelectingWorkspace] = useState(false);
  const [existingProject, setExistingProject] = useState<ProjectState>();
  const [integrationId, setIntegrationId] = useState("");
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  const created = useRef<{ key: string; project: ProjectState; conversationId?: string } | undefined>(undefined);
  const integrationGate = usePluginIntegrationGate();
  // A prompt picks its integration from its mentions; a blank project from this list.
  const integrations = firstMessage
    ? []
    : isAppProjectType(type) ? plugins.filter((plugin) => plugin.integration && (!plugin.projectTypes?.length || plugin.projectTypes.includes(kind))) : [];

  useEffect(() => {
    let active = true;
    setPluginsPhase("loading");
    void getHomeComposerCapabilities().then((value) => {
      if (!active) return;
      setPlugins(value.plugins);
      setPluginsPhase("ready");
    }).catch(() => { if (active) setPluginsPhase("error"); });
    return () => { active = false; };
  }, [pluginsRetry]);

  function close(): void {
    if (!creating) onClose();
  }

  // State updates too late to stop a second click in the same tick.
  const submitting = useRef(false);
  async function submit(): Promise<void> {
    if (submitting.current || creating || !ready) return;
    submitting.current = true;
    try { await create(); }
    finally { submitting.current = false; }
  }

  async function create(): Promise<void> {
    setCreating(true);
    setError(undefined);
    try {
      if (!types.length) throw new Error(t("integration.incompatible"));
      const pluginId = firstMessage
        ? referencedIntegration(mentions, plugins)
        : integrations.find((plugin) => plugin.id === integrationId)?.id;
      const input = {
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(isAppProjectType(type) ? { type, ...(pluginId ? { pluginId } : {}) } : { projectType: type }),
        ...(workspacePath ? { workspacePath } : {}),
      };
      if (typePluginConsent) await consentToPlugin(typePluginConsent.id, typePluginConsent.capabilities);
      // Retrying after a failure reuses the project, unless the choices changed.
      const key = JSON.stringify(input);
      if (created.current?.key !== key) created.current = { key, project: await createProject(input) };
      const gateId = pluginId ?? created.current.project.integration?.pluginId;
      const integration = plugins.find((plugin) => plugin.id === gateId)?.integration;
      const project = await integrationGate.ensure(
        created.current.project,
        gateId,
        gateId ? { canCreate: !!integration?.createProject, embedded: true } : undefined,
      );
      if (!project) {
        setCreating(false);
        return;
      }
      created.current.project = project;
      // Plugins chosen on Home for this project alone; the person allowed what they ask for there.
      for (const plugin of firstMessage?.projectPlugins ?? []) {
        // A plugin's own type turns it on; the app's Godot type does not.
        if (plugin.providesTypes.includes(type)) continue;
        if (!plugin.consented) await consentToPlugin(plugin.id, plugin.capabilities);
        await setProjectPluginVersion(project.id, plugin.id, plugin.version);
      }
      const text = prompt.trim();
      if (!firstMessage || (!text && !firstMessage.attachments.length)) {
        onCreated(project);
        return;
      }
      created.current.conversationId ??= (await createConversation(project.id)).id;
      const attachments = await uploadAttachments(project.id, crypto.randomUUID(), firstMessage.attachments);
      saveHomePrompt({ prompt: text, mentions });
      onCreated(project, { conversationId: created.current.conversationId, prompt: text, mentions, mode: firstMessage.mode, attachments });
    } catch (cause) {
      setError(errorMessage(cause));
      setCreating(false);
    }
  }

  async function chooseWorkspace(): Promise<void> {
    setSelectingWorkspace(true);
    setError(undefined);
    setExistingProject(undefined);
    try {
      const picked = await pickProjectFolder();
      if (!picked) return;
      if ("owner" in picked) setExistingProject(picked.owner);
      else setWorkspacePath(picked.path);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSelectingWorkspace(false);
    }
  }

  // Creating with a plugin that makes its own project (TapTap Maker) continues in its panel.
  if (integrationGate.creation) return <IntegrationStep label={integrationGate.creationTitle} onCancel={integrationGate.cancelCreation}>{integrationGate.creation}</IntegrationStep>;

  const location = workspacePath ?? (defaultLocation ? t("createDialog.inLocation", { path: defaultLocation }) : t("createDialog.managedFolder"));
  return (
    <Dialog open onClose={close} title={t("createDialog.newProject")} size="md"
      footer={<>
        <Button disabled={creating} onClick={close}>{t("common.cancel")}</Button>
        <Button variant="primary" disabled={creating || !ready} icon={creating || (!ready && pluginsPhase !== "error") ? <LoaderCircle className="spin" size={14} /> : undefined} onClick={() => void submit()}>
          {firstMessage ? t("createDialog.createAndStart") : t("common.create")}
        </Button>
      </>}>
      <form className="new-project-form" onSubmit={(event) => { event.preventDefault(); void submit(); }}>
        {firstMessage ? (
          <Field label={t("createDialog.firstMessage")}>
            {(props) => <Textarea {...props} rows={3} value={prompt} disabled={creating}
              onChange={(event) => setPrompt(event.target.value)} />}
          </Field>
        ) : null}
        <Field label={t("common.name")}>
          {(props) => <Input {...props} value={name} maxLength={120} disabled={creating}
            placeholder={firstMessage ? t("createDialog.namedFromPrompt") : defaultProjectName(kind)}
            onChange={(event) => setName(event.target.value)} />}
        </Field>
        <Field label={t("createDialog.type")}>
          {(props) => <Select<string> id={props.id} label={t("createDialog.type")} value={type}
            onChange={(value) => {
              if (value === MORE_TYPES) {
                onClose();
                openMoreProjectTypes();
                return;
              }
              setChosenType(value);
              setIntegrationId("");
            }}
            options={projectTypeOptions(types.map((option) => option.value), pluginTypes)} />}
        </Field>
        {typePluginConsent?.capabilities.length ? (
          <div className="new-project-consent">
            <p>{t("createDialog.typePluginConsent", { name: typePluginConsent.displayName })}</p>
            <ul className="project-plugins-capabilities">
              {typePluginConsent.capabilities.map((capability) => <li key={capability}><code>{capability}</code></li>)}
            </ul>
          </div>
        ) : null}
        {integrations.length ? (
          <Field label={t("integration.plugin")}>
            {(props) => <Select id={props.id} label={t("integration.plugin")} value={integrationId} onChange={setIntegrationId}
              options={[{ value: "", label: t("integration.noPlugin") }, ...integrations.map((plugin) => ({ value: plugin.id, label: plugin.displayName }))]} />}
          </Field>
        ) : null}
        <Field label={t("creator.workspace")}>
          {(props) => (
            <div className="new-project-location">
              <Input {...props} readOnly value={location} title={location} />
              <Button disabled={creating || selectingWorkspace} onClick={() => void chooseWorkspace()}>
                {selectingWorkspace ? t("createDialog.opening") : workspacePath ? t("createDialog.chooseAnother") : t("creator.chooseFolder")}
              </Button>
              {workspacePath ? <Button variant="ghost" disabled={creating} onClick={() => setWorkspacePath(undefined)}>{t("common.clear")}</Button> : null}
            </div>
          )}
        </Field>
        {existingProject ? (
          <p className="new-project-error" role="alert">
            {t("creator.folderInUse", { name: existingProject.name })}
            {onOpenProject ? <Button size="sm" onClick={() => onOpenProject(existingProject.id)}>{t("creator.openProject")}</Button> : null}
          </p>
        ) : null}
        {(installedPluginTypes.failed && !isAppProjectType(wanted)) || (pluginChoicesFailed && !isAppProjectType(type)) ? (
          <p className="new-project-error" role="alert">
            {t("createDialog.pluginsFailed")}
            <Button size="sm" onClick={() => {
              if (installedPluginTypes.failed) installedPluginTypes.retry();
              if (pluginChoicesFailed) retryPluginChoices();
            }}>{t("common.retry")}</Button>
          </p>
        ) : null}
        {pluginsPhase === "error" ? (
          <p className="new-project-error" role="alert">
            {t("createDialog.pluginsFailed")}
            <Button size="sm" onClick={() => setPluginsRetry((value) => value + 1)}>{t("common.retry")}</Button>
          </p>
        ) : null}
        {error ? <p className="new-project-error" role="alert">{error}</p> : null}
        {/* Enter in a field submits; the visible buttons are in the footer. */}
        <button type="submit" hidden />
      </form>
    </Dialog>
  );
}

/** The plugin's own creation panel, which brings its header and cancel button. */
function IntegrationStep({ label, onCancel, children }: { label?: string; onCancel: () => void; children: React.ReactNode }) {
  const panel = useRef<HTMLDivElement>(null);
  useEffect(() => {
    panel.current?.querySelector<HTMLElement>("input, button")?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      onCancel();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onCancel]);
  return createPortal(
    <div className="ui-backdrop">
      <div ref={panel} className="ui-dialog ui-dialog-md new-project-integration" role="dialog" aria-modal="true" aria-label={label}>
        {children}
      </div>
    </div>,
    document.body,
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
