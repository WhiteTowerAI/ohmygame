import {
  REALTIME_TICK_MS,
  MULTIPLAYER_MAX_CLIENTS,
  MULTIPLAYER_MIN_CLIENTS,
  type MultiplayerGameAdapter,
  type MultiplayerGameState,
  type MultiplayerMode,
  type TurnCommand,
} from "@ohmygame/sdk/protocol";

export const TURN_SECONDS = 60;
export const TICK_MS = REALTIME_TICK_MS;

export function nextTurn(state: MultiplayerGameState, now = Date.now()): void {
  const index = state.players.findIndex(
    (player) => player.playerId === state.currentPlayerId,
  );
  state.currentPlayerId =
    state.players[(index + 1) % state.players.length]?.playerId ?? "";
  state.turnDeadline = now + TURN_SECONDS * 1000;
}

/**
 * The room's own commands: the owner starts, closes and removes players. Rules build on it
 * and handle their game's commands themselves; any other command is rejected.
 */
export function createRoomAdapter(
  mode: MultiplayerMode,
): MultiplayerGameAdapter<MultiplayerGameState, TurnCommand> {
  return {
    mode,
    players: { min: MULTIPLAYER_MIN_CLIENTS, max: MULTIPLAYER_MAX_CLIENTS },
    initialState: () => ({
      phase: "lobby",
      ownerId: "",
      currentPlayerId: "",
      winnerPlayerId: "",
      remaining: 0,
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
        if (next.phase === "playing" && next.players.length === 1) {
          next.phase = "finished";
          next.winnerPlayerId = next.players[0]!.playerId;
        }
      } else if (command.type === "start") {
        next.phase = "playing";
        next.currentPlayerId = next.players[0]!.playerId;
        next.turnDeadline = Date.now() + TURN_SECONDS * 1000;
      }
      return next;
    },
  };
}
