import type { PlayablePresetSummary } from "../shared/playable-editor.js";
import { t } from "./i18n.js";

const TEMPLATE_TEXT_KEYS = {
  blank: "storyTemplates.blank",
  "main-menu": "storyTemplates.mainMenu",
  choice: "storyTemplates.choice",
  qte: "storyTemplates.qte",
  hotspot: "storyTemplates.hotspot",
  ending: "storyTemplates.ending",
  "story-map": "storyTemplates.storyMap",
  "visual-novel": "storyTemplates.visualNovel",
} as const;

/** Translate editor labels while keeping the daemon's IDs and agent context intact. */
export function playableTemplateText(
  preset: PlayablePresetSummary,
): Pick<PlayablePresetSummary, "label" | "summary"> {
  if (!Object.hasOwn(TEMPLATE_TEXT_KEYS, preset.id)) return preset;
  const key = TEMPLATE_TEXT_KEYS[preset.id as keyof typeof TEMPLATE_TEXT_KEYS];
  return { label: t(`${key}.label`), summary: t(`${key}.summary`) };
}
