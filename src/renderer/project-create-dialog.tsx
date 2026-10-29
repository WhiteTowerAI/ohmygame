import { useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import { createConversation, createProject, getHomeComposerCapabilities, listProjects } from "./api.js";
import { uploadAttachments, type ComposerAttachment } from "./composer-attachments.js";
import { activePluginMentions } from "./composer-mentions.js";
import { LoaderCircle } from "./icons.js";
import { referencedIntegration, usePluginIntegrationGate } from "./plugin-integration.js";
import { saveHomePrompt } from "./prompt-history.js";
import { defaultProjectName, PROJECT_TYPES, ProjectTypeIcon } from "./project-types.js";
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
import { t } from "./i18n.js";
import "./project-create-dialog.css";

/** What Home's prompt box hands over: it becomes the project's first message. */
export interface FirstMessage {
  prompt: string;
  mentions: PluginMention[];
  attachments: ComposerAttachment[];
  mode: PromptMode;
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
  const mentions = activePluginMentions(prompt, firstMessage?.mentions ?? []);
  const referenced = plugins.filter((plugin) =>
    mentions.some((mention) => mention.name === plugin.name && mention.marketplaceId === plugin.marketplaceId),
  );
  // Types the mentioned plugins can work in; a plugin that names no types fits all of them.
  const types = PROJECT_TYPES.filter(({ value }) => pluginProjectType(value, referenced) === value);
  const [chosenType, setChosenType] = useState<ProjectType>();
  const type = chosenType && types.some(({ value }) => value === chosenType)
    ? chosenType
    : pluginProjectType(initialType, referenced) ?? referenced.find((plugin) => plugin.projectTypes?.length)?.projectTypes?.[0] ?? types[0]?.value ?? initialType;
  const [workspacePath, setWorkspacePath] = useState(initialWorkspacePath);
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
    : plugins.filter((plugin) => plugin.integration && (!plugin.projectTypes?.length || plugin.projectTypes.includes(type)));

  useEffect(() => {
    let active = true;
    void getHomeComposerCapabilities().then((value) => { if (active) setPlugins(value.plugins); }).catch(() => {});
    return () => { active = false; };
  }, []);

  function close(): void {
    if (!creating) onClose();
  }

  async function submit(): Promise<void> {
    if (creating) return;
    setCreating(true);
    setError(undefined);
    try {
      if (!types.length) throw new Error(t("integration.incompatible"));
      const pluginId = firstMessage
        ? referencedIntegration(mentions, plugins)
        : integrations.find((plugin) => plugin.id === integrationId)?.id;
      const input = {
        ...(name.trim() ? { name: name.trim() } : {}),
        type,
        ...(workspacePath ? { workspacePath } : {}),
        ...(pluginId ? { pluginId } : {}),
      };
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

  const location = workspacePath ?? t("createDialog.managedFolder");
  return (
    <Dialog open onClose={close} title={t("createDialog.newProject")} size="md"
      footer={<>
        <Button disabled={creating} onClick={close}>{t("common.cancel")}</Button>
        <Button variant="primary" disabled={creating} icon={creating ? <LoaderCircle className="spin" size={14} /> : undefined} onClick={() => void submit()}>
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
            placeholder={firstMessage ? t("createDialog.namedFromPrompt") : defaultProjectName(type)}
            onChange={(event) => setName(event.target.value)} />}
        </Field>
        <Field label={t("createDialog.type")}>
          {(props) => <Select<ProjectType> id={props.id} label={t("createDialog.type")} value={type}
            onChange={(value) => { setChosenType(value); setIntegrationId(""); }}
            options={types.map((option) => ({ value: option.value, label: option.label, icon: <ProjectTypeIcon type={option.value} size={16} /> }))} />}
        </Field>
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
