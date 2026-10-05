import { FileText, Plus, Upload, X } from "./icons.js";
import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { formatBytes } from "./format-bytes.js";
import type { PromptAttachment } from "../shared/contracts.js";
import { uploadProjectAttachment } from "./api.js";
import { MAX_ATTACHMENT_BATCH_BYTES, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_FILES } from "../shared/file-transfer.js";

export interface ComposerAttachment {
  id: string;
  file: File;
  relativePath: string;
}

export type AttachmentInput = File | { file: File; relativePath?: string };

export function appendAttachments(current: ComposerAttachment[], next: ComposerAttachment[]): ComposerAttachment[] {
  if (next.some((attachment) => attachment.file.size > MAX_ATTACHMENT_BYTES)) throw new Error("An attachment cannot exceed 500 MB");
  const paths = new Set(current.map((attachment) => attachment.relativePath));
  const duplicate = next.find((attachment) => {
    if (paths.has(attachment.relativePath)) return true;
    paths.add(attachment.relativePath);
    return false;
  });
  if (duplicate) throw new Error(`\"${duplicate.relativePath}\" is already attached`);
  const combined = [...current, ...next];
  if (combined.length > MAX_ATTACHMENT_FILES) throw new Error("Attach at most 1,000 files at a time");
  if (combined.reduce((total, attachment) => total + attachment.file.size, 0) > MAX_ATTACHMENT_BATCH_BYTES) throw new Error("Attached files cannot exceed 1 GB in total");
  return combined;
}

export async function uploadAttachments(projectId: string, batchId: string, attachments: ComposerAttachment[]): Promise<PromptAttachment[]> {
  const uploaded = new Array<PromptAttachment>(attachments.length);
  let next = 0;
  const results = await Promise.allSettled(Array.from({ length: Math.min(4, attachments.length) }, async () => {
    while (next < attachments.length) {
      const index = next++;
      const attachment = attachments[index]!;
      uploaded[index] = await uploadProjectAttachment(projectId, batchId, attachment.file, attachment.relativePath);
    }
  }));
  const failure = results.find((result) => result.status === "rejected");
  if (failure?.status === "rejected") throw failure.reason;
  return uploaded;
}

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
  onDesignReference,
}: {
  disabled?: boolean;
  onFiles: (files: ComposerAttachment[]) => void;
  onDesignReference?: () => void;
}) {
  const filesInput = useRef<HTMLInputElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const select = (files: FileList | null) => {
    const attachments = attachmentFiles([...(files ?? [])]);
    if (attachments.length) onFiles(attachments);
  };

  useEffect(() => {
    if (!open) return;
    menu.current?.querySelector<HTMLButtonElement>('[role="menuitem"]')?.focus();
    const close = (event: MouseEvent) => {
      if (!menu.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") { setOpen(false); trigger.current?.focus(); }
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);
  useEffect(() => { if (disabled) setOpen(false); }, [disabled]);

  return (
    <div className="composer-attach-control" ref={menu}>
      <button
        className="icon-button composer-attach-button"
        ref={trigger}
        type="button"
        disabled={disabled}
        onClick={() => setOpen((value) => !value)}
        title="Add context or attach files"
        aria-label="Add context or attach files"
        aria-expanded={open}
        aria-haspopup="menu"
      >
        <Plus size={17} />
      </button>
      {open ? <div className="composer-attach-menu" role="menu" onKeyDown={(event) => {
        if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
        event.preventDefault();
        const items = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('[role="menuitem"]')];
        const index = items.indexOf(document.activeElement as HTMLButtonElement);
        items[(index + (event.key === "ArrowDown" ? 1 : -1) + items.length) % items.length]?.focus();
      }}>
        <button type="button" role="menuitem" onClick={() => { setOpen(false); filesInput.current?.click(); }}>
          <Upload size={15} />
          <span>Attach files</span>
        </button>
        {onDesignReference ? <button type="button" role="menuitem" onClick={() => { setOpen(false); onDesignReference(); }}>
          <FileText size={15} />
          <span>Reference game design</span>
        </button> : null}
      </div> : null}
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
    </div>
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
