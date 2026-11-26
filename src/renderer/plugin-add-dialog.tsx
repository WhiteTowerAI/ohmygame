import { useEffect, useState, type FormEvent } from "react";
import { OHMYGAME_PUBLISHER } from "../shared/plugin-manifest.js";
import { isNewerPluginVersion, PLUGIN_ARCHIVE_MAX_BYTES, type MarketPlugin, type PluginAddPreview, type PluginAddSource } from "../shared/plugins.js";
import { addPlugin, addPluginFile, ApiError, inspectAddedPlugin, inspectPluginFile } from "./api.js";
import { ExternalLink, LoaderCircle } from "./icons.js";
import { t } from "./i18n.js";
import { NativeCodeWarning, PluginCapabilityList } from "./plugin-consent-dialog.js";
import { PluginFilePicker } from "./plugin-file-picker.js";
import { PluginAddsList, pluginAddRows } from "./plugin-summary.js";
import { settingsHash } from "./routes.js";
import { Alert, Button, Checkbox, Dialog, Field, Input, Tabs } from "./ui/index.js";

type SourceKind = "github" | "local";

interface Review {
  preview: PluginAddPreview;
  /** A package that was uploaded goes up again when it's added. */
  file?: File;
  /** The folder, as a local package has no origin to show. */
  folder?: string;
}

/** A market plugin's version, as the market lists it. */
export const marketPluginSource = (listed: MarketPlugin): PluginAddSource => ({ type: "market", id: listed.id, version: listed.version });

/**
 * One place to add a plugin from outside the app: read the package, show what it
 * does, then add it. Given a plugin from the market, it starts with that review.
 */
