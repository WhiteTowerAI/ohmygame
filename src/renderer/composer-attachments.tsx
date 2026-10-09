import { FileText, X } from "./icons.js";
import { Fragment, useEffect, useMemo } from "react";
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
