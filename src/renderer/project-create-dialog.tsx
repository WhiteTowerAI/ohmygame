import { useEffect, useRef, useState } from "react";
import { consentToPlugin, createConversation, createProject, getHomeComposerCapabilities, getProjectLocation, listProjects, setProjectPluginVersion } from "./api.js";
import { uploadAttachments, type ComposerAttachment } from "./composer-attachments.js";
import { activePluginMentions } from "./composer-mentions.js";
import { Folder, LoaderCircle } from "./icons.js";
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
import { pluginAppliesTo, pluginProjectType, projectFileTypeFor } from "../shared/project-runtime.js";
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
  direct = false,
  onClose,
  onCreated,
  onOpenProject,
}: {
  initialType?: ProjectType;
  initialWorkspacePath?: string;
  firstMessage?: FirstMessage;
  /**
   * Creates the project as soon as it can, with nothing to fill in. The dialog
   * shows only for what needs the person: a type's plugin asking for access,
   * plugins that fail to load, or a failure or cancel while creating.
   */
  direct?: boolean;
  onClose: () => void;
  onCreated: (project: ProjectState, start?: ProjectStart) => void;
  onOpenProject?: (projectId: string) => void;
}) {
  const [prompt, setPrompt] = useState(firstMessage?.prompt ?? "");
  const [name, setName] = useState("");
  const [plugins, setPlugins] = useState<Plugin[]>([]);
  // The types come from the plugins, so creating waits for them.
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
  const offersPluginTypes = referenced.every((plugin) => !plugin.projectTypes?.length);
  const pluginTypes = offersPluginTypes ? installedPluginTypes.types ?? [] : [];
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
  // Where a project without a chosen folder goes: Settings → General → Project location, else OhMyGame's own storage.
  const [defaultLocation, setDefaultLocation] = useState<{ location?: string; storage?: string }>({});
  useEffect(() => {
    let active = true;
    void getProjectLocation().then((value) => { if (active) setDefaultLocation(value); }).catch(() => undefined);
    return () => { active = false; };
  }, []);
  const [selectingWorkspace, setSelectingWorkspace] = useState(false);
  const [existingProject, setExistingProject] = useState<ProjectState>();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  const created = useRef<{ key: string; project: ProjectState; conversationId?: string } | undefined>(undefined);
  // Types are waited for when offered or when Home asked for a plugin's type.
  const typesFailed = installedPluginTypes.failed && (offersPluginTypes || !isAppProjectType(wanted));
  const loadFailed = pluginsPhase === "error" || typesFailed || (pluginChoicesFailed && !isAppProjectType(type));
  const [shown, setShown] = useState(!direct);

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

  const started = useRef(false);
  // Leaving the page by other means while creating does not pull the person back.
  const mounted = useRef(true);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; };
  }, []);
  useEffect(() => {
    if (shown) return;
    // The type Home asked for may be gone; the person picks another rather than get the first.
    if (loadFailed || typePluginConsent?.capabilities.length || (ready && type !== preferred)) setShown(true);
    else if (ready && !started.current) {
      started.current = true;
      void submit();
    }
  }, [shown, ready, loadFailed, typePluginConsent, type]);

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
      if (!types.length) throw new Error(t("createDialog.incompatiblePlugins"));
      const input = {
        ...(name.trim() ? { name: name.trim() } : {}),
        ...(isAppProjectType(type) ? { type } : { projectType: type }),
        ...(workspacePath ? { workspacePath } : {}),
      };
      if (typePluginConsent) await consentToPlugin(typePluginConsent.id, typePluginConsent.capabilities);
      // Retrying after a failure reuses the project, unless the choices changed.
      const key = JSON.stringify(input);
      if (created.current?.key !== key) created.current = { key, project: await createProject(input) };
      const project = created.current.project;
      // Plugins chosen on Home for this project alone; the person allowed what they ask for there.
      for (const plugin of firstMessage?.projectPlugins ?? []) {
        // A plugin's own type turns it on; the app's Godot type does not.
        if (plugin.providesTypes.includes(type) || !pluginAppliesTo(plugin.appliesTo, projectFileTypeFor(type))) continue;
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
      if (!mounted.current) return;
      onCreated(project, { conversationId: created.current.conversationId, prompt: text, mentions, mode: firstMessage.mode, attachments });
    } catch (cause) {
      setError(errorMessage(cause));
      setCreating(false);
      setShown(true);
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

  if (!shown) return null;

  // A folder the person chose or set is shown as its path; OhMyGame's own storage by name, its path on hover.
  const locationPath = workspacePath ?? defaultLocation.location;
  const locationTitle = locationPath ?? defaultLocation.storage;
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
        {/* Only a folder shown by its path needs saying how it is used. */}
        <Field label={t("creator.workspace")} hint={workspacePath ? t("createDialog.usesFolder") : locationPath ? t("createDialog.newFolder") : undefined}>
          {(props) => (
            // One box with the folder and its buttons, as tall as the fields above; a folder is only chosen with the button.
            <div className="new-project-location">
              <Folder size={14} className="new-project-location-icon" aria-hidden="true" />
              <output {...props} className={`new-project-location-path${locationPath ? " is-path" : ""}`} title={locationTitle}>
                <bdi>{locationPath ?? t("settings.general.projectLocationDefault")}</bdi>
              </output>
              <Button size="sm" disabled={creating || selectingWorkspace} onClick={() => void chooseWorkspace()}>
                {selectingWorkspace ? t("createDialog.opening") : workspacePath ? t("createDialog.chooseAnother") : t("creator.chooseFolder")}
              </Button>
              {workspacePath ? <Button size="sm" variant="ghost" disabled={creating} onClick={() => setWorkspacePath(undefined)}>{t("common.clear")}</Button> : null}
            </div>
          )}
        </Field>
        {existingProject ? (
          <p className="new-project-error" role="alert">
            {t("creator.folderInUse", { name: existingProject.name })}
            {onOpenProject ? <Button size="sm" onClick={() => onOpenProject(existingProject.id)}>{t("creator.openProject")}</Button> : null}
          </p>
        ) : null}
        {typesFailed || (pluginChoicesFailed && !isAppProjectType(type)) ? (
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

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
