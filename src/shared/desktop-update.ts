export type DesktopUpdatePhase = "check" | "download" | "prepare" | "install";
export type DesktopUpdateRetry = "check" | "download" | "install";
export type DesktopUpdateErrorCode =
  | "network"
  | "storage"
  | "verification"
  | "permission"
  | "save"
  | "shutdown"
  | "installer"
  | "unknown";

export type DesktopUpdateStatus =
  | { type: "idle" }
  | { type: "checking" }
  | { type: "up-to-date" }
  | { type: "available"; version: string }
  | { type: "downloading"; version: string; percent: number }
  | { type: "ready"; version: string }
  | { type: "installing"; version: string }
  | {
      type: "error";
      phase: DesktopUpdatePhase;
      code: DesktopUpdateErrorCode;
      title: string;
      message: string;
      detail: string;
      retry: DesktopUpdateRetry;
      version?: string;
      dataSafe: true;
    };

export interface DesktopUpdateState {
  currentVersion: string;
  status: DesktopUpdateStatus;
}
