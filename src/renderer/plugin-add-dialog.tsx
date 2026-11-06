import { useEffect, useState, type FormEvent } from "react";
import { customNpmRegistry, PLUGIN_ARCHIVE_MAX_BYTES, PLUGIN_NPM_REGISTRIES, type MarketPlugin, type PluginAddPreview, type PluginAddSource, type PluginNpmRegistry } from "../shared/plugins.js";
import { addPlugin, addPluginFile, ApiError, inspectAddedPlugin, inspectPluginFile } from "./api.js";
import { LoaderCircle } from "./icons.js";
import { language, t } from "./i18n.js";
import { NativeCodeWarning, PluginCapabilityList } from "./plugin-consent-dialog.js";
import { hookLabel } from "./plugin-hook-labels.js";
import { PluginFilePicker } from "./plugin-file-picker.js";
import { settingsHash } from "./routes.js";
import { Alert, Button, Checkbox, Dialog, Field, Input, Select, Tabs } from "./ui/index.js";

type SourceKind = "npm" | "github" | "local";

interface Review {
  preview: PluginAddPreview;
  /** A package that was uploaded goes up again when it's added. */
  file?: File;
  /** The folder, as a local package has no origin to show. */
  folder?: string;
}

const REGISTRY_KEY = "ohmygame.pluginRegistry";

/**
 * The registry chosen last, here and for market cards. Otherwise npm, or in
 * Chinese the mirror, since npm can be slow to reach from China.
 */
function preferredRegistry(): PluginNpmRegistry {
  let saved: string | null = null;
  try {
    saved = localStorage.getItem(REGISTRY_KEY);
  } catch {
    // Storage may be off; the default does.
  }
  if (saved && ((PLUGIN_NPM_REGISTRIES as readonly string[]).includes(saved) || customNpmRegistry(saved) === saved)) return saved as PluginNpmRegistry;
  return language === "zh-CN" ? "npmmirror" : "npmjs";
}

function rememberRegistry(registry: PluginNpmRegistry): void {
  try {
    localStorage.setItem(REGISTRY_KEY, registry);
  } catch {
    // Next time starts from the default.
  }
}

const isKnownRegistry = (registry: PluginNpmRegistry): registry is (typeof PLUGIN_NPM_REGISTRIES)[number] =>
  (PLUGIN_NPM_REGISTRIES as readonly string[]).includes(registry);

/** What to call a registry: its name, or for another one, its host. */
export function registryLabel(registry: PluginNpmRegistry): string {
  if (isKnownRegistry(registry)) return t(`pluginAdd.registries.${registry}`);
  try {
    return new URL(registry).host;
  } catch {
    return registry;
  }
}

/**
 * One place to add a plugin from outside the app: read the package, show what it
 * does, then add it. Given a plugin from the market, it starts with that review.
 */
