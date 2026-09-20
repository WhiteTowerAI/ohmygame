import { Check, ChevronDown, LoaderCircle, Monitor, SendArrow } from "./icons.js";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { AgentModel, AgentModelRef, AgentReasoningLevel, ConversationCapabilities, PluginMention, ProjectType, PromptImage, PromptMode } from "../shared/contracts.js";
import { clampReasoningLevel } from "../shared/reasoning.js";
import { preferredAgentModel } from "../shared/agent-models.js";
import { createConversation, createProject, getHomeComposerCapabilities, updateAgentDefaults, waitForRuntime } from "./api.js";
import { ImageAttachmentStrip, ImagePickerButton, promptImages, type ComposerImage } from "./image-attachments.js";
import { ModelSelector, useAgentModels } from "./model-selector.js";
import { matchesPlanCommand, PlanCommandMenu, PlanModeIndicator } from "./plan-mode-control.js";
import { PromptBox } from "./prompt-box.js";
import { PROJECT_TYPES, ProjectTypeIcon } from "./project-types.js";
import { ComposerMentionMenu } from "./composer-mention-menu.js";
import { activePluginMentions, formatComposerInvocation, formatSkillInvocation, insertMention, matchingMentions, mentionQuery, toPluginMention, type ComposerMention } from "./composer-mentions.js";
import { ComposerCapabilityReferences } from "./composer-capability-references.js";
import { STORY_FORMAT_PRESETS, storyFormatPreset, type StoryFormatPresetId } from "../shared/story-formats.js";

const EMPTY_CAPABILITIES: ConversationCapabilities = { plugins: [], skills: [] };

