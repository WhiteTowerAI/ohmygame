import type { PlayablePresetSummary } from "../shared/playable-editor.js";
import { t } from "./i18n.js";
import { playableTemplateText } from "./playable-template-labels.js";
import { templateAssetUrl } from "./template-assets.js";
import { Dialog } from "./ui/index.js";

/**
 * Pictures of each Template as a new Scene looks: its starter source with the
 * default Project Style and Last Bus artwork, titled with the Template's name.
 * Recapture them from the canvas thumbnails when a Template's source changes.
 * The Story map's shows a sample story partly played instead, since a new
 * one has nothing seen to show, and the Visual Novel's shows its first line
 * of dialogue.
 */
const TEMPLATE_PICTURES: Record<string, string> = Object.fromEntries(
  ["blank", "choice", "ending", "hotspot", "main-menu", "qte", "story-map", "visual-novel"]
    .map((id) => [id, templateAssetUrl(`${id}.webp`)]),
);

/** Add a Scene: a grid of Templates, each with a picture and one line. */
export function PlayableTemplateDialog({ presets, busy, onChoose, onClose }: {
  presets: readonly PlayablePresetSummary[];
  busy: boolean;
  onChoose: (presetId: string) => void;
  onClose: () => void;
}) {
  return <Dialog open size="lg" className="playable-template-dialog" title={t("storyMenu.addAScene")} description={t("storyMenu.templateHint")} onClose={onClose}>
    <div className="playable-template-grid">
      {presets.map((preset) => <button
        type="button"
        className="playable-template"
        key={preset.id}
        disabled={busy}
        onClick={() => onChoose(preset.id)}
      >
        <span className="playable-template-picture">
          {TEMPLATE_PICTURES[preset.id] ? <img src={TEMPLATE_PICTURES[preset.id]} alt="" /> : null}
        </span>
        <strong>{playableTemplateText(preset).label}</strong>
        <small>{playableTemplateText(preset).summary}</small>
      </button>)}
    </div>
  </Dialog>;
}
