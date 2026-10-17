import { FileText, X } from "./icons.js";
import { Fragment, useEffect, useMemo } from "react";
import { formatBytes } from "./format-bytes.js";
import type { PromptAttachment } from "../shared/contracts.js";
import { uploadProjectAttachment } from "./api.js";
import { MAX_ATTACHMENT_BATCH_BYTES, MAX_ATTACHMENT_BYTES, MAX_ATTACHMENT_FILES } from "../shared/file-transfer.js";
import { t } from "./i18n.js";

export interface ComposerAttachment {
  id: string;
  file: File;
  relativePath: string;
}

export type AttachmentInput = File | { file: File; relativePath?: string };

export function appendAttachments(current: ComposerAttachment[], next: ComposerAttachment[]): ComposerAttachment[] {
  if (next.some((attachment) => attachment.file.size > MAX_ATTACHMENT_BYTES)) throw new Error(t("attachments.tooLarge"));
  // Each attachment uploads to its own path in the batch. Pasted screenshots are all "image.png",
  // so a repeated name gets a numbered copy instead of being refused. Case-insensitive disks share paths.
  const paths = new Set(current.map((attachment) => attachment.relativePath.toLowerCase()));
  const combined = [...current, ...next.map((attachment) => {
    const relativePath = availablePath(attachment.relativePath, paths);
    paths.add(relativePath.toLowerCase());
    return relativePath === attachment.relativePath ? attachment : { ...attachment, relativePath };
  })];
  if (combined.length > MAX_ATTACHMENT_FILES) throw new Error(t("attachments.tooMany"));
  if (combined.reduce((total, attachment) => total + attachment.file.size, 0) > MAX_ATTACHMENT_BATCH_BYTES) throw new Error(t("attachments.batchTooLarge"));
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
  return files.flatMap((value) => {
    const file = value instanceof File ? value : value.file;
    const relativePath = (value instanceof File ? file.webkitRelativePath : value.relativePath) || file.webkitRelativePath || file.name;
    return file.name ? [{ id: crypto.randomUUID(), file, relativePath }] : [];
  });
}

function availablePath(relativePath: string, taken: ReadonlySet<string>): string {
  if (!taken.has(relativePath.toLowerCase())) return relativePath;
  const slash = relativePath.lastIndexOf("/") + 1, name = relativePath.slice(slash);
  const dot = name.lastIndexOf("."), stem = dot > 0 ? name.slice(0, dot) : name, extension = dot > 0 ? name.slice(dot) : "";
  for (let copy = 2; ; copy++) {
    const candidate = `${relativePath.slice(0, slash)}${stem} (${copy})${extension}`;
    if (!taken.has(candidate.toLowerCase())) return candidate;
  }
}

export function AttachmentStrip({ items, onRemove }: { items: ComposerAttachment[]; onRemove: (id: string) => void }) {
  if (!items.length) return null;
  const images = items.filter(isPreviewableImage);
  const files = items.filter((attachment) => !isPreviewableImage(attachment));
  return (
    <Fragment>
      {images.length ? <div className="composer-images" aria-label={t("attachments.images")}>
        {images.map((attachment) => <ImageAttachment key={attachment.id} attachment={attachment} onRemove={onRemove} />)}
      </div> : null}
      {files.length ? <div className="composer-attachments" aria-label={t("attachments.files")}>
        {files.map((attachment) => (
          <div className="composer-attachment" key={attachment.id} title={`${attachment.relativePath} · ${formatBytes(attachment.file.size)}`}>
            <FileText size={14} />
            <span>{attachment.relativePath}</span>
            <button type="button" onClick={() => onRemove(attachment.id)} title={t("attachments.remove", { name: attachment.relativePath })} aria-label={t("attachments.remove", { name: attachment.relativePath })}>
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
    <button type="button" onClick={() => onRemove(attachment.id)} title={t("attachments.remove", { name: attachment.relativePath })} aria-label={t("attachments.remove", { name: attachment.relativePath })}>
      <X size={11} />
    </button>
  </div>;
}

function isPreviewableImage(attachment: ComposerAttachment): boolean {
  return ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(attachment.file.type)
    || /\.(?:png|jpe?g|webp|gif)$/i.test(attachment.file.name);
}
