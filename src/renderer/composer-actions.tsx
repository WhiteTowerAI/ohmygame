import type { ComponentProps, ReactNode } from "react";
import { ModelSelector } from "./model-selector.js";
import { ArrowUp, Stop } from "./icons.js";
import { t } from "./i18n.js";

/** Model controls and send/stop behavior shared by workspace composers; `usage` sits before the model. */
export function ComposerActions({ usage, showStop, stopping = false, sendDisabled, sendLabel = t("composer.send"), stopLabel = t("composer.stop"), onStop, ...modelProps }: ComponentProps<typeof ModelSelector> & {
  usage?: ReactNode;
  showStop: boolean;
  stopping?: boolean;
  sendDisabled: boolean;
  sendLabel?: string;
  stopLabel?: string;
  onStop: () => void;
}) {
  return <>
    {usage}
    <ModelSelector {...modelProps} />
    {showStop ? <button className="icon-button stop-button" type="button" onClick={onStop} disabled={stopping} title={stopLabel} aria-label={stopLabel}>
      <Stop size="sm" />
    </button> : <button className="icon-button send-button" type="submit" disabled={sendDisabled} title={sendLabel} aria-label={sendLabel}>
      <ArrowUp size="sm" />
    </button>}
  </>;
}
