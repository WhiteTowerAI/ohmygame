import { useEffect, useState, type ReactNode } from "react";
import type { GitHubAccountView, GitHubPublished } from "../shared/plugin-setup.js";
import type { StorePlugin } from "../shared/plugins.js";
import { publishStorePluginToGitHub, readGitHubAccount, signInToGitHub, signOutOfGitHub } from "./api.js";
import { ExternalLinkFallback, useExternalLink } from "./external-link.js";
import { ExternalLink, LoaderCircle } from "./icons.js";
import { Alert, Button, Dialog } from "./ui/index.js";
import { t } from "./i18n.js";

/**
 * Publishes a plugin made in the Plugin Builder to GitHub, where the plugin
 * market finds it, after signing in with GitHub's device flow.
 */
export function PluginPublishDialog({ plugin, onClose }: { plugin: StorePlugin; onClose: () => void }): ReactNode {
  const [account, setAccount] = useState<GitHubAccountView>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [published, setPublished] = useState<GitHubPublished>();
  const link = useExternalLink();
  const name = plugin.id.slice(plugin.id.indexOf("/") + 1);
  const waiting = Boolean(account?.signIn);
  useEffect(() => {
    void readGitHubAccount().then(setAccount, (cause: unknown) => setError(message(cause)));
  }, []);
  // GitHub tells the daemon when the person entered the code; until then, ask again.
  useEffect(() => {
    if (!waiting) return;
    const timer = window.setInterval(() => void readGitHubAccount().then(setAccount).catch(() => {}), 2000);
    return () => window.clearInterval(timer);
  }, [waiting]);

  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError(undefined);
    try {
      await action();
    } catch (cause) {
      setError(message(cause));
      // A sign-in GitHub no longer takes is gone now.
      await readGitHubAccount().then(setAccount).catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  const openGitHub = (signIn: NonNullable<GitHubAccountView["signIn"]>) => {
    void navigator.clipboard?.writeText(signIn.userCode).catch(() => {});
    void link.open(signIn.verificationUri);
  };
  const login = account?.login;
  const id = login ? `${login.toLowerCase()}/${name}` : "";

  const footer = published ? <Button variant="primary" onClick={onClose}>{t("common.done")}</Button> : <>
    {login ? <Button disabled={busy} onClick={() => void run(async () => { await signOutOfGitHub(); setAccount(await readGitHubAccount()); })}>{t("pluginBuilder.publish.signOut")}</Button> : null}
    <Button disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
    {login ? <Button variant="primary" disabled={busy} icon={busy ? <LoaderCircle className="spin" size={14} /> : undefined}
      onClick={() => void run(async () => setPublished(await publishStorePluginToGitHub(plugin.id)))}>
      {busy ? t("pluginBuilder.publish.publishing") : t("pluginBuilder.publish.publish")}</Button>
      : account && !waiting ? <Button variant="primary" disabled={busy} onClick={() => void run(async () => {
        const next = await signInToGitHub();
        setAccount(next);
        if (next.signIn) openGitHub(next.signIn);
      })}>{t("pluginBuilder.publish.signIn")}</Button> : null}
  </>;
  return <Dialog open title={t("pluginBuilder.publish.title", { name: plugin.displayName })} onClose={() => { if (!busy) onClose(); }} footer={footer}>
    {published ? <>
      <p>{t("pluginBuilder.publish.published", { id: published.id, version: published.version })}</p>
      <p>{t("pluginBuilder.publish.personalStays", { id: published.id, personal: plugin.id })}</p>
      <Button icon={<ExternalLink size={14} />} onClick={() => void link.open(published.release)}>{t("pluginBuilder.publish.openRelease")}</Button>
    </> : !account ? (error ? null : <p role="status"><LoaderCircle className="spin" size={13} /></p>)
      : account.signIn ? <>
        <p>{t("pluginBuilder.publish.enterCode")}</p>
        <div className="settings-device-code">{account.signIn.userCode}</div>
        <p role="status"><LoaderCircle className="spin" size={13} /> {t("pluginBuilder.publish.waiting")}</p>
        <Button icon={<ExternalLink size={14} />} onClick={() => openGitHub(account.signIn!)}>{t("pluginBuilder.publish.openGitHub")}</Button>
      </> : login ? <>
        <p>{t("pluginBuilder.publish.signedInAs", { login })}</p>
        <p>{t("pluginBuilder.publish.summary", { id, version: plugin.version, repository: `github.com/${login}/${name}` })}</p>
        <p>{t("pluginBuilder.publish.personalStays", { id, personal: plugin.id })}</p>
      </> : <p>{t("pluginBuilder.publish.signInHint")}</p>}
    <ExternalLinkFallback url={link.failedUrl} />
    {error ?? account?.error ? <Alert tone="danger" title={error ?? account?.error} /> : null}
  </Dialog>;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
