import { useEffect, useState, type FormEvent } from "react";
import { PLUGIN_DOWNLOAD_SOURCES, type PluginDownloadSource, type PluginMarketListing, type PluginMarketSettings } from "../shared/plugins.js";
import { getPluginMarketSettings, setPluginMarketSettings } from "./api.js";
import { t } from "./i18n.js";
import { Plus, Trash2 } from "./icons.js";
import { useReadyRuntimeGeneration } from "./runtime-connection.js";
import { Alert, Badge, Button, Dialog, Disclosure, Field, IconButton, Input, Select } from "./ui/index.js";

/** Indexes besides the main one, as the daemon allows (`PLUGIN_MARKET_EXTRA_MAX`). */
const EXTRA_MAX = 5;

/**
 * Discover's settings, from the foot of its side list: where its plugins are
 * listed from, and where they download from. The main index can be read from
 * another address, such as a mirror, and more indexes can add plugins it
 * doesn't list.
 */
export function PluginMarketSourcesDialog({ sources, onClose, onSaved }: {
  /** Whether each index could be read, from the last listing. */
  sources?: PluginMarketListing["sources"];
  onClose: () => void;
  onSaved: () => void;
}) {
  const generation = useReadyRuntimeGeneration();
  const [saved, setSaved] = useState<PluginMarketSettings>();
  const [index, setIndex] = useState("");
  const [extra, setExtra] = useState<string[]>([]);
  const [adding, setAdding] = useState("");
  const [download, setDownload] = useState<PluginDownloadSource>("auto");
  const [proxy, setProxy] = useState("");
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState<{ tone: "success" | "danger"; text: string }>();

  useEffect(() => {
    let live = true;
    void getPluginMarketSettings().then((settings) => {
      if (!live) return;
      setSaved(settings);
      setIndex(settings.index);
      setExtra(settings.extra);
      setDownload(settings.download);
      setProxy(settings.proxy);
    }, (cause) => { if (live) setNote({ tone: "danger", text: errorText(cause) }); });
    return () => { live = false; };
  }, [generation]);

  const unreadable = (url: string) => sources?.find((source) => source.url === url)?.status === "unavailable";
  const pending = adding.trim();
  const changed = saved !== undefined && (index.trim() !== saved.index || pending !== "" || extra.join("\n") !== saved.extra.join("\n")
    || download !== saved.download || proxy.trim() !== saved.proxy);

  async function save(event?: FormEvent) {
    event?.preventDefault();
    setBusy(true);
    setNote(undefined);
    try {
      // An address typed but not yet added is meant too.
      const next = await setPluginMarketSettings({ index: index.trim(), extra: pending ? [...extra, pending] : extra, download, proxy: proxy.trim() });
      setSaved(next);
      setIndex(next.index);
      setExtra(next.extra);
      setDownload(next.download);
      setProxy(next.proxy);
      setAdding("");
      setNote({ tone: "success", text: t("pluginMarketSettings.saved") });
      onSaved();
    } catch (cause) {
      setNote({ tone: "danger", text: errorText(cause) });
    } finally {
      setBusy(false);
    }
  }

  function add() {
    if (!pending || extra.includes(pending)) return;
    setExtra([...extra, pending]);
    setAdding("");
    setNote(undefined);
  }

  const loading = saved === undefined;
  // Most people only choose where downloads come from; indexes they changed, or one that failed, stay in view.
  const customIndexes = Boolean(saved && (saved.index !== saved.defaultIndex || saved.extra.length || [saved.index, ...saved.extra].some(unreadable)));
  return (
    <Dialog open size="md" onClose={onClose} title={t("pluginMarketSettings.title")}>
      <form className="plugin-market-settings" onSubmit={(event) => void save(event)}>
        <Field label={t("pluginMarketSettings.download")} hint={t("pluginMarketSettings.downloadHint")}>
          {(props) => <Select {...props} label={t("pluginMarketSettings.download")} value={download} disabled={busy || loading}
            onChange={(next) => { setDownload(next); setNote(undefined); }}
            options={PLUGIN_DOWNLOAD_SOURCES.map((value) => ({ value, label: t(`pluginMarketSettings.downloads.${value}`), description: t(`pluginMarketSettings.downloadNotes.${value}`) }))} />}
        </Field>
        {download === "proxy" ? <Field label={t("pluginMarketSettings.proxy")} hint={t("pluginMarketSettings.proxyHint")}>
          {(props) => <Input {...props} type="url" required value={proxy} placeholder="https://proxy.example.com/" disabled={busy || loading}
            onChange={(event) => { setProxy(event.target.value); setNote(undefined); }} spellCheck={false} autoComplete="off" />}
        </Field> : null}
        <Disclosure summary={t("pluginMarketSettings.indexes")} defaultOpen={customIndexes}>
          <div className="plugin-market-settings">
            <Field label={t("pluginMarketSettings.main")} hint={t("pluginMarketSettings.mainHint")}>
              {(props) => (
                <div className="plugin-market-settings-row">
                  <Input {...props} type="url" value={index} placeholder={saved?.defaultIndex} disabled={busy || loading}
                    onChange={(event) => { setIndex(event.target.value); setNote(undefined); }} spellCheck={false} autoComplete="off" />
                  {saved && index.trim() !== saved.defaultIndex ? (
                    <Button variant="ghost" size="sm" disabled={busy} onClick={() => { setIndex(saved.defaultIndex); setNote(undefined); }}>
                      {t("pluginMarketSettings.useDefault")}
                    </Button>
                  ) : null}
                  {saved && unreadable(saved.index) ? <Badge tone="danger">{t("pluginMarketSettings.unreadable")}</Badge> : null}
                </div>
              )}
            </Field>
            <Field label={t("pluginMarketSettings.extra")} hint={t("pluginMarketSettings.extraHint")}>
              {(props) => (
                <div className="plugin-market-settings-list">
                  {extra.map((url) => (
                    <div key={url} className="plugin-market-settings-row">
                      <span className="plugin-market-settings-url" title={url}>{url}</span>
                      {unreadable(url) ? <Badge tone="danger">{t("pluginMarketSettings.unreadable")}</Badge> : null}
                      <IconButton size="sm" label={t("pluginMarketSettings.remove", { url })} disabled={busy}
                        onClick={() => { setExtra(extra.filter((item) => item !== url)); setNote(undefined); }}>
                        <Trash2 size="sm" />
                      </IconButton>
                    </div>
                  ))}
                  {extra.length < EXTRA_MAX ? (
                    <div className="plugin-market-settings-row">
                      <Input {...props} type="url" value={adding} placeholder="https://example.com/plugins/index.json" disabled={busy || loading}
                        onChange={(event) => { setAdding(event.target.value); setNote(undefined); }}
                        onKeyDown={(event) => { if (event.key === "Enter") { event.preventDefault(); add(); } }}
                        spellCheck={false} autoComplete="off" />
                      <Button size="sm" icon={<Plus size="sm" />} disabled={busy || !pending} onClick={add}>{t("pluginMarketSettings.add")}</Button>
                    </div>
                  ) : null}
                </div>
              )}
            </Field>
          </div>
        </Disclosure>
        {note ? <Alert tone={note.tone === "success" ? "success" : "danger"} title={note.text} /> : null}
        <div className="plugin-market-settings-actions">
          <Button variant="primary" type="submit" disabled={busy || !changed}>
            {busy ? t("common.saving") : t("common.save")}
          </Button>
        </div>
      </form>
    </Dialog>
  );
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
