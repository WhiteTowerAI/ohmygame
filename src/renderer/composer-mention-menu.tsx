import { Package, WandSparkles } from "./icons.js";
import { useEffect, useLayoutEffect, useRef } from "react";
import { skillDisplayName, type ComposerMention } from "./composer-mentions.js";

export function ComposerMentionMenu({ items, selected, onSelect }: {
  items: ComposerMention[];
  selected: number;
  onSelect: (item: ComposerMention) => void;
}) {
  const menu = useRef<HTMLDivElement>(null);
  const selectedItem = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => {
    const element = menu.current;
    const anchor = element?.closest(".prompt-box");
    if (!element || !anchor) return;
    const updateHeight = () => {
      const boundary = anchor.closest(".agent-body")?.getBoundingClientRect().top ?? 0;
      const availableHeight = Math.max(48, anchor.getBoundingClientRect().top - boundary - 12);
      element.style.maxHeight = `${Math.min(360, availableHeight)}px`;
    };
    updateHeight();
    const observer = typeof ResizeObserver === "undefined" ? undefined : new ResizeObserver(updateHeight);
    observer?.observe(anchor);
    window.addEventListener("resize", updateHeight);
    return () => {
      observer?.disconnect();
      window.removeEventListener("resize", updateHeight);
    };
  }, [items.length]);
  useEffect(() => {
    selectedItem.current?.scrollIntoView({ block: "nearest" });
  }, [selected]);

  if (items.length === 0) return null;
  return (
    <div className="composer-command-menu composer-mention-menu" ref={menu} role="listbox" aria-label="Composer mentions">
      {items.map((item, index) => {
        const skillName = item.type === "skill" ? skillDisplayName(item.value.name) : undefined;
        const name = item.type === "plugin"
          ? item.value.displayName
          : item.value.pluginDisplayName ? `${item.value.pluginDisplayName}: ${skillName}` : skillName;
        const key = item.type === "plugin" ? item.value.id : item.value.name;
        const source = item.value.marketplaceDisplayName;
        return <button
          className={selected === index ? "is-selected" : ""}
          ref={selected === index ? selectedItem : undefined}
          key={`${item.type}:${key}`}
          type="button"
          role="option"
          aria-selected={selected === index}
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onSelect(item)}
        >
          {item.type === "plugin" ? <Package size={15} /> : <WandSparkles size={15} />}
          <span>{name}</span>
          <small>{item.value.description}</small>
          {source ? <em>{source}</em> : null}
        </button>;
      })}
    </div>
  );
}
