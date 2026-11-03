import type { ReactNode, Ref } from "react";
import { CategoryMark } from "./chip.js";
import type { Category } from "./display.js";
import "./media.css";

/** A project or library asset: a preview, its kind, its name and a short note. */
export function MediaTile({
  ref,
  src,
  preview,
  category,
  name,
  meta,
  selected = false,
  onClick,
  badge,
  ratio = "4 / 3",
}: {
  ref?: Ref<HTMLButtonElement>;
  src?: string;
  /** Drawn in place of an image (a video frame, a file mark). */
  preview?: ReactNode;
  category: Category;
  name: string;
  meta?: ReactNode;
  selected?: boolean;
  onClick?: () => void;
  badge?: ReactNode;
  ratio?: string;
}) {
  return (
    <button
      ref={ref}
      type="button"
      className={`ui-media${selected ? " is-selected" : ""}`}
      aria-pressed={onClick ? selected : undefined}
      onClick={onClick}
    >
      <span className="ui-media-preview" style={{ aspectRatio: ratio }}>
        {src ? (
          <img src={src} alt="" loading="lazy" draggable={false} />
        ) : (
          (preview ?? <CategoryMark category={category} size={20} />)
        )}
        {badge ? <span className="ui-media-badge">{badge}</span> : null}
      </span>
      <span className="ui-media-text">
        <span className="ui-media-name">
          <CategoryMark category={category} size={8} />
          <span className="ui-media-name-text">{name}</span>
        </span>
        {meta ? <span className="ui-media-meta">{meta}</span> : null}
      </span>
    </button>
  );
}
