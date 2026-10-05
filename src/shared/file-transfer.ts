export const MAX_ATTACHMENT_BYTES = 500 * 1024 * 1024;
export const MAX_ATTACHMENT_FILES = 1_000;
export const MAX_ATTACHMENT_BATCH_BYTES = 1024 * 1024 * 1024;

export interface DesktopClipboardFile {
  name: string;
  relativePath: string;
  lastModified: number;
  bytes: Uint8Array;
}
