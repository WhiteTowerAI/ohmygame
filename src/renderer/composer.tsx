import { ArrowUp, Square } from "lucide-react";
import { useEffect, useRef, useState, type KeyboardEvent } from "react";
import type { AgentModel, AgentModelRef, AgentReasoningLevel, ConversationCapabilities, PendingPrompt, PlanMode, PlanState, PluginMention, PromptImage, PromptMode } from "../shared/contracts.js";
import { ImageAttachmentStrip, ImagePickerButton, promptImages, type ComposerImage } from "./image-attachments.js";
import { ModelSelector } from "./model-selector.js";
import { MessageQueue } from "./message-queue.js";
import { PromptBox } from "./prompt-box.js";
import { PlanStatus } from "./plan-status.js";
import { compactInstructions, matchesCompactCommand, matchesPlanCommand, PlanCommandMenu, PlanModeIndicator } from "./plan-mode-control.js";
import { createPromptHistory, nextPrompt, previousPrompt, recordPrompt } from "./prompt-history.js";
import type { ChatReference } from "./chat-reference.js";
import { ComposerMentionMenu } from "./composer-mention-menu.js";
import { activePluginMentions, insertMention, matchingMentions, mentionQuery, toPluginMention, type ComposerMention } from "./composer-mentions.js";

interface ComposerProps {
  conversationReady: boolean;
  running: boolean;
  stopping: boolean;
  pendingPrompts: PendingPrompt[];
  plan?: PlanState;
  planMode: PlanMode;
  notice?: string;
  models: AgentModel[];
  model?: AgentModelRef;
  reasoningLevel?: AgentReasoningLevel;
  modelChanging: boolean;
  promptHistory: Array<{ prompt: string; mentions: PluginMention[] }>;
  capabilities: ConversationCapabilities;
  initialDraft?: string;
  onInitialDraftHandled?: () => void;
  onSubmit: (prompt: string, mentions: PluginMention[], images: PromptImage[], mode: PromptMode) => Promise<boolean>;
  onCompact: (instructions?: string) => Promise<void>;
  onContextUsage: () => Promise<number | undefined>;
  onCancelPlan: () => Promise<boolean>;
  onModelChange: (model: AgentModel) => void;
  onReasoningChange: (level: AgentReasoningLevel) => void;
  onStop: () => void;
  onRemovePending: (turnId: string) => Promise<boolean>;
  onSteerPending: (turnId: string) => Promise<boolean>;
  reference?: ChatReference;
  onClearReference?: () => void;
}