export function PluginAddDialog({ listed, source, onClose, onAdded }: {
  listed?: MarketPlugin;
  /** Starts with the review of this package, as for an update from where a plugin came from. */
  source?: PluginAddSource;
  onClose: () => void;
  onAdded: (id: string) => void;
}) {
  const started = Boolean(listed ?? source);
  const [kind, setKind] = useState<SourceKind>("npm");
  const [name, setName] = useState("");
  const [registry, setRegistry] = useState<(typeof PLUGIN_NPM_REGISTRIES)[number] | "custom">(() => {
    const preferred = preferredRegistry();
    return isKnownRegistry(preferred) ? preferred : "custom";
  });
  const [customRegistry, setCustomRegistry] = useState(() => {
    const preferred = preferredRegistry();
    return isKnownRegistry(preferred) ? "" : preferred;
  });
  const [url, setUrl] = useState("");
  const [file, setFile] = useState<File>();
  /** A folder typed in, where there's no desktop folder picker. */
  const [folderPath, setFolderPath] = useState("");
  const [development, setDevelopment] = useState(false);
  const [review, setReview] = useState<Review>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [versionIssue, setVersionIssue] = useState<"needs-app-update" | "needs-plugin-update">();
  const desktop = typeof window !== "undefined" ? window.ohMyGameDesktop : undefined;

  async function run(work: () => Promise<void>): Promise<void> {
    if (busy) return;
    setBusy(true);
    setError(undefined);
    setVersionIssue(undefined);
    try {
      await work();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      const code = cause instanceof ApiError ? cause.code : undefined;
      setVersionIssue(code === "needs-app-update" || code === "needs-plugin-update" ? code : undefined);
    } finally {
      setBusy(false);
    }
  }

  const readSource = (source: PluginAddSource, folder?: string) => run(async () => {
    setReview({ preview: await inspectAddedPlugin(source), ...(folder ? { folder } : {}) });
  });
  useEffect(() => {
    if (listed) void readSource({ type: "npm", name: listed.package, version: listed.version, registry: preferredRegistry(), market: true });
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
    else if (kind === "npm") {
      const chosen = registry === "custom" ? customNpmRegistry(customRegistry) : registry;
      if (!chosen) {
        setError(t("pluginAdd.customRegistryInvalid"));
        return;
      }
      rememberRegistry(chosen);
      void readSource({ type: "npm", name: name.trim(), registry: chosen });
    }
    else if (kind === "github") void readSource({ type: "github", url: url.trim() });
    else if (folderPath.trim()) void readSource(folderSource(folderPath.trim()), folderPath.trim());
    else if (file) void readFile(file);
  }
  const folderSource = (folder: string): PluginAddSource => ({ type: "directory", path: folder, ...(development ? { development: true as const } : {}) });
  async function chooseFolder(): Promise<void> {
    await run(async () => {
      const selected = await desktop?.selectPluginDirectory();
      if (selected) setReview({ preview: await inspectAddedPlugin(folderSource(selected)), folder: selected });
    });
  }
  const canContinue = review || (kind === "npm" ? name.trim() && (registry !== "custom" || customRegistry.trim()) : kind === "github" ? url.trim() : folderPath.trim() || file);

  return <Dialog open onClose={() => { if (!busy) onClose(); }}
    title={review ? t("pluginAdd.reviewTitle", { name: review.preview.displayName }) : t("pluginAdd.title")}
    description={review || started ? undefined : t("pluginAdd.description")}
    footer={<>
      <Button disabled={busy} onClick={() => { if (review && !started) { setReview(undefined); setError(undefined); } else onClose(); }}>{review && !started ? t("pluginAdd.back") : t("common.cancel")}</Button>
      {started && !review ? null : <Button variant="primary" type="submit" form="plugin-add-form" disabled={busy || !canContinue}
        icon={busy ? <LoaderCircle className="spin" size={14} /> : undefined}>{review ? t("pluginAdd.add") : t("pluginAdd.continue")}</Button>}
    </>}>
    <form id="plugin-add-form" className="plugins-install-form" onSubmit={submit}>
      {review ? <PluginAddReview review={review} {...(listed ? { listed } : {})} /> : started ? (busy ? <p>{t("pluginAdd.reading")}</p> : null) : <>
        <Tabs<SourceKind> variant="pills" label={t("pluginAdd.source")} value={kind} onChange={(next) => { if (busy) return; setKind(next); setError(undefined); }} tabs={[
          { value: "npm", label: "npm" },
          { value: "github", label: "GitHub" },
          { value: "local", label: t("pluginAdd.local") },
        ]} />
        {kind === "npm" ? <>
          <Field label={t("pluginAdd.packageName")} hint={t("pluginAdd.packageHint")}>{(props) => <Input {...props} autoFocus required disabled={busy} value={name} placeholder="@publisher/plugin" spellCheck={false} onChange={(event) => setName(event.target.value)} />}</Field>
          <Field label={t("pluginAdd.registry")}>{(props) => <Select {...props} label={t("pluginAdd.registry")} value={registry} disabled={busy} onChange={setRegistry} options={[
            ...PLUGIN_NPM_REGISTRIES.map((value) => ({ value, label: t(`pluginAdd.registries.${value}`) })),
            { value: "custom" as const, label: t("pluginAdd.customRegistry") },
          ]} />}</Field>
          {registry === "custom" ? <Field label={t("pluginAdd.customRegistryAddress")} hint={t("pluginAdd.customRegistryHint")}>{(props) => <Input {...props} required disabled={busy} type="url" value={customRegistry} placeholder="https://registry.example.com" spellCheck={false} onChange={(event) => setCustomRegistry(event.target.value)} />}</Field> : null}
        </> : null}
        {kind === "github" ? <Field label={t("pluginAdd.repository")} hint={t("pluginAdd.repositoryHint")}>{(props) => <Input {...props} autoFocus required disabled={busy} type="url" value={url} placeholder="https://github.com/publisher/plugin" spellCheck={false} onChange={(event) => setUrl(event.target.value)} />}</Field> : null}
        {kind === "local" ? <>
          {desktop ? <Button disabled={busy} onClick={() => void chooseFolder()}>{t("pluginAdd.chooseFolder")}</Button>
            : <Field label={t("pluginAdd.folder")} hint={t("pluginAdd.folderHint")}>{(props) => <Input {...props} disabled={busy} value={folderPath} placeholder="/Users/me/my-plugin" spellCheck={false} onChange={(event) => setFolderPath(event.target.value)} />}</Field>}
          <Checkbox checked={development} disabled={busy} onChange={setDevelopment} label={t("pluginAdd.develop")} description={t("pluginAdd.developHint")} />
          <PluginFilePicker label={t("pluginAdd.packageFile")} inputLabel={t("pluginAdd.packageFile")} chooseLabel={t("pluginAdd.chooseFile")} emptyLabel={t("pluginAdd.noFile")} file={file} accept=".tgz,.tar.gz,application/gzip" disabled={busy} onChange={setFile} />
        </> : null}
      </>}
      {error ? <Alert tone="danger" title={versionIssue === "needs-app-update" ? t("pluginAdd.needsAppUpdate") : versionIssue ? t("pluginAdd.needsPluginUpdate") : error} action={versionIssue === "needs-app-update" && desktop?.updates ? <Button size="sm" onClick={() => {
        window.location.hash = settingsHash("about");
        onClose();
      }}>{t("pluginAdd.updateApp")}</Button> : undefined} /> : null}
    </form>
  </Dialog>;
}

function PluginAddReview({ review, listed }: { review: Review; listed?: MarketPlugin }) {
  const { preview, folder, file } = review;
  const others = preview.installedVersions.filter((version) => version !== preview.version);
  return <div className="plugin-add-review">
    <p>{preview.description}</p>
    <dl>
      <dt>{t("pluginAdd.plugin")}</dt><dd>{preview.id} {preview.version}</dd>
      <dt>{t("pluginAdd.from")}</dt><dd>{sourceLabel(preview, folder ?? file?.name)}</dd>
      {listed?.repository ? <><dt>{t("plugins.repository")}</dt><dd><a href={listed.repository} target="_blank" rel="noreferrer">{listed.repository.replace("https://github.com/", "")}</a> · {t(listed.sourceVerified ? "plugins.sourceVerified" : "plugins.sourceUnverified")}</dd></> : null}
    </dl>
    <p>{t(preview.appWide ? "pluginAdd.appliesByItself" : "pluginAdd.turnedOnPerProject")}</p>
    {preview.asks.length ? <section><h3>{t("pluginBuilder.asksFor")}</h3><PluginCapabilityList capabilities={preview.asks} newAsks={preview.newAsks} />
      {preview.newAsks ? <p>{preview.newAsks.length ? t("pluginAdd.asksAgain") : t("pluginAdd.asksNothingNew")}</p> : null}
    </section> : null}
    <NativeCodeWarning asks={preview.asks} />
    {preview.skills ? <p>{t("plugins.skillCount", { count: preview.skills })}</p> : null}
    {preview.mcpServers.length ? <section><h3>{t("pluginControls.mcpServices")}</h3><ul>{preview.mcpServers.map((server) => <li key={server}>{server}</li>)}</ul></section> : null}
    {preview.hooks?.length ? <section><h3>{t("pluginHooks.heading")}</h3><ul>{preview.hooks.map((hook) => <li key={hook}>{hookLabel(hook)}</li>)}</ul></section> : null}
    {preview.settings ? <p>{t("pluginAdd.settingsAfterAdding")}</p> : null}
    {preview.origin?.type === "development" ? <p>{t("pluginAdd.developsFolder")}</p> : null}
    {preview.installedVersions.includes(preview.version) ? <Alert tone="info" title={t("pluginAdd.alreadyInstalled", { version: preview.version })} /> : null}
    {others.length ? <p>{t(preview.appWide ? "pluginAdd.replacesVersions" : "pluginAdd.keepsVersions", { versions: others.join(", ") })}</p> : null}
    <Alert tone="info" title={t("pluginAdd.unreviewed")} />
  </div>;
}

function sourceLabel({ origin }: PluginAddPreview, local: string | undefined): string {
  if (origin?.type === "npm") return `${origin.package} · ${registryLabel(origin.registry)}`;
  if (origin?.type === "github") return `github.com/${origin.repository} · ${origin.commit.slice(0, 7)}`;
  if (origin?.type === "development") return `${origin.folder} · ${t("plugins.inDevelopment")}`;
  return local ?? t("pluginAdd.local");
}
