import type { ComponentProps } from "react";
import { ModelSelector } from "./model-selector.js";
import { SendArrow, Stop } from "./icons.js";
import { t } from "./i18n.js";

/** Model controls and send/stop behavior shared by workspace composers. */
export function ComposerActions({ showStop, stopping = false, sendDisabled, sendLabel = t("composer.send"), stopLabel = t("composer.stop"), onStop, ...modelProps }: ComponentProps<typeof ModelSelector> & {
  showStop: boolean;
  stopping?: boolean;
  sendDisabled: boolean;
  sendLabel?: string;
  stopLabel?: string;
  onStop: () => void;
}) {
  return <>
    <ModelSelector {...modelProps} />
    {showStop ? <button className="icon-button stop-button" type="button" onClick={onStop} disabled={stopping} title={stopLabel} aria-label={stopLabel}>
      <Stop size={14} />
    </button> : <button className="icon-button send-button" type="submit" disabled={sendDisabled} title={sendLabel} aria-label={sendLabel}>
      <SendArrow size={15} />
    </button>}
  </>;
}
