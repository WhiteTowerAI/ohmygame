import { isRecord, type RealtimeInput } from "@ohmygame/sdk/protocol";

/** The input arena and roam read: a direction from -1 to 1 on each axis. */
export interface DirectionInput {
  x: number;
  y: number;
}

export function validateDirection(input: RealtimeInput): void {
  const axis = (value: unknown) => typeof value === "number" && Number.isFinite(value) && Math.abs(value) <= 1;
  if (!isRecord(input) || Object.keys(input).length !== 2 || !axis(input.x) || !axis(input.y))
    throw new Error("Send a direction as { x, y }, each from -1 to 1.");
}

/**
 * Moves a seat up to unitsPerSecond for dt seconds, inside the 100 by 100 world. Input below
 * full tilt moves slower, and diagonals are no faster than straight lines.
 */
export function moveToward(
  player: { x: number; y: number },
  input: RealtimeInput,
  unitsPerSecond: number,
  dt: number,
): void {
  const { x, y } = input as unknown as DirectionInput;
  const length = Math.hypot(x, y);
  if (!length) return;
  const scale = (unitsPerSecond * dt * Math.min(1, length)) / length;
  player.x = Math.max(0, Math.min(100, player.x + x * scale));
  player.y = Math.max(0, Math.min(100, player.y + y * scale));
}
