import type {
  MultiplayerGameAdapter,
  MultiplayerGameState,
  TurnCommand,
} from "../shared/multiplayer-protocol.js";
import {
  GOMOKU_SIZE,
  gomokuWinningLine,
  initialGomokuState,
  isGomokuPoint,
  type GomokuState,
} from "../shared/gomoku.js";
import { createGameAdapter, nextTurn } from "./game.js";

/** Players send a coordinate; only the service places stones and decides victory. */
export function createGomokuAdapter(): MultiplayerGameAdapter<
  MultiplayerGameState,
  TurnCommand
> {
  const roomRules = createGameAdapter("turn-based");
  return {
    initialState: () => ({
      ...roomRules.initialState(),
      remaining: GOMOKU_SIZE ** 2,
      game: initialGomokuState(),
    }),
    validateCommand(state, playerId, command) {
      if (["start", "close", "kick"].includes(command.type)) {
        roomRules.validateCommand(state, playerId, command);
        if (command.type === "start" && state.players.length !== 2)
          throw new Error("Gomoku requires exactly two players.");
        return;
      }
      if (command.type !== "action")
        throw new Error("Gomoku only accepts move and reset actions.");
      const payload = command.payload!;
      if (payload.action === "reset" && Object.keys(payload).length === 1) {
        if (
          playerId !== state.ownerId ||
          !["playing", "finished"].includes(state.phase) ||
          state.players.length !== 2
        )
          throw new Error("Only the room owner can start a new match.");
        return;
      }
      if (
        payload.action !== "move" ||
        Object.keys(payload).length !== 2 ||
        !isGomokuPoint(payload.point)
      )
        throw new Error("Choose a valid board coordinate.");
      if (state.phase !== "playing")
        throw new Error("The match is not playing.");
      if (playerId !== state.currentPlayerId)
        throw new Error("It is another player's turn.");
      const game = state.game as GomokuState;
      if (game.board[payload.point.r * GOMOKU_SIZE + payload.point.c] !== 0)
        throw new Error("This intersection is occupied.");
    },
    applyCommand(state, playerId, command) {
      if (["start", "close", "kick"].includes(command.type))
        return roomRules.applyCommand(state, playerId, command);
      const next = structuredClone(state);
      const game = next.game as GomokuState;
      if (command.payload!.action === "reset") {
        next.game = {
          ...initialGomokuState(),
          blackWins: game.blackWins,
          whiteWins: game.whiteWins,
        };
        next.remaining = GOMOKU_SIZE ** 2;
        next.winnerPlayerId = "";
        next.phase = "playing";
        next.currentPlayerId = next.players[0]!.playerId;
        next.turnDeadline = Date.now() + 60_000;
        return next;
      }
      const point = command.payload!.point as { r: number; c: number };
      const cell = next.players[0]!.playerId === playerId ? 1 : 2;
      game.board[point.r * GOMOKU_SIZE + point.c] = cell;
      game.history.push({ ...point });
      game.winningLine = gomokuWinningLine(game.board, point);
      next.remaining--;
      if (game.winningLine.length) {
        next.phase = "finished";
        next.winnerPlayerId = playerId;
        if (cell === 1) game.blackWins++;
        else game.whiteWins++;
      } else if (!next.remaining) next.phase = "finished";
      else nextTurn(next);
      return next;
    },
    onTurnTimeout(state, now) {
      const next = structuredClone(state);
      // A missed turn is skipped; the service remains the time authority.
      nextTurn(next, now);
      return next;
    },
  };
}
