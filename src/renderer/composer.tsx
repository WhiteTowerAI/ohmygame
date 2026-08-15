import { ArrowUp, Pencil, Square, X } from "lucide-react";
import { useRef, useState } from "react";
import type { AgentModel, AgentModelRef, PendingPrompt, PromptImage } from "../shared/contracts.js";
import { composerImages, ImageAttachmentStrip, ImagePickerButton, promptImages, type ComposerImage } from "./image-attachments.js";
import { ModelSelector } from "./model-selector.js";
import { PromptBox } from "./prompt-box.js";

interface ComposerProps {
  conversationReady: boolean;
  running: boolean;
  stopping: boolean;
  pendingPrompt?: PendingPrompt;
  notice?: string;
  models: AgentModel[];
  model?: AgentModelRef;
  modelChanging: boolean;
  onSubmit: (prompt: string, images: PromptImage[]) => Promise<boolean>;
  onModelChange: (model: AgentModel) => void;
  onStop: () => void;
  onRemovePending: (turnId: string) => Promise<boolean>;
}

export function Composer({
  conversationReady,
  running,
  stopping,
  pendingPrompt,
  notice,
  models,
  model,
  modelChanging,
  onSubmit,
  onModelChange,
  onStop,
  onRemovePending,
}: ComposerProps) {
  const [prompt, setPrompt] = useState("");
  const [images, setImages] = useState<ComposerImage[]>([]);
  const [attachmentError, setAttachmentError] = useState<string>();
  const textarea = useRef<HTMLTextAreaElement>(null);

  async function submit() {
    const value = prompt.trim();
    if (!conversationReady || (!value && images.length === 0) || stopping) return;
    if (await onSubmit(value, promptImages(images))) {
      setPrompt("");
      setImages([]);
      setAttachmentError(undefined);
      textarea.current?.focus();
    }
  }

  const showStop = running && !prompt.trim() && images.length === 0;

  return (
    <div className="composer">
      {pendingPrompt ? (
        <div className="pending-prompt">
          <div>
            <span>Up next</span>
            <p>{pendingPrompt.prompt || `${pendingPrompt.images.length} image${pendingPrompt.images.length === 1 ? "" : "s"}`}</p>
          </div>
          <div className="pending-prompt-actions">
            <button
              type="button"
              onClick={() => { void (async () => {
                if (!(await onRemovePending(pendingPrompt.turnId))) return;
                setPrompt(pendingPrompt.prompt);
                setImages(composerImages(pendingPrompt.images));
                queueMicrotask(() => {
                  textarea.current?.focus();
                });
              })(); }}
              title="Edit follow-up"
              aria-label="Edit follow-up"
            >
              <Pencil size={13} />
            </button>
            <button type="button" onClick={() => { void onRemovePending(pendingPrompt.turnId); }} title="Remove follow-up" aria-label="Remove follow-up">
              <X size={14} />
            </button>
          </div>
        </div>
      ) : null}
      {notice || attachmentError ? <p className="composer-error" role="alert">{attachmentError ?? notice}</p> : null}
      <PromptBox
        actions={(
          <>
            <ModelSelector
              models={models}
              value={model}
              disabled={!conversationReady || running || stopping || modelChanging}
              onChange={onModelChange}
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
        onChange={setPrompt}
        onSubmit={() => void submit()}
        placeholder={running ? "Add a follow-up" : "Ask for a change"}
        textareaRef={textarea}
        value={prompt}
        variant="project"
      />
    </div>
  );
}
