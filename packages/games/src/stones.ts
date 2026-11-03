import { createRoomAdapter, nextTurn, type GameAdapter } from "@ohmygame/server/adapters";

const STONES = 21;

/** A take-away race: players take one to three stones in turn, and whoever takes the last wins. */
export function createStonesAdapter(): GameAdapter {
  const room = createRoomAdapter("turn-based");
  return {
    ...room,
    initialState: () => ({ ...room.initialState(), remaining: STONES }),
    validateCommand(state, playerId, command) {
      if (command.type !== "take" && command.type !== "pass")
        return room.validateCommand(state, playerId, command);
      if (state.phase === "closed") throw new Error("The room is closed.");
      if (state.phase !== "playing")
        throw new Error("The room is not playing a turn-based game.");
      if (state.currentPlayerId !== playerId)
        throw new Error("It is another player's turn.");
      if (command.type === "take" && (command.payload?.count ?? 0) > state.remaining)
        throw new Error("There are not enough stones remaining.");
    },
    applyCommand(state, playerId, command) {
      if (command.type !== "take" && command.type !== "pass")
        return room.applyCommand(state, playerId, command);
      const next = structuredClone(state);
      if (command.type === "take") next.remaining -= command.payload!.count!;
      if (next.remaining === 0) {
        next.phase = "finished";
        next.winnerPlayerId = playerId;
      } else nextTurn(next);
      return next;
    },
  };
}