export function ProjectPromptCreator({ projectType, placeholder, onProjectTypeChange, onCreate }: {
  projectType: ProjectType;
  placeholder: string;
  onProjectTypeChange?: (type: ProjectType) => void;
  onCreate: (projectId: string, conversationId: string, prompt: string, mentions: PluginMention[], images: PromptImage[], mode: PromptMode) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [selectedSkill, setSelectedSkill] = useState<string>();
  const [selectedPlugin, setSelectedPlugin] = useState<PluginMention>();
  const [pluginMentions, setPluginMentions] = useState<PluginMention[]>([]);
  const [capabilities, setCapabilities] = useState(EMPTY_CAPABILITIES);
  const [mentionCursor, setMentionCursor] = useState(0);
  const [selectedMention, setSelectedMention] = useState(0);
  const [dismissedMention, setDismissedMention] = useState<string>();
  const [planning, setPlanning] = useState(false);
  const [images, setImages] = useState<ComposerImage[]>([]);
  const [creating, setCreating] = useState(false);
  const [savingDefaults, setSavingDefaults] = useState(false);
  const [error, setError] = useState<string>();
  const [model, setModel] = useState<AgentModelRef>();
  const [reasoningLevel, setReasoningLevel] = useState<AgentReasoningLevel>();
  const [storyFormat, setStoryFormat] = useState<StoryFormatPresetId>("landscape");
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const modelCatalog = useAgentModels();
  const selectedModel = preferredAgentModel(modelCatalog.models, model, modelCatalog.defaultModel);
  const candidateMention = mentionQuery(prompt, mentionCursor);
  const mentionKey = candidateMention ? `${candidateMention.start}:${candidateMention.trigger}:${candidateMention.query}` : undefined;
  const activeMention = mentionKey === dismissedMention ? undefined : candidateMention;
  const mentions = activeMention ? matchingMentions(
    planning ? { plugins: capabilities.plugins, skills: [] } : capabilities,
    activeMention,
  ) : [];

  useEffect(() => {
    let disposed = false;
    void waitForRuntime()
      .then(() => getHomeComposerCapabilities())
      .then((result) => { if (!disposed) setCapabilities(result); })
      .catch((cause) => { if (!disposed) setError(errorMessage(cause)); });
    return () => { disposed = true; };
  }, []);

  useEffect(() => setSelectedMention(0), [activeMention?.trigger, activeMention?.query]);
  useEffect(() => {
    if (!mentionKey) setDismissedMention(undefined);
  }, [mentionKey]);

  useEffect(() => {
    if (!selectedModel) return;
    const next = clampReasoningLevel(reasoningLevel ?? modelCatalog.defaultReasoningLevel, selectedModel.reasoningLevels);
    if (next && next !== reasoningLevel) setReasoningLevel(next);
  }, [selectedModel, modelCatalog.defaultReasoningLevel, reasoningLevel]);

  async function submit(): Promise<void> {
    if (matchesPlanCommand(prompt)) {
      togglePlanning();
      return;
    }
    const nextPrompt = formatComposerInvocation(selectedSkill, selectedPlugin, prompt.trim());
    if ((!nextPrompt && images.length === 0) || creating) return;
    setCreating(true);
    setError(undefined);
    try {
      const project = await createProject({
        type: projectType,
        ...(projectType === "interactive-drama"
          ? { storyViewport: storyFormatPreset(storyFormat).viewport }
          : {}),
      });
      const conversation = await createConversation(project.id);
      onCreate(
        project.id,
        conversation.id,
        nextPrompt,
        activePluginMentions(nextPrompt, pluginMentions),
        promptImages(images),
        planning ? "planning" : "normal",
      );
    } catch (cause) {
      setError(errorMessage(cause));
      setCreating(false);
    }
  }

  async function saveDefaults(nextModel: AgentModelRef, nextReasoningLevel: AgentReasoningLevel): Promise<void> {
    if (savingDefaults) return;
    const modelRef = { provider: nextModel.provider, id: nextModel.id };
    setSavingDefaults(true);
    setError(undefined);
    try {
      await updateAgentDefaults({ model: modelRef, reasoningLevel: nextReasoningLevel });
      setModel(modelRef);
      setReasoningLevel(nextReasoningLevel);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSavingDefaults(false);
    }
  }

  function changeModel(nextModel: AgentModel): void {
    const nextReasoningLevel = clampReasoningLevel(reasoningLevel ?? modelCatalog.defaultReasoningLevel, nextModel.reasoningLevels);
    void saveDefaults(nextModel, nextReasoningLevel);
  }

  function togglePlanning(): void {
    setPlanning((value) => !value);
    setPrompt("");
    setSelectedSkill(undefined);
    setSelectedPlugin(undefined);
    setPluginMentions([]);
    setMentionCursor(0);
    promptRef.current?.focus();
  }

  function changePrompt(value: string): void {
    setPrompt(value);
    setPluginMentions((current) => activePluginMentions(formatComposerInvocation(selectedSkill, selectedPlugin, value), current));
  }

  function clearSelectedPlugin(): void {
    setSelectedPlugin(undefined);
    setPluginMentions((current) => activePluginMentions(formatSkillInvocation(selectedSkill, prompt), current));
  }

  function selectMention(mention: ComposerMention): void {
    if (!activeMention) return;
    if (mention.type === "skill") {
      const suffix = prompt.slice(activeMention.end).replace(/^\s+/, "");
      setPrompt(`${prompt.slice(0, activeMention.start)}${suffix}`);
      setSelectedSkill(mention.value.name);
      setMentionCursor(activeMention.start);
      setSelectedMention(0);
      focusAt(activeMention.start);
      return;
    }
    const selected = toPluginMention(mention.value);
    if (activeMention.start === 0 && !selectedPlugin) {
      const nextPrompt = prompt.slice(activeMention.end).replace(/^\s+/, "");
      const candidates = [
        ...pluginMentions.filter((item) => item.name !== selected.name || item.marketplaceId !== selected.marketplaceId),
        selected,
      ];
      setPrompt(nextPrompt);
      setSelectedPlugin(selected);
      setPluginMentions(activePluginMentions(formatComposerInvocation(selectedSkill, selected, nextPrompt), candidates));
      setMentionCursor(0);
      setSelectedMention(0);
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
    setSelectedMention(0);
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
    if (!mentions.length) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const offset = event.key === "ArrowDown" ? 1 : -1;
      setSelectedMention((current) => (current + offset + mentions.length) % mentions.length);
      return true;
    }
    if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
      event.preventDefault();
      selectMention(mentions[selectedMention] ?? mentions[0]);
      return true;
    }
    if (event.key !== "Escape") return false;
    event.preventDefault();
    setDismissedMention(mentionKey);
    return true;
  }

  return (
    <>
      <PromptBox
        actions={(
          <>
            <ModelSelector
              models={modelCatalog.models}
              status={modelCatalog.status}
              value={selectedModel}
              reasoningLevel={reasoningLevel}
              disabled={creating || savingDefaults}
              onChange={changeModel}
              onReasoningChange={(next) => { if (selectedModel) void saveDefaults(selectedModel, next); }}
            />
            <button
              className="icon-button send-button"
              type="submit"
              disabled={(!selectedSkill && !selectedPlugin && !prompt.trim() && images.length === 0) || creating}
              title="Create project"
              aria-label="Create project"
            >
              {creating ? <LoaderCircle className="spin" size={15} /> : <SendArrow size={15} />}
            </button>
          </>
        )}
        content={<ImageAttachmentStrip images={images} onRemove={(id) => setImages((items) => items.filter((image) => image.id !== id))} />}
        disabled={creating}
        prefix={<ComposerCapabilityReferences
          skill={selectedSkill}
          plugin={selectedPlugin}
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
            <ImagePickerButton disabled={creating} onImages={(next) => { setError(undefined); setImages((items) => [...items, ...next]); }} onError={setError} />
            {onProjectTypeChange ? <ProjectTypeSelector disabled={creating} value={projectType} onChange={onProjectTypeChange} /> : null}
            {projectType === "interactive-drama" ? <StoryFormatSelector disabled={creating} value={storyFormat} onChange={setStoryFormat} /> : null}
            {planning ? <PlanModeIndicator disabled={creating} onExit={togglePlanning} /> : null}
          </>
        )}
        onChange={changePrompt}
        onCommandKeyDown={handleCommandKeyDown}
        onSubmit={() => void submit()}
        overlay={mentions.length
          ? <ComposerMentionMenu items={mentions} selected={selectedMention} onSelect={selectMention} />
          : matchesPlanCommand(prompt) ? <PlanCommandMenu planning={planning} onToggle={togglePlanning} /> : null}
        placeholder={selectedSkill || selectedPlugin ? "" : planning ? "Describe what to plan" : placeholder}
        textareaRef={promptRef}
        onSelectionChange={setMentionCursor}
        value={prompt}
        variant="home"
      />
      {error ? <p className="home-notice" role="alert">{error}</p> : null}
    </>
  );
}

