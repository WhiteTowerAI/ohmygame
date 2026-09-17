export interface GameMosaicSlot {
  column: number;
  row: number;
  size: 1 | 2 | 3;
}

export const HOME_GAME_MOSAIC_SLOTS: readonly GameMosaicSlot[] = [
  { column: 1, row: 1, size: 3 },
  { column: 4, row: 1, size: 2 },
  { column: 6, row: 1, size: 2 },
  { column: 8, row: 1, size: 1 },
  { column: 9, row: 1, size: 1 },
  { column: 10, row: 1, size: 1 },
  { column: 8, row: 2, size: 2 },
  { column: 10, row: 2, size: 1 },
  { column: 4, row: 3, size: 1 },
  { column: 5, row: 3, size: 2 },
  { column: 7, row: 3, size: 1 },
  { column: 10, row: 3, size: 1 },
  { column: 1, row: 4, size: 2 },
  { column: 3, row: 4, size: 1 },
  { column: 4, row: 4, size: 1 },
  { column: 7, row: 4, size: 2 },
  { column: 9, row: 4, size: 2 },
  { column: 3, row: 5, size: 3 },
  { column: 6, row: 5, size: 1 },
  { column: 1, row: 6, size: 1 },
  { column: 2, row: 6, size: 1 },
  { column: 6, row: 6, size: 2 },
  { column: 8, row: 6, size: 1 },
  { column: 9, row: 6, size: 2 },
  { column: 1, row: 7, size: 2 },
  { column: 8, row: 7, size: 1 },
  { column: 3, row: 8, size: 2 },
  { column: 6, row: 8, size: 3 },
];

export const GAME_DETAIL_MOSAIC_SLOTS: readonly GameMosaicSlot[] = [
  { column: 8, row: 1, size: 1 },
  { column: 8, row: 2, size: 1 },
  { column: 8, row: 3, size: 1 },
  { column: 8, row: 4, size: 1 },
  { column: 8, row: 5, size: 1 },
  { column: 6, row: 6, size: 2 },
  { column: 8, row: 6, size: 1 },
  { column: 8, row: 7, size: 1 },
  { column: 6, row: 8, size: 3 },
  { column: 1, row: 9, size: 2 },
  { column: 3, row: 9, size: 1 },
  { column: 3, row: 10, size: 1 },
  { column: 4, row: 8, size: 2 },
  { column: 1, row: 11, size: 3 },
  { column: 4, row: 11, size: 2 },
  { column: 7, row: 11, size: 2 },
  { column: 6, row: 11, size: 1 },
  { column: 6, row: 12, size: 1 },
  { column: 4, row: 13, size: 1 },
  { column: 5, row: 13, size: 1 },
  { column: 6, row: 13, size: 1 },
  { column: 7, row: 13, size: 1 },
  { column: 8, row: 13, size: 1 },
  { column: 1, row: 14, size: 1 },
  { column: 2, row: 14, size: 1 },
  { column: 3, row: 14, size: 2 },
  { column: 5, row: 14, size: 1 },
  { column: 6, row: 14, size: 2 },
];

export function takeGameMosaicSlots(slots: readonly GameMosaicSlot[], count: number): readonly GameMosaicSlot[] {
  return slots.slice(0, Math.max(0, Math.min(Math.floor(count), slots.length)));
}
