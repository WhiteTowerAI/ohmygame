import { Fragment, useEffect, useId, useLayoutEffect, useRef, useState, type KeyboardEvent, type RefObject } from "react";
import type { AgentUsageLimit, ConversationCapabilities } from "../shared/contracts.js";
import { AgentUsageInline } from "./agent-usage.js";
import { ClipboardList, FileText, Paperclip, Plug, Plus, Share2, Sparkles, WandSparkles } from "./icons.js";
import { attachmentFiles, type ComposerAttachment } from "./composer-attachments.js";
import { matchingMentions, mentionQuery, slashCommandQuery, skillDisplayName, type ComposerMention, type ComposerMentionQuery } from "./composer-mentions.js";
import { t } from "./i18n.js";
import { PluginGlyph } from "./plugin-icons.js";
import { DropdownMenu, type MenuEntry } from "./ui/index.js";

type ContextAction = "plan" | "compact" | "publish";
interface ContextMenuItem {
  id: string;
  section: "Commands" | "Plugins" | "Skills";
  label: string;
  description: string;
  source?: string;
  command?: "plan" | "compact" | "publish";
  action?: ContextAction;
  mention?: ComposerMention;
}

/**
 * What a typed "/", "@" or "$" offers: "/" the commands and skills, "@" the
 * plugins and skills, "$" the skills. With no query it is the "/" list, as
 * the + menu opens it. Attaching files and the modes live in the + menu.
 */
