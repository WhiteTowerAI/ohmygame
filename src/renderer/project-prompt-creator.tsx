import { Lightbulb, LoaderCircle, SendArrow } from "./icons.js";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { AgentModel, AgentModelRef, AgentReasoningLevel, ConversationCapabilities, PluginMention } from "../shared/contracts.js";
import { clampReasoningLevel } from "../shared/reasoning.js";
import { appWidePluginSuits } from "../shared/project-runtime.js";
import { preferredAgentModel } from "../shared/agent-models.js";
import { isAgentRuntimeId, nativeEffort } from "../shared/agent-runtimes.js";
import { getHomeComposerCapabilities, updateAgentDefaults, waitForRuntime } from "./api.js";
import { AttachmentStrip, appendAttachments, attachmentFiles, type ComposerAttachment } from "./composer-attachments.js";
import { composerDrafts, homeDraftScope, type SavedComposerDraft } from "./composer-drafts.js";
import { ModelSelector, useAgentModels } from "./model-selector.js";
import { matchesPlanCommand, PlanModeIndicator } from "./plan-mode-control.js";
import { PromptBox, type DroppedFile, type PromptInput, type PromptSelection } from "./prompt-box.js";
import type { FirstMessage } from "./project-create-dialog.js";
import { PluginConsentDialog } from "./plugin-consent-dialog.js";
import { PROJECT_TYPES } from "./project-types.js";
import { isAppProjectType, MORE_TYPES, newProjectKind, openMoreProjectTypes, projectTypeOptions, usePluginProjectTypes } from "./project-type-choices.js";
import { Button, DropdownMenu, Select } from "./ui/index.js";
import { useComposerContextMenu } from "./composer-context-menu.js";
import { activePluginMentions, insertMention, toPluginMention, type ComposerMention, type ComposerMentionQuery } from "./composer-mentions.js";
import { createPromptHistory, loadHomePromptHistory, nextPrompt, previousPrompt } from "./prompt-history.js";
import { t } from "./i18n.js";

const EMPTY_CAPABILITIES: ConversationCapabilities = { plugins: [], skills: [] };

const DEFAULT_TYPE = "web-game";
const TYPE_KEY = "ohmygame.home.projectType";
type Plugin = ConversationCapabilities["plugins"][number];

// Game ideas per type. The plugins' own prompts are written for an open
// project ("the current game"), so Home keeps its own.
const WEB_IDEAS = ["home.ideas.web.dungeon", "home.ideas.web.merge", "home.ideas.web.racing"] as const;
const STUDIO_IDEAS = ["home.ideas.studio.platformer", "home.ideas.studio.towerDefense", "home.ideas.studio.cards"] as const;
const GODOT_IDEAS = ["home.ideas.godot.thirdPerson", "home.ideas.godot.shooter", "home.ideas.godot.physics"] as const;
const GENERAL_IDEAS = ["home.ideas.general.platformer", "home.ideas.general.puzzle", "home.ideas.general.story"] as const;
type IdeaKey = (typeof WEB_IDEAS | typeof STUDIO_IDEAS | typeof GODOT_IDEAS | typeof GENERAL_IDEAS)[number];
const TYPE_IDEAS: Record<string, readonly IdeaKey[]> = {
  "web-game": WEB_IDEAS,
  general: STUDIO_IDEAS,
  "godot-game": GODOT_IDEAS,
  "ohmygame/godot:godot-game": GODOT_IDEAS,
};

/**
 * Home's prompt box. Sending hands the prompt to the new-project dialog as the
 * first message; the project is created there, and the dialog clears the draft.
 */
