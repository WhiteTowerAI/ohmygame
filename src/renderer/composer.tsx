import { ArrowUp, Square } from "lucide-react";
import { useRef, useState } from "react";
import type { AgentModel, AgentModelRef, AgentReasoningLevel, PendingPrompt, PromptImage } from "../shared/contracts.js";
import { ImageAttachmentStrip, ImagePickerButton, promptImages, type ComposerImage } from "./image-attachments.js";
import { ModelSelector } from "./model-selector.js";
import { MessageQueue } from "./message-queue.js";
import { PromptBox } from "./prompt-box.js";
import { createPromptHistory, nextPrompt, previousPrompt, recordPrompt } from "./prompt-history.js";

interface ComposerProps {
  conversationReady: boolean;
  running: boolean;
  stopping: boolean;
  pendingPrompts: PendingPrompt[];
  notice?: string;
  models: AgentModel[];
  model?: AgentModelRef;
  reasoningLevel?: AgentReasoningLevel;
  modelChanging: boolean;
  promptHistory: string[];
  onSubmit: (prompt: string, images: PromptImage[]) => Promise<boolean>;
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
  notice,
  models,
  model,
  reasoningLevel,
  modelChanging,
  promptHistory,
  onSubmit,
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
  const textarea = useRef<HTMLTextAreaElement>(null);

  async function submit() {
    const value = prompt.trim();
    if (!conversationReady || (!value && images.length === 0) || stopping) return;
    const submitted = await onSubmit(value, promptImages(images));
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

  return (
    <div className="composer">
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
              <button className="icon-button send-button" type="submit" disabled={!conversationReady || (!prompt.trim() && images.length === 0) || stopping} title={running ? "Queue follow-up" : "Send prompt"} aria-label={running ? "Queue follow-up" : "Send prompt"}>
                <ArrowUp size={17} />
              </button>
            )}
          </>
        )}
        content={<ImageAttachmentStrip images={images} onRemove={(id) => setImages((items) => items.filter((image) => image.id !== id))} />}
        disabled={!conversationReady}
        leading={(
          <ImagePickerButton
            disabled={!conversationReady}
            onImages={(next) => { setAttachmentError(undefined); setImages((items) => [...items, ...next]); }}
            onError={setAttachmentError}
          />
        )}
        onChange={changePrompt}
        onHistoryNext={() => browseHistory("next")}
        onHistoryPrevious={() => browseHistory("previous")}
        onSubmit={() => void submit()}
        placeholder={running ? "Add a follow-up" : "Ask for a change"}
        textareaRef={textarea}
        value={prompt}
        variant="project"
      />
    </div>
  );
}
