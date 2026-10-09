import { FileText, SendArrow, Square, X } from "./icons.js";
import { useEffect, useRef, useState, useSyncExternalStore, type KeyboardEvent } from "react";
import type { AgentModel, AgentModelRef, AgentReasoningLevel, ConversationCapabilities, PendingPrompt, PlanMode, PlanState, PluginMention, PromptAttachment, PromptContext, PromptImage, PromptMode, PromptReference } from "../shared/contracts.js";
import { AttachmentStrip, appendAttachments, attachmentFiles, uploadAttachments, type ComposerAttachment } from "./composer-attachments.js";
import { ModelSelector, type AgentModelCatalogStatus } from "./model-selector.js";
import { MessageQueue } from "./message-queue.js";
import { PromptBox, type DroppedFile } from "./prompt-box.js";
import { PlanStatus } from "./plan-status.js";
import { compactInstructions, matchesCompactCommand, matchesPlanCommand, PlanCommandMenu, PlanModeIndicator } from "./plan-mode-control.js";
import { createPromptHistory, nextPrompt, previousPrompt, recordPrompt } from "./prompt-history.js";
import { formatChatPrompt, PromptContextIcon, type ChatContextChip } from "./chat-reference.js";
import { useComposerContextMenu } from "./composer-context-menu.js";
import { activePluginMentions, extractLeadingPluginMention, formatComposerInvocation, formatSkillInvocation, insertMention, parseSkillInvocation, toPluginMention, type ComposerMention, type ComposerMentionQuery } from "./composer-mentions.js";
import { ComposerCapabilityReferences } from "./composer-capability-references.js";
import { getCanvasDocument } from "./canvas-api.js";
import { canvasDocumentPath } from "../shared/canvas-document.js";
import { composerDrafts, type ComposerDraft } from "./composer-drafts.js";

export type { ComposerDraft } from "./composer-drafts.js";

interface ComposerProps {
  projectId?: string;
  conversationId?: string;
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
  /** Editor context the next message carries, such as the open Node. */
  contexts?: ChatContextChip[];
  onRemoveContext?: (key: string) => void;
}

