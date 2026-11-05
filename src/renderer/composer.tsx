import { DangerCircle, FileText, InfoCircle, X } from "./icons.js";
import { useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { AgentModel, AgentModelRef, AgentReasoningLevel, ConversationCapabilities, PendingPrompt, PlanMode, PlanState, PluginMention, PromptAttachment, PromptContext, PromptImage, PromptMode, PromptReference, ScheduledMessage } from "../shared/contracts.js";
import { AttachmentStrip, appendAttachments, attachmentFiles, uploadAttachments, type ComposerAttachment } from "./composer-attachments.js";
import type { AgentModelCatalogStatus } from "./model-selector.js";
import { MessageQueue, ScheduledMessages } from "./message-queue.js";
import { isLaterCommand, laterCommand, parseLaterCommand } from "./later-command.js";
import { PromptBox, type DroppedFile, type PromptInput, type PromptSelection } from "./prompt-box.js";
import { ComposerActions } from "./composer-actions.js";
import { PlanStatus } from "./plan-status.js";
import { compactInstructions, matchesCompactCommand, matchesPlanCommand, PlanModeIndicator } from "./plan-mode-control.js";
import { createPromptHistory, nextPrompt, previousPrompt, recordPrompt } from "./prompt-history.js";
import { formatChatPrompt, PromptContextIcon, type ChatContextChip } from "./chat-reference.js";
import { useComposerContextMenu, type ComposerPluginCommands } from "./composer-context-menu.js";
import type { ProjectPluginCommand } from "../shared/plugins.js";
import { activePluginMentions, formatPluginInvocation, formatSkillInvocation, insertMention, parseSkillInvocation, toPluginMention, type ComposerMention, type ComposerMentionQuery } from "./composer-mentions.js";
import { getCanvasDocument } from "./canvas-api.js";
import { canvasDocumentPath } from "../shared/canvas-document.js";
import { composerDrafts, type ComposerDraft } from "./composer-drafts.js";
import { t } from "./i18n.js";
import type { AgentContextUsage } from "../shared/contracts.js";
import { ComposerStatus } from "./composer-status.js";
import { isAgentRuntimeId } from "../shared/agent-runtimes.js";

export type { ComposerDraft } from "./composer-drafts.js";

interface ComposerProps {
  projectId?: string;
  conversationId?: string;
  supportsDesign?: boolean;
  conversationReady: boolean;
  running: boolean;
  stopping: boolean;
  pendingPrompts: PendingPrompt[];
  scheduledMessages: ScheduledMessage[];
  plan?: PlanState;
  planMode: PlanMode;
  notice?: string;
  /** Something to know that isn't a failure, such as a message put back in the box. */
  status?: string;
  /** The person began writing while a continue was armed, or changed the agent's setting from the notice. */
  /** This conversation will continue by itself after a usage limit, until the person starts writing. */
  limitResumeArmed?: boolean;
  onSkipLimitResume?: () => void;
  models: AgentModel[];
  modelStatus: AgentModelCatalogStatus;
  model?: AgentModelRef;
  reasoningLevel?: AgentReasoningLevel;
  nativeReasoningLevel?: string;
  accountProfileId?: string;
  modelChanging: boolean;
  promptHistory: Array<{ prompt: string; mentions: PluginMention[] }>;
  capabilities: ConversationCapabilities;
  initialDraft?: ComposerDraft;
  onInitialDraftHandled?: () => void;
  onSubmit: (prompt: string, mentions: PluginMention[], images: PromptImage[], mode: PromptMode, attachments: PromptAttachment[], references: PromptReference[], contexts: PromptContext[]) => Promise<boolean>;
  onCompact: (instructions?: string) => Promise<void>;
  /** `passive` reads what is known without loading the agent's session. */
  onContextUsage: (passive?: boolean) => Promise<AgentContextUsage | undefined>;
  onCancelPlan: () => Promise<boolean>;
  onModelChange: (model: AgentModel) => void;
  onReasoningChange: (level: AgentReasoningLevel) => void;
  onNativeReasoningChange?: (level: string) => void;
  onStop: () => void;
  onRemovePending: (turnId: string) => Promise<boolean>;
  onSteerPending: (turnId: string) => Promise<boolean>;
  onEditPending: (item: PendingPrompt) => Promise<boolean>;
  onScheduleMessage: (prompt: string, at: number) => Promise<boolean>;
  onRemoveScheduled: (id: string) => Promise<boolean>;
  /** Editor context the next message carries, such as the open Node. */
  contexts?: ChatContextChip[];
  onRemoveContext?: (key: string) => void;
  canPublish?: boolean;
  onPublish?: () => void;
  /** Plugin commands for the "/" list and the + menu; the project shell runs them. */
  pluginCommands?: ComposerPluginCommands;
  onPluginCommand?: (command: ProjectPluginCommand) => void;
  /** Turns on a plugin that is off in the project, for mentioning it; false when the person declined. */
  onTurnOnPlugin?: (plugin: ConversationCapabilities["plugins"][number]) => Promise<boolean>;
  /** What the empty box asks for, in place of a change to the game. */
  placeholder?: string;
}

export function Composer({
  projectId,
  conversationId,
  supportsDesign = false,
  placeholder: idlePlaceholder,
  conversationReady,
  running,
  stopping,
  pendingPrompts,
  scheduledMessages,
  plan,
  planMode,
  notice,
  status,
  limitResumeArmed,
  onSkipLimitResume,
  models,
  modelStatus,
  model,
  reasoningLevel,
  nativeReasoningLevel,
  accountProfileId,
  modelChanging,
  promptHistory,
  capabilities,
  initialDraft,
  onInitialDraftHandled,
  onTurnOnPlugin,
  onSubmit,
  onCompact,
  onContextUsage,
  onCancelPlan,
  onModelChange,
  onReasoningChange,
  onNativeReasoningChange,
  onStop,
  onRemovePending,
  onSteerPending,
  onEditPending,
  onScheduleMessage,
  onRemoveScheduled,
  contexts = [],
  onRemoveContext,
  canPublish,
  onPublish,
  pluginCommands,
  onPluginCommand,
}: ComposerProps) {
  const [draftSession] = useState(() => composerDrafts.get(
    projectId && conversationId ? { projectId, conversationId } : undefined,
    initialDraft,
    planMode === "planning",
  ));
  const draft = useSyncExternalStore(draftSession.subscribe, draftSession.getSnapshot, draftSession.getSnapshot);
  const { prompt, mentions: pluginMentions, attachments, uploaded: carried = [], designReference, reference, planning, submitting } = draft;
  const updateDraft = draftSession.update;
  const [referencingDesign, setReferencingDesign] = useState(false);
  const [attachmentError, setAttachmentError] = useState<string>();
  const [history, setHistory] = useState(() => createPromptHistory(promptHistory.map((entry) => entry.prompt)));
  const [mentionHistory, setMentionHistory] = useState(() => new Map(promptHistory.map((entry) => [entry.prompt, entry.mentions])));
  const [runtimeUsage, setRuntimeUsage] = useState<AgentContextUsage>();
  const contextPercent = runtimeUsage?.percent == null ? undefined : Math.round(Math.max(0, Math.min(100, runtimeUsage.percent)));
  const [mentionCursor, setMentionCursor] = useState(0);
  const input = useRef<PromptInput>(null);
  // The text now, for a mention that goes in once its plugin is on.
  const latestPrompt = useRef(prompt);
  latestPrompt.current = prompt;
  useEffect(() => {
    // A draft saved when a plugin sat in a slot before the text gets it back in the text, after its Skill as it was sent.
    const legacy = draftSession.getSnapshot().selectedPlugin;
    if (legacy) updateDraft((current) => {
      const skill = parseSkillInvocation(current.prompt);
      return {
        prompt: formatSkillInvocation(skill?.name, formatPluginInvocation(legacy, skill?.prompt ?? current.prompt)),
        selectedPlugin: undefined,
        mentions: [...current.mentions, legacy],
      };
    });
    if (!initialDraft) return;
    focusAt(draftSession.getSnapshot().prompt.length);
    onInitialDraftHandled?.();
  }, []);

  function focusAt(cursor: number): void {
    setMentionCursor(cursor);
    requestAnimationFrame(() => input.current?.focus(cursor));
  }

  async function submit() {
    const value = prompt.trim();
    if (!conversationReady || (!value && attachments.length === 0 && carried.length === 0) || stopping || draftSession.getSnapshot().submitting || !projectId) return;
    setAttachmentError(undefined);
    updateDraft({ submitting: true });
    try {
      const batchId = crypto.randomUUID();
      let uploaded: PromptAttachment[];
      try {
        uploaded = [...carried, ...await uploadAttachments(projectId, batchId, attachments)];
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
        input.current?.focus();
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
      if (!result) throw new Error(t("composer.noDesign"));
      updateDraft({ designReference: {
        references: [{ type: "workspace-file", path: canvasDocumentPath(result.document.id) }],
        context: {
          kind: "design-document",
          label: result.document.title || t("composer.gameDesign"),
          text: "Reference the saved game design document for this message.",
        },
      } });
      input.current?.focus();
    } catch (cause) {
      setAttachmentError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setReferencingDesign(false);
      requestAnimationFrame(() => input.current?.focus());
    }
  }

  function browseHistory(direction: "previous" | "next") {
    const result = direction === "previous" ? previousPrompt(history, prompt) : nextPrompt(history);
    if (!result) return;
    setHistory(result.history);
    updateDraft({ prompt: result.prompt, mentions: mentionHistory.get(result.prompt) ?? [] });
    focusAt(result.prompt.length);
  }

  function changePrompt(value: string, mentions = pluginMentions) {
    updateDraft({ prompt: value, mentions: activePluginMentions(value, mentions) });
    setHistory((current) => current.index === current.entries.length
      ? current
      : { ...current, index: current.entries.length, draft: value });
  }

  function addAttachments(next: ComposerAttachment[]): void {
    setAttachmentError(undefined);
    try { updateDraft({ attachments: appendAttachments(attachments, next) }); }
    catch (cause) { setAttachmentError(cause instanceof Error ? cause.message : String(cause)); return; }
    input.current?.focus();
  }

  function addFiles(files: DroppedFile[]): void {
    addAttachments(attachmentFiles(files));
  }

  function selectMention(mention: ComposerMention, query?: ComposerMentionQuery) {
    // A plugin that is off here is turned on first, then mentioned.
    if (mention.type === "plugin" && mention.value.off && onTurnOnPlugin) {
      setAttachmentError(undefined);
      const before = prompt;
      void onTurnOnPlugin(mention.value).then(
        // Text typed meanwhile stays; the plugin is on, so `@` puts it in at once.
        (on) => { if (on && latestPrompt.current === before) insertSelectedMention(mention, query); },
        (cause: unknown) => setAttachmentError(cause instanceof Error ? cause.message : String(cause)),
      );
      return;
    }
    insertSelectedMention(mention, query);
  }

  function insertSelectedMention(mention: ComposerMention, query?: ComposerMentionQuery) {
    // Plugins and Skills go where they are typed, any number of each.
    const inserted = insertMention(prompt, query ?? { start: mentionCursor, end: mentionCursor, trigger: "@", query: "" }, mention);
    if (mention.type === "plugin") {
      const selected = toPluginMention(mention.value);
      changePrompt(inserted.value, [...pluginMentions.filter((item) => item.name !== selected.name || item.marketplaceId !== selected.marketplaceId), selected]);
    } else {
      changePrompt(inserted.value);
    }
    focusAt(inserted.cursor);
  }

  const showStop = running && !prompt.trim() && attachments.length === 0 && carried.length === 0;
  const awaitingApproval = planMode === "awaiting_approval";
  const canTogglePlanning = conversationReady && !running && !stopping && !awaitingApproval && planMode !== "executing";
  const showPlanCommand = canTogglePlanning && matchesPlanCommand(prompt);
  const showCompactCommand = conversationReady && !running && !stopping && matchesCompactCommand(prompt);
  const planInputLocked = awaitingApproval || planMode === "executing" || (planMode === "planning" && running);
  const textareaDisabled = !conversationReady || planInputLocked;
  // A disabled field drops focus to the page, where canvas shortcuts such as
  // Backspace (delete the selected Node) would take the next keystrokes.
  const textareaReadOnly = submitting || referencingDesign;
  const inputDisabled = textareaDisabled || textareaReadOnly;
  const skillNames = useMemo(() => capabilities.skills.map((skill) => skill.name), [capabilities.skills]);
  const publishAvailable = Boolean(canPublish && onPublish && !running && !stopping);
  useEffect(() => {
    const requestId = draft.focusRequestId;
    if (!requestId || inputDisabled) return;
    const frame = requestAnimationFrame(() => {
      const current = draftSession.getSnapshot();
      if (!input.current || current.focusRequestId !== requestId) return;
      const cursor = current.prompt.length;
      input.current.focus(cursor);
      setMentionCursor(cursor);
      updateDraft({ focusRequestId: undefined });
    });
    return () => cancelAnimationFrame(frame);
  }, [draft.focusRequestId, inputDisabled]);

  const contextMenu = useComposerContextMenu({
    prompt,
    cursor: mentionCursor,
    input,
    disabled: inputDisabled,
    capabilities,
    planning,
    canTogglePlanning,
    onFiles: addAttachments,
    onDesignReference: supportsDesign ? () => { void referenceDesign(); } : undefined,
    onTogglePlanning: () => { void togglePlanning(false); },
    onCompact: conversationReady && !running && !stopping ? () => { void runCompact(compactInstructions(prompt) ?? undefined); } : undefined,
    onLater: later,
    onPublish,
    onMention: selectMention,
    onChange: changePrompt,
    onSelectionChange: setMentionCursor,
    contextPercent,
    canPublish: publishAvailable,
    usageLimits: isAgentRuntimeId(model?.provider) ? runtimeUsage?.limits : undefined,
    pluginCommands,
    onPluginCommand,
  });

  useEffect(() => {
    if (!showCompactCommand && !isAgentRuntimeId(model?.provider)) {
      setRuntimeUsage(undefined);
      return;
    }
    let disposed = false;
    setRuntimeUsage(undefined);
    void onContextUsage().then((usage) => {
      if (!disposed) setRuntimeUsage(usage);
    }).catch(() => {
      if (!disposed) setRuntimeUsage(undefined);
    });
    return () => { disposed = true; };
  }, [showCompactCommand, running, modelStatus, model?.provider, model?.id, conversationId, accountProfileId, contextMenu.open]);

  // The status line under the composer follows each finished response.
  const [statusUsage, setStatusUsage] = useState<AgentContextUsage>();
  useEffect(() => {
    if (!conversationId || running) return;
    let disposed = false;
    void onContextUsage(true).then((usage) => { if (!disposed) setStatusUsage(usage); }).catch(() => {});
    return () => { disposed = true; };
  }, [conversationId, running, model?.provider, model?.id]);
  useEffect(() => setStatusUsage(undefined), [conversationId]);

  const writing = Boolean(prompt.trim()) || attachments.length > 0;
  useEffect(() => {
    if (writing && limitResumeArmed) onSkipLimitResume?.();
  }, [writing, limitResumeArmed]);

  useEffect(() => {
    if (planMode === "planning") updateDraft({ planning: true });
    else if (planMode !== "normal") updateDraft({ planning: false });
  }, [planMode]);

  async function togglePlanning(clearDraft = true) {
    if (planning && planMode === "planning" && !await onCancelPlan()) return;
    updateDraft((current) => ({
      planning: !current.planning,
      ...(clearDraft ? { prompt: "", mentions: [] } : {}),
    }));
    if (clearDraft) setMentionCursor(0);
    input.current?.focus();
  }

  function submitOrRunCommand() {
    if (isLaterCommand(prompt)) {
      later();
      return;
    }
    if (publishAvailable && !inputDisabled && prompt.trim().toLowerCase() === "/publish") {
      changePrompt("");
      setMentionCursor(0);
      onPublish?.();
      return;
    }
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

  /** Offers the time first, ahead of anything already written, then schedules once there is one to read. */
  function later(): void {
    if (/^\s*\/later\s/i.test(prompt)) {
      void scheduleLater();
      return;
    }
    changePrompt(`/later ${prompt.replace(/^\s*\/\S*\s*/, "")}`);
    focusAt("/later ".length);
  }

  async function scheduleLater(): Promise<void> {
    if (!conversationReady || draftSession.getSnapshot().submitting) return;
    const scheduled = parseLaterCommand(prompt);
    const textOnly = !attachments.length && !carried.length && !reference && !designReference && !activePluginMentions(prompt, pluginMentions).length;
    const problem = planning ? t("later.planning") : !textOnly ? t("later.textOnly") : scheduled ? undefined : t("later.invalid");
    setAttachmentError(problem);
    if (problem || !scheduled) return;
    updateDraft({ submitting: true });
    try {
      if (!await onScheduleMessage(scheduled.prompt, scheduled.at)) return;
      setHistory((current) => recordPrompt(current, prompt.trim()));
      if (draftSession.clearSubmitted(draft)) setMentionCursor(0);
      input.current?.focus();
    } finally {
      updateDraft({ submitting: false });
    }
  }

  async function editScheduled(item: ScheduledMessage): Promise<void> {
    if (inputDisabled || !(await onRemoveScheduled(item.id))) return;
    // A missed message comes back to send as it is, or to put a new time on.
    const command = item.missed ? item.prompt : laterCommand(item);
    updateDraft({ prompt: command, mentions: [], attachments: [], uploaded: undefined, reference: undefined, designReference: undefined });
    setAttachmentError(undefined);
    focusAt(command.length);
  }

  async function runCompact(instructions?: string) {
    updateDraft({ prompt: "" });
    setMentionCursor(0);
    input.current?.focus();
    await onCompact(instructions);
  }

  async function editPending(item: PendingPrompt): Promise<void> {
    if (inputDisabled || !(await onEditPending(item))) return;
    const nextPrompt = item.prompt;
    const referencedDesign = item.references.find((reference) => reference.type === "workspace-file" && /^canvas\/documents\/[a-zA-Z0-9_-]+\.md$/.test(reference.path));
    updateDraft({ prompt: nextPrompt, mentions: item.mentions,
      attachments: [], reference: undefined, designReference: referencedDesign ? {
      references: [referencedDesign],
      context: {
        kind: "design-document",
        label: t("composer.gameDesign"),
        text: "The user explicitly referenced this saved design document.",
      },
    } : undefined });
    setAttachmentError(undefined);
    focusAt(nextPrompt.length);
  }

  function handleCommandKeyDown(event: KeyboardEvent, selection: PromptSelection): boolean {
    setMentionCursor(selection.start);
    return contextMenu.handleKeyDown(event);
  }

  return (
    <div className="composer">
      <PlanStatus
        plan={awaitingApproval ? undefined : plan}
      />
      <MessageQueue
        prioritizeOnly={isAgentRuntimeId(model?.provider)}
        items={pendingPrompts}
        disabled={!running || stopping}
        onRemove={(turnId) => { void onRemovePending(turnId); }}
        onSteer={(turnId) => { void onSteerPending(turnId); }}
        onEdit={(item) => { void editPending(item); }}
      />
      <ScheduledMessages
        items={scheduledMessages}
        disabled={!conversationReady}
        editDisabled={inputDisabled}
        onEdit={(item) => { void editScheduled(item); }}
        onRemove={(id) => { void onRemoveScheduled(id); }}
      />
      {status ? <div className="composer-notice composer-info" role="status">
        <InfoCircle size={14} aria-hidden="true" />
        <span>{status}</span>
      </div> : null}
      {notice || attachmentError ? <div className="composer-notice composer-error" role="alert">
        <DangerCircle size={14} aria-hidden="true" />
        <span>{attachmentError ?? notice}</span>
      </div> : null}
      <PromptBox
        actions={<ComposerActions
          models={models} status={modelStatus} value={model} reasoningLevel={reasoningLevel}
          nativeReasoningLevel={nativeReasoningLevel} onNativeReasoningChange={onNativeReasoningChange}
          disabled={!conversationReady || running || stopping || modelChanging}
          onChange={onModelChange} onReasoningChange={onReasoningChange}
          showStop={showStop} stopping={stopping} onStop={onStop}
          sendDisabled={inputDisabled || (!prompt.trim() && attachments.length === 0 && carried.length === 0) || stopping}
          sendLabel={running ? t("composer.queue") : t("composer.send")}
        />}
        content={<>
          {contexts.length ? <div className="composer-contexts" aria-label={t("composer.contexts")}>
            {contexts.map((context) => <div className={`composer-context is-${context.kind}`} key={context.key} title={context.detail ?? context.label}>
              <PromptContextIcon kind={context.kind} />
              <span>{context.label}</span>
              {context.detail ? <small>{context.detail}</small> : null}
              <button type="button" onClick={() => onRemoveContext?.(context.key)} aria-label={t("composer.removeContext", { label: context.label })}><X size={11} /></button>
            </div>)}
          </div> : null}
          {reference ? <div className="composer-reference">
            <div className="composer-reference-label">{t("composer.selectedText")}</div>
            <div className="composer-reference-text">{reference.text}</div>
            <button type="button" className="composer-reference-remove" onClick={() => updateDraft({ reference: undefined })} aria-label={t("composer.removeSelectedText")}>×</button>
          </div> : null}
          {designReference ? <div className="composer-contexts" aria-label={t("composer.referencedDesign")}>
            <div className="composer-context is-design-document" title={designReference.context.label}>
              <FileText size={12} />
              <span>{designReference.context.label}</span>
              <small>{t("composer.gameDesign")}</small>
              <button type="button" onClick={() => updateDraft({ designReference: undefined })} aria-label={t("composer.removeDesign")}><X size={11} /></button>
            </div>
          </div> : null}
          <AttachmentStrip items={attachments} uploaded={carried} onRemove={(id) => updateDraft((current) => ({
            attachments: current.attachments.filter((attachment) => attachment.id !== id),
            uploaded: current.uploaded?.filter((attachment) => attachment.id !== id),
          }))} />
        </>}
        disabled={textareaDisabled}
        readOnly={textareaReadOnly}
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
        onDropError={(error) => setAttachmentError(t("composer.droppedFolder", { error: error.message }))}
        onSubmit={submitOrRunCommand}
        suggestions={contextMenu.suggestions}
        overlay={contextMenu.open ? contextMenu.overlay : null}
        placeholder={awaitingApproval ? t("composer.placeholder.review") : planMode === "executing" ? t("composer.placeholder.executing") : planning ? t("creator.planPlaceholder") : running ? t("composer.placeholder.followUp") : idlePlaceholder ?? t("composer.placeholder.change")}
        inputRef={input}
        onSelectionChange={setMentionCursor}
        value={prompt}
        variant="project"
        mentions={pluginMentions}
        plugins={capabilities.plugins}
        skills={skillNames}
      />
      <ComposerStatus usage={runtimeUsage ?? statusUsage} />
    </div>
  );
}
