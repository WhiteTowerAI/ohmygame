import type { LibraryUploadMediaType } from "../shared/contracts.js";
import { fileExtension, mediaFileInfo } from "../shared/media-files.js";
import type { TransferredFile } from "./file-transfer.js";

export type CanvasImportKind =
  | { kind: "document" }
  | { kind: "table"; delimiter: "," | "\t" }
  | { kind: "media"; mediaType: LibraryUploadMediaType }
  | { kind: "file" };

const DOCUMENT_EXTENSIONS = [".md", ".markdown", ".txt"];
const TABLE_EXTENSIONS = { ".csv": ",", ".tsv": "\t" } as const;

/** Documents, tables and Library media get their own nodes; any other file is kept in the project as a file node. */
export function canvasImportKind(name: string): CanvasImportKind {
  const extension = fileExtension(name).toLowerCase();
  if (DOCUMENT_EXTENSIONS.includes(extension)) return { kind: "document" };
  if (extension === ".csv" || extension === ".tsv")
    return { kind: "table", delimiter: TABLE_EXTENSIONS[extension] };
  const media = mediaFileInfo(name);
  return media
    ? { kind: "media", mediaType: media.contentType }
    : { kind: "file" };
}

/** System files that a dropped folder or archive carries along, which nobody means to import. */
export function isIgnoredImportPath(relativePath: string): boolean {
  const parts = relativePath.split(/[\\/]/);
  const name = parts.at(-1) ?? "";
  if (
    /^(?:\.DS_Store|Thumbs\.db|desktop\.ini)$/i.test(name) ||
    name.startsWith("._")
  )
    return true;
  // Inside a folder, hidden files and folders stay behind; a hidden file chosen on its own does not.
  return parts.some(
    (part, index) =>
      part === "__MACOSX" ||
      (parts.length > 1 && index > 0 && part.startsWith(".")),
  );
}

export interface DroppedFolder {
  name: string;
  /** Each file with its folder inside the dropped one, "" for the top level. */
  files: { file: File; directory: string }[];
  bytes: number;
}

/** Splits a transfer into the folders it carried and the files chosen on their own. */
export function droppedFolders(transferred: readonly TransferredFile[]): {
  folders: DroppedFolder[];
  files: TransferredFile[];
} {
  const folders = new Map<string, DroppedFolder>();
  const files: TransferredFile[] = [];
  for (const item of transferred) {
    const parts = (item.relativePath ?? "").split("/");
    if (parts.length < 2) {
      files.push(item);
      continue;
    }
    const name = parts[0]!;
    const folder = folders.get(name) ?? { name, files: [], bytes: 0 };
    folder.files.push({
      file: item.file,
      directory: parts.slice(1, -1).join("/"),
    });
    folder.bytes += item.file.size;
    folders.set(name, folder);
  }
  return { folders: [...folders.values()], files };
}
