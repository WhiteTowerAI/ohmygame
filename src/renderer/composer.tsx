import { FileText, SendArrow, Square, X } from "./icons.js";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { AgentModel, AgentModelRef, AgentReasoningLevel, ConversationCapabilities, PendingPrompt, PlanMode, PlanState, PluginMention, PromptAttachment, PromptContext, PromptImage, PromptMode, PromptReference } from "../shared/contracts.js";
import { AttachmentPickerButton, AttachmentStrip, appendAttachments, attachmentFiles, uploadAttachments, type ComposerAttachment } from "./composer-attachments.js";
import { ModelSelector, type AgentModelCatalogStatus } from "./model-selector.js";
import { MessageQueue } from "./message-queue.js";
import { PromptBox, type DroppedFile } from "./prompt-box.js";
import { PlanStatus } from "./plan-status.js";
import { compactInstructions, matchesCompactCommand, matchesPlanCommand, PlanCommandMenu, PlanModeIndicator } from "./plan-mode-control.js";
import { createPromptHistory, nextPrompt, previousPrompt, recordPrompt } from "./prompt-history.js";
import { PromptContextIcon, type ChatContextChip, type ChatReference } from "./chat-reference.js";
import { ComposerMentionMenu } from "./composer-mention-menu.js";
import { activePluginMentions, extractLeadingPluginMention, formatComposerInvocation, formatSkillInvocation, insertMention, matchingMentions, mentionQuery, parseSkillInvocation, toPluginMention, type ComposerMention } from "./composer-mentions.js";
import { ComposerCapabilityReferences } from "./composer-capability-references.js";
import { getCanvasDocument } from "./canvas-api.js";
import { canvasDocumentPath } from "../shared/canvas-document.js";

interface ComposerProps {
  projectId?: string;
  supportsDesign?: boolean;
  conversationReady: boolean;
  running: boolean;
  stopping: boolean;
  pendingPrompts: PendingPrompt[];
  plan?: PlanState;
  planMode: PlanMode;
  notice?: string;
  models: AgentModel[];
  modelStatus: AgentModelCatalogStatus;
  model?: AgentModelRef;
  reasoningLevel?: AgentReasoningLevel;
  modelChanging: boolean;
  promptHistory: Array<{ prompt: string; mentions: PluginMention[] }>;
  capabilities: ConversationCapabilities;
  initialDraft?: ComposerDraft;
  onInitialDraftHandled?: () => void;
  onSubmit: (prompt: string, mentions: PluginMention[], images: PromptImage[], mode: PromptMode, attachments: PromptAttachment[], references: PromptReference[], contexts: PromptContext[]) => Promise<boolean>;
  onCompact: (instructions?: string) => Promise<void>;
  onContextUsage: () => Promise<number | undefined>;
  onCancelPlan: () => Promise<boolean>;
  onModelChange: (model: AgentModel) => void;
  onReasoningChange: (level: AgentReasoningLevel) => void;
  onStop: () => void;
  onRemovePending: (turnId: string) => Promise<boolean>;
  onSteerPending: (turnId: string) => Promise<boolean>;
  onEditPending: (item: PendingPrompt) => Promise<boolean>;
  reference?: ChatReference;
  onClearReference?: () => void;
  /** Editor context the next message carries, such as the open Node. */
  contexts?: ChatContextChip[];
  onRemoveContext?: (key: string) => void;
  onDirtyChange?: (dirty: boolean) => void;
  /** Text an editor asks to put in the prompt, such as "Ask AI to create it"; a new `id` inserts it again. */
  promptRequest?: { text: string; id: number };
}

export interface ComposerDraft {
  prompt: string;
  mentions: PluginMention[];
}

interface DesignDocumentReference {
  references: PromptReference[];
  context: PromptContext;
}

