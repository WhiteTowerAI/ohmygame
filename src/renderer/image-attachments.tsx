import { useEffect, useState } from "react";
import type { PromptImage, PromptImageMediaType } from "../shared/contracts.js";
import { getConversationImage } from "./api.js";
import { useNearViewport } from "./asset-gallery.js";
import { t } from "./i18n.js";

export interface ComposerImage extends PromptImage {
  id: string;
  name: string;
}

const ACCEPTED_IMAGE_TYPES: PromptImageMediaType[] = ["image/png", "image/jpeg", "image/webp", "image/gif"];

export function imageSource(image: PromptImage): string {
  return `data:${image.mediaType};base64,${image.data}`;
}

export function ConversationImage({ image, alt }: { image: PromptImage; alt: string }) {
  const [target, visible] = useNearViewport<HTMLImageElement>();
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!visible || !image.url) return;
    const controller = new AbortController();
    let objectUrl: string | undefined;
    setUrl(undefined);
    void getConversationImage(image.url, controller.signal).then((blob) => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch(() => {});
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [image.url, visible]);
  return <img ref={target} src={image.url ? url : imageSource(image)} alt={alt} loading="lazy" />;
}

export async function readImageFiles(files: File[]): Promise<ComposerImage[]> {
  for (const file of files) {
    if (!ACCEPTED_IMAGE_TYPES.includes(file.type as PromptImageMediaType)) throw new Error(t("attachments.imageTypes"));
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
    reader.onerror = () => reject(new Error(t("attachments.readFailed", { name: file.name })));
    reader.onload = () => resolve(String(reader.result).split(",", 2)[1] ?? "");
    reader.readAsDataURL(file);
  });
}
