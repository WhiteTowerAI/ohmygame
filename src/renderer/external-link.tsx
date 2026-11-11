import { useCallback, useState } from "react";
import { SettingsNote } from "./settings-parts.js";
import { CommandText } from "./command-text.js";
import { t } from "./i18n.js";

/** Opens a link in the person's browser; rejects when the system has no app to open it with. */
async function openExternalUrl(url: string): Promise<void> {
  if (window.ohMyGameDesktop?.openExternal) {
    await window.ohMyGameDesktop.openExternal(url);
  } else {
    window.open(url, "_blank", "noopener,noreferrer");
  }
}

/**
 * Opens links in the browser and remembers the last one that could not open,
 * so the page can offer it to copy instead (Windows without a default browser
 * fails with "no application is associated").
 */
export function useExternalLink() {
  const [failedUrl, setFailedUrl] = useState<string>();
  const open = useCallback(async (url: string): Promise<void> => {
    setFailedUrl(undefined);
    try {
      await openExternalUrl(url);
    } catch {
      setFailedUrl(url);
    }
  }, []);
  return { open, failedUrl };
}

/** The link the browser could not open, ready to copy. */
export function ExternalLinkFallback({ url }: { url: string | undefined }) {
  if (!url) return null;
  return (
    <SettingsNote tone="danger">
      <p>{t("common.openLinkFailed")}</p>
      <CommandText command={url} copyLabel={t("common.copyLink")} />
    </SettingsNote>
  );
}
