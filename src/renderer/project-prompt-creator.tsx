import { ArrowUp, Check, ChevronDown, LoaderCircle } from "./icons.js";
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { AgentModel, AgentModelRef, AgentReasoningLevel, ConversationCapabilities, PluginMention, ProjectType, PromptImage, PromptMode } from "../shared/contracts.js";
import { clampReasoningLevel } from "../shared/reasoning.js";
import { createConversation, createProject, getHomeComposerCapabilities, waitForRuntime } from "./api.js";
import { ImageAttachmentStrip, ImagePickerButton, promptImages, type ComposerImage } from "./image-attachments.js";
import { ModelSelector, useAgentModels } from "./model-selector.js";
import { matchesPlanCommand, PlanCommandMenu, PlanModeIndicator } from "./plan-mode-control.js";
import { PromptBox } from "./prompt-box.js";
import { PROJECT_TYPES, ProjectTypeIcon } from "./project-types.js";
import { ComposerMentionMenu } from "./composer-mention-menu.js";
import { activePluginMentions, formatComposerInvocation, formatSkillInvocation, insertMention, matchingMentions, mentionQuery, toPluginMention, type ComposerMention } from "./composer-mentions.js";
import { ComposerCapabilityReferences } from "./composer-capability-references.js";

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
  const [error, setError] = useState<string>();
  const [model, setModel] = useState<AgentModelRef>();
  const [reasoningLevel, setReasoningLevel] = useState<AgentReasoningLevel>();
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const modelCatalog = useAgentModels();
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
    if (modelCatalog.models.some((candidate) => sameModel(candidate, model))) return;
    const fallback = modelCatalog.models.find((candidate) => sameModel(candidate, modelCatalog.defaultModel))
      ?? modelCatalog.models[0];
    if (!fallback || !sameModel(fallback, model)) setModel(fallback);
  }, [model, modelCatalog.models, modelCatalog.defaultModel]);

  useEffect(() => {
    const selected = modelCatalog.models.find((candidate) => sameModel(candidate, model));
    if (!selected) return;
    const next = clampReasoningLevel(reasoningLevel ?? modelCatalog.defaultReasoningLevel, selected.reasoningLevels);
    if (next && next !== reasoningLevel) setReasoningLevel(next);
  }, [model, modelCatalog.models, modelCatalog.defaultReasoningLevel, reasoningLevel]);

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
      const project = await createProject({ type: projectType });
      const conversation = await createConversation(project.id, model, reasoningLevel);
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
              value={model}
              reasoningLevel={reasoningLevel}
              disabled={creating}
              onChange={setModel}
              onReasoningChange={setReasoningLevel}
            />
            <button
              className="icon-button send-button"
              type="submit"
              disabled={(!selectedSkill && !selectedPlugin && !prompt.trim() && images.length === 0) || creating}
              title="Create project"
              aria-label="Create project"
            >
              {creating ? <LoaderCircle className="spin" size={16} /> : <ArrowUp size={17} />}
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

function sameModel(model: AgentModel, value?: AgentModelRef): boolean {
  return Boolean(value && model.provider === value.provider && model.id === value.id);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
