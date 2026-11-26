import { Lightbulb, Spinner, ArrowUp } from "./icons.js";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore, type ReactNode } from "react";
import type { AgentModel, AgentModelRef, AgentReasoningLevel, ConversationCapabilities, PluginMention } from "../shared/contracts.js";
import { clampReasoningLevel } from "../shared/reasoning.js";
import { appWidePluginSuits } from "../shared/project-runtime.js";
import { preferredAgentModel } from "../shared/agent-models.js";
import { isAgentRuntimeId, nativeEffort } from "../shared/agent-runtimes.js";
import { generateGameIdea, getHomeComposerCapabilities, updateAgentDefaults, waitForRuntime } from "./api.js";
import { AttachmentStrip, appendAttachments, attachmentFiles, type ComposerAttachment } from "./composer-attachments.js";
import { composerDrafts, homeDraftScope, type SavedComposerDraft } from "./composer-drafts.js";
import { ModelSelector, useAgentModels } from "./model-selector.js";
import { matchesPlanCommand, PlanModeIndicator } from "./plan-mode-control.js";
import { PromptBox, type DroppedFile, type PromptInput, type PromptSelection } from "./prompt-box.js";
import type { FirstMessage } from "./project-create-dialog.js";
import { isAppProjectType, PROJECT_TYPES } from "./project-types.js";
import { newProjectKind, projectTypeOptions, usePluginProjectTypes } from "./project-type-choices.js";
import { Button, Select } from "./ui/index.js";
import { useComposerContextMenu } from "./composer-context-menu.js";
import { activePluginMentions, insertMention, toPluginMention, type ComposerMention, type ComposerMentionQuery } from "./composer-mentions.js";
import { createPromptHistory, loadHomePromptHistory, nextPrompt, previousPrompt } from "./prompt-history.js";
import { t } from "./i18n.js";

const EMPTY_CAPABILITIES: ConversationCapabilities = { plugins: [], skills: [] };

const DEFAULT_TYPE = "web-game";
const TYPE_KEY = "ohmygame.home.projectType";
type Plugin = ConversationCapabilities["plugins"][number];

// The random idea button asks the model for one idea of the type; offline, or
// with no model it can use, it picks one of these. The plugins' own prompts are
// written for an open project ("the current game"), so Home keeps its own.
const WEB_IDEAS = ["home.ideas.web.dungeon", "home.ideas.web.merge", "home.ideas.web.racing"] as const;
const GODOT_IDEAS = ["home.ideas.godot.thirdPerson", "home.ideas.godot.shooter", "home.ideas.godot.physics"] as const;
const GENERAL_IDEAS = ["home.ideas.general.platformer", "home.ideas.general.puzzle", "home.ideas.studio.towerDefense", "home.ideas.studio.cards"] as const;
const STORY_IDEAS = ["home.ideas.story.mystery", "home.ideas.story.space", "home.ideas.story.school"] as const;
const ASSET_IDEAS = ["home.ideas.assets.knight", "home.ideas.assets.forest", "home.ideas.assets.effects"] as const;
type IdeaKey = (typeof WEB_IDEAS | typeof GODOT_IDEAS | typeof GENERAL_IDEAS | typeof STORY_IDEAS | typeof ASSET_IDEAS)[number];
type IdeaType = "general" | "web-game" | "godot-game" | "interactive-story" | "asset-canvas";
const TYPE_IDEAS: Record<IdeaType, readonly IdeaKey[]> = {
  general: GENERAL_IDEAS,
  "web-game": WEB_IDEAS,
  "godot-game": GODOT_IDEAS,
  "interactive-story": STORY_IDEAS,
  "asset-canvas": ASSET_IDEAS,
};

/** The kind of idea that suits a type: an app type's own, Godot's for the Godot plugin, otherwise a general game. */
function ideaType(type: string): IdeaType {
  if (type === "ohmygame/godot:godot-game") return "godot-game";
  return type in TYPE_IDEAS ? type as IdeaType : "general";
}

/** One of the type's own ideas, other than the one showing. */
export function presetIdea(type: string, current = "", random = Math.random): string {
  const ideas = TYPE_IDEAS[ideaType(type)].map((key) => t(key)).filter((idea) => idea !== current.trim());
  return ideas[Math.floor(random() * ideas.length)] ?? t(TYPE_IDEAS.general[0]);
}

/**
 * Home's prompt box. Sending hands the prompt to the new-project dialog as the
 * first message; the project is created there, and the dialog clears the draft.
 */
