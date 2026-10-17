import type { ReactNode } from "react";
import { Pencil, type IconComponent } from "./icons.js";
import { t } from "./i18n.js";

export interface CanvasNodeDetails {
  title?: string;
  label: string;
  description?: string;
  edit(): void;
}

export function CanvasNodeLabel({ icon: Icon, label, details, titleEditor, trailing, className = "" }: {
  icon: IconComponent;
  label: string;
  details?: CanvasNodeDetails;
  titleEditor?: ReactNode;
  trailing?: ReactNode;
  className?: string;
}) {
  return <header className={`story-media-node-label canvas-node-label ${className}`} title={details?.description}>
    <Icon size={14} />
    {details?.title ? <span title={details.title}>{details.title}</span> : titleEditor ?? <span title={label}>{label}</span>}
    {trailing}
    {details ? <button className="canvas-node-details nodrag" type="button" title={t("assetCanvas.nodeDetails")} aria-label={t("canvasNode.detailsFor", { label: details.label })} onClick={details.edit}><Pencil size={12} /></button> : null}
  </header>;
}
