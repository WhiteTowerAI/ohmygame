import type { ReactNode } from "react";
import { Pencil, RefreshCw, type IconComponent } from "./icons.js";
import { t } from "./i18n.js";
import { localizedTemplateText } from "./template-text.js";

export interface CanvasNodeDetails {
  title?: string;
  label: string;
  description?: string;
  edit(): void;
  /** Its output came from inputs that have changed since; the button runs it and what follows again. */
  stale?: { regenerate?: () => void };
}

export function CanvasNodeLabel({ icon: Icon, label, details, titleEditor, trailing, className = "" }: {
  icon: IconComponent;
  label: string;
  details?: CanvasNodeDetails;
  titleEditor?: ReactNode;
  trailing?: ReactNode;
  className?: string;
}) {
  const title = localizedTemplateText(details?.title);
  return <header className={`story-media-node-label canvas-node-label ${className}`} title={localizedTemplateText(details?.description)}>
    <Icon size={14} />
    {title ? <span title={title}>{title}</span> : titleEditor ?? <span title={label}>{label}</span>}
    {trailing}
    {details?.stale ? <button className="canvas-node-stale nodrag" type="button" disabled={!details.stale.regenerate} title={t("assetCanvas.staleHint")} onClick={details.stale.regenerate}><RefreshCw size={11} /><span>{t("assetCanvas.stale")}</span></button> : null}
    {details ? <button className="canvas-node-details nodrag" type="button" title={t("assetCanvas.nodeDetails")} aria-label={t("canvasNode.detailsFor", { label: details.label })} onClick={details.edit}><Pencil size={12} /></button> : null}
  </header>;
}
