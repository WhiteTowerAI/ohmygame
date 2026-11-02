// Values a person tunes while the game runs, kept in a file of the project.
// See docs/preview-runtime.md#game-tuning.

/** Where a project keeps its values; the first that exists is used. */
export const GAME_TUNING_FILES = ["public/tuning.json", "tuning.json"] as const;

export type GameTuningScalar = number | boolean;

export type GameTuningItem =
  | { id: string; label: string; value: number; min: number; max: number; step?: number }
  | { id: string; label: string; value: boolean };

export interface GameTuningState {
  /** Rises with every change, so a reader can drop a state older than one it has. */
  sequence: number;
  /** The file the values come from, relative to the project. */
  file?: string;
  /** The saved values; the last good ones while `error` is set. */
  values: GameTuningItem[];
  /** Values changed and not saved yet. */
  draft: Record<string, GameTuningScalar>;
  /** Why the file can't be used. */
  error?: string;
  /** A page of the game is listening for values. */
  connected: boolean;
}

/** A value the game should use: its draft, or else what is saved. */
export function gameTuningValue(state: Pick<GameTuningState, "draft">, item: GameTuningItem): GameTuningScalar {
  return Object.hasOwn(state.draft, item.id) ? state.draft[item.id] : item.value;
}
