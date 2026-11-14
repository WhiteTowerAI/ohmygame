import {
  snapshot as readSnapshot,
  same as sameSnapshot,
  type Snapshot as MediaSnapshot,
} from "./media-settings-snapshot.js";
export { equal } from "./media-settings-snapshot.js";

export const FILES = [
  "seedance.json",
  "plugin-store/configuration.json",
  "model-visibility.json",
] as const;
export type File = (typeof FILES)[number];
export type Snapshot = MediaSnapshot<File>;
export function snapshot(directory: string): Promise<Snapshot> {
  return readSnapshot(directory, FILES);
}
export function same(a: Snapshot, b: Snapshot): boolean {
  return sameSnapshot(a, b, FILES);
}
