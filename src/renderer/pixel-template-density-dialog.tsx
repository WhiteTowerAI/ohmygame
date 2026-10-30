import { useEffect, useId, useRef, useState } from "react";
import { PIXEL_ART_LEVELS, type PixelArtLevel } from "../shared/canvas-pixel-style.js";
import { pixelExampleImageUrl, pixelPresetExampleId } from "./asset-canvas-pixel-examples.js";
import { pixelArtLevelOptions, pixelAssetTemplatePresetIds, type PixelAssetTemplateCategory } from "./asset-canvas-pixel-workflows.js";
import { t } from "./i18n.js";

const LAST_LEVEL_KEY = "ohmygame.pixelTemplateLevel";

export function lastPixelTemplateLevel(): PixelArtLevel {
  const stored = localStorage.getItem(LAST_LEVEL_KEY);
  return PIXEL_ART_LEVELS.find((level) => level === stored) ?? "classic";
}

/** Shows the category's own example at each density; Maps have no per-density examples, so they use the scene. */
function levelPreviewUrl(category: PixelAssetTemplateCategory, level: PixelArtLevel): string | undefined {
  const own = pixelAssetTemplatePresetIds(category)
    .map((id) => pixelPresetExampleId(id, level))
    .find((id) => id?.startsWith(`${level}/`));
  return pixelExampleImageUrl(own ?? `${level}/${category === "terrain" ? "scene" : "character-sheet"}`);
}

export function PixelTemplateDensityDialog({ category, returnFocus, onClose, onConfirm }: {
  category: PixelAssetTemplateCategory;
  returnFocus: HTMLElement | null;
  onClose: () => void;
  onConfirm: (level: PixelArtLevel) => void;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  const [level, setLevel] = useState(lastPixelTemplateLevel);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus = returnFocus ?? (document.activeElement instanceof HTMLElement ? document.activeElement : undefined);
    dialog.current?.querySelector<HTMLInputElement>("input:checked")?.focus();
    const handleKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        onCloseRef.current();
      }
      if (event.key !== "Tab" || !dialog.current) return;
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>("button, input:checked")];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyboard);
    return () => {
      window.removeEventListener("keydown", handleKeyboard);
      previousFocus?.focus();
    };
  }, [returnFocus]);

  return (
    <div className="project-create-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section ref={dialog} className="project-create-dialog pixel-template-density-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <header><h2 id={titleId}>{t("assetCanvas.pixelPresets.densityDialogTitle", { category: t(`assetCanvas.pixelPresets.categories.${category}`) })}</h2></header>
        <form onSubmit={(event) => {
          event.preventDefault();
          localStorage.setItem(LAST_LEVEL_KEY, level);
          onConfirm(level);
        }}>
          <p className="pixel-template-density-hint">{t("assetCanvas.pixelPresets.densityDialogHint")}</p>
          <div className="pixel-template-density-options" role="radiogroup" aria-labelledby={titleId}>
            {pixelArtLevelOptions().map((option) => {
              const preview = levelPreviewUrl(category, option.value);
              return (
                <label key={option.value} className="pixel-template-density-option">
                  <input type="radio" name="pixel-template-density" value={option.value} checked={level === option.value} onChange={() => setLevel(option.value)} />
                  <span className="pixel-template-density-preview">{preview ? <img src={preview} alt="" /> : null}</span>
                  <strong>{option.label}</strong>
                  <small>{option.description}</small>
                </label>
              );
            })}
          </div>
          <footer>
            <button type="button" onClick={onClose}>{t("common.cancel")}</button>
            <button className="project-create-submit" type="submit">{t("assetCanvas.pixelPresets.densityDialogCreate")}</button>
          </footer>
        </form>
      </section>
    </div>
  );
}
