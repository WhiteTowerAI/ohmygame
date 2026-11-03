import { isRecord } from "./multiplayer-protocol.js";

export const GOMOKU_SIZE = 15;
export type GomokuCell = 0 | 1 | 2;
export interface GomokuPoint {
  r: number;
  c: number;
}
export interface GomokuState {
  board: GomokuCell[];
  history: GomokuPoint[];
  winningLine: GomokuPoint[];
  blackWins: number;
  whiteWins: number;
  [key: string]: unknown;
}

export function initialGomokuState(): GomokuState {
  return {
    board: Array<GomokuCell>(GOMOKU_SIZE ** 2).fill(0),
    history: [],
    winningLine: [],
    blackWins: 0,
    whiteWins: 0,
  };
}

export function isGomokuPoint(value: unknown): value is GomokuPoint {
  return (
    isRecord(value) &&
    Object.keys(value).length === 2 &&
    Number.isInteger(value.r) &&
    Number(value.r) >= 0 &&
    Number(value.r) < GOMOKU_SIZE &&
    Number.isInteger(value.c) &&
    Number(value.c) >= 0 &&
    Number(value.c) < GOMOKU_SIZE
  );
}

export function isGomokuState(value: unknown): value is GomokuState {
  return (
    isRecord(value) &&
    Array.isArray(value.board) &&
    value.board.length === GOMOKU_SIZE ** 2 &&
    value.board.every((cell) => cell === 0 || cell === 1 || cell === 2) &&
    Array.isArray(value.history) &&
    value.history.length <= GOMOKU_SIZE ** 2 &&
    value.history.every(isGomokuPoint) &&
    Array.isArray(value.winningLine) &&
    value.winningLine.every(isGomokuPoint) &&
    Number.isSafeInteger(value.blackWins) &&
    Number(value.blackWins) >= 0 &&
    Number.isSafeInteger(value.whiteWins) &&
    Number(value.whiteWins) >= 0
  );
}

export function gomokuWinningLine(
  board: GomokuCell[],
  point: GomokuPoint,
): GomokuPoint[] {
  const cell = board[point.r * GOMOKU_SIZE + point.c];
  if (!cell) return [];
  for (const [dr, dc] of [
    [0, 1],
    [1, 0],
    [1, 1],
    [1, -1],
  ]) {
    const line = [point];
    for (const direction of [-1, 1]) {
      for (let distance = 1; distance < GOMOKU_SIZE; distance++) {
        const r = point.r + dr! * direction * distance;
        const c = point.c + dc! * direction * distance;
        if (
          r < 0 ||
          c < 0 ||
          r >= GOMOKU_SIZE ||
          c >= GOMOKU_SIZE ||
          board[r * GOMOKU_SIZE + c] !== cell
        )
          break;
        if (direction < 0) line.unshift({ r, c });
        else line.push({ r, c });
      }
    }
    if (line.length >= 5) return line;
  }
  return [];
}