export function PluginAddDialog({ listed, source, preview, onClose, onAdded }: {
  listed?: MarketPlugin;
  /** Starts with the review of this package, as for an update from where a plugin came from. */
  source?: PluginAddSource;
  /** A review already read before opening, as when a card update asks for new permissions. */
  preview?: PluginAddPreview;
  onClose: () => void;
  onAdded: (id: string) => void;
}) {
  const started = Boolean(listed ?? source ?? preview);
  const [kind, setKind] = useState<SourceKind>("github");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File>();
  /** The folder chosen, or typed in where there's no desktop folder picker. */
  const [folderPath, setFolderPath] = useState("");
  const [development, setDevelopment] = useState(false);
  const [review, setReview] = useState<Review | undefined>(() => preview ? { preview } : undefined);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [issue, setIssue] = useState<"needs-app-update" | "needs-plugin-update" | "official-publisher">();
  const desktop = typeof window !== "undefined" ? window.ohMyGameDesktop : undefined;

  async function run(work: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setIssue(undefined);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      const code = cause instanceof ApiError ? cause.code : undefined;
      setIssue(code === "needs-app-update" || code === "needs-plugin-update" || code === "official-publisher" ? code : undefined);
    } finally {
      setBusy(false);
    }
  }

  const readSource = (source: PluginAddSource, folder?: string) => run(async () => {
    setReview({ preview: await inspectAddedPlugin(source), ...(folder ? { folder } : {}) });
  });
  useEffect(() => {
    if (preview) return;
    if (listed) void readSource(marketPluginSource(listed));
    else if (source) void readSource(source);
  }, []);
  const readFile = (selected: File) => run(async () => {
    if (selected.size > PLUGIN_ARCHIVE_MAX_BYTES) throw new Error(t("pluginAdd.tooLarge"));
    setReview({ preview: await inspectPluginFile(selected), file: selected });
  });
  const add = () => run(async () => {
    if (!review) return;
    const { preview } = review;
    if (review.file) await addPluginFile(review.file, preview.digest);
    else if (preview.source) await addPlugin(preview.source, preview.digest);
    onAdded(preview.id);
  });
  function submit(event: FormEvent): void {
    event.preventDefault();
    if (review) void add();
    else if (kind === "github") void readSource({ type: "github", url: url.trim() });
    else if (folderPath.trim()) void readSource(folderSource(folderPath.trim()), folderPath.trim());
    else if (file) void readFile(file);
  }
  const folderSource = (folder: string): PluginAddSource => ({ type: "directory", path: folder, ...(development ? { development: true as const } : {}) });
  // Choosing a folder or a file only picks it: Continue reads it, with Development as it is then.
  // Changing what Continue reads clears the last error, as switching tabs does.
  async function chooseFolder(): Promise<void> {
    const selected = await desktop?.selectPluginDirectory();
    if (!selected) return;
    setFolderPath(selected);
    setFile(undefined);
    setError(undefined);
  }
  function chooseFile(selected?: File): void {
    setFile(selected);
    if (selected) setFolderPath("");
    setError(undefined);
  }
  // Newer than every version installed, it's an update, and says so.
  const installed = review?.preview.installedVersions ?? [];
  const update = installed.length > 0 && installed.every((version) => isNewerPluginVersion(review!.preview.version, version));
  const canContinue = review || (kind === "github" ? url.trim() : folderPath.trim() || file);

  return <Dialog open onClose={() => { if (!busy) onClose(); }}
    title={review ? t(update ? "pluginAdd.updateTitle" : "pluginAdd.reviewTitle", { name: review.preview.displayName, version: review.preview.version }) : t("pluginAdd.title")}
    description={review || started ? undefined : t("pluginAdd.description")}
    footer={<>
      <Button disabled={busy} onClick={() => { if (review && !started) { setReview(undefined); setError(undefined); } else onClose(); }}>{review && !started ? t("pluginAdd.back") : t("common.cancel")}</Button>
      {started && !review ? null : <Button variant="primary" type="submit" form="plugin-add-form" disabled={busy || !canContinue}
        icon={busy ? <LoaderCircle className="spin" size={14} /> : undefined}>{review ? t(update ? "pluginAdd.update" : "pluginAdd.add") : t("pluginAdd.continue")}</Button>}
    </>}>
    <form id="plugin-add-form" className="plugins-install-form" onSubmit={submit}>
      {review ? <PluginAddReview review={review} {...(listed ? { listed } : {})} /> : started ? (busy ? <p>{t("pluginAdd.reading")}</p> : null) : <>
        <Tabs<SourceKind> variant="pills" label={t("pluginAdd.source")} value={kind} onChange={(next) => { if (busy) return; setKind(next); setError(undefined); }} tabs={[
          { value: "github", label: "GitHub" },
          { value: "local", label: t("pluginAdd.local") },
        ]} />
        {kind === "github" ? <Field label={t("pluginAdd.repository")} hint={t("pluginAdd.repositoryHint")}>{(props) => <Input {...props} autoFocus required disabled={busy} type="url" value={url} placeholder="https://github.com/publisher/plugin" spellCheck={false} onChange={(event) => setUrl(event.target.value)} />}</Field> : null}
        {kind === "local" ? <>
          {desktop ? <div className="plugin-file-picker">
            <span className="plugin-file-picker-label">{t("pluginAdd.folder")}</span>
            <div className="plugin-file-picker-control">
              <button className="plugin-file-picker-button" type="button" disabled={busy} onClick={() => void chooseFolder()}>{t("pluginAdd.chooseFolder")}</button>
              <span className={`plugin-file-picker-name${folderPath ? "" : " is-empty"}`} title={folderPath || undefined}>{folderPath || t("pluginAdd.noFolder")}</span>
            </div>
          </div>
            : <Field label={t("pluginAdd.folder")} hint={t("pluginAdd.folderHint")}>{(props) => <Input {...props} disabled={busy} value={folderPath} placeholder="/Users/me/my-plugin" spellCheck={false} onChange={(event) => { setFolderPath(event.target.value); if (event.target.value) setFile(undefined); setError(undefined); }} />}</Field>}
          <Checkbox checked={development} disabled={busy} onChange={(next) => { setDevelopment(next); setError(undefined); }} label={t("pluginAdd.develop")} description={t("pluginAdd.developHint")} />
          <PluginFilePicker label={t("pluginAdd.packageFile")} inputLabel={t("pluginAdd.packageFile")} chooseLabel={t("pluginAdd.chooseFile")} emptyLabel={t("pluginAdd.noFile")} file={file} accept=".tgz,.tar.gz,application/gzip" disabled={busy} onChange={chooseFile} />
        </> : null}
      </>}
      {error ? <Alert tone="danger" title={issue === "needs-app-update" ? t("pluginAdd.needsAppUpdate") : issue === "needs-plugin-update" ? t("pluginAdd.needsPluginUpdate") : issue === "official-publisher" ? t("pluginAdd.officialPublisher") : error} action={issue === "needs-app-update" && desktop?.updates ? <Button size="sm" onClick={() => {
        window.location.hash = settingsHash("about");
        onClose();
      }}>{t("pluginAdd.updateApp")}</Button> : undefined} /> : null}
    </form>
  </Dialog>;
}

