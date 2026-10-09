import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { ConversationCapabilities } from "../shared/contracts.js";
import { FileText, Lightbulb, Package, Plus, Upload, WandSparkles } from "./icons.js";
import { attachmentFiles, type ComposerAttachment } from "./composer-attachments.js";
import { matchingMentions, mentionQuery, skillDisplayName, type ComposerMention, type ComposerMentionQuery } from "./composer-mentions.js";

type ContextAction = "files" | "design" | "plan";
interface ContextMenuItem {
  id: string;
  section: "Add" | "Plugins" | "Skills";
  label: string;
  description: string;
  source?: string;
  action?: ContextAction;
  mention?: ComposerMention;
}

export function composerContextItems({ capabilities, query, planning, canTogglePlanning, supportsDesign }: {
  capabilities: ConversationCapabilities;
  query?: ComposerMentionQuery;
  planning: boolean;
  canTogglePlanning: boolean;
  supportsDesign: boolean;
}): ContextMenuItem[] {
  const actions: ContextMenuItem[] = query?.trigger === "$" ? [] : [
    { id: "files", section: "Add", label: "Attach files", description: "Add files to this message", action: "files" },
    ...(supportsDesign ? [{ id: "design", section: "Add" as const, label: "Reference game design", description: "Use the saved design document", action: "design" as const }] : []),
    ...(canTogglePlanning ? [{ id: "plan", section: "Add" as const, label: "Plan mode", description: planning ? "Turn plan mode off" : "Turn plan mode on", action: "plan" as const }] : []),
  ];
  const search = query?.query ?? "";
  return [
    ...actions.filter((item) => `${item.label} ${item.description}`.toLowerCase().includes(search)),
    ...matchingMentions(planning ? { plugins: capabilities.plugins, skills: [] } : capabilities, query ?? { start: 0, end: 0, trigger: "@", query: "" }).map((mention): ContextMenuItem => {
      const skillName = mention.type === "skill" ? skillDisplayName(mention.value.name) : undefined;
      return {
        id: mention.type === "plugin" ? `plugin:${mention.value.id}` : `skill:${mention.value.name}`,
        section: mention.type === "plugin" ? "Plugins" : "Skills",
        label: mention.type === "plugin" ? mention.value.displayName : mention.value.pluginDisplayName ? `${mention.value.pluginDisplayName}: ${skillName}` : skillName!,
        description: mention.value.description,
        source: mention.value.marketplaceDisplayName,
        mention,
      };
    }),
  ];
}

export function useComposerContextMenu({ prompt, cursor, textarea, disabled, capabilities, planning, canTogglePlanning, onFiles, onDesignReference, onTogglePlanning, onMention, onChange, onSelectionChange }: {
  prompt: string;
  cursor: number;
  textarea: RefObject<HTMLTextAreaElement | null>;
  disabled: boolean;
  capabilities: ConversationCapabilities;
  planning: boolean;
  canTogglePlanning: boolean;
  onFiles: (files: ComposerAttachment[]) => void;
  onDesignReference?: () => void;
  onTogglePlanning: () => void;
  onMention: (mention: ComposerMention, query?: ComposerMentionQuery) => void;
  onChange: (value: string) => void;
  onSelectionChange: (cursor: number) => void;
}) {
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  const [openedByButton, setOpenedByButton] = useState(false);
  const [dismissed, setDismissed] = useState<string>();
  const [selected, setSelected] = useState(0);
  const candidate = mentionQuery(prompt, cursor);
  const mentionKey = candidate ? `${candidate.start}:${candidate.trigger}:${candidate.query}` : undefined;
  const query = mentionKey === dismissed ? undefined : candidate;
  const open = !disabled && (openedByButton || Boolean(query));
  const items = composerContextItems({ capabilities, query, planning, canTogglePlanning, supportsDesign: Boolean(onDesignReference) });
  const selectedIndex = Math.min(selected, Math.max(0, items.length - 1));

  useEffect(() => setSelected(0), [query?.start, query?.trigger, query?.query, openedByButton]);
  useEffect(() => {
    if (!mentionKey) setDismissed(undefined);
  }, [mentionKey]);
  useEffect(() => {
    if (disabled) {
      setOpenedByButton(false);
      setDismissed(mentionKey);
    }
  }, [disabled]);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: Event) => {
      const target = event.target as Node;
      if (target === textarea.current || menu.current?.contains(target) || trigger.current?.contains(target)) return;
      close();
    };
    document.addEventListener("pointerdown", closeOutside);
    document.addEventListener("focusin", closeOutside);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      document.removeEventListener("focusin", closeOutside);
    };
  }, [open, mentionKey]);

  function close(): void {
    setOpenedByButton(false);
    setDismissed(mentionKey);
  }

  function select(item: ContextMenuItem): void {
    close();
    if (item.mention) {
      onMention(item.mention, query);
      return;
    }
    // Actions consume the search token, leaving the message draft intact.
    if (query) {
      onChange(`${prompt.slice(0, query.start)}${prompt.slice(query.end).replace(/^\s+/, "")}`);
      onSelectionChange(query.start);
      requestAnimationFrame(() => textarea.current?.setSelectionRange(query.start, query.start));
    }
    if (item.action === "files") filesInput.current?.click();
    else if (item.action === "design") onDesignReference?.();
    else if (item.action === "plan") onTogglePlanning();
    textarea.current?.focus();
  }

  function handleKeyDown(event: KeyboardEvent): boolean {
    if (!open) return false;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      if (items.length) setSelected((selectedIndex + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length);
      return true;
    }
    if (event.key === "Tab" && (event.shiftKey || !items.length)) {
      close();
      return false;
    }
    if ((event.key === "Enter" && !event.shiftKey) || event.key === "Tab") {
      // Do not send a half-written mention when a search has no results.
      event.preventDefault();
      if (items[selectedIndex]) select(items[selectedIndex]);
      return true;
    }
    if (event.key !== "Escape") return false;
    event.preventDefault();
    event.stopPropagation();
    close();
    textarea.current?.focus();
    return true;
  }

  return {
    open,
    handleKeyDown,
    button: <>
      <button
        ref={trigger}
        className="icon-button composer-attach-button"
        type="button"
        disabled={disabled}
        aria-label="Add context or attach files"
        title="Add context or attach files"
        aria-expanded={open}
        aria-controls={open ? id : undefined}
        aria-haspopup="listbox"
        onKeyDown={handleKeyDown}
        onClick={() => {
          if (open) close();
          else {
            setOpenedByButton(true);
            setDismissed(undefined);
            setSelected(0);
          }
          textarea.current?.focus();
        }}
      ><Plus size={17} /></button>
      <input ref={filesInput} className="visually-hidden" type="file" multiple tabIndex={-1} aria-hidden="true" onChange={(event) => {
        const files = attachmentFiles([...(event.target.files ?? [])]);
        if (files.length) onFiles(files);
        event.target.value = "";
        textarea.current?.focus();
      }} />
    </>,
    overlay: open ? <ComposerContextMenu id={id} menuRef={menu} items={items} selected={selectedIndex} onSelect={select} onHover={setSelected} /> : null,
    suggestions: open ? { id, activeId: items[selectedIndex] ? `${id}-${items[selectedIndex].id}` : undefined } : undefined,
  };
}

