import { useEffect, useState } from "react";
import { createPortal } from "react-dom";
import type { PromptImage } from "../shared/contracts.js";
import { getConversationImage } from "./api.js";
import { Copy, Download } from "./icons.js";
import { t } from "./i18n.js";
import { ConversationImage } from "./image-attachments.js";
import { ContextMenu, useModal, useToast, type MenuEntry } from "./ui/overlay.js";

const EXTENSIONS: Record<string, string> = { "image/png": "png", "image/jpeg": "jpg", "image/webp": "webp", "image/gif": "gif" };
type GalleryImage = PromptImage | { blob: Blob; url: string; name?: string };

/** Images in a message or tool result. Choosing one shows it larger; right-click copies or saves it. */
export function ImageGallery({ images, alt, className }: { images: GalleryImage[]; alt: (index: number) => string; className: string }) {
  const [open, setOpen] = useState<number>();
  const menu = useImageMenu();
  return <>
    <div className={className}>
      {images.map((image, index) => (
        <ContextMenu key={`${"blob" in image ? image.blob.type : image.mediaType}:${index}`} items={menu(image, index)}>
          <button type="button" className="image-gallery-item" aria-label={t("imageViewer.open", { name: alt(index) })} onClick={() => setOpen(index)}>
            {"blob" in image ? <img src={image.url} alt={alt(index)} /> : <ConversationImage image={image} alt={alt(index)} />}
          </button>
        </ContextMenu>
      ))}
    </div>
    {open === undefined ? null
      : <ImagePreview image={images[open]!} alt={alt(open)} menu={menu(images[open]!, open)} onClose={() => setOpen(undefined)} />}
  </>;
}

/** The whole image, from a loaded workspace file, the conversation cache or its own data. */
function imageBlob(image: GalleryImage, signal?: AbortSignal): Promise<Blob> {
  if ("blob" in image) return Promise.resolve(image.blob);
  if (image.url) return getConversationImage(image.url, signal);
  // The app's content policy does not let it fetch `data:` URLs, so the data is decoded here.
  const bytes = Uint8Array.from(atob(image.data), (character) => character.charCodeAt(0));
  return Promise.resolve(new Blob([bytes], { type: image.mediaType }));
}

/** Most clipboards take only PNG, so other images are drawn into one first. */
export async function pngBlob(blob: Blob): Promise<Blob> {
  if (blob.type === "image/png") return blob;
  const bitmap = await createImageBitmap(blob);
  const canvas = document.createElement("canvas");
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext("2d")!.drawImage(bitmap, 0, 0);
  bitmap.close();
  return new Promise((resolve, reject) => canvas.toBlob((png) => png ? resolve(png) : reject(new Error("Could not encode the image")), "image/png"));
}

function useImageMenu(): (image: GalleryImage, index: number) => MenuEntry[] {
  const toast = useToast();
  return (image, index) => [
    {
      label: t("imageViewer.copy"),
      icon: <Copy size={14} />,
      onSelect: () => {
        // The write starts within the click, as clipboards allow it only then, and waits for the image.
        navigator.clipboard.write([new ClipboardItem({ "image/png": imageBlob(image).then(pngBlob) })])
          .then(() => toast({ title: t("imageViewer.copied"), tone: "success" }))
          .catch(() => toast({ title: t("imageViewer.copyFailed"), tone: "danger" }));
      },
    },
    {
      label: t("imageViewer.save"),
      icon: <Download size={14} />,
      onSelect: () => {
        void imageBlob(image).then((blob) => {
          const url = URL.createObjectURL(blob);
          const link = document.createElement("a");
          link.href = url;
          link.download = image.name ?? `image-${index + 1}.${EXTENSIONS[blob.type] ?? "png"}`;
          link.click();
          setTimeout(() => URL.revokeObjectURL(url), 1_000);
        }).catch(() => toast({ title: t("imageViewer.saveFailed"), tone: "danger" }));
      },
    },
  ];
}

/** The image fitted to the window. Esc or a click anywhere closes it. */
function ImagePreview({ image, alt, menu, onClose }: { image: GalleryImage; alt: string; menu: MenuEntry[]; onClose: () => void }) {
  const panel = useModal(true, onClose);
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    const controller = new AbortController();
    let objectUrl: string | undefined;
    void imageBlob(image, controller.signal).then((blob) => {
      if (controller.signal.aborted) return;
      objectUrl = URL.createObjectURL(blob);
      setUrl(objectUrl);
    }).catch(() => {});
    return () => {
      controller.abort();
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [image]);
  // Nothing in it takes focus, so the preview does, and Esc reaches it.
  useEffect(() => { panel.current?.focus(); }, [panel]);
  return createPortal(
    <div className="image-preview-backdrop" onClick={(event) => {
      // A choice in the image's menu, which renders elsewhere, leaves the preview open.
      if (event.currentTarget.contains(event.target as Node)) onClose();
    }}>
      <div ref={panel} className="image-preview" role="dialog" aria-modal="true" aria-label={alt} tabIndex={-1}>
        {url ? <ContextMenu items={menu}><img src={url} alt={alt} /></ContextMenu> : null}
      </div>
    </div>,
    document.body,
  );
}