export function Composer({
  conversationReady,
  running,
  stopping,
  pendingPrompts,
  plan,
  planMode,
  notice,
  models,
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
  reference,
  onClearReference,
}: ComposerProps) {
  const [prompt, setPrompt] = useState(initialDraft ?? "");
  const [pluginMentions, setPluginMentions] = useState<PluginMention[]>([]);
  const [images, setImages] = useState<ComposerImage[]>([]);
  const [attachmentError, setAttachmentError] = useState<string>();
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
  ).slice(0, 8) : [];

  useEffect(() => setSelectedMention(0), [activeMention?.trigger, activeMention?.query]);
  useEffect(() => {
    if (!initialDraft) return;
    setMentionCursor(initialDraft.length);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(initialDraft.length, initialDraft.length);
    });
    onInitialDraftHandled?.();
  }, []);
  useEffect(() => {
    if (!mentionKey) setDismissedMention(undefined);
  }, [mentionKey]);

  async function submit() {
    const value = prompt.trim();
    if (!conversationReady || (!value && images.length === 0) || stopping) return;
    const submitted = await onSubmit(value, activePluginMentions(value, pluginMentions), promptImages(images), planning ? "planning" : "normal");
    if (submitted) {
      setHistory((current) => recordPrompt(current, value));
      setMentionHistory((current) => new Map(current).set(value, activePluginMentions(value, pluginMentions)));
      setPrompt("");
      setPluginMentions([]);
      setMentionCursor(0);
      setImages([]);
      setAttachmentError(undefined);
      textarea.current?.focus();
    }
  }

  function browseHistory(direction: "previous" | "next") {
    const result = direction === "previous" ? previousPrompt(history, prompt) : nextPrompt(history);
    if (!result) return;
    setHistory(result.history);
    setPrompt(result.prompt);
    setPluginMentions(mentionHistory.get(result.prompt) ?? []);
    setMentionCursor(result.prompt.length);
    requestAnimationFrame(() => {
      const end = result.prompt.length;
      textarea.current?.setSelectionRange(end, end);
    });
  }

  function changePrompt(value: string) {
    setPrompt(value);
    setPluginMentions((current) => activePluginMentions(value, current));
    setHistory((current) => current.index === current.entries.length
      ? current
      : { ...current, index: current.entries.length, draft: value });
  }

  function selectMention(mention: ComposerMention) {
    if (!activeMention) return;
    const inserted = insertMention(prompt, activeMention, mention);
    changePrompt(inserted.value);
    if (mention.type === "plugin") {
      const selected = toPluginMention(mention.value);
      setPluginMentions((current) => [
        ...current.filter((item) => item.name !== selected.name || item.marketplaceId !== selected.marketplaceId),
        selected,
      ]);
    }
    setMentionCursor(inserted.cursor);
    setSelectedMention(0);
    requestAnimationFrame(() => {
      textarea.current?.focus();
      textarea.current?.setSelectionRange(inserted.cursor, inserted.cursor);
    });
  }

  const showStop = running && !prompt.trim() && images.length === 0;
  const awaitingApproval = planMode === "awaiting_approval";
  const canTogglePlanning = conversationReady && !running && !stopping && !awaitingApproval && planMode !== "executing";
  const showPlanCommand = canTogglePlanning && matchesPlanCommand(prompt);
  const showCompactCommand = conversationReady && !running && !stopping && matchesCompactCommand(prompt);
  const planInputLocked = awaitingApproval || planMode === "executing" || (planMode === "planning" && running);
  const inputDisabled = !conversationReady || planInputLocked;

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

  function handleCommandKeyDown(event: KeyboardEvent<HTMLTextAreaElement>): boolean {
    setMentionCursor(event.currentTarget.selectionStart);
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
      />
      {notice || attachmentError ? <p className="composer-error" role="alert">{attachmentError ?? notice}</p> : null}
      <PromptBox
        actions={(
          <>
            <ModelSelector
              models={models}
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
              <button className="icon-button send-button" type="submit" disabled={inputDisabled || (!prompt.trim() && images.length === 0) || stopping} title={running ? "Queue follow-up" : "Send prompt"} aria-label={running ? "Queue follow-up" : "Send prompt"}>
                <ArrowUp size={17} />
              </button>
            )}
          </>
        )}
        content={<>
          {reference ? <div className="composer-reference">
            <div className="composer-reference-label">Selected text</div>
            <div className="composer-reference-text">{reference.text}</div>
            <button type="button" className="composer-reference-remove" onClick={onClearReference} aria-label="Remove selected text">×</button>
          </div> : null}
          <ImageAttachmentStrip images={images} onRemove={(id) => setImages((items) => items.filter((image) => image.id !== id))} />
        </>}
        disabled={inputDisabled}
        leading={(
          <>
            <ImagePickerButton
              disabled={inputDisabled}
              onImages={(next) => { setAttachmentError(undefined); setImages((items) => [...items, ...next]); }}
              onError={setAttachmentError}
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
        placeholder={awaitingApproval ? "Review the plan above" : planMode === "executing" ? "Executing plan" : planning ? "Describe what to plan" : running ? "Add a follow-up" : "Ask for a change"}
        textareaRef={textarea}
        onSelectionChange={setMentionCursor}
        value={prompt}
        variant="project"
      />
    </div>
  );
}
