/**
 * OhMyGame's game_use opens a game with this query parameter, and reads
 * `globalThis.__OHMYGAME_PLAYTEST__.snapshot()` as the game's state.
 */
export const PLAYTEST_PARAMETER = "ohmygamePlaytest";

interface PlaytestBridge {
  snapshot?: () => unknown;
  [method: string]: unknown;
}

type PlaytestScope = { __OHMYGAME_PLAYTEST__?: unknown; location?: { search?: string } };

/** Whether this page is one of OhMyGame's playtests. */
export function inPlaytest(scope: PlaytestScope = globalThis as PlaytestScope): boolean {
  try {
    return new URLSearchParams(scope.location?.search ?? "").get(PLAYTEST_PARAMETER) === "1";
  } catch {
    return false;
  }
}

/**
 * In a playtest, adds `snapshot` to the page's playtest bridge, creating the
 * bridge when there is none. A game's own `snapshot` stays: the game knows
 * best what it shows. Returns what takes it away again.
 */
export function offerPlaytestSnapshot(snapshot: () => unknown, scope: PlaytestScope = globalThis as PlaytestScope): () => void {
  if (!inPlaytest(scope)) return () => {};
  const existing = scope.__OHMYGAME_PLAYTEST__;
  if (existing !== undefined && (typeof existing !== "object" || existing === null)) return () => {};
  const bridge = (existing ?? {}) as PlaytestBridge;
  if (typeof bridge.snapshot === "function") return () => {};
  bridge.snapshot = snapshot;
  if (existing === undefined) scope.__OHMYGAME_PLAYTEST__ = bridge;
  return () => {
    if (bridge.snapshot !== snapshot) return;
    delete bridge.snapshot;
    if (scope.__OHMYGAME_PLAYTEST__ === bridge && Object.keys(bridge).length === 0) delete scope.__OHMYGAME_PLAYTEST__;
  };
}
