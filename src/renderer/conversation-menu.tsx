import { Archive, Check, ChevronDown, ChevronLeft, FilePenLine, LoaderCircle, RotateCcw, Search, Trash2, X } from "./icons.js";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ConversationSummary } from "../shared/contracts.js";
import { t } from "./i18n.js";
import { editedAgo } from "./app-sidebar.js";
import { Popover } from "./ui/index.js";

/** Below this many conversations the list fits at a glance and needs no search. */
const SEARCH_FROM = 8;

interface ConversationMenuProps {
  conversations: ConversationSummary[];
  currentConversationId?: string;
  activeConversationId?: string;
  disabled: boolean;
  onRename: (conversationId: string, title: string) => Promise<void>;
  onSelect: (conversationId: string) => void;
  onArchive?: (conversationId: string) => Promise<void>;
  /** The archived conversations, which can be restored or deleted for good. */
  archive?: {
    list: () => Promise<ConversationSummary[]>;
    restore: (conversationId: string) => Promise<void>;
    remove: (conversationId: string) => Promise<void>;
  };
}

export function ConversationMenu({
  conversations,
  currentConversationId,
  activeConversationId,
  disabled,
  onRename,
  onSelect,
  onArchive,
  archive,
}: ConversationMenuProps) {
  const [open, setOpen] = useState(false);
  const [editingId, setEditingId] = useState<string>();
  const [title, setTitle] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const [query, setQuery] = useState("");
  // The archive view replaces the list while it is open.
  const [archived, setArchived] = useState<ConversationSummary[]>();
  const [busyId, setBusyId] = useState<string>();
  const [confirmingId, setConfirmingId] = useState<string>();
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const editInput = useRef<HTMLInputElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);

  // The list opens over the page, so the panel's tab strip, which clips its
  // overflow, cannot cut it off.
  useEffect(() => {
    if (!open) return;
    requestAnimationFrame(() => (searchInput.current ?? document.querySelector<HTMLElement>("#conversation-menu-popover .conversation-option"))?.focus());
  }, [open]);

  useEffect(() => {
    if (editingId) editInput.current?.select();
  }, [editingId]);

  function close(): void {
    setOpen(false);
    setEditingId(undefined);
    setError(undefined);
    setArchived(undefined);
    setConfirmingId(undefined);
  }

  async function act(conversationId: string, operation: () => Promise<void>): Promise<void> {
    if (busyId) return;
    setBusyId(conversationId);
    setError(undefined);
    try { await operation(); }
    catch (cause) { setError(cause instanceof Error ? cause.message : String(cause)); }
    finally { setBusyId(undefined); }
  }

  const showArchived = () => archive && act("archive", async () => setArchived(await archive.list()));
  const restore = (conversation: ConversationSummary) => archive && act(conversation.id, async () => {
    await archive.restore(conversation.id);
    setArchived((items) => items?.filter((item) => item.id !== conversation.id));
  });
  const remove = (conversation: ConversationSummary) => {
    if (confirmingId !== conversation.id) { setConfirmingId(conversation.id); return; }
    void (archive && act(conversation.id, async () => {
      await archive.remove(conversation.id);
      setConfirmingId(undefined);
      setArchived((items) => items?.filter((item) => item.id !== conversation.id));
    }));
  };

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

  const normalizedQuery = query.trim().toLowerCase();
  const currentTitle = conversations.find((conversation) => conversation.id === currentConversationId)?.title || t("conversations.untitled");
  const visibleConversations = conversations.filter((conversation) => !normalizedQuery || conversation.title.toLowerCase().includes(normalizedQuery));

  return (
    <div className="conversation-menu" ref={root}>
      <button
        ref={trigger}
        className="conversation-trigger"
        type="button"
        disabled={disabled}
        aria-expanded={open}
        aria-controls="conversation-menu-popover"
        aria-haspopup="dialog"
        title={t("conversations.history")}
        onClick={() => setOpen((value) => !value)}
      >
        <span>{currentTitle}</span>
        <ChevronDown size={12} />
      </button>

      <Popover open={open} onClose={close} anchor={trigger} placement="bottom-start" className="conversation-popover" label={t("conversations.label")}>
        <div id="conversation-menu-popover">
          {archived ? <>
            <div className="conversation-archive-head">
              <button type="button" className="conversation-archive-back" onClick={() => { setArchived(undefined); setConfirmingId(undefined); }}
                aria-label={t("conversations.back")} title={t("conversations.back")}>
                <ChevronLeft size={14} />
              </button>
              <span>{t("conversations.showArchived")}</span>
            </div>
            <div className="conversation-list">
              {archived.map((conversation) => (
                <div className="conversation-row is-archived" key={conversation.id}>
                  <span className="conversation-option">
                    <span className="conversation-option-title">{conversation.title}</span>
                    <span className="conversation-option-meta">{editedAgo(conversation.updatedAt)}</span>
                  </span>
                  <span className="conversation-row-actions is-visible">
                  <button className="conversation-rename-button" type="button" disabled={Boolean(busyId)} onClick={() => void restore(conversation)}
                    title={t("conversations.restoreName", { title: conversation.title })} aria-label={t("conversations.restoreName", { title: conversation.title })}>
                    {busyId === conversation.id && confirmingId !== conversation.id ? <LoaderCircle className="spin" size={13} /> : <RotateCcw size={13} />}
                  </button>
                  <button className={`conversation-rename-button is-danger${confirmingId === conversation.id ? " is-confirming" : ""}`} type="button" disabled={Boolean(busyId)}
                    onClick={() => remove(conversation)} onBlur={() => setConfirmingId((id) => id === conversation.id ? undefined : id)}
                    title={t("conversations.deleteName", { title: conversation.title })} aria-label={t("conversations.deleteName", { title: conversation.title })}>
                    {confirmingId === conversation.id ? t("conversations.confirmDelete") : <Trash2 size={13} />}
                  </button>
                  </span>
                </div>
              ))}
              {!archived.length ? <div className="conversation-menu-empty">{t("conversations.noArchived")}</div> : null}
            </div>
            {archived.length ? <p className="conversation-archive-hint">{t("conversations.archivedHint")}</p> : null}
          </> : <>
          {conversations.length >= SEARCH_FROM ? (
            <label className="project-switcher-search">
              <Search size={13} />
              <input ref={searchInput} aria-label={t("conversations.search")} value={query} placeholder={t("conversations.search")} onChange={(event) => setQuery(event.target.value)} />
            </label>
          ) : <div className="conversation-menu-label">{t("conversations.label")}</div>}
          <div className="conversation-list">
            {visibleConversations.map((conversation) => editingId === conversation.id ? (
              <form className="conversation-rename" key={conversation.id} onSubmit={submitRename}>
                <input
                  ref={editInput}
                  aria-label={t("conversations.titleLabel")}
                  disabled={saving}
                  maxLength={80}
                  onChange={(event) => setTitle(event.target.value)}
                  value={title}
                />
                <button type="submit" disabled={!title.trim() || saving} title={t("conversations.saveTitle")} aria-label={t("conversations.saveTitle")}>
                  {saving ? <LoaderCircle className="spin" size={13} /> : <Check size={13} />}
                </button>
                <button type="button" disabled={saving} onClick={() => setEditingId(undefined)} title={t("conversations.cancelRename")} aria-label={t("conversations.cancelRename")}>
                  <X size={13} />
                </button>
              </form>
            ) : (
              <div className="conversation-row" key={conversation.id}>
                <button
                  className="conversation-option"
                  type="button"
                  aria-current={conversation.id === currentConversationId ? "true" : undefined}
                  onClick={() => {
                    close();
                    if (conversation.id !== currentConversationId) onSelect(conversation.id);
                  }}
                >
                  <span className="conversation-option-title">{conversation.title}</span>
                  <span className="conversation-option-meta">
                    {conversation.id === activeConversationId
                      ? t("conversations.running")
                      : conversation.messageCount === 0
                        ? t("conversations.empty")
                        : editedAgo(conversation.updatedAt)}
                  </span>
                  <span className="conversation-option-mark" aria-hidden="true">
                    {conversation.id === currentConversationId ? <Check size={14} /> : null}
                  </span>
                </button>
                <span className="conversation-row-actions">
                <button
                  className="conversation-rename-button"
                  type="button"
                  onClick={() => startRename(conversation)}
                  title={t("conversations.rename")}
                  aria-label={t("conversations.renameName", { title: conversation.title })}
                >
                  <FilePenLine size={13} />
                </button>
                {onArchive ? <button
                  className="conversation-rename-button"
                  type="button"
                  disabled={Boolean(busyId) || conversation.id === activeConversationId}
                  onClick={() => void act(conversation.id, () => onArchive(conversation.id))}
                  title={t("conversations.archive")}
                  aria-label={t("conversations.archiveName", { title: conversation.title })}
                >
                  {busyId === conversation.id ? <LoaderCircle className="spin" size={13} /> : <Archive size={13} />}
                </button> : null}
                </span>
              </div>
            ))}
            {!visibleConversations.length ? <div className="conversation-menu-empty">{t("conversations.noMatch")}</div> : null}
          </div>
          {archive ? (
            <button type="button" className="conversation-archive-link" disabled={busyId === "archive"} onClick={() => void showArchived()}>
              {busyId === "archive" ? <LoaderCircle className="spin" size={13} /> : <Archive size={13} />}
              <span>{t("conversations.showArchived")}</span>
            </button>
          ) : null}
          </>}
          {error ? <p className="conversation-menu-error" role="alert">{error}</p> : null}
        </div>
      </Popover>
    </div>
  );
}
