import {
  DEFAULT_TICK_MS,
  MULTIPLAYER_MAX_CLIENTS,
  MULTIPLAYER_MIN_CLIENTS,
  TICK_MS_RANGE,
  type MultiplayerGameAdapter,
  type MultiplayerGameState,
  type MultiplayerMode,
  type TurnCommand,
} from "@ohmygame/sdk/protocol";

export const TURN_SECONDS = 60;

/** A realtime adapter's tick in milliseconds: its own, or the default. */
export function tickMsOf(adapter: { tickMs?: number }): number {
  return adapter.tickMs ?? DEFAULT_TICK_MS;
}
/** Throws unless the tick is a whole number of milliseconds the service can run. */
export function checkTickMs(tickMs: number): void {
  if (!Number.isInteger(tickMs) || tickMs < TICK_MS_RANGE.min || tickMs > TICK_MS_RANGE.max)
    throw new Error(`tickMs must be a whole number from ${TICK_MS_RANGE.min} to ${TICK_MS_RANGE.max}.`);
}

export function nextTurn(state: MultiplayerGameState, now = Date.now()): void {
  const index = state.players.findIndex(
    (player) => player.playerId === state.currentPlayerId,
  );
  state.currentPlayerId =
    state.players[(index + 1) % state.players.length]?.playerId ?? "";
  state.turnDeadline = now + TURN_SECONDS * 1000;
}

/** Ends the match with these winners: one, several for a team, or none for a draw. */
export function finishMatch(state: MultiplayerGameState, winners: readonly string[]): void {
  state.phase = "finished";
  state.winnerPlayerIds = [...winners];
  state.winnerPlayerId = winners.length === 1 ? winners[0]! : "";
}

/**
 * The room's own commands: the owner starts, closes and removes players. Rules build on it
 * and handle their game's commands themselves; any other command is rejected. A match left
 * with fewer than players.min seats after a removal ends without a winner.
 */
export function createRoomAdapter(
  mode: MultiplayerMode,
  players: { min: number; max: number } = { min: MULTIPLAYER_MIN_CLIENTS, max: MULTIPLAYER_MAX_CLIENTS },
): MultiplayerGameAdapter<MultiplayerGameState, TurnCommand> {
  return {
    mode,
    players,
    initialState: () => ({
      phase: "lobby",
      ownerId: "",
      currentPlayerId: "",
      winnerPlayerId: "",
      turnDeadline: 0,
      players: [],
    }),
    validateCommand(state, playerId, command) {
      if (state.phase === "closed") throw new Error("The room is closed.");
      if (command.type === "close" || command.type === "kick") {
        if (state.ownerId !== playerId)
          throw new Error("Only the room owner can manage this room.");
        if (
          command.type === "kick" &&
          (!state.players.some(
            (p) => p.playerId === command.payload?.playerId,
          ) ||
            command.payload?.playerId === playerId)
        )
          throw new Error("Choose another player to remove.");
      } else if (command.type === "start") {
        // The room checks the player count against the adapter's seats.
        if (state.ownerId !== playerId || state.phase !== "lobby")
          throw new Error("Only the room owner can start the match.");
      } else throw new Error("This game does not support that action.");
    },
    applyCommand(state, _playerId, command) {
      const next = structuredClone(state);
      if (command.type === "close") next.phase = "closed";
      else if (command.type === "kick") {
        const id = command.payload!.playerId!;
        if (next.currentPlayerId === id) nextTurn(next);
        next.players = next.players.filter((p) => p.playerId !== id);
        if (next.phase === "playing" && next.players.length < players.min) finishMatch(next, []);
      } else if (command.type === "start") {
        next.phase = "playing";
        next.currentPlayerId = next.players[0]!.playerId;
        next.turnDeadline = Date.now() + TURN_SECONDS * 1000;
      }
      return next;
    },
  };
}
