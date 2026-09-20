import { FileText, FolderInput, Plus, X } from "./icons.js";
import { Fragment, useEffect, useMemo, useRef } from "react";
import { formatBytes } from "./format-bytes.js";

export interface ComposerAttachment {
  id: string;
  file: File;
  relativePath: string;
}

export type AttachmentInput = File | { file: File; relativePath?: string };

export function attachmentFiles(files: AttachmentInput[]): ComposerAttachment[] {
  const seen = new Set<string>();
  return files.flatMap((value) => {
    const file = value instanceof File ? value : value.file;
    const relativePath = (value instanceof File ? file.webkitRelativePath : value.relativePath) || file.webkitRelativePath || file.name;
    if (!file.name || seen.has(relativePath)) return [];
    seen.add(relativePath);
    return [{ id: crypto.randomUUID(), file, relativePath }];
  });
}

export function AttachmentPickerButton({
  disabled,
  onFiles,
}: {
  disabled?: boolean;
  onFiles: (files: ComposerAttachment[]) => void;
}) {
  const filesInput = useRef<HTMLInputElement>(null);
  const folderInput = useRef<HTMLInputElement>(null);
  const select = (files: FileList | null) => {
    const attachments = attachmentFiles([...(files ?? [])]);
    if (attachments.length) onFiles(attachments);
  };

  return (
    <>
      <button
        className="icon-button composer-attach-button"
        type="button"
        disabled={disabled}
        onClick={() => filesInput.current?.click()}
        title="Attach files"
        aria-label="Attach files"
      >
        <Plus size={17} />
      </button>
      <button
        className="icon-button composer-attach-button"
        type="button"
        disabled={disabled}
        onClick={() => folderInput.current?.click()}
        title="Attach folder"
        aria-label="Attach folder"
      >
        <FolderInput size={16} />
      </button>
      <input
        ref={filesInput}
        className="visually-hidden"
        type="file"
        multiple
        onChange={(event) => {
          select(event.target.files);
          event.target.value = "";
        }}
      />
      <input
        ref={(input) => {
          folderInput.current = input;
          if (input) input.setAttribute("webkitdirectory", "");
        }}
        className="visually-hidden"
        type="file"
        multiple
        onChange={(event) => {
          select(event.target.files);
          event.target.value = "";
        }}
      />
    </>
  );
}

export function AttachmentStrip({ items, onRemove }: { items: ComposerAttachment[]; onRemove: (id: string) => void }) {
  if (!items.length) return null;
  const images = items.filter(isPreviewableImage);
  const files = items.filter((attachment) => !isPreviewableImage(attachment));
  return (
    <Fragment>
      {images.length ? <div className="composer-images" aria-label="Attached images">
        {images.map((attachment) => <ImageAttachment key={attachment.id} attachment={attachment} onRemove={onRemove} />)}
      </div> : null}
      {files.length ? <div className="composer-attachments" aria-label="Attached files">
        {files.map((attachment) => (
          <div className="composer-attachment" key={attachment.id} title={`${attachment.relativePath} · ${formatBytes(attachment.file.size)}`}>
            <FileText size={14} />
            <span>{attachment.relativePath}</span>
            <button type="button" onClick={() => onRemove(attachment.id)} title={`Remove ${attachment.relativePath}`} aria-label={`Remove ${attachment.relativePath}`}>
              <X size={11} />
            </button>
          </div>
        ))}
      </div> : null}
    </Fragment>
  );
}

function ImageAttachment({ attachment, onRemove }: { attachment: ComposerAttachment; onRemove: (id: string) => void }) {
  const source = useMemo(() => URL.createObjectURL(attachment.file), [attachment.file]);
  useEffect(() => () => URL.revokeObjectURL(source), [source]);
  return <div className="composer-image" title={`${attachment.relativePath} · ${formatBytes(attachment.file.size)}`}>
    <img src={source} alt={attachment.relativePath} />
    <button type="button" onClick={() => onRemove(attachment.id)} title={`Remove ${attachment.relativePath}`} aria-label={`Remove ${attachment.relativePath}`}>
      <X size={11} />
    </button>
  </div>;
}

function isPreviewableImage(attachment: ComposerAttachment): boolean {
  return ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(attachment.file.type)
    || /\.(?:png|jpe?g|webp|gif)$/i.test(attachment.file.name);
}
