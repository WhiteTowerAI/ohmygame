import { ArrowUp, CircleX, Lightbulb, Square } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { AgentModel, AgentModelRef, AgentReasoningLevel, PendingPrompt, PlanMode, PlanState, PromptImage } from "../shared/contracts.js";
import { ImageAttachmentStrip, ImagePickerButton, promptImages, type ComposerImage } from "./image-attachments.js";
import { ModelSelector } from "./model-selector.js";
import { MessageQueue } from "./message-queue.js";
import { PromptBox } from "./prompt-box.js";
import { PlanStatus } from "./plan-status.js";
import { createPromptHistory, nextPrompt, previousPrompt, recordPrompt } from "./prompt-history.js";

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
  promptHistory: string[];
  onSubmit: (prompt: string, images: PromptImage[], mode: "normal" | "planning") => Promise<boolean>;
  onCancelPlan: () => Promise<boolean>;
  onModelChange: (model: AgentModel) => void;
  onReasoningChange: (level: AgentReasoningLevel) => void;
  onStop: () => void;
  onRemovePending: (turnId: string) => Promise<boolean>;
  onSteerPending: (turnId: string) => Promise<boolean>;
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
  onSubmit,
  onCancelPlan,
  onModelChange,
  onReasoningChange,
  onStop,
  onRemovePending,
  onSteerPending,
}: ComposerProps) {
  const [prompt, setPrompt] = useState("");
  const [images, setImages] = useState<ComposerImage[]>([]);
  const [attachmentError, setAttachmentError] = useState<string>();
  const [history, setHistory] = useState(() => createPromptHistory(promptHistory));
  const [planning, setPlanning] = useState(planMode === "planning");
  const textarea = useRef<HTMLTextAreaElement>(null);

  async function submit() {
    const value = prompt.trim();
    if (!conversationReady || (!value && images.length === 0) || stopping) return;
    const submitted = await onSubmit(value, promptImages(images), planning ? "planning" : "normal");
    if (submitted) {
      setHistory((current) => recordPrompt(current, value));
      setPrompt("");
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
    requestAnimationFrame(() => {
      const end = result.prompt.length;
      textarea.current?.setSelectionRange(end, end);
    });
  }

  function changePrompt(value: string) {
    setPrompt(value);
    setHistory((current) => current.index === current.entries.length
      ? current
      : { ...current, index: current.entries.length, draft: value });
  }

  const showStop = running && !prompt.trim() && images.length === 0;
  const awaitingApproval = planMode === "awaiting_approval";
  const canTogglePlanning = conversationReady && !running && !stopping && !awaitingApproval && planMode !== "executing";
  const showPlanCommand = canTogglePlanning && matchesPlanCommand(prompt);
  const planInputLocked = awaitingApproval || planMode === "executing" || (planMode === "planning" && running);
  const inputDisabled = !conversationReady || planInputLocked;

  useEffect(() => {
    if (planMode === "planning") setPlanning(true);
    else if (planMode !== "normal") setPlanning(false);
  }, [planMode]);

  async function togglePlanning() {
    if (planning && planMode === "planning" && !await onCancelPlan()) return;
    setPlanning((value) => !value);
    setPrompt("");
    textarea.current?.focus();
  }

  function submitOrRunCommand() {
    if (showPlanCommand) {
      void togglePlanning();
      return;
    }
    void submit();
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
        content={<ImageAttachmentStrip images={images} onRemove={(id) => setImages((items) => items.filter((image) => image.id !== id))} />}
        disabled={inputDisabled}
        leading={(
          <>
            <ImagePickerButton
              disabled={inputDisabled}
              onImages={(next) => { setAttachmentError(undefined); setImages((items) => [...items, ...next]); }}
              onError={setAttachmentError}
            />
            {planning ? (
              <div className="composer-plan-mode" aria-label="Plan mode active">
                <button type="button" disabled={running || stopping} onClick={() => { void togglePlanning(); }} title="Exit plan mode" aria-label="Exit plan mode">
                  <Lightbulb className="composer-plan-icon" size={15} aria-hidden="true" />
                  <CircleX className="composer-plan-close" size={15} aria-hidden="true" />
                  <span>Plan</span>
                </button>
              </div>
            ) : null}
          </>
        )}
        onChange={changePrompt}
        onHistoryNext={() => browseHistory("next")}
        onHistoryPrevious={() => browseHistory("previous")}
        onSubmit={submitOrRunCommand}
        overlay={showPlanCommand ? (
          <div className="composer-command-menu" role="listbox" aria-label="Composer commands">
            <button type="button" role="option" aria-selected="true" onClick={() => { void togglePlanning(); }}>
              <Lightbulb size={15} aria-hidden="true" />
              <span>Plan mode</span>
              <small>{planning ? "Turn plan mode off" : "Turn plan mode on"}</small>
            </button>
          </div>
        ) : null}
        placeholder={awaitingApproval ? "Review the plan above" : planMode === "executing" ? "Executing plan" : planning ? "Describe what to plan" : running ? "Add a follow-up" : "Ask for a change"}
        textareaRef={textarea}
        value={prompt}
        variant="project"
      />
    </div>
  );
}

export function matchesPlanCommand(value: string): boolean {
  const command = value.trim().toLowerCase();
  return command.startsWith("/") && !command.includes(" ") && "/plan".startsWith(command);
}
