import type {
  MultiplayerGameAdapter,
  MultiplayerGameState,
  MultiplayerMode,
  RealtimeInput,
  TurnCommand,
} from "../shared/multiplayer-protocol.js";

export const TURN_SECONDS = 60;
export const TICK_MS = 50;

export function nextTurn(state: MultiplayerGameState, now = Date.now()): void {
  const index = state.players.findIndex(
    (player) => player.playerId === state.currentPlayerId,
  );
  state.currentPlayerId =
    state.players[(index + 1) % state.players.length]?.playerId ?? "";
  state.turnDeadline = now + TURN_SECONDS * 1000;
}

export function createGameAdapter(
  mode: MultiplayerMode,
): MultiplayerGameAdapter<MultiplayerGameState, TurnCommand> {
  return {
    initialState: () => ({
      phase: "lobby",
      ownerId: "",
      currentPlayerId: "",
      winnerPlayerId: "",
      remaining: 21,
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
        if (
          state.ownerId !== playerId ||
          state.phase !== "lobby" ||
          state.players.filter((p) => p.connected).length < 2
        )
          throw new Error(
            "The owner can start when at least two players are connected.",
          );
      } else {
        if (command.type !== "take" && command.type !== "pass")
          throw new Error("This game does not support that action.");
        if (mode !== "turn-based" || state.phase !== "playing")
          throw new Error("The room is not playing a turn-based game.");
        if (state.currentPlayerId !== playerId)
          throw new Error("It is another player's turn.");
        if (
          command.type === "take" &&
          (command.payload?.count ?? 0) > state.remaining
        )
          throw new Error("There are not enough stones remaining.");
      }
    },
    applyCommand(state, playerId, command) {
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
      } else {
        if (command.type === "take") next.remaining -= command.payload!.count!;
        if (next.remaining === 0) {
          next.phase = "finished";
          next.winnerPlayerId = playerId;
        } else nextTurn(next);
      }
      return next;
    },
  };
}

/** Inputs expire after 250ms. Speed, arena bounds and victory are server rules. */
export function stepArena(
  state: MultiplayerGameState,
  inputs: ReadonlyMap<string, { input: RealtimeInput; at: number }>,
  now: number,
): MultiplayerGameState {
  const next = structuredClone(state);
  for (const player of next.players) {
    const entry = inputs.get(player.playerId);
    if (!player.connected || !entry || now - entry.at > 250) continue;
    const length = Math.max(1, Math.hypot(entry.input.x, entry.input.y));
    player.x = Math.max(0, Math.min(100, player.x + entry.input.x / length));
    player.y = Math.max(0, Math.min(100, player.y + entry.input.y / length));
    if (Math.hypot(player.x - 50, player.y - 50) < 4) {
      next.phase = "finished";
      next.winnerPlayerId = player.playerId;
      break;
    }
  }
  return next;
}
