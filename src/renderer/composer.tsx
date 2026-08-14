import { ArrowUp, FileCode2, Pencil, Plus, Square, X } from "lucide-react";
import { useRef, useState } from "react";
import type { AgentModel, AgentModelRef, PendingPrompt, PromptReference, WorkspaceFile } from "../shared/contracts.js";
import { listWorkspaceFiles } from "./api.js";
import { ModelSelector } from "./model-selector.js";
import { PromptBox } from "./prompt-box.js";

interface ComposerProps {
  projectId?: string;
  conversationReady: boolean;
  running: boolean;
  stopping: boolean;
  pendingPrompt?: PendingPrompt;
  notice?: string;
  models: AgentModel[];
  model?: AgentModelRef;
  modelChanging: boolean;
  onSubmit: (prompt: string, references: PromptReference[]) => Promise<boolean>;
  onModelChange: (model: AgentModel) => void;
  onStop: () => void;
  onRemovePending: (turnId: string) => Promise<boolean>;
}

export function Composer({
  projectId,
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
  const [references, setReferences] = useState<PromptReference[]>([]);
  const [files, setFiles] = useState<WorkspaceFile[]>([]);
  const [query, setQuery] = useState("");
  const [pickerOpen, setPickerOpen] = useState(false);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [pickerError, setPickerError] = useState<string>();
  const textarea = useRef<HTMLTextAreaElement>(null);

  async function openPicker() {
    if (!projectId) return;
    setPickerOpen(true);
    setPickerError(undefined);
    setLoadingFiles(true);
    try {
      setFiles(await listWorkspaceFiles(projectId));
    } catch (error) {
      setPickerError(error instanceof Error ? error.message : String(error));
    } finally {
      setLoadingFiles(false);
    }
  }

  async function submit() {
    const value = prompt.trim();
    if (!conversationReady || !value || stopping) return;
    if (await onSubmit(value, references)) {
      setPrompt("");
      setReferences([]);
      textarea.current?.focus();
    }
  }

  const selectedPaths = new Set(references.map(({ path }) => path));
  const filteredFiles = files.filter(({ path }) => !selectedPaths.has(path) && path.toLowerCase().includes(query.trim().toLowerCase()));
  const showStop = running && !prompt.trim();

  return (
    <div className="composer">
      {pendingPrompt ? (
        <div className="pending-prompt">
          <div>
            <span>Up next</span>
            <p>{pendingPrompt.prompt}</p>
          </div>
          <div className="pending-prompt-actions">
            <button
              type="button"
              onClick={() => { void (async () => {
                if (!(await onRemovePending(pendingPrompt.turnId))) return;
                setPrompt(pendingPrompt.prompt);
                setReferences(pendingPrompt.references);
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
      {notice ? <p className="composer-error" role="alert">{notice}</p> : null}
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
              <button className="icon-button send-button" type="submit" disabled={!conversationReady || !prompt.trim() || stopping} title={running ? "Queue follow-up" : "Send prompt"} aria-label={running ? "Queue follow-up" : "Send prompt"}>
                <ArrowUp size={17} />
              </button>
            )}
          </>
        )}
        content={references.length > 0 ? (
          <div className="composer-references" aria-label="Referenced files">
            {references.map((reference) => (
              <span className="reference-chip" key={reference.path} title={reference.path}>
                <FileCode2 size={12} />
                <span>{reference.path}</span>
                <button
                  type="button"
                  onClick={() => setReferences((items) => items.filter(({ path }) => path !== reference.path))}
                  title={`Remove ${reference.path}`}
                  aria-label={`Remove ${reference.path}`}
                >
                  <X size={11} />
                </button>
              </span>
            ))}
          </div>
        ) : null}
        disabled={!conversationReady}
        leading={(
          <div className="reference-picker-wrap">
            <button
              className="icon-button composer-attach-button"
              type="button"
              onClick={() => pickerOpen ? setPickerOpen(false) : void openPicker()}
              disabled={!conversationReady}
              title="Reference file"
              aria-label="Reference file"
              aria-expanded={pickerOpen}
            >
              <Plus size={17} />
            </button>
            {pickerOpen ? (
              <div className="reference-picker">
                <input
                  autoFocus
                  aria-label="Search workspace files"
                  placeholder="Search files"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => { if (event.key === "Escape") setPickerOpen(false); }}
                />
                <div className="reference-picker-list">
                  {loadingFiles ? <span>Loading files</span> : pickerError ? <span className="error-state">{pickerError}</span> : filteredFiles.length ? (
                    filteredFiles.slice(0, 100).map((file) => (
                      <button
                        type="button"
                        key={file.path}
                        title={file.path}
                        onClick={() => {
                          setReferences((items) => [...items, { type: "workspace-file", path: file.path }]);
                          setQuery("");
                          setPickerOpen(false);
                          textarea.current?.focus();
                        }}
                      >
                        <FileCode2 size={13} />
                        <span>{file.path}</span>
                      </button>
                    ))
                  ) : <span>No matching files</span>}
                </div>
              </div>
            ) : null}
          </div>
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