export function ProjectPromptCreator({ draftKey, placeholder, disabled: creating = false, starts, type: chosenType, autoFocus = false, onConnectModel, onSubmit }: {
  /** Each start page keeps its own unsent prompt while the user visits projects. */
  draftKey: string;
  placeholder: string;
  disabled?: boolean;
  /** The page's other ways to start, in a row under the box. */
  starts?: ReactNode;
  /** A type chosen outside the box, as by the new game dialog's cards; the box then has no type menu. */
  type?: string;
  autoFocus?: boolean;
  /** With no model to send to, the box says so and offers this instead of sending. */
  onConnectModel?: () => void;
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
  const type = chosenType ?? (isAppProjectType(savedType) || typePending || pluginTypes.some((option) => option.id === savedType) ? savedType : DEFAULT_TYPE);
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
  const needsModel = !!onConnectModel && modelCatalog.status === "ready" && modelCatalog.models.length === 0;
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

  const [ideaLoading, setIdeaLoading] = useState(false);
  const ideaRequest = useRef(0);
  useEffect(() => () => { ideaRequest.current += 1; }, []);

  /** Fills the box with a fresh idea: the model's, or one of the type's own when there is no model or it fails. */
  async function randomIdea(): Promise<void> {
    const request = ++ideaRequest.current;
    const current = prompt;
    setError(undefined);
    setIdeaLoading(true);
    let idea: string | undefined;
    if (modelCatalog.models.length) {
      try { idea = await generateGameIdea({ type: ideaType(type), model: selectedModel, avoid: current.trim() || undefined }); }
      catch { /* The type's own ideas stand in. */ }
    }
    if (request !== ideaRequest.current) return;
    setIdeaLoading(false);
    const next = idea ?? presetIdea(type, current);
    changePrompt(next, []);
    setMentionCursor(next.length);
    focusAt(next.length);
  }

  useEffect(() => {
    if (!autoFocus) return;
    const frame = requestAnimationFrame(() => promptRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [autoFocus]);
  const skillNames = useMemo(() => capabilities.skills.map((skill) => skill.name), [capabilities.skills]);

  function chooseType(value: string): void {
    setSavedType(value);
    try { localStorage.setItem(TYPE_KEY, value); } catch { /* The type is remembered only when storage works. */ }
  }

  /** The mentioned plugins that suit the type but aren't on in every project: creating the project turns them on. */
  function pluginsToTurnOn(text: string): Plugin[] {
    const mentioned = activePluginMentions(text, pluginMentions);
    return offered.plugins.filter((plugin) => plugin.off && mentioned.some((mention) => mention.name === plugin.name && mention.marketplaceId === plugin.marketplaceId));
  }

  function submit(): void {
    if (matchesPlanCommand(prompt)) {
      togglePlanning();
      return;
    }
    if ((!prompt.trim() && attachments.length === 0) || creating || typePending || needsModel) return;
    const submittedPrompt = prompt.trim();
    const turnOn = pluginsToTurnOn(submittedPrompt);
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
    // One that isn't on in every project is turned on in the new project, which allows it.
    insert();
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
              disabled={(!prompt.trim() && attachments.length === 0) || creating || typePending || needsModel}
              title={t("creator.create")}
              aria-label={t("creator.create")}
            >
              {creating ? <Spinner size="sm" /> : <ArrowUp size="sm" />}
            </button>
          </>
        )}
        content={<>
          {needsModel ? <div className="creator-connect-model" role="status">
            <span>{t("newGame.connectModel")}</span>
            <Button size="sm" variant="primary" onClick={onConnectModel}>{t("newGame.connectModelAction")}</Button>
          </div> : null}
          <AttachmentStrip items={attachments} onRemove={(id) => setAttachments((items) => items.filter((attachment) => attachment.id !== id))} />
        </>}
        disabled={creating}
        leading={(
          <>
            {contextMenu.button}
            <button
              className="icon-button composer-attach-button creator-idea-button"
              type="button"
              disabled={creating || ideaLoading}
              aria-busy={ideaLoading || undefined}
              aria-label={t("home.randomIdea")}
              title={t("home.randomIdea")}
              onClick={() => void randomIdea()}
            >{ideaLoading ? <Spinner size="md" /> : <Lightbulb size="md" />}</button>
            {chosenType === undefined ? <span className="home-project-type">
              <Select<string> size="sm" label={t("home.projectType")} value={type} onChange={chooseType}
                options={projectTypeOptions(PROJECT_TYPES.map((option) => option.value), pluginTypes)} />
            </span> : null}
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
      {starts ? <div className="home-starts">{starts}</div> : null}
    </>
  );
}

function loadType(): string {
  try { return localStorage.getItem(TYPE_KEY) ?? DEFAULT_TYPE; } catch { return DEFAULT_TYPE; }
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
