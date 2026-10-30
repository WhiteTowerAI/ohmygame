import { LoaderCircle, SendArrow } from "./icons.js";
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import type { AgentModel, AgentModelRef, AgentReasoningLevel, ConversationCapabilities, PluginMention } from "../shared/contracts.js";
import { clampReasoningLevel } from "../shared/reasoning.js";
import { preferredAgentModel } from "../shared/agent-models.js";
import { isAgentRuntimeId, nativeEffort } from "../shared/agent-runtimes.js";
import { getHomeComposerCapabilities, updateAgentDefaults, waitForRuntime } from "./api.js";
import { AttachmentStrip, appendAttachments, attachmentFiles, type ComposerAttachment } from "./composer-attachments.js";
import { composerDrafts, homeDraftScope, type SavedComposerDraft } from "./composer-drafts.js";
import { ModelSelector, useAgentModels } from "./model-selector.js";
import { matchesPlanCommand, PlanModeIndicator } from "./plan-mode-control.js";
import { PromptBox, type DroppedFile } from "./prompt-box.js";
import type { FirstMessage } from "./project-create-dialog.js";
import { HomePluginMenu } from "./home-plugin-menu.js";
import { PROJECT_TYPES } from "./project-types.js";
import { isAppProjectType, MORE_TYPES, openMoreProjectTypes, projectTypeOptions, usePluginProjectTypes, useProjectPluginChoices } from "./project-type-choices.js";
import { Select } from "./ui/index.js";
import { useComposerContextMenu } from "./composer-context-menu.js";
import { activePluginMentions, extractLeadingPluginMention, formatComposerInvocation, formatSkillInvocation, insertMention, parseSkillInvocation, toPluginMention, type ComposerMention, type ComposerMentionQuery } from "./composer-mentions.js";
import { createPromptHistory, loadHomePromptHistory, nextPrompt, previousPrompt } from "./prompt-history.js";
import { ComposerCapabilityReferences } from "./composer-capability-references.js";
import { t } from "./i18n.js";

const EMPTY_CAPABILITIES: ConversationCapabilities = { plugins: [], skills: [] };

// Plugins that start a project, in the order Home offers them; only enabled ones show.
const STARTERS = [
  "web-game-studio", "game-studio", "godot", "threejs-world", "wechat-minigame",
  "douyin-minigame", "cocos-creator", "unity", "unreal-engine", "taptap-maker",
];
const DEFAULT_TYPE = "web-game";
const TYPE_KEY = "ohmygame.home.projectType";
type Plugin = ConversationCapabilities["plugins"][number];

// Game ideas per starting plugin. The plugins' own prompts are written for an
// open project ("the current game"), so Home keeps its own.
const IDEAS = {
  "web-game-studio": ["home.ideas.web.dungeon", "home.ideas.web.merge", "home.ideas.web.racing"],
  "game-studio": ["home.ideas.studio.platformer", "home.ideas.studio.towerDefense", "home.ideas.studio.cards"],
  godot: ["home.ideas.godot.thirdPerson", "home.ideas.godot.shooter", "home.ideas.godot.physics"],
  "threejs-world": ["home.ideas.world.island", "home.ideas.world.cyberpunk", "home.ideas.world.station"],
  "wechat-minigame": ["home.ideas.minigame.match", "home.ideas.minigame.rhythm"],
} as const;
const GENERAL_IDEAS = ["home.ideas.general.platformer", "home.ideas.general.puzzle", "home.ideas.general.story"] as const;
type IdeaKey = (typeof IDEAS)[keyof typeof IDEAS][number] | (typeof GENERAL_IDEAS)[number];

/**
 * Home's prompt box. Sending hands the prompt to the new-project dialog as the
 * first message; the project is created there, and the dialog clears the draft.
 */