export function Composer({
  projectId,
  supportsDesign = false,
  conversationReady,
  running,
  stopping,
  pendingPrompts,
  plan,
  planMode,
  notice,
  models,
  modelStatus,
  model,
  reasoningLevel,
  modelChanging,
  promptHistory,
  capabilities,
  initialDraft,
  onInitialDraftHandled,
  onSubmit,
  onCompact,
  onContextUsage,
  onCancelPlan,
  onModelChange,
  onReasoningChange,
  onStop,
  onRemovePending,
  onSteerPending,
  onEditPending,
  reference,
  onClearReference,
  contexts = [],
  onRemoveContext,
  onDirtyChange,
  promptRequest,
}: ComposerProps) {
  const initialSkill = parseSkillInvocation(initialDraft?.prompt ?? "");
  const initialPlugin = extractLeadingPluginMention(initialSkill?.prompt ?? initialDraft?.prompt ?? "", initialDraft?.mentions ?? []);
  const [prompt, setPrompt] = useState(initialPlugin.prompt);
  const [selectedSkill, setSelectedSkill] = useState(initialSkill?.name);
  const [selectedPlugin, setSelectedPlugin] = useState(initialPlugin.mention);
  const [pluginMentions, setPluginMentions] = useState<PluginMention[]>(initialDraft?.mentions ?? []);
  const [attachments, setAttachments] = useState<ComposerAttachment[]>([]);
  const [designReference, setDesignReference] = useState<DesignDocumentReference>();
  const [referencingDesign, setReferencingDesign] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [history, setHistory] = useState(() => createPromptHistory(promptHistory.map((entry) => entry.prompt)));
  const [mentionHistory, setMentionHistory] = useState(() => new Map(promptHistory.map((entry) => [entry.prompt, entry.mentions])));
  const [planning, setPlanning] = useState(planMode === "planning");
  const [selectedCommand, setSelectedCommand] = useState<"plan" | "compact">("plan");
  const [contextPercent, setContextPercent] = useState<number>();
  const [mentionCursor, setMentionCursor] = useState(0);
  const [selectedMention, setSelectedMention] = useState(0);
  const [dismissedMention, setDismissedMention] = useState<string>();
  const textarea = useRef<HTMLTextAreaElement>(null);
  const candidateMention = mentionQuery(prompt, mentionCursor);
  const mentionKey = candidateMention ? `${candidateMention.start}:${candidateMention.trigger}:${candidateMention.query}` : undefined;
  const activeMention = mentionKey === dismissedMention ? undefined : candidateMention;
  const mentions = activeMention ? matchingMentions(
    planning ? { plugins: capabilities.plugins, skills: [] } : capabilities,
    activeMention,
  ) : [];
  const dirty = Boolean(prompt || selectedSkill || selectedPlugin || attachments.length || reference || designReference);

  useEffect(() => setSelectedMention(0), [activeMention?.trigger, activeMention?.query]);
  useEffect(() => {
    onDirtyChange?.(dirty);
    return () => onDirtyChange?.(false);
  }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!initialDraft) return;
    const cursor = initialPlugin.prompt.length;
    setMentionCursor(cursor);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(cursor, cursor);
    });
    onInitialDraftHandled?.();
  }, []);
  useEffect(() => {
    if (!promptRequest) return;
    const next = prompt.trim() ? `${prompt.trimEnd()}\n${promptRequest.text}` : promptRequest.text;
    setPrompt(next);
    setMentionCursor(next.length);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(next.length, next.length);
    });
  }, [promptRequest?.id]);
  useEffect(() => {
    if (!mentionKey) setDismissedMention(undefined);
  }, [mentionKey]);

  async function submit() {
    const value = formatComposerPrompt(selectedSkill, selectedPlugin, prompt.trim());
    if (!conversationReady || (!value && attachments.length === 0) || stopping || submitting || !projectId) return;
    setAttachmentError(undefined);
    setSubmitting(true);
    try {
      const batchId = crypto.randomUUID();
      let uploaded: PromptAttachment[];
      try {
        uploaded = await uploadAttachments(projectId, batchId, attachments);
      } catch (error) {
        setAttachmentError(error instanceof Error ? error.message : String(error));
        return;
      }
      const submitted = await onSubmit(
        value,
        activePluginMentions(value, pluginMentions),
        [],
        planning ? "planning" : "normal",
        uploaded,
        designReference?.references ?? [],
        designReference ? [designReference.context] : [],
      );
      if (submitted) {
        setHistory((current) => recordPrompt(current, value));
        setMentionHistory((current) => new Map(current).set(value, activePluginMentions(value, pluginMentions)));
        setPrompt("");
        setSelectedSkill(undefined);
        setSelectedPlugin(undefined);
        setPluginMentions([]);
        setMentionCursor(0);
        setAttachments([]);
        setDesignReference(undefined);
        setAttachmentError(undefined);
        textarea.current?.focus();
      }
    } finally {
      setSubmitting(false);
    }
  }

  async function referenceDesign(): Promise<void> {
    if (!projectId || inputDisabled) return;
    setAttachmentError(undefined);
    setReferencingDesign(true);
    try {
      const result = await getCanvasDocument(projectId);
      if (!result) throw new Error("This project does not have a game design document yet");
      setDesignReference({
        references: [{ type: "workspace-file", path: canvasDocumentPath(result.document.id) }],
        context: {
          kind: "design-document",
          label: result.document.title || "Game design",
          text: "Reference the saved game design document for this message.",
        },
      });
      textarea.current?.focus();
    } catch (cause) {
      setAttachmentError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setReferencingDesign(false);
      requestAnimationFrame(() => textarea.current?.focus());
    }
  }

  function browseHistory(direction: "previous" | "next") {
    const result = direction === "previous" ? previousPrompt(history, formatComposerPrompt(selectedSkill, selectedPlugin, prompt)) : nextPrompt(history);
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
      textarea.current?.setSelectionRange(cursor, cursor);
    });
  }

  function changePrompt(value: string) {
    setPrompt(value);
    setPluginMentions((current) => activePluginMentions(formatComposerPrompt(selectedSkill, selectedPlugin, value), current));
    setHistory((current) => current.index === current.entries.length
      ? current
      : { ...current, index: current.entries.length, draft: formatComposerPrompt(selectedSkill, selectedPlugin, value) });
  }

  function clearSelectedPlugin(): void {
    setSelectedPlugin(undefined);
    setPluginMentions((current) => activePluginMentions(formatSkillInvocation(selectedSkill, prompt), current));
  }

  function addAttachments(next: ComposerAttachment[]): void {
    setAttachmentError(undefined);
    try { setAttachments(appendAttachments(attachments, next)); }
    catch (cause) { setAttachmentError(cause instanceof Error ? cause.message : String(cause)); return; }
    textarea.current?.focus();
  }

  function addFiles(files: DroppedFile[]): void {
    addAttachments(attachmentFiles(files));
  }

  function selectMention(mention: ComposerMention) {
    if (!activeMention) return;
    if (mention.type === "skill") {
      const suffix = prompt.slice(activeMention.end).replace(/^\s+/, "");
      setPrompt(`${prompt.slice(0, activeMention.start)}${suffix}`);
      setSelectedSkill(mention.value.name);
      setMentionCursor(activeMention.start);
      setSelectedMention(0);
      requestAnimationFrame(() => {
        textarea.current?.focus();
        textarea.current?.setSelectionRange(activeMention.start, activeMention.start);
      });
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
      setPluginMentions(activePluginMentions(formatComposerPrompt(selectedSkill, selected, nextPrompt), candidates));
      setMentionCursor(0);
      setSelectedMention(0);
      requestAnimationFrame(() => {
        textarea.current?.focus();
        textarea.current?.setSelectionRange(0, 0);
      });
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
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(inserted.cursor, inserted.cursor);
    });
  }

  const showStop = running && !selectedSkill && !prompt.trim() && attachments.length === 0;
  const awaitingApproval = planMode === "awaiting_approval";
  const canTogglePlanning = conversationReady && !running && !stopping && !awaitingApproval && planMode !== "executing";
  const showPlanCommand = !selectedSkill && !selectedPlugin && canTogglePlanning && matchesPlanCommand(prompt);
  const showCompactCommand = !selectedSkill && !selectedPlugin && conversationReady && !running && !stopping && matchesCompactCommand(prompt);
  const planInputLocked = awaitingApproval || planMode === "executing" || (planMode === "planning" && running);
  const textareaDisabled = !conversationReady || planInputLocked;
  // A disabled field drops focus to the page, where canvas shortcuts such as
  // Backspace (delete the selected Node) would take the next keystrokes.
  const textareaReadOnly = submitting || referencingDesign;
  const inputDisabled = textareaDisabled || textareaReadOnly;

  useEffect(() => {
    if (showPlanCommand) setSelectedCommand("plan");
    else if (showCompactCommand) setSelectedCommand("compact");
  }, [showPlanCommand, showCompactCommand]);

  useEffect(() => {
    if (!showCompactCommand) {
      setContextPercent(undefined);
      return;
    }
    let disposed = false;
    setContextPercent(undefined);
    void onContextUsage().then((percent) => {
      if (!disposed) setContextPercent(percent);
    }).catch(() => {
      if (!disposed) setContextPercent(undefined);
    });
    return () => { disposed = true; };
  }, [showCompactCommand]);

  useEffect(() => {
    if (planMode === "planning") setPlanning(true);
    else if (planMode !== "normal") setPlanning(false);
  }, [planMode]);

  async function togglePlanning() {
    if (planning && planMode === "planning" && !await onCancelPlan()) return;
    setPlanning((value) => !value);
    setPrompt("");
    setSelectedSkill(undefined);
    setSelectedPlugin(undefined);
    setPluginMentions([]);
    setMentionCursor(0);
    textarea.current?.focus();
  }

  function submitOrRunCommand() {
    const instructions = compactInstructions(prompt);
    if (showCompactCommand && instructions !== null && !running && !stopping) {
      void runCompact(instructions ?? undefined);
      return;
    }
    if (showPlanCommand) {
      void togglePlanning();
      return;
    }
    void submit();
  }

  async function runCompact(instructions?: string) {
    setPrompt("");
    setMentionCursor(0);
    textarea.current?.focus();
    await onCompact(instructions);
  }

  async function editPending(item: PendingPrompt): Promise<void> {
    if (inputDisabled || !(await onEditPending(item))) return;
    const skill = parseSkillInvocation(item.prompt);
    const plugin = extractLeadingPluginMention(skill?.prompt ?? item.prompt, item.mentions);
    const nextPrompt = plugin.prompt;
    setPrompt(nextPrompt);
    setSelectedSkill(skill?.name);
    setSelectedPlugin(plugin.mention);
    setPluginMentions(item.mentions);
    setAttachments([]);
    const referencedDesign = item.references.find((reference) => reference.type === "workspace-file" && /^canvas\/documents\/[a-zA-Z0-9_-]+\.md$/.test(reference.path));
    setDesignReference(referencedDesign ? {
      references: [referencedDesign],
      context: {
        kind: "design-document",
        label: "Game design",
        text: "The user explicitly referenced this saved design document.",
      },
    } : undefined);
    onClearReference?.();
    setMentionCursor(nextPrompt.length);
    setAttachmentError(undefined);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(nextPrompt.length, nextPrompt.length);
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
    if (mentions.length > 0) {
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
      if (event.key === "Escape") {
        event.preventDefault();
        setDismissedMention(mentionKey);
        return true;
      }
    }
    if (!showPlanCommand && !showCompactCommand) return false;
    const commands: Array<"plan" | "compact"> = [
      ...(showPlanCommand ? ["plan" as const] : []),
      ...(showCompactCommand ? ["compact" as const] : []),
    ];
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const current = Math.max(0, commands.indexOf(selectedCommand));
      const offset = event.key === "ArrowDown" ? 1 : -1;
      setSelectedCommand(commands[(current + offset + commands.length) % commands.length]);
      return true;
    }
    if (event.key !== "Enter" || event.shiftKey) return false;
    event.preventDefault();
    if (selectedCommand === "compact" && showCompactCommand) {
      const instructions = compactInstructions(prompt);
      void runCompact(instructions ?? undefined);
    } else if (showPlanCommand) {
      void togglePlanning();
    }
    return true;
  }

  return (
    <div className="composer">
      <PlanStatus
        plan={awaitingApproval ? undefined : plan}
      />
      <MessageQueue
        items={pendingPrompts}
        disabled={!running || stopping}
        onRemove={(turnId) => { void onRemovePending(turnId); }}
        onSteer={(turnId) => { void onSteerPending(turnId); }}
        onEdit={(item) => { void editPending(item); }}
      />
      {notice || attachmentError ? <p className="composer-error" role="alert">{attachmentError ?? notice}</p> : null}
      <PromptBox
        actions={(
          <>
            <ModelSelector
              models={models}
              status={modelStatus}
              value={model}
              reasoningLevel={reasoningLevel}
              disabled={!conversationReady || running || stopping || modelChanging}
              onChange={onModelChange}
              onReasoningChange={onReasoningChange}
            />
            {showStop ? (
              <button className="icon-button stop-button" type="button" onClick={onStop} disabled={stopping} title="Stop agent" aria-label="Stop agent">
                <Square size={14} fill="currentColor" />
              </button>
            ) : (
              <button className="icon-button send-button" type="submit" disabled={inputDisabled || (!selectedSkill && !selectedPlugin && !prompt.trim() && attachments.length === 0) || stopping} title={running ? "Queue follow-up" : "Send prompt"} aria-label={running ? "Queue follow-up" : "Send prompt"}>
                <SendArrow size={15} />
              </button>
            )}
          </>
        )}
        content={<>
          {contexts.length ? <div className="composer-contexts" aria-label="Context for the next message">
            {contexts.map((context) => <div className={`composer-context is-${context.kind}`} key={context.key} title={context.detail ?? context.label}>
              <PromptContextIcon kind={context.kind} />
              <span>{context.label}</span>
              {context.detail ? <small>{context.detail}</small> : null}
              <button type="button" onClick={() => onRemoveContext?.(context.key)} aria-label={`Remove ${context.label} from the message`}><X size={11} /></button>
            </div>)}
          </div> : null}
          {reference ? <div className="composer-reference">
            <div className="composer-reference-label">Selected text</div>
            <div className="composer-reference-text">{reference.text}</div>
            <button type="button" className="composer-reference-remove" onClick={onClearReference} aria-label="Remove selected text">×</button>
          </div> : null}
          {designReference ? <div className="composer-contexts" aria-label="Referenced game design">
            <div className="composer-context is-design-document" title={designReference.context.label}>
              <FileText size={12} />
              <span>{designReference.context.label}</span>
              <small>Game design</small>
              <button type="button" onClick={() => setDesignReference(undefined)} aria-label="Remove game design reference"><X size={11} /></button>
            </div>
          </div> : null}
          <AttachmentStrip items={attachments} onRemove={(id) => setAttachments((items) => items.filter((attachment) => attachment.id !== id))} />
        </>}
        disabled={textareaDisabled}
        readOnly={textareaReadOnly}
        prefix={<ComposerCapabilityReferences
          skill={selectedSkill}
          plugin={selectedPlugin}
          onRemoveSkill={() => {
            setSelectedSkill(undefined);
            textarea.current?.focus();
          }}
          onRemovePlugin={() => {
            clearSelectedPlugin();
            textarea.current?.focus();
          }}
        />}
        leading={(
          <>
            <AttachmentPickerButton
              disabled={inputDisabled}
              onFiles={addAttachments}
              onDesignReference={supportsDesign ? () => { void referenceDesign(); } : undefined}
            />
            {planning ? (
              <PlanModeIndicator disabled={running || stopping} onExit={() => { void togglePlanning(); }} />
            ) : null}
          </>
        )}
        onChange={changePrompt}
        onCommandKeyDown={handleCommandKeyDown}
        onHistoryNext={() => browseHistory("next")}
        onHistoryPrevious={() => browseHistory("previous")}
        onDropFiles={inputDisabled ? undefined : addFiles}
        onDropError={(error) => setAttachmentError(`Could not read dropped folder: ${error.message}`)}
        onSubmit={submitOrRunCommand}
        overlay={mentions.length ? (
          <ComposerMentionMenu items={mentions} selected={selectedMention} onSelect={selectMention} />
        ) : showPlanCommand || showCompactCommand ? (
          <PlanCommandMenu
            planning={planning}
            onToggle={() => { void togglePlanning(); }}
            showPlan={showPlanCommand}
            showCompact={showCompactCommand}
            selected={selectedCommand}
            contextPercent={contextPercent}
            onCompact={() => {
              const instructions = compactInstructions(prompt);
              void runCompact(instructions ?? undefined);
            }}
          />
        ) : null}
        placeholder={selectedSkill || selectedPlugin ? "" : awaitingApproval ? "Review the plan above" : planMode === "executing" ? "Executing plan" : planning ? "Describe what to plan" : running ? "Add a follow-up" : "Ask for a change"}
        textareaRef={textarea}
        onSelectionChange={setMentionCursor}
        value={prompt}
        variant="project"
      />
    </div>
  );
}

function formatComposerPrompt(skill: string | undefined, plugin: PluginMention | undefined, prompt: string): string {
  return formatComposerInvocation(skill, plugin, prompt);
}
