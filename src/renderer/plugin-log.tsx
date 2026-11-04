import { useEffect, useState } from "react";
import type { PluginLogEntry, PluginLogView } from "../shared/plugins.js";
import { readPluginLog, setStorePluginEnabled } from "./api.js";
import { t } from "./i18n.js";
import { Alert, Button, Dialog, Skeleton } from "./ui/index.js";

// A plugin's log since the app started: what its code printed, and what of
// it failed. The daemon redacts credentials before any of it gets here, so
// copying it to share is safe as far as the redaction reaches.

export function PluginLogDialog({ plugin, displayName, onClose, onChanged }: {
  plugin: string;
  displayName: string;
  onClose: () => void;
  /** It was turned off, or back on. */
  onChanged?: () => void;
}) {
  const [view, setView] = useState<PluginLogView>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [copied, setCopied] = useState(false);
  const load = () => readPluginLog(plugin).then(setView, (cause: unknown) => setError(message(cause)));
  useEffect(() => { void load(); }, [plugin]);

  async function switchTo(enabled: boolean): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      await setStorePluginEnabled(plugin, enabled);
      onChanged?.();
      if (!enabled) onClose();
      else await load();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(false);
    }
  }

  const text = view?.entries.map(logLine).join("\n") ?? "";
  return <Dialog open size="lg" title={t("pluginLog.title", { name: displayName })} onClose={onClose}
    footer={<>
      <Button variant="ghost" disabled={busy} onClick={() => void switchTo(false)}>{t("pluginLog.turnOff")}</Button>
      <Button disabled={!text} onClick={() => void navigator.clipboard.writeText(text).then(() => setCopied(true), (cause: unknown) => setError(message(cause)))}>
        {copied ? t("pluginLog.copied") : t("pluginLog.copy")}
      </Button>
      <Button variant="primary" onClick={onClose}>{t("common.close")}</Button>
    </>}>
    <div className="plugin-log">
      {error ? <Alert tone="danger" title={error} /> : null}
      {view?.quarantined ? <Alert tone="danger" title={t("pluginLog.quarantined")} action={
        <Button size="sm" disabled={busy} onClick={() => void switchTo(true)}>{t("pluginLog.turnOnAgain")}</Button>
      }>{t("pluginLog.quarantinedHint")}</Alert> : null}
      {!view && !error ? <Skeleton height={120} /> : null}
      {view ? view.entries.length
        ? <pre className="plugin-log-lines" aria-label={t("pluginLog.title", { name: displayName })}>{text}</pre>
        : <p className="plugins-note">{t("pluginLog.empty")}</p> : null}
      <p className="plugins-note">{t("pluginLog.redacted")}</p>
    </div>
  </Dialog>;
}

function logLine(entry: PluginLogEntry): string {
  return `${entry.at} ${entry.level.toUpperCase()} [${entry.source}] ${entry.text}`;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
