import { Check, FilePenLine, History, LoaderCircle, X } from "./icons.js";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ConversationSummary } from "../shared/contracts.js";

interface ConversationMenuProps {
  conversations: ConversationSummary[];
  currentConversationId?: string;
  activeConversationId?: string;
  disabled: boolean;
  onRename: (conversationId: string, title: string) => Promise<void>;
  onSelect: (conversationId: string) => void;
}

export function ConversationMenu({
  conversations,
  currentConversationId,
  activeConversationId,
  disabled,
  onRename,
  onSelect,
}: ConversationMenuProps) {
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const editInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) close();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      close();
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
    if (editingId) editInput.current?.select();
  }, [editingId]);

  function close(): void {
    setOpen(false);
    setEditingId(undefined);
    setError(undefined);
  }

  function startRename(conversation: ConversationSummary): void {
    setEditingId(conversation.id);
    setTitle(conversation.title);
    setError(undefined);
  }

  async function submitRename(event: FormEvent): Promise<void> {
    event.preventDefault();
    const nextTitle = title.trim();
    if (!editingId || !nextTitle || saving) return;
    setSaving(true);
    setError(undefined);
    try {
      await onRename(editingId, nextTitle);
      setEditingId(undefined);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  return (
    <div className="conversation-menu" ref={root}>
      <button
        ref={trigger}
        className="icon-button pane-header-action conversation-trigger"
        type="button"
        disabled={disabled}
        aria-expanded={open}
        aria-controls="conversation-menu-popover"
        aria-haspopup="dialog"
        title="Conversation history"
        aria-label="Conversation history"
        onClick={() => setOpen((value) => !value)}
      >
        <History size={14} />
      </button>

      {open ? (
        <div id="conversation-menu-popover" className="conversation-popover" role="dialog" aria-label="Conversations">
          <div className="conversation-popover-heading">Conversations</div>
          <div className="conversation-list">
            {conversations.map((conversation) => editingId === conversation.id ? (
              <form className="conversation-rename" key={conversation.id} onSubmit={submitRename}>
                <input
                  ref={editInput}
                  aria-label="Conversation title"
                  disabled={saving}
                  maxLength={80}
                  onChange={(event) => setTitle(event.target.value)}
                  value={title}
                />
                <button type="submit" disabled={!title.trim() || saving} title="Save title" aria-label="Save title">
                  {saving ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}
                </button>
                <button type="button" disabled={saving} onClick={() => setEditingId(undefined)} title="Cancel rename" aria-label="Cancel rename">
                  <X size={13} />
                </button>
              </form>
            ) : (
              <div className={`conversation-row${conversation.id === currentConversationId ? " conversation-row-current" : ""}`} key={conversation.id}>
                <button
                  className="conversation-option"
                  type="button"
                  onClick={() => {
                    close();
                    if (conversation.id !== currentConversationId) onSelect(conversation.id);
                  }}
                >
                  <span className="conversation-option-copy">
                    <span className="conversation-option-title">{conversation.title}</span>
                    <span className="conversation-option-meta">
                      {conversation.id === activeConversationId
                        ? "Running"
                        : conversation.messageCount === 0
                          ? "Empty"
                          : `${conversation.messageCount} ${conversation.messageCount === 1 ? "message" : "messages"}`}
                    </span>
                  </span>
                  <span className="conversation-option-mark" aria-hidden="true">
                    {conversation.id === currentConversationId ? <Check size={14} /> : null}
                  </span>
                </button>
                <button
                  className="conversation-rename-button"
                  type="button"
                  onClick={() => startRename(conversation)}
                  title="Rename conversation"
                  aria-label={`Rename ${conversation.title}`}
                >
                  <FilePenLine size={13} />
                </button>
              </div>
            ))}
          </div>
          {error ? <p className="conversation-menu-error" role="alert">{error}</p> : null}
        </div>
      ) : null}
    </div>
  );
}
