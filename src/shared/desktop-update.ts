export type DesktopUpdateStatus =
  | { type: "idle" }
  | { type: "checking" }
  | { type: "up-to-date" }
  | { type: "available"; version: string }
  | { type: "downloading"; version: string; percent: number }
  | { type: "ready"; version: string }
  | { type: "error"; message: string };

export interface DesktopUpdateState {
  currentVersion: string;
  status: DesktopUpdateStatus;
}