function ComposerContextMenu({ id, menuRef, items, selected, onSelect, onHover }: {
  id: string;
  menuRef: RefObject<HTMLDivElement | null>;
  items: ContextMenuItem[];
  selected: number;
  onSelect: (item: ContextMenuItem) => void;
  onHover: (index: number) => void;
}) {
  const selectedItem = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const element = menuRef.current;
    const anchor = element?.closest(".prompt-box");
    if (!element || !anchor) return;
    const updateHeight = () => {
      const boundary = anchor.closest(".agent-body")?.getBoundingClientRect().top ?? 0;
      element.style.maxHeight = `${Math.min(400, Math.max(48, anchor.getBoundingClientRect().top - boundary - 12))}px`;
    };
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(anchor);
    const boundary = anchor.closest(".agent-body");
    if (boundary) observer.observe(boundary);
    window.addEventListener("resize", updateHeight);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateHeight);
    };
  }, [menuRef, items.length]);
  useEffect(() => {
    const element = menuRef.current;
    const item = selectedItem.current;
    if (!element || !item) return;
    if (selected === 0) {
      element.scrollTop = 0;
      return;
    }
    const boundary = element.getBoundingClientRect();
    const row = item.getBoundingClientRect();
    if (row.top < boundary.top + 6) element.scrollTop -= boundary.top + 6 - row.top;
    else if (row.bottom > boundary.bottom - 6) element.scrollTop += row.bottom - boundary.bottom + 6;
  }, [selected, items[selected]?.id, menuRef]);

  return <div ref={menuRef} id={id} className="composer-command-menu composer-context-menu" role="listbox" aria-label="Add context" onMouseDown={(event) => event.preventDefault()}>
    {items.length ? items.map((item, index) => <Fragment key={item.id}>
      {item.section !== items[index - 1]?.section ? <div className="composer-context-menu-section" role="presentation">{item.section}</div> : null}
      <button
        ref={selected === index ? selectedItem : undefined}
        id={`${id}-${item.id}`}
        type="button"
        tabIndex={-1}
        role="option"
        aria-selected={selected === index}
        className={selected === index ? "is-selected" : undefined}
        title={[item.label, item.description, item.source].filter(Boolean).join(" · ")}
        onMouseEnter={() => onHover(index)}
        onClick={() => onSelect(item)}
      >
        {item.action === "files" ? <Upload size={16} /> : item.action === "design" ? <FileText size={16} /> : item.action === "plan" ? <Lightbulb size={16} /> : item.mention?.type === "plugin" ? <Package size={16} /> : <WandSparkles size={16} />}
        <span>{item.label}</span>
        <small>{item.description}</small>
      </button>
    </Fragment>) : <div className="composer-context-menu-empty" role="status">No matching items</div>}
  </div>;
}