export function ProjectPromptCreator({ draftKey, placeholder, disabled: creating = false, starts, onSubmit }: {
  /** Each start page keeps its own unsent prompt while the user visits projects. */
  draftKey: string;
  placeholder: string;
  disabled?: boolean;
  /** The page's other ways to start, in a row under the box with Ideas. */
  starts?: ReactNode;
  /** `clearDraft` empties the prompt box once the project has been created. */
  onSubmit: (message: FirstMessage, clearDraft: () => void) => void;
}) {
  const draftSession = composerDrafts.get(homeDraftScope(draftKey));
  const draft = useSyncExternalStore(draftSession.subscribe, draftSession.getSnapshot, draftSession.getSnapshot);
  const { prompt, mentions: pluginMentions, planning, attachments } = draft;
  function draftSetter<K extends keyof SavedComposerDraft>(field: K) {
    return (value: SavedComposerDraft[K] | ((current: SavedComposerDraft[K]) => SavedComposerDraft[K])) => draftSession.update((current) => ({
      [field]: typeof value === "function" ? (value as (current: SavedComposerDraft[K]) => SavedComposerDraft[K])(current[field]) : value,
    }));
  }
  const setPrompt = draftSetter("prompt");
  const setPluginMentions = draftSetter("mentions");
  const setPlanning = draftSetter("planning");
  const setAttachments = draftSetter("attachments");
  const [capabilities, setCapabilities] = useState(EMPTY_CAPABILITIES);
  const [savedType, setSavedType] = useState(loadType);
  const { types: loadedPluginTypes, failed: pluginTypesFailed, retry: retryPluginTypes } = usePluginProjectTypes();
  const pluginTypes = loadedPluginTypes ?? [];
  // A plugin's type stays chosen only while its plugin is installed and enabled;
  // until plugins and their types load, sending waits rather than sending another type.
  const typePending = !isAppProjectType(savedType) && loadedPluginTypes === undefined;
  const type = isAppProjectType(savedType) || typePending || pluginTypes.some((option) => option.id === savedType) ? savedType : DEFAULT_TYPE;
  // Plugins whose consent the person gave here, for the project about to be made.
  const [allowed, setAllowed] = useState<ReadonlySet<string>>(new Set());
  const [consent, setConsent] = useState<{ plugin: Plugin; next: (allowed: ReadonlySet<string>) => void }>();
  const [mentionCursor, setMentionCursor] = useState(0);
  const [savingDefaults, setSavingDefaults] = useState(false);
  const [error, setError] = useState<string>();
  const [model, setModel] = useState<AgentModelRef>();
  const [reasoningLevel, setReasoningLevel] = useState<AgentReasoningLevel>();
  const [nativeReasoningLevel, setNativeReasoningLevel] = useState<string>();
  const [storedHistory] = useState(() => loadHomePromptHistory());
  const [history, setHistory] = useState(() => createPromptHistory(storedHistory.map((entry) => entry.prompt)));
  const mentionHistory = new Map(storedHistory.map((entry) => [entry.prompt, entry.mentions]));
  // The unsent prompt's plugins, for coming back to it from history.
  const draftMentions = useRef<PluginMention[]>([]);
  const promptRef = useRef<PromptInput>(null);
  const modelCatalog = useAgentModels({ agentRuntimes: true });
  const selectedModel = preferredAgentModel(modelCatalog.models, model, modelCatalog.defaultModel);
  // Only plugins that work in the chosen type can be mentioned.
  const kind = newProjectKind(type);
  const offered = useMemo(() => ({
    plugins: capabilities.plugins.filter((plugin) => appWidePluginSuits(plugin.appliesTo, kind)),
    skills: capabilities.skills,
  }), [capabilities, kind.type, kind.pluginType?.id]);
  const contextMenu = useComposerContextMenu({
    prompt,
    cursor: mentionCursor,
    input: promptRef,
    disabled: creating,
    capabilities: offered,
    planning,
    canTogglePlanning: !creating,
    onFiles: addAttachments,
    onTogglePlanning: () => togglePlanning(false),
    onMention: selectMention,
    onChange: changePrompt,
    onSelectionChange: setMentionCursor,
  });

  useEffect(() => {
    let disposed = false;
    void waitForRuntime()
      .then(() => getHomeComposerCapabilities())
      .then((result) => { if (!disposed) setCapabilities(result); })
      // Without the list, a remembered plugin type stays pending rather than look disabled.
      .catch((cause) => { if (!disposed) setError(errorMessage(cause)); });
    return () => { disposed = true; };
  }, []);

  useEffect(() => {
    if (!selectedModel) return;
    if (isAgentRuntimeId(selectedModel.provider)) {
      const next = nativeEffort(selectedModel, nativeReasoningLevel, modelCatalog.defaultNativeReasoningLevel);
      if (next !== nativeReasoningLevel) setNativeReasoningLevel(next);
      return;
    }
    const next = clampReasoningLevel(reasoningLevel ?? modelCatalog.defaultReasoningLevel, selectedModel.reasoningLevels);
    if (next && next !== reasoningLevel) setReasoningLevel(next);
  }, [selectedModel, modelCatalog.defaultReasoningLevel, modelCatalog.defaultNativeReasoningLevel, reasoningLevel, nativeReasoningLevel]);

  const ideas = TYPE_IDEAS[type] ?? GENERAL_IDEAS;
  const skillNames = useMemo(() => capabilities.skills.map((skill) => skill.name), [capabilities.skills]);

  function chooseType(value: string): void {
    if (value === MORE_TYPES) {
      openMoreProjectTypes();
      return;
    }
    setSavedType(value);
    try { localStorage.setItem(TYPE_KEY, value); } catch { /* The type is remembered only when storage works. */ }
  }

  /** The mentioned plugins that suit the type but aren't on in every project: creating the project turns them on. */
  function pluginsToTurnOn(text: string): Plugin[] {
    const mentioned = activePluginMentions(text, pluginMentions);
    return offered.plugins.filter((plugin) => plugin.off && mentioned.some((mention) => mention.name === plugin.name && mention.marketplaceId === plugin.marketplaceId));
  }

  function submit(allowedNow = allowed): void {
    if (matchesPlanCommand(prompt)) {
      togglePlanning();
      return;
    }
    if ((!prompt.trim() && attachments.length === 0) || creating || typePending) return;
    const submittedPrompt = prompt.trim();
    const turnOn = pluginsToTurnOn(submittedPrompt);
    // A plugin brought back from history asks before the project allows it.
    const unallowed = turnOn.find((plugin) => plugin.asks?.length && !allowedNow.has(plugin.id));
    if (unallowed) {
      setConsent({ plugin: unallowed, next: submit });
      return;
    }
    const submittedDraft = draft;
    onSubmit({
      prompt: submittedPrompt,
      mentions: activePluginMentions(submittedPrompt, pluginMentions),
      attachments,
      mode: planning ? "planning" : "normal",
      type,
      ...(turnOn.length ? { turnOn } : {}),
    }, () => { draftSession.clearSubmitted(submittedDraft); });
  }

  function addAttachments(next: ComposerAttachment[]): void {
    setError(undefined);
    try { setAttachments(appendAttachments(attachments, next)); }
    catch (cause) { setError(errorMessage(cause)); }
    promptRef.current?.focus();
  }
  function addFiles(files: DroppedFile[]): void { addAttachments(attachmentFiles(files)); }

  /** Saves the model with Pi's reasoning level, or with its own effort for a coding agent's model. */
  async function saveDefaults(nextModel: AgentModel, choice: { reasoningLevel?: AgentReasoningLevel; nativeReasoningLevel?: string } = {}): Promise<void> {
    if (savingDefaults) return;
    const modelRef = { provider: nextModel.provider, id: nextModel.id };
    setSavingDefaults(true);
    setError(undefined);
    try {
      if (isAgentRuntimeId(nextModel.provider)) {
        const effort = nativeEffort(nextModel, choice.nativeReasoningLevel, nativeReasoningLevel);
        await updateAgentDefaults({ model: modelRef, ...(effort ? { nativeReasoningLevel: effort } : {}) });
        setNativeReasoningLevel(effort);
      } else {
        const level = choice.reasoningLevel ?? clampReasoningLevel(reasoningLevel ?? modelCatalog.defaultReasoningLevel, nextModel.reasoningLevels);
        await updateAgentDefaults({ model: modelRef, reasoningLevel: level });
        setReasoningLevel(level);
      }
      setModel(modelRef);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSavingDefaults(false);
    }
  }

  function changeModel(nextModel: AgentModel): void {
    void saveDefaults(nextModel);
  }

  function togglePlanning(clearDraft = true): void {
    setPlanning((value) => !value);
    if (clearDraft) {
      setPrompt("");
      setPluginMentions([]);
      setMentionCursor(0);
    }
    promptRef.current?.focus();
  }

  function changePrompt(value: string, mentions = pluginMentions): void {
    setPrompt(value);
    setPluginMentions(activePluginMentions(value, mentions));
    setHistory((current) => current.index === current.entries.length
      ? current
      : { ...current, index: current.entries.length, draft: value });
  }

  function browseHistory(direction: "previous" | "next"): void {
    const result = direction === "previous" ? previousPrompt(history, prompt) : nextPrompt(history);
    if (!result) return;
    if (history.index === history.entries.length) draftMentions.current = pluginMentions;
    const historicalMentions = mentionHistory.get(result.prompt)
      ?? (result.history.index === result.history.entries.length ? draftMentions.current : []);
    setHistory(result.history);
    setPrompt(result.prompt);
    setPluginMentions(activePluginMentions(result.prompt, historicalMentions));
    setMentionCursor(result.prompt.length);
    focusAt(result.prompt.length);
  }

  function selectMention(mention: ComposerMention, query?: ComposerMentionQuery): void {
    const insert = () => {
      const inserted = insertMention(prompt, query ?? { start: mentionCursor, end: mentionCursor, trigger: "@", query: "" }, mention);
      if (mention.type === "plugin") {
        const selected = toPluginMention(mention.value);
        changePrompt(inserted.value, [...pluginMentions.filter((item) => item.name !== selected.name || item.marketplaceId !== selected.marketplaceId), selected]);
      } else {
        changePrompt(inserted.value);
      }
      setMentionCursor(inserted.cursor);
      focusAt(inserted.cursor);
    };
    // One that isn't on in every project is turned on in the new project, once the person allows what it asks for.
    const plugin = mention.type === "plugin" ? offered.plugins.find((item) => item.id === mention.value.id) : undefined;
    if (plugin?.asks?.length && !allowed.has(plugin.id)) setConsent({ plugin, next: insert });
    else insert();
  }

  function focusAt(cursor: number): void {
    requestAnimationFrame(() => promptRef.current?.focus(cursor));
  }

  function handleCommandKeyDown(event: KeyboardEvent, selection: PromptSelection): boolean {
    setMentionCursor(selection.start);
    return contextMenu.handleKeyDown(event);
  }

  return (
    <>
      <PromptBox
        actions={(
          <>
            <ModelSelector
              placement="below"
              models={modelCatalog.models}
              status={modelCatalog.status}
              value={selectedModel}
              reasoningLevel={reasoningLevel}
              nativeReasoningLevel={nativeReasoningLevel}
              disabled={creating || savingDefaults}
              onChange={changeModel}
              onReasoningChange={(next) => { if (selectedModel) void saveDefaults(selectedModel, { reasoningLevel: next }); }}
              onNativeReasoningChange={(next) => { if (selectedModel) void saveDefaults(selectedModel, { nativeReasoningLevel: next }); }}
            />
            <button
              className="icon-button send-button"
              type="submit"
              disabled={(!prompt.trim() && attachments.length === 0) || creating || typePending}
              title={t("creator.create")}
              aria-label={t("creator.create")}
            >
              {creating ? <LoaderCircle className="spin" size={15} /> : <SendArrow size={15} />}
            </button>
          </>
        )}
        content={<AttachmentStrip items={attachments} onRemove={(id) => setAttachments((items) => items.filter((attachment) => attachment.id !== id))} />}
        disabled={creating}
        leading={(
          <>
            {contextMenu.button}
            <span className="home-project-type">
              <Select<string> size="sm" label={t("home.projectType")} value={type} onChange={chooseType}
                options={projectTypeOptions(PROJECT_TYPES.map((option) => option.value), pluginTypes)} />
            </span>
            {planning ? <PlanModeIndicator disabled={creating} onExit={() => togglePlanning()} /> : null}
          </>
        )}
        onChange={changePrompt}
        onCommandKeyDown={handleCommandKeyDown}
        onHistoryNext={() => browseHistory("next")}
        onHistoryPrevious={() => browseHistory("previous")}
        onSubmit={() => void submit()}
        suggestions={contextMenu.suggestions}
        overlay={contextMenu.open ? contextMenu.overlay : null}
        placeholder={planning ? t("creator.planPlaceholder") : placeholder}
        inputRef={promptRef}
        onSelectionChange={setMentionCursor}
        value={prompt}
        variant="home"
        mentions={pluginMentions}
        plugins={capabilities.plugins}
        skills={skillNames}
        onDropFiles={creating ? undefined : addFiles}
        onDropError={(cause) => setError(cause.message)}
      />
      {error ? <p className="home-notice" role="alert">{error}</p> : null}
      {pluginTypesFailed ? (
        <p className="home-notice" role="alert">
          {t("createDialog.pluginsFailed")}{" "}
          <Button size="sm" variant="ghost" onClick={retryPluginTypes}>{t("common.retry")}</Button>
        </p>
      ) : null}
      {/* Ideas are one button beside the other ways to start, rather than a row
          of ideas that changed width with the type and moved the page. */}
      {consent ? <PluginConsentDialog name={consent.plugin.displayName} capabilities={consent.plugin.asks ?? []}
        onCancel={() => setConsent(undefined)}
        onAllow={() => {
          const { plugin, next: proceed } = consent;
          const next = new Set([...allowed, plugin.id]);
          setConsent(undefined);
          setAllowed(next);
          proceed(next);
        }} /> : null}
      <div className="home-starts">
        {starts}
        <DropdownMenu placement="bottom" items={ideas.map((key) => ({ label: t(key), onSelect: () => {
          changePrompt(t(key));
          focusAt(t(key).length);
        } }))} trigger={(props) => (
          <Button {...props} variant="ghost" size="sm" icon={<Lightbulb size={14} />} disabled={creating}>{t("home.ideasButton")}</Button>
        )} />
      </div>
    </>
  );
}

function loadType(): string {
  try { return localStorage.getItem(TYPE_KEY) ?? DEFAULT_TYPE; } catch { return DEFAULT_TYPE; }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
