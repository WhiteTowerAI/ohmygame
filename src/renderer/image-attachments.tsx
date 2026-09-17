import { Plus, X } from "./icons.js";
import { useRef } from "react";
import type { PromptImage, PromptImageMediaType } from "../shared/contracts.js";

export interface ComposerImage extends PromptImage {
  id: string;
  name: string;
}

const ACCEPTED_IMAGE_TYPES: PromptImageMediaType[] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export function ImagePickerButton({
  disabled,
  onImages,
  onError,
}: {
  disabled?: boolean;
  onImages: (images: ComposerImage[]) => void;
  onError: (message?: string) => void;
}) {
  const input = useRef<HTMLInputElement>(null);

  return (
    <>
      <button
        className="icon-button composer-attach-button"
        type="button"
        disabled={disabled}
        onClick={() => input.current?.click()}
        title="Attach images"
        aria-label="Attach images"
      >
        <Plus size={17} />
      </button>
      <input
        ref={input}
        className="visually-hidden"
        type="file"
        accept={ACCEPTED_IMAGE_TYPES.join(",")}
        multiple
        onChange={(event) => {
          const files = [...(event.target.files ?? [])];
          event.target.value = "";
          void readImageFiles(files).then(onImages).catch((error) => {
            onError(error instanceof Error ? error.message : String(error));
          });
        }}
      />
    </>
  );
}

export function ImageAttachmentStrip({ images, onRemove }: { images: ComposerImage[]; onRemove: (id: string) => void }) {
  if (images.length === 0) return null;
  return (
    <div className="composer-images" aria-label="Attached images">
      {images.map((image) => (
        <div className="composer-image" key={image.id} title={image.name}>
          <img src={imageSource(image)} alt={image.name} />
          <button type="button" onClick={() => onRemove(image.id)} title={`Remove ${image.name}`} aria-label={`Remove ${image.name}`}>
            <X size={11} />
          </button>
        </div>
      ))}
    </div>
  );
}

export function promptImages(images: ComposerImage[]): PromptImage[] {
  return images.map(({ name, mediaType, data }) => ({ name, mediaType, data }));
}

export function composerImages(images: PromptImage[]): ComposerImage[] {
  return images.map((image, index) => ({ ...image, id: crypto.randomUUID(), name: image.name ?? `Image ${index + 1}` }));
}

export function imageSource(image: PromptImage): string {
  return `data:${image.mediaType};base64,${image.data}`;
}

export async function readImageFiles(files: File[]): Promise<ComposerImage[]> {
  for (const file of files) {
    if (!ACCEPTED_IMAGE_TYPES.includes(file.type as PromptImageMediaType)) throw new Error("Use PNG, JPEG, WebP, or GIF images");
  }
  return Promise.all(files.map(async (file) => ({
    id: crypto.randomUUID(),
    name: file.name,
    mediaType: file.type as PromptImageMediaType,
    data: await fileBase64(file),
  })));
}

function fileBase64(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error(`Could not read ${file.name}`));
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.readAsDataURL(file);
  });
}
