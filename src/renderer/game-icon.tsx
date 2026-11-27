import book from "./assets/game-icons/book.svg";
import controller from "./assets/game-icons/controller.svg";
import ghost from "./assets/game-icons/ghost.svg";
import internet from "./assets/game-icons/internet.svg";
import palette from "./assets/game-icons/palette.svg";
import puzzle01 from "./assets/game-icons/puzzle-01.svg";
import puzzle02 from "./assets/game-icons/puzzle-02.svg";
import randomDice from "./assets/game-icons/random-dice.svg";
import rocket from "./assets/game-icons/rocket.svg";
import "./game-icon.css";

/** The game icon pack's icons the app uses; see assets/game-icons/README.md. */
const GAME_ICONS = {
  book,
  controller,
  ghost,
  internet,
  palette,
  "puzzle-01": puzzle01,
  "puzzle-02": puzzle02,
  "random-dice": randomDice,
  rocket,
} as const;

export type GameIconName = keyof typeof GAME_ICONS;
/** Tile colours, named for the category hues in tokens.css they use. */
export type GameIconTone =
  "blue" | "orange" | "pink" | "green" | "purple" | "teal" | "gold" | "neutral";

/** A game icon in a rounded tile of its tone, for content rather than controls. */
export function GameIcon({
  name,
  tone,
  size = 40,
  className,
}: {
  name: GameIconName;
  tone: GameIconTone;
  size?: number;
  className?: string;
}) {
  return (
    <span
      className={`game-icon is-${tone}${className ? ` ${className}` : ""}`}
      style={{ width: size, height: size }}
      aria-hidden="true"
    >
      <span style={{ maskImage: `url("${GAME_ICONS[name]}")` }} />
    </span>
  );
}
