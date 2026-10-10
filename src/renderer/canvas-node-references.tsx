import { Box, FileText, Film, Image as ImageIcon, Music2, X } from "./icons.js";
import { useWorkspaceAssetUrl } from "./use-workspace-asset-url.js";

export interface CanvasNodeReferenceView {
  nodeId: string;
  name: string;
  type: "text" | "document" | "image";
  text?: string;
  assetId?: string;
}
export interface CanvasNodeReferencesRuntime {
  references: CanvasNodeReferenceView[];
  onRemoveReference(index: number): void;
}

export function CanvasNodeReferenceStrip({ references, onRemoveReference, busy = false }: CanvasNodeReferencesRuntime & { busy?: boolean }) {
  if (!references.length) return null;
  return <div className="story-media-references" aria-label="Node references">
    {references.map((reference, index) => <CanvasReferenceThumbnail key={reference.nodeId} reference={{ ...reference, label: reference.name }} caption={reference.name} disabled={busy} onRemove={() => onRemoveReference(index)} />)}
  </div>;
}

/** Shared by media generation nodes and the Text/Document reference strip. */
export function CanvasReferenceThumbnail({ reference, caption, disabled, onRemove }: {
  reference: { assetId?: string; name: string; label: string; type: "text" | "document" | "image" | "video" | "audio" | "model"; text?: string };
  caption?: string;
  disabled?: boolean;
  onRemove(): void;
}) {
  const textual = reference.type === "text" || reference.type === "document";
  const preview = useWorkspaceAssetUrl(undefined, "", 0, reference.type === "image" || reference.type === "video" ? reference.assetId : undefined);
  const title = preview.error ?? reference.text ?? `${reference.label}: ${reference.name}`;
  return <div className={`story-media-reference${textual ? " story-text-reference" : ""}${preview.error ? " is-unavailable" : ""}`} title={title}>
    {preview.url && reference.type === "image" ? <img src={preview.url} alt={reference.name} /> : null}
    {preview.url && reference.type === "video" ? <video src={preview.url} muted playsInline preload="metadata" /> : null}
    {textual ? <FileText size={19} /> : reference.type === "audio" ? <Music2 size={18} /> : reference.type === "model" ? <Box size={18} /> : !preview.url ? reference.type === "video" ? <Film size={18} /> : <ImageIcon size={18} /> : null}
    {caption ? <small>{caption}</small> : null}
    {preview.error ? <button className="canvas-reference-retry" type="button" title={`Recheck ${reference.name}: ${preview.error}`} aria-label={`Recheck ${reference.name}`} disabled={preview.loading} onClick={preview.retry}>↻</button> : null}
    <button type="button" title={`Remove ${reference.name}`} aria-label={`Remove ${reference.name}`} disabled={disabled} onClick={onRemove}><X size={11} /></button>
  </div>;
}