function PluginAddReview({ review, listed }: { review: Review; listed?: MarketPlugin }) {
  const { preview, folder, file } = review;
  const others = preview.installedVersions.filter((version) => version !== preview.version);
  const adds = pluginAddRows(preview.adds);
  return <div className="plugin-add-review">
    <p>{preview.description}</p>
    <dl>
      <dt>{t("pluginAdd.plugin")}</dt><dd>{preview.id} {preview.version}</dd>
      <dt>{t("pluginAdd.from")}</dt><dd>{sourceLabel(preview, folder ?? file?.name)}</dd>
      {listed?.repository ? <><dt>{t("plugins.repository")}</dt><dd><a href={listed.repository} target="_blank" rel="noreferrer">{listed.repository.replace("https://github.com/", "")}<ExternalLink size={11} /></a> · {t(listed.sourceVerified ? "plugins.sourceVerified" : "plugins.sourceUnverified")}</dd></> : null}
    </dl>
    <p>{t(preview.appWide ? "pluginAdd.appliesByItself" : "pluginAdd.turnedOnEverywhere")}</p>
    {preview.asks.length ? <section><h3>{t("pluginBuilder.asksFor")}</h3><PluginCapabilityList capabilities={preview.asks} newAsks={preview.newAsks} />
      {preview.newAsks ? <p>{preview.newAsks.length ? t("pluginAdd.asksAgain") : t("pluginAdd.asksNothingNew")}</p> : null}
    </section> : null}
    <NativeCodeWarning asks={preview.asks} />
    {adds.length ? <section><h3>{t("pluginStore.adds")}</h3><PluginAddsList rows={adds} /></section> : null}
    {preview.settings ? <p>{t("pluginAdd.settingsAfterAdding")}</p> : null}
    {preview.origin?.type === "development" ? <p>{t("pluginAdd.developsFolder")}</p> : null}
    {preview.installedVersions.includes(preview.version) ? <Alert tone="info" title={t("pluginAdd.alreadyInstalled", { version: preview.version })} /> : null}
    {others.length ? <p>{t("pluginAdd.replacesVersions", { versions: others.join(", ") })}</p> : null}
    {/* An official plugin is ours; another from Discover passed the index's checks, which aren't a review. */}
    {listed?.id.startsWith(`${OHMYGAME_PUBLISHER}/`) ? null : <Alert tone="info" title={t(listed ? "pluginAdd.checkedOnly" : "pluginAdd.unreviewed")} />}
  </div>;
}

function sourceLabel({ origin }: PluginAddPreview, local: string | undefined): string {
  if (origin?.type === "github") return `github.com/${origin.repository} · ${origin.release ?? origin.commit.slice(0, 7)}`;
  if (origin?.type === "development") return `${origin.folder} · ${t("plugins.inDevelopment")}`;
  return local ?? t("pluginAdd.local");
}
