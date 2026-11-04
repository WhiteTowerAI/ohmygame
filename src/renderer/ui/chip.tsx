import type { ReactNode } from "react";
import {
  Box,
  Database,
  FileCode2,
  FileText,
  Film,
  Image,
  Music2,
  TextField,
} from "../icons.js";
import { t } from "../i18n.js";
import type { Category } from "./display.js";
import "./chip.css";

const CATEGORY_ICON: Record<Category, typeof Box> = {
  document: FileText,
  text: TextField,
  image: Image,
  video: Film,
  audio: Music2,
  model: Box,
  code: FileCode2,
  data: Database,
};

/** A kind of content: its icon in its category hue, the same set the file tree uses. */
export function CategoryMark({
  category,
  size = 12,
}: {
  category: Category;
  size?: number;
}) {
  const Icon = CATEGORY_ICON[category];
  return (
    <span
      className="ui-category-mark"
      style={{ color: `var(--category-${category})` }}
      aria-hidden="true"
    >
      <Icon size={size + 2} />
    </span>
  );
}

export function Chip({
  category,
  outline = false,
  onRemove,
  children,
}: {
  category?: Category;
  outline?: boolean;
  onRemove?: () => void;
  children: ReactNode;
}) {
  return (
    <span
      className={`ui-chip${outline ? " ui-chip-outline" : ""}${category ? " ui-chip-with-mark" : ""}`}
    >
      {category ? <CategoryMark category={category} /> : null}
      <span className="ui-chip-label">{children}</span>
      {onRemove ? (
        <button
          type="button"
          className="ui-chip-remove"
          aria-label={t("ui.remove")}
          onClick={onRemove}
        >
          ×
        </button>
      ) : null}
    </span>
  );
}