export function Composer({
  projectId,
  conversationId,
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
  contexts = [],
  onRemoveContext,
}: ComposerProps) {
  const [draftSession] = useState(() => composerDrafts.get(
    projectId && conversationId ? { projectId, conversationId } : undefined,
    initialDraft,
    planMode === "planning",
  ));
  const draft = useSyncExternalStore(draftSession.subscribe, draftSession.getSnapshot, draftSession.getSnapshot);
  const { prompt, selectedSkill, selectedPlugin, mentions: pluginMentions, attachments, designReference, reference, planning, submitting } = draft;
  const updateDraft = draftSession.update;
  const [referencingDesign, setReferencingDesign] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string>();
  const [history, setHistory] = useState(() => createPromptHistory(promptHistory.map((entry) => entry.prompt)));
  const [mentionHistory, setMentionHistory] = useState(() => new Map(promptHistory.map((entry) => [entry.prompt, entry.mentions])));
  const [selectedCommand, setSelectedCommand] = useState<"plan" | "compact">("plan");
  const [contextPercent, setContextPercent] = useState<number>();
  const [mentionCursor, setMentionCursor] = useState(0);
  const textarea = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (!initialDraft) return;
    const cursor = prompt.length;
    setMentionCursor(cursor);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(cursor, cursor);
    });
    onInitialDraftHandled?.();
  }, []);

  async function submit() {
    const value = formatComposerPrompt(selectedSkill, selectedPlugin, prompt.trim());
    if (!conversationReady || (!value && attachments.length === 0) || stopping || draftSession.getSnapshot().submitting || !projectId) return;
    setAttachmentError(undefined);
    updateDraft({ submitting: true });
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
        reference ? formatChatPrompt(reference, value) : value,
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
        if (draftSession.clearSubmitted(draft)) setMentionCursor(0);
        setAttachmentError(undefined);
        textarea.current?.focus();
      }
    } finally {
      updateDraft({ submitting: false });
    }
  }

  async function referenceDesign(): Promise<void> {
    if (!projectId || inputDisabled) return;
    setAttachmentError(undefined);
    setReferencingDesign(true);
    try {
      const result = await getCanvasDocument(projectId);
      if (!result) throw new Error("This project does not have a game design document yet");
      updateDraft({ designReference: {
        references: [{ type: "workspace-file", path: canvasDocumentPath(result.document.id) }],
        context: {
          kind: "design-document",
          label: result.document.title || "Game design",
          text: "Reference the saved game design document for this message.",
        },
      } });
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
    updateDraft({ prompt: plugin.prompt, selectedSkill: skill?.name, selectedPlugin: plugin.mention, mentions: historicalMentions });
    const cursor = plugin.prompt.length;
    setMentionCursor(cursor);
    requestAnimationFrame(() => {
      textarea.current?.setSelectionRange(cursor, cursor);
    });
  }

  function changePrompt(value: string, mentions = pluginMentions) {
    updateDraft({ prompt: value, mentions: activePluginMentions(formatComposerPrompt(selectedSkill, selectedPlugin, value), mentions) });
    setHistory((current) => current.index === current.entries.length
      ? current
      : { ...current, index: current.entries.length, draft: formatComposerPrompt(selectedSkill, selectedPlugin, value) });
  }

  function clearSelectedPlugin(): void {
    updateDraft((current) => ({ selectedPlugin: undefined, mentions: activePluginMentions(formatSkillInvocation(selectedSkill, prompt), current.mentions) }));
  }

  function addAttachments(next: ComposerAttachment[]): void {
    setAttachmentError(undefined);
    try { updateDraft({ attachments: appendAttachments(attachments, next) }); }
    catch (cause) { setAttachmentError(cause instanceof Error ? cause.message : String(cause)); return; }
    textarea.current?.focus();
  }

  function addFiles(files: DroppedFile[]): void {
    addAttachments(attachmentFiles(files));
  }

  function selectMention(mention: ComposerMention, query?: ComposerMentionQuery) {
    const activeMention = query ?? { start: mentionCursor, end: mentionCursor, trigger: "@" as const, query: "" };
    if (mention.type === "skill") {
      const suffix = prompt.slice(activeMention.end).replace(/^\s+/, "");
      updateDraft({ selectedSkill: mention.value.name, ...(query ? { prompt: `${prompt.slice(0, activeMention.start)}${suffix}` } : {}) });
      setMentionCursor(activeMention.start);
      requestAnimationFrame(() => {
        textarea.current?.focus();
        textarea.current?.setSelectionRange(activeMention.start, activeMention.start);
      });
      return;
    }
    const selected = toPluginMention(mention.value);
    const candidates = [
      ...pluginMentions.filter((item) => item.name !== selected.name || item.marketplaceId !== selected.marketplaceId),
      selected,
    ];
    if ((!query || activeMention.start === 0) && !selectedPlugin) {
      const nextPrompt = query ? prompt.slice(activeMention.end).replace(/^\s+/, "") : prompt;
      updateDraft({ prompt: nextPrompt, selectedPlugin: selected, mentions: activePluginMentions(formatComposerPrompt(selectedSkill, selected, nextPrompt), candidates) });
      setMentionCursor(0);
      requestAnimationFrame(() => {
        textarea.current?.focus();
        textarea.current?.setSelectionRange(0, 0);
      });
      return;
    }
    const inserted = insertMention(prompt, activeMention, mention);
    changePrompt(inserted.value, candidates);
    setMentionCursor(inserted.cursor);
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
    const requestId = draft.focusRequestId;
    if (!requestId || inputDisabled) return;
    const frame = requestAnimationFrame(() => {
      const input = textarea.current;
      const current = draftSession.getSnapshot();
      if (!input || input.disabled || input.readOnly || current.focusRequestId !== requestId) return;
      const cursor = current.prompt.length;
      input.focus();
      input.setSelectionRange(cursor, cursor);
      setMentionCursor(cursor);
      updateDraft({ focusRequestId: undefined });
    });
    return () => cancelAnimationFrame(frame);
  }, [draft.focusRequestId, inputDisabled]);

  const contextMenu = useComposerContextMenu({
    prompt,
    cursor: mentionCursor,
    textarea,
    disabled: inputDisabled,
    capabilities,
    planning,
    canTogglePlanning,
    onFiles: addAttachments,
    onDesignReference: supportsDesign ? () => { void referenceDesign(); } : undefined,
    onTogglePlanning: () => { void togglePlanning(false); },
    onMention: selectMention,
    onChange: changePrompt,
    onSelectionChange: setMentionCursor,
  });

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
    if (planMode === "planning") updateDraft({ planning: true });
    else if (planMode !== "normal") updateDraft({ planning: false });
  }, [planMode]);

  async function togglePlanning(clearDraft = true) {
    if (planning && planMode === "planning" && !await onCancelPlan()) return;
    updateDraft((current) => ({
      planning: !current.planning,
      selectedSkill: clearDraft || !current.planning ? undefined : current.selectedSkill,
      ...(clearDraft ? { prompt: "", selectedPlugin: undefined, mentions: [] } : {}),
    }));
    if (clearDraft) setMentionCursor(0);
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
    updateDraft({ prompt: "" });
    setMentionCursor(0);
    textarea.current?.focus();
    await onCompact(instructions);
  }

  async function editPending(item: PendingPrompt): Promise<void> {
    if (inputDisabled || !(await onEditPending(item))) return;
    const skill = parseSkillInvocation(item.prompt);
    const plugin = extractLeadingPluginMention(skill?.prompt ?? item.prompt, item.mentions);
    const nextPrompt = plugin.prompt;
    const referencedDesign = item.references.find((reference) => reference.type === "workspace-file" && /^canvas\/documents\/[a-zA-Z0-9_-]+\.md$/.test(reference.path));
    updateDraft({ prompt: nextPrompt, selectedSkill: skill?.name, selectedPlugin: plugin.mention, mentions: item.mentions,
      attachments: [], reference: undefined, designReference: referencedDesign ? {
      references: [referencedDesign],
      context: {
        kind: "design-document",
        label: "Game design",
        text: "The user explicitly referenced this saved design document.",
      },
    } : undefined });
    setMentionCursor(nextPrompt.length);
    setAttachmentError(undefined);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(nextPrompt.length, nextPrompt.length);
    });
  }

  function handleCommandKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    setMentionCursor(event.currentTarget.selectionStart);
    if (contextMenu.handleKeyDown(event)) return true;
    if (selectedSkill && event.key === "Backspace" && event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0) {
      event.preventDefault();
      updateDraft({ selectedSkill: undefined });
      return true;
    }
    if (selectedPlugin && event.key === "Backspace" && event.currentTarget.selectionStart === 0 && event.currentTarget.selectionEnd === 0) {
      event.preventDefault();
      clearSelectedPlugin();
      return true;
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
            <button type="button" className="composer-reference-remove" onClick={() => updateDraft({ reference: undefined })} aria-label="Remove selected text">×</button>
          </div> : null}
          {designReference ? <div className="composer-contexts" aria-label="Referenced game design">
            <div className="composer-context is-design-document" title={designReference.context.label}>
              <FileText size={12} />
              <span>{designReference.context.label}</span>
              <small>Game design</small>
              <button type="button" onClick={() => updateDraft({ designReference: undefined })} aria-label="Remove game design reference"><X size={11} /></button>
            </div>
          </div> : null}
          <AttachmentStrip items={attachments} onRemove={(id) => updateDraft((current) => ({ attachments: current.attachments.filter((attachment) => attachment.id !== id) }))} />
        </>}
        disabled={textareaDisabled}
        readOnly={textareaReadOnly}
        prefix={<ComposerCapabilityReferences
          skill={selectedSkill}
          plugin={selectedPlugin}
          onRemoveSkill={() => {
            updateDraft({ selectedSkill: undefined });
            textarea.current?.focus();
          }}
          onRemovePlugin={() => {
            clearSelectedPlugin();
            textarea.current?.focus();
          }}
        />}
        leading={(
          <>
            {contextMenu.button}
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
        suggestions={contextMenu.suggestions}
        overlay={contextMenu.open ? contextMenu.overlay : showPlanCommand || showCompactCommand ? (
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
