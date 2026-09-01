import { ArrowUp, Check, ChevronDown, LoaderCircle } from "./icons.js";
import { useEffect, useId, useRef, useState } from "react";
import type { AgentModel, AgentModelRef, AgentReasoningLevel, ProjectType, PromptImage, PromptMode } from "../shared/contracts.js";
import { clampReasoningLevel } from "../shared/reasoning.js";
import { createConversation, createProject } from "./api.js";
import { ImageAttachmentStrip, ImagePickerButton, promptImages, type ComposerImage } from "./image-attachments.js";
import { ModelSelector, useAgentModels } from "./model-selector.js";
import { matchesPlanCommand, PlanCommandMenu, PlanModeIndicator } from "./plan-mode-control.js";
import { PromptBox } from "./prompt-box.js";
import { PROJECT_TYPES, ProjectTypeIcon } from "./project-types.js";

export function ProjectPromptCreator({ projectType, placeholder, onProjectTypeChange, onCreate }: {
  projectType: ProjectType;
  placeholder: string;
  onProjectTypeChange?: (type: ProjectType) => void;
  onCreate: (projectId: string, conversationId: string, prompt: string, images: PromptImage[], mode: PromptMode) => void;
}) {
  const [prompt, setPrompt] = useState("");
  const [planning, setPlanning] = useState(false);
  const [images, setImages] = useState<ComposerImage[]>([]);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  const [model, setModel] = useState<AgentModelRef>();
  const [reasoningLevel, setReasoningLevel] = useState<AgentReasoningLevel>();
  const promptRef = useRef<HTMLTextAreaElement>(null);
  const modelCatalog = useAgentModels();

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
    const nextPrompt = prompt.trim();
    if ((!nextPrompt && images.length === 0) || creating) return;
    setCreating(true);
    setError(undefined);
    try {
      const project = await createProject({ type: projectType });
      const conversation = await createConversation(project.id, model, reasoningLevel);
      onCreate(project.id, conversation.id, nextPrompt, promptImages(images), planning ? "planning" : "normal");
    } catch (cause) {
      setError(errorMessage(cause));
      setCreating(false);
    }
  }

  function togglePlanning(): void {
    setPlanning((value) => !value);
    setPrompt("");
    promptRef.current?.focus();
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
              disabled={(!prompt.trim() && images.length === 0) || creating}
              title="Create project"
              aria-label="Create project"
            >
              {creating ? <LoaderCircle className="spin" size={16} /> : <ArrowUp size={17} />}
            </button>
          </>
        )}
        content={<ImageAttachmentStrip images={images} onRemove={(id) => setImages((items) => items.filter((image) => image.id !== id))} />}
        disabled={creating}
        leading={(
          <>
            <ImagePickerButton disabled={creating} onImages={(next) => { setError(undefined); setImages((items) => [...items, ...next]); }} onError={setError} />
            {onProjectTypeChange ? <ProjectTypeSelector disabled={creating} value={projectType} onChange={onProjectTypeChange} /> : null}
            {planning ? <PlanModeIndicator disabled={creating} onExit={togglePlanning} /> : null}
          </>
        )}
        onChange={setPrompt}
        onSubmit={() => void submit()}
        overlay={matchesPlanCommand(prompt) ? <PlanCommandMenu planning={planning} onToggle={togglePlanning} /> : null}
        placeholder={planning ? "Describe what to plan" : placeholder}
        textareaRef={promptRef}
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