export function ProjectPromptCreator({ draftKey, placeholder, disabled: creating = false, onSubmit }: {
  /** Each start page keeps its own unsent prompt while the user visits projects. */
  draftKey: string;
  placeholder: string;
  disabled?: boolean;
  /** `clearDraft` empties the prompt box once the project has been created. */
  onSubmit: (message: FirstMessage, clearDraft: () => void) => void;
}) {
  const draftSession = composerDrafts.get(homeDraftScope(draftKey));
  const draft = useSyncExternalStore(draftSession.subscribe, draftSession.getSnapshot, draftSession.getSnapshot);
  const { prompt, selectedSkill, selectedPlugin, mentions: pluginMentions, planning, attachments } = draft;
  function draftSetter<K extends keyof SavedComposerDraft>(field: K) {
    return (value: SavedComposerDraft[K] | ((current: SavedComposerDraft[K]) => SavedComposerDraft[K])) => draftSession.update((current) => ({
      [field]: typeof value === "function" ? (value as (current: SavedComposerDraft[K]) => SavedComposerDraft[K])(current[field]) : value,
    }));
  }
  const setPrompt = draftSetter("prompt");
  const setSelectedSkill = draftSetter("selectedSkill");
  const setSelectedPlugin = draftSetter("selectedPlugin");
  const setPluginMentions = draftSetter("mentions");
  const setPlanning = draftSetter("planning");
  const setAttachments = draftSetter("attachments");
  const [capabilities, setCapabilities] = useState(EMPTY_CAPABILITIES);
  const [savedType, setSavedType] = useState(loadType);
  const pluginTypes = usePluginProjectTypes() ?? [];
  // A plugin's type stays chosen only while its plugin is installed and enabled.
  const type = isAppProjectType(savedType) || pluginTypes.some((option) => option.id === savedType) ? savedType : DEFAULT_TYPE;
  const projectPluginChoices = useProjectPluginChoices() ?? [];
  const [projectPluginIds, setProjectPluginIds] = useState<string[]>([]);
  const [mentionCursor, setMentionCursor] = useState(0);
  const [savingDefaults, setSavingDefaults] = useState(false);
  const [error, setError] = useState<string>();
  const [model, setModel] = useState<AgentModelRef>();
  const [reasoningLevel, setReasoningLevel] = useState<AgentReasoningLevel>();
  const [nativeReasoningLevel, setNativeReasoningLevel] = useState<string>();
  const [storedHistory] = useState(() => loadHomePromptHistory());
  const [history, setHistory] = useState(() => createPromptHistory(storedHistory.map((entry) => entry.prompt)));
  const mentionHistory = new Map(storedHistory.map((entry) => [entry.prompt, entry.mentions]));
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const modelCatalog = useAgentModels({ agentRuntimes: true });
  const selectedModel = preferredAgentModel(modelCatalog.models, model, modelCatalog.defaultModel);
  const contextMenu = useComposerContextMenu({
    prompt,
    cursor: mentionCursor,
    textarea: promptRef,
    disabled: creating,
    capabilities,
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

  const allStarters = capabilities.plugins
    .filter((plugin) => STARTERS.includes(plugin.name))
    .sort((left, right) => STARTERS.indexOf(left.name) - STARTERS.indexOf(right.name));
  const starters = allStarters.filter((plugin) => fitsType(plugin, type));
  const selectedStarter = selectedPlugin && allStarters.find((plugin) => plugin.name === selectedPlugin.name && plugin.marketplaceId === selectedPlugin.marketplaceId);
  const starter = selectedStarter && fitsType(selectedStarter, type) ? selectedStarter : undefined;
  const ideas: readonly IdeaKey[] = (starter && starter.name in IDEAS ? IDEAS[starter.name as keyof typeof IDEAS] : undefined) ?? GENERAL_IDEAS;
  // A plugin that adds the chosen type is on in its projects already.
  const projectPlugins = projectPluginChoices.filter((plugin) => !plugin.providesTypes.includes(type));

  useEffect(() => {
    // A plugin put first in the prompt by hand is kept, and so is a starter that works in the type.
    if (selectedPlugin && (!selectedStarter || starter)) return;
    const next = defaultStarter(starters, type);
    if (next || selectedStarter) chooseStarter(next?.id);
  }, [capabilities, type]);

  /** A new type brings its own starting plugin. */
  function chooseType(value: string): void {
    if (value === MORE_TYPES) {
      openMoreProjectTypes();
      return;
    }
    setSavedType(value);
    try { localStorage.setItem(TYPE_KEY, value); } catch { /* The type is remembered only when storage works. */ }
    chooseStarter(defaultStarter(allStarters.filter((plugin) => fitsType(plugin, value)), value)?.id);
  }

  function chooseStarter(id: string | undefined): void {
    const plugin = allStarters.find((item) => item.id === id);
    if (!plugin) {
      clearSelectedPlugin();
      return;
    }
    const mention = toPluginMention(plugin);
    setSelectedPlugin(mention);
    setPluginMentions((current) => activePluginMentions(formatComposerInvocation(selectedSkill, mention, prompt), [
      ...current.filter((item) => item.name !== mention.name || item.marketplaceId !== mention.marketplaceId),
      mention,
    ]));
  }

  function submit(): void {
    if (matchesPlanCommand(prompt)) {
      togglePlanning();
      return;
    }
    // The starting plugin alone is not a message.
    if ((!prompt.trim() && !selectedSkill && attachments.length === 0) || creating) return;
    const submittedPrompt = formatComposerInvocation(selectedSkill, selectedPlugin, prompt.trim());
    const submittedDraft = draft;
    onSubmit({
      prompt: submittedPrompt,
      mentions: activePluginMentions(submittedPrompt, pluginMentions),
      attachments,
      mode: planning ? "planning" : "normal",
      type,
      projectPlugins: projectPlugins.filter((plugin) => projectPluginIds.includes(plugin.id)),
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
      setSelectedSkill(undefined);
      setSelectedPlugin(undefined);
      setPluginMentions([]);
      setMentionCursor(0);
    }
    if (!planning) setSelectedSkill(undefined);
    promptRef.current?.focus();
  }

  function changePrompt(value: string): void {
    setPrompt(value);
    setPluginMentions((current) => activePluginMentions(formatComposerInvocation(selectedSkill, selectedPlugin, value), current));
    setHistory((current) => current.index === current.entries.length
      ? current
      : { ...current, index: current.entries.length, draft: formatComposerInvocation(selectedSkill, selectedPlugin, value) });
  }

  function browseHistory(direction: "previous" | "next"): void {
    const result = direction === "previous" ? previousPrompt(history, formatComposerInvocation(selectedSkill, selectedPlugin, prompt)) : nextPrompt(history);
    if (!result) return;
    const skill = parseSkillInvocation(result.prompt);
    const historicalMentions = mentionHistory.get(result.prompt) ?? [];
    const plugin = extractLeadingPluginMention(skill?.prompt ?? result.prompt, historicalMentions);
    setHistory(result.history);
    setPrompt(plugin.prompt);
    setSelectedSkill(skill?.name);
    setSelectedPlugin(plugin.mention);
    setPluginMentions(historicalMentions);
    const cursor = plugin.prompt.length;
    setMentionCursor(cursor);
    requestAnimationFrame(() => {
      promptRef.current?.setSelectionRange(cursor, cursor);
    });
  }

  function clearSelectedPlugin(): void {
    setSelectedPlugin(undefined);
    setPluginMentions((current) => activePluginMentions(formatSkillInvocation(selectedSkill, prompt), current));
  }

  function selectMention(mention: ComposerMention, query?: ComposerMentionQuery): void {
    const activeMention = query ?? { start: mentionCursor, end: mentionCursor, trigger: "@" as const, query: "" };
    if (mention.type === "skill") {
      if (query) {
        const suffix = prompt.slice(activeMention.end).replace(/^\s+/, "");
        setPrompt(`${prompt.slice(0, activeMention.start)}${suffix}`);
      }
      setSelectedSkill(mention.value.name);
      setMentionCursor(activeMention.start);
      focusAt(activeMention.start);
      return;
    }
    const selected = toPluginMention(mention.value);
    if ((!query || activeMention.start === 0) && !selectedPlugin) {
      const nextPrompt = query ? prompt.slice(activeMention.end).replace(/^\s+/, "") : prompt;
      const candidates = [
        ...pluginMentions.filter((item) => item.name !== selected.name || item.marketplaceId !== selected.marketplaceId),
        selected,
      ];
      setPrompt(nextPrompt);
      setSelectedPlugin(selected);
      setPluginMentions(activePluginMentions(formatComposerInvocation(selectedSkill, selected, nextPrompt), candidates));
      setMentionCursor(0);
      focusAt(0);
      return;
    }
    const inserted = insertMention(prompt, activeMention, mention);
    changePrompt(inserted.value);
    setPluginMentions((current) => [
      ...current.filter((item) => item.name !== selected.name || item.marketplaceId !== selected.marketplaceId),
      selected,
    ]);
    setMentionCursor(inserted.cursor);
    focusAt(inserted.cursor);
  }

  function focusAt(cursor: number): void {
    requestAnimationFrame(() => {
      promptRef.current?.focus();
      promptRef.current?.setSelectionRange(cursor, cursor);
    });
  }

  function handleCommandKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    setMentionCursor(event.currentTarget.selectionStart);
    if (contextMenu.handleKeyDown(event)) return true;
    if (selectedSkill && event.key === "Backspace" && event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0) {
      event.preventDefault();
      setSelectedSkill(undefined);
      return true;
    }
    if (selectedPlugin && event.key === "Backspace" && event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0) {
      event.preventDefault();
      clearSelectedPlugin();
      return true;
    }
    return false;
  }

  return (
    <>
      <PromptBox
        actions={(
          <>
            <HomePluginMenu
              starters={starters}
              starter={starter}
              onStarter={chooseStarter}
              choices={projectPlugins}
              selected={projectPluginIds.filter((id) => projectPlugins.some((plugin) => plugin.id === id))}
              onSelected={setProjectPluginIds}
              disabled={creating}
            />
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
              disabled={(!selectedSkill && !prompt.trim() && attachments.length === 0) || creating}
              title={t("creator.create")}
              aria-label={t("creator.create")}
            >
              {creating ? <LoaderCircle className="spin" size={15} /> : <SendArrow size={15} />}
            </button>
          </>
        )}
        content={<AttachmentStrip items={attachments} onRemove={(id) => setAttachments((items) => items.filter((attachment) => attachment.id !== id))} />}
        disabled={creating}
        prefix={<ComposerCapabilityReferences
          skill={selectedSkill}
          plugin={starter ? undefined : selectedPlugin}
          onRemoveSkill={() => {
            setSelectedSkill(undefined);
            promptRef.current?.focus();
          }}
          onRemovePlugin={() => {
            clearSelectedPlugin();
            promptRef.current?.focus();
          }}
        />}
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
        placeholder={selectedSkill || (selectedPlugin && !starter) ? "" : planning ? t("creator.planPlaceholder") : placeholder}
        textareaRef={promptRef}
        onSelectionChange={setMentionCursor}
        value={prompt}
        variant="home"
        onDropFiles={creating ? undefined : addFiles}
        onDropError={(cause) => setError(cause.message)}
      />
      {error ? <p className="home-notice" role="alert">{error}</p> : null}
      <div className="home-ideas">
        {ideas.map((key) => (
          <button key={key} type="button" className="home-idea" disabled={creating} onClick={() => {
            changePrompt(t(key));
            focusAt(t(key).length);
          }}>{t(key)}</button>
        ))}
      </div>
    </>
  );
}

function loadType(): string {
  try { return localStorage.getItem(TYPE_KEY) ?? DEFAULT_TYPE; } catch { return DEFAULT_TYPE; }
}

/** Starters that work in a type; a plugin's own type takes only those that name no types. */
function fitsType(plugin: Plugin, type: string): boolean {
  if (!plugin.projectTypes?.length) return true;
  return isAppProjectType(type) && plugin.projectTypes.includes(type);
}

/** The starter made for a type, else one that names it; a type none names starts with no plugin. */
function defaultStarter(starters: readonly Plugin[], type: string): Plugin | undefined {
  return starters.find((plugin) => plugin.projectTypes?.[0] === type)
    ?? starters.find((plugin) => isAppProjectType(type) && plugin.projectTypes?.includes(type));
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