export function composerContextItems({ capabilities, query, planning, canTogglePlanning, showCompact = false, contextPercent, canPublish = false }: {
  capabilities: ConversationCapabilities;
  query?: ComposerMentionQuery;
  planning: boolean;
  canTogglePlanning: boolean;
  showCompact?: boolean;
  contextPercent?: number;
  canPublish?: boolean;
}): ContextMenuItem[] {
  const trigger = query?.trigger ?? "/";
  const actions: ContextMenuItem[] = trigger !== "/" ? [] : [
    ...(canTogglePlanning ? [{ id: "plan", command: "plan" as const, section: "Commands" as const, label: t("planMode.mode"), description: planning ? t("planMode.turnOff") : t("planMode.turnOn"), action: "plan" as const }] : []),
    ...(showCompact ? [{ id: "compact", command: "compact" as const, section: "Commands" as const, label: t("planMode.compact"), description: `${t("planMode.compactHint")}${contextPercent === undefined ? "" : t("planMode.full", { percent: contextPercent })}`, action: "compact" as const }] : []),
    ...(canPublish ? [{ id: "publish", command: "publish" as const, section: "Commands" as const, label: t("contextMenu.publish"), description: t("contextMenu.publishHint"), action: "publish" as const }] : []),
  ];
  const search = query?.query ?? "";
  return [
    ...actions.filter((item) => item.command!.startsWith(search) || (item.command === "compact" && search.startsWith("compact "))),
    ...matchingMentions(planning ? { plugins: capabilities.plugins, skills: [] } : capabilities, query ?? { start: 0, end: 0, trigger: "/", query: "" }).map((mention): ContextMenuItem => {
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

export function useComposerContextMenu({ prompt, cursor, textarea, disabled, capabilities, planning, canTogglePlanning, onFiles, onDesignReference, onTogglePlanning, onCompact, onPublish, onMention, onChange, onSelectionChange, contextPercent, canPublish, usageLimits }: {
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
  onCompact?: () => void;
  onPublish?: () => void;
  onMention: (mention: ComposerMention, query?: ComposerMentionQuery) => void;
  onChange: (value: string) => void;
  onSelectionChange: (cursor: number) => void;
  contextPercent?: number;
  canPublish?: boolean;
  /** A coding agent's account quota, shown under the commands when they are opened with "/". */
  usageLimits?: AgentUsageLimit[];
}) {
  const id = useId();
  const menu = useRef<HTMLDivElement>(null);
  const filesInput = useRef<HTMLInputElement>(null);
  // The + menu opens the "/" or "@" list without typing it.
  const [openedWith, setOpenedWith] = useState<"/" | "@">();
  const [dismissed, setDismissed] = useState<string>();
  const [selected, setSelected] = useState(0);
  const candidate = mentionQuery(prompt, cursor) ?? slashCommandQuery(prompt, cursor);
  const mentionKey = candidate ? `${candidate.start}:${candidate.trigger}:${candidate.query}` : undefined;
  const typed = mentionKey === dismissed ? undefined : candidate;
  const query: ComposerMentionQuery | undefined = typed ?? (openedWith ? { start: cursor, end: cursor, trigger: openedWith, query: "" } : undefined);
  const open = !disabled && Boolean(query);
  const items = composerContextItems({ capabilities, query, planning, canTogglePlanning, showCompact: Boolean(onCompact), contextPercent, canPublish });
  const selectedIndex = Math.min(selected, Math.max(0, items.length - 1));

  useEffect(() => setSelected(0), [query?.start, query?.trigger, query?.query]);
  useEffect(() => {
    if (!mentionKey) setDismissed(undefined);
    else setOpenedWith(undefined);
  }, [mentionKey]);
  useEffect(() => {
    if (disabled) {
      setOpenedWith(undefined);
      setDismissed(mentionKey);
    }
  }, [disabled]);
  useEffect(() => {
    if (!open) return;
    const closeOutside = (event: Event) => {
      const target = event.target as Node;
      if (target === textarea.current || menu.current?.contains(target)) return;
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
    setOpenedWith(undefined);
    setDismissed(mentionKey);
  }

  function openList(trigger: "/" | "@"): void {
    setDismissed(undefined);
    setSelected(0);
    setOpenedWith(trigger);
    // The menu hands focus back to its button as it closes; the list belongs to the field.
    requestAnimationFrame(() => textarea.current?.focus());
  }

  function select(item: ContextMenuItem): void {
    close();
    if (item.mention) {
      onMention(item.mention, query);
      return;
    }
    if (item.action === "compact") {
      onCompact?.();
      textarea.current?.focus();
      return;
    }
    // Actions consume the search token, leaving the message draft intact.
    if (query && query.end > query.start) {
      onChange(`${prompt.slice(0, query.start)}${prompt.slice(query.end).replace(/^\s+/, "")}`);
      onSelectionChange(query.start);
      requestAnimationFrame(() => textarea.current?.setSelectionRange(query.start, query.start));
    }
    if (item.action === "plan") onTogglePlanning();
    else if (item.action === "publish") onPublish?.();
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
    if (!items.length && query?.trigger === "/" && event.key === "Enter" && !event.shiftKey) {
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

  const addItems: MenuEntry[] = [
    { label: t("contextMenu.attachFiles"), icon: <Paperclip size={14} />, onSelect: () => filesInput.current?.click() },
    ...(onDesignReference ? [{ label: t("contextMenu.design"), icon: <FileText size={14} />, onSelect: onDesignReference }] : []),
    ...(canTogglePlanning ? ["separator" as const, { label: t("planMode.mode"), icon: <ClipboardList size={14} />, checked: planning, onSelect: onTogglePlanning }] : []),
    "separator",
    { label: t("contextMenu.commandsAndSkills"), icon: <Sparkles size={14} />, shortcut: "/", onSelect: () => openList("/") },
    ...(capabilities.plugins.length ? [{ label: t("contextMenu.mentionPlugin"), icon: <Plug size={14} />, shortcut: "@", onSelect: () => openList("@") }] : []),
  ];

  return {
    open,
    handleKeyDown,
    button: <>
      <DropdownMenu placement="top-start" items={addItems} trigger={(props) => (
        <button
          {...props}
          className="icon-button composer-attach-button"
          type="button"
          disabled={disabled}
          aria-label={t("contextMenu.trigger")}
          title={t("contextMenu.trigger")}
        ><Plus size={17} /></button>
      )} />
      <input ref={filesInput} className="visually-hidden" type="file" multiple tabIndex={-1} aria-hidden="true" onChange={(event) => {
        const files = attachmentFiles([...(event.target.files ?? [])]);
        if (files.length) onFiles(files);
        event.target.value = "";
        textarea.current?.focus();
      }} />
    </>,
    overlay: open ? <ComposerContextMenu id={id} menuRef={menu} trigger={query?.trigger ?? "/"} items={items} selected={selectedIndex} onSelect={select} onHover={setSelected} usageLimits={query?.trigger === "/" ? usageLimits : undefined} /> : null,
    suggestions: open ? { id, activeId: items[selectedIndex] ? `${id}-${items[selectedIndex].id}` : undefined } : undefined,
  };
}

function ComposerContextMenu({ id, menuRef, trigger, items, selected, onSelect, onHover, usageLimits }: {
  id: string;
  trigger: "/" | "@" | "$";
  usageLimits?: AgentUsageLimit[];
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
    // The floating bar's composer is bounded by the area it floats over.
    const pane = anchor.closest(".agent-body, .home-page, .dock-body");
    const content = anchor.closest(".desktop-window-content");
    const updateHeight = () => {
      const anchorRect = anchor.getBoundingClientRect();
      const paneRect = pane?.getBoundingClientRect();
      const contentRect = content?.getBoundingClientRect();
      const top = Math.max(0, paneRect?.top ?? 0, contentRect?.top ?? 0);
      const bottom = Math.min(
        window.innerHeight,
        paneRect?.bottom ?? window.innerHeight,
        contentRect?.bottom ?? window.innerHeight,
      );
      const above = Math.max(0, anchorRect.top - top - 12);
      const below = Math.max(0, bottom - anchorRect.bottom - 12);
      // Include the section heading, first option, and menu padding.
      const minimumMenuHeight = 84;
      const openBelow = above < minimumMenuHeight && below >= minimumMenuHeight;
      const openInside = above < minimumMenuHeight && below < minimumMenuHeight;
      element.classList.toggle("is-below", openBelow);
      element.classList.toggle("is-inside", openInside);
      element.style.top = openInside ? `${Math.max(0, top - anchorRect.top + 6)}px` : "";
      element.style.maxHeight = `${Math.min(400, openInside
        ? Math.max(0, bottom - Math.max(top, anchorRect.top) - 12)
        : openBelow ? below : above)}px`;
    };
    updateHeight();
    const observer = new ResizeObserver(updateHeight);
    observer.observe(anchor);
    if (pane) observer.observe(pane);
    if (content) observer.observe(content);
    window.addEventListener("resize", updateHeight);
    window.addEventListener("scroll", updateHeight, true);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", updateHeight);
      window.removeEventListener("scroll", updateHeight, true);
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

  return <div ref={menuRef} id={id} className="composer-command-menu composer-context-menu" role="listbox" aria-label={t(`contextMenu.list.${trigger === "/" ? "commands" : trigger === "@" ? "mentions" : "skills"}`)} onMouseDown={(event) => event.preventDefault()}>
    {items.length ? items.map((item, index) => <Fragment key={item.id}>
      {item.section !== items[index - 1]?.section ? <div className="composer-context-menu-section" role="presentation">{t(`contextMenu.section.${item.section}`)}</div> : null}
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
        <span className="composer-context-menu-icon">{item.action === "plan" ? <ClipboardList size={14} /> : item.action === "compact" ? <FileText size={14} /> : item.action === "publish" ? <Share2 size={14} /> : item.mention?.type === "plugin" ? <PluginGlyph plugin={item.mention.value} size={14} /> : <WandSparkles size={14} />}</span>
        <span className={item.command ? "composer-context-menu-command" : undefined}>{item.command ? `/${item.command}` : item.label}</span>
        <small>{item.command ? item.label : item.description}</small>
      </button>
    </Fragment>) : <div className="composer-context-menu-empty" role="status">{t("contextMenu.noMatch")}</div>}
    {usageLimits?.length ? <div className="composer-context-menu-usage" role="status" aria-label={t("agentUsage.title")}><AgentUsageInline limits={usageLimits} compact /></div> : null}
    <div className="composer-context-menu-foot" aria-hidden="true"><kbd>↑↓</kbd>{t("contextMenu.keys.select")}<kbd>↵</kbd>{t("contextMenu.keys.use")}<kbd>esc</kbd>{t("contextMenu.keys.close")}</div>
  </div>;
}
