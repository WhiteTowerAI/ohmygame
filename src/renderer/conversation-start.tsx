import type { ProjectType } from "../shared/contracts.js";
import { t } from "./i18n.js";

type StarterKind = "game" | "story" | "assets";
type StarterStage = "new" | "going";

/** The starters per kind of project and how far along it is; each names its label and the message it fills. */
const STARTERS = {
  game: { new: ["game.design", "game.prototype"], going: ["game.playtest", "game.sound", "game.document"] },
  story: { new: ["story.outline", "story.opening"], going: ["story.branches", "story.dialogue"] },
  assets: { new: ["assets.style", "assets.character"], going: ["assets.set", "assets.variants"] },
} as const satisfies Record<StarterKind, Record<StarterStage, readonly string[]>>;

export interface ConversationStarter {
  id: string;
  label: string;
  prompt: string;
}

/** A new conversation's next steps: getting a project going, or carrying one on. */
export function conversationStarters(type: ProjectType, going: boolean): ConversationStarter[] {
  const kind: StarterKind = type === "interactive-story" ? "story" : type === "asset-canvas" ? "assets" : "game";
  const stage: StarterStage = going ? "going" : "new";
  const keys: readonly (typeof STARTERS)[StarterKind][StarterStage][number][] = STARTERS[kind][stage];
  return keys.map((id) => ({
    id,
    label: t(`conversationStart.${id}.label`),
    prompt: t(`conversationStart.${id}.prompt`),
  }));
}

/**
 * Above an empty conversation's composer: a quiet hint and a few next steps.
 * Choosing one only fills the composer, so the person can edit it before sending.
 */
export function ConversationStart({ type, going, onChoose }: {
  type: ProjectType;
  going: boolean;
  onChoose: (prompt: string) => void;
}) {
  return (
    <div className="conversation-start">
      <p>{t(going ? "conversationStart.hintGoing" : "conversationStart.hintNew")}</p>
      <div className="conversation-start-chips">
        {conversationStarters(type, going).map((starter) => (
          <button key={starter.id} type="button" className="conversation-start-chip" onClick={() => onChoose(starter.prompt)}>
            {starter.label}
          </button>
        ))}
      </div>
    </div>
  );
}
