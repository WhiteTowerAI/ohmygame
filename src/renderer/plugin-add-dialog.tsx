import { useState, type FormEvent } from "react";
import { PLUGIN_ARCHIVE_MAX_BYTES, PLUGIN_NPM_REGISTRIES, type PluginAddPreview, type PluginAddSource, type PluginNpmRegistry } from "../shared/plugins.js";
import { addPlugin, addPluginFile, inspectAddedPlugin, inspectPluginFile } from "./api.js";
import { LoaderCircle } from "./icons.js";
import { language, t } from "./i18n.js";
import { PluginFilePicker } from "./plugin-file-picker.js";
import { Alert, Button, Dialog, Field, Input, Select, Tabs } from "./ui/index.js";

type SourceKind = "npm" | "github" | "local";

interface Review {
  preview: PluginAddPreview;
  /** A package that was uploaded goes up again when it's added. */
  file?: File;
  /** The folder, as a local package has no origin to show. */
  folder?: string;
}

/** One place to add a plugin from outside the app: read the package, show what it does, then add it. */
export function PluginAddDialog({ onClose, onAdded }: { onClose: () => void; onAdded: (id: string) => void }) {
  const [kind, setKind] = useState<SourceKind>("npm");
  const [name, setName] = useState("");
  // npm can be slow to reach from China, where the mirror is the usual choice.
  const [registry, setRegistry] = useState<PluginNpmRegistry>(language === "zh-CN" ? "npmmirror" : "npmjs");
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File>();
  const [review, setReview] = useState<Review>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const desktop = typeof window !== "undefined" ? window.ohMyGameDesktop : undefined;

  async function run(work: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  const readSource = (source: PluginAddSource, folder?: string) => run(async () => {
    setReview({ preview: await inspectAddedPlugin(source), ...(folder ? { folder } : {}) });
  });
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
    else if (kind === "npm") void readSource({ type: "npm", name: name.trim(), registry });
    else if (kind === "github") void readSource({ type: "github", url: url.trim() });
    else if (file) void readFile(file);
  }
  async function chooseFolder(): Promise<void> {
    await run(async () => {
      const selected = await desktop?.selectPluginDirectory();
      if (selected) setReview({ preview: await inspectAddedPlugin({ type: "directory", path: selected }), folder: selected });
    });
  }
  const canContinue = review || (kind === "npm" ? name.trim() : kind === "github" ? url.trim() : file);

  return <Dialog open onClose={() => { if (!busy) onClose(); }}
    title={review ? t("pluginAdd.reviewTitle", { name: review.preview.displayName }) : t("pluginAdd.title")}
    description={review ? undefined : t("pluginAdd.description")}
    footer={<>
      <Button disabled={busy} onClick={() => { if (review) { setReview(undefined); setError(undefined); } else onClose(); }}>{review ? t("pluginAdd.back") : t("common.cancel")}</Button>
      <Button variant="primary" type="submit" form="plugin-add-form" disabled={busy || !canContinue}
        icon={busy ? <LoaderCircle className="spin" size={14} /> : undefined}>{review ? t("pluginAdd.add") : t("pluginAdd.continue")}</Button>
    </>}>
    <form id="plugin-add-form" className="plugins-install-form" onSubmit={submit}>
      {review ? <PluginAddReview review={review} /> : <>
        <Tabs<SourceKind> variant="pills" label={t("pluginAdd.source")} value={kind} onChange={(next) => { if (busy) return; setKind(next); setError(undefined); }} tabs={[
          { value: "npm", label: "npm" },
          { value: "github", label: "GitHub" },
          { value: "local", label: t("pluginAdd.local") },
        ]} />
        {kind === "npm" ? <>
          <Field label={t("pluginAdd.packageName")} hint={t("pluginAdd.packageHint")}>{(props) => <Input {...props} autoFocus required disabled={busy} value={name} placeholder="@publisher/plugin" spellCheck={false} onChange={(event) => setName(event.target.value)} />}</Field>
          <Field label={t("pluginAdd.registry")}>{(props) => <Select {...props} label={t("pluginAdd.registry")} value={registry} disabled={busy} onChange={setRegistry} options={PLUGIN_NPM_REGISTRIES.map((value) => ({ value, label: t(`pluginAdd.registries.${value}`) }))} />}</Field>
        </> : null}
        {kind === "github" ? <Field label={t("pluginAdd.repository")} hint={t("pluginAdd.repositoryHint")}>{(props) => <Input {...props} autoFocus required disabled={busy} type="url" value={url} placeholder="https://github.com/publisher/plugin" spellCheck={false} onChange={(event) => setUrl(event.target.value)} />}</Field> : null}
        {kind === "local" ? <>
          {desktop ? <Button disabled={busy} onClick={() => void chooseFolder()}>{t("pluginAdd.chooseFolder")}</Button> : null}
          <PluginFilePicker label={t("pluginAdd.packageFile")} inputLabel={t("pluginAdd.packageFile")} chooseLabel={t("pluginAdd.chooseFile")} emptyLabel={t("pluginAdd.noFile")} file={file} accept=".tgz,.tar.gz,application/gzip" disabled={busy} onChange={setFile} />
        </> : null}
      </>}
      {error ? <Alert tone="danger" title={error} /> : null}
    </form>
  </Dialog>;
}

function PluginAddReview({ review }: { review: Review }) {
  const { preview, folder, file } = review;
  const others = preview.installedVersions.filter((version) => version !== preview.version);
  return <div className="plugin-add-review">
    <p>{preview.description}</p>
    <dl>
      <dt>{t("pluginAdd.plugin")}</dt><dd>{preview.id} {preview.version}</dd>
      <dt>{t("pluginAdd.from")}</dt><dd>{sourceLabel(preview, folder ?? file?.name)}</dd>
    </dl>
    <p>{t(preview.appWide ? "pluginAdd.appliesByItself" : "pluginAdd.turnedOnPerProject")}</p>
    {preview.asks.length ? <section><h3>{t("pluginBuilder.asksFor")}</h3><ul>{preview.asks.map((ask) => <li key={ask}><code>{ask}</code></li>)}</ul></section> : null}
    {preview.skills ? <p>{t("plugins.skillCount", { count: preview.skills })}</p> : null}
    {preview.mcpServers.length ? <section><h3>{t("pluginControls.mcpServices")}</h3><ul>{preview.mcpServers.map((server) => <li key={server}>{server}</li>)}</ul></section> : null}
    {preview.settings ? <p>{t("pluginAdd.settingsAfterAdding")}</p> : null}
    {preview.installedVersions.includes(preview.version) ? <Alert tone="info" title={t("pluginAdd.alreadyInstalled", { version: preview.version })} /> : null}
    {others.length ? <p>{t(preview.appWide ? "pluginAdd.replacesVersions" : "pluginAdd.keepsVersions", { versions: others.join(", ") })}</p> : null}
    <Alert tone="info" title={t("pluginAdd.unreviewed")} />
  </div>;
}

function sourceLabel({ origin }: PluginAddPreview, local: string | undefined): string {
  if (origin?.type === "npm") return `${origin.package} · ${t(`pluginAdd.registries.${origin.registry}`)}`;
  if (origin?.type === "github") return `github.com/${origin.repository} · ${origin.commit.slice(0, 7)}`;
  return local ?? t("pluginAdd.local");
}
