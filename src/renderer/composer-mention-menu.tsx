import { Package, WandSparkles } from "./icons.js";
import type { ComposerMention } from "./composer-mentions.js";

export function ComposerMentionMenu({ items, selected, onSelect }: {
  items: ComposerMention[];
  selected: number;
  onSelect: (item: ComposerMention) => void;
}) {
  if (items.length === 0) return null;
  return (
    <div className="composer-command-menu" role="listbox" aria-label="Composer mentions">
      {items.map((item, index) => {
        const name = item.type === "plugin" ? item.value.displayName : item.value.name;
        const key = item.type === "plugin" ? item.value.id : item.value.name;
        return <button
          className={selected === index ? "is-selected" : ""}
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
        </button>;
      })}
    </div>
  );
}