function StoryFormatSelector({
  value,
  disabled,
  onChange,
}: {
  value: StoryFormatPresetId;
  disabled?: boolean;
  onChange: (value: StoryFormatPresetId) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const current = storyFormatPreset(value);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  }, [open]);

  return (
    <div className="home-project-type-selector" ref={root}>
      <button
        ref={trigger}
        className="home-project-type-trigger"
        type="button"
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={disabled}
        onClick={() => setOpen((currentOpen) => !currentOpen)}
      >
        <Monitor size={14} />
        <span>{current.ratio}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>
      {open ? (
        <div
          ref={menu}
          className="home-project-type-menu home-story-format-menu"
          id={menuId}
          role="menu"
          aria-label="Canvas format"
          onKeyDown={(event) => {
            if (event.key === "Tab") {
              setOpen(false);
              return;
            }
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
            const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
            const nextIndex = event.key === "Home"
              ? 0
              : event.key === "End"
                ? items.length - 1
                : (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
            items[nextIndex]?.focus();
          }}
        >
          {STORY_FORMAT_PRESETS.map((preset) => {
            const selected = preset.id === value;
            return (
              <button
                className={selected ? "is-active" : undefined}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                key={preset.id}
                onClick={() => {
                  onChange(preset.id);
                  setOpen(false);
                  trigger.current?.focus();
                }}
              >
                <span
                  className={`story-format-frame story-format-frame-${preset.id}`}
                  aria-hidden="true"
                />
                <span>{preset.label}</span>
                <small>{preset.ratio}</small>
                {selected ? <Check size={13} aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function ProjectTypeSelector({ value, disabled, onChange }: {
  value: ProjectType;
  disabled?: boolean;
  onChange: (value: ProjectType) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const menuId = useId();
  const current = PROJECT_TYPES.find((option) => option.value === value)!;

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      trigger.current?.focus();
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  useEffect(() => {
    if (disabled) setOpen(false);
  }, [disabled]);

  useEffect(() => {
    if (open) menu.current?.querySelector<HTMLButtonElement>('[aria-checked="true"]')?.focus();
  }, [open]);

  return (
    <div className="home-project-type-selector" ref={root}>
      <button
        ref={trigger}
        className="home-project-type-trigger"
        type="button"
        aria-controls={menuId}
        aria-expanded={open}
        aria-haspopup="menu"
        disabled={disabled}
        onClick={() => setOpen((currentOpen) => !currentOpen)}
      >
        <ProjectTypeIcon type={current.value} />
        <span>{current.label}</span>
        <ChevronDown size={12} aria-hidden="true" />
      </button>

      {open ? (
        <div
          ref={menu}
          className="home-project-type-menu"
          id={menuId}
          role="menu"
          aria-label="Project type"
          onKeyDown={(event) => {
            if (event.key === "Tab") {
              setOpen(false);
              return;
            }
            if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitemradio"]')];
            const currentIndex = items.indexOf(document.activeElement as HTMLButtonElement);
            const nextIndex = event.key === "Home"
              ? 0
              : event.key === "End"
                ? items.length - 1
                : (currentIndex + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length;
            items[nextIndex]?.focus();
          }}
        >
          {PROJECT_TYPES.map((option) => {
            const selected = option.value === value;
            return (
              <button
                className={selected ? "is-active" : undefined}
                type="button"
                role="menuitemradio"
                aria-checked={selected}
                key={option.value}
                onClick={() => {
                  onChange(option.value);
                  setOpen(false);
                  trigger.current?.focus();
                }}
              >
                <ProjectTypeIcon type={option.value} />
                <span>{option.label}</span>
                {selected ? <Check size={13} aria-hidden="true" /> : null}
              </button>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
