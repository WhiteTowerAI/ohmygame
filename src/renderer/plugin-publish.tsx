import { useEffect, useState, type ReactNode } from "react";
import type { GitHubAccountView, GitHubPublished } from "../shared/plugin-setup.js";
import type { StorePlugin } from "../shared/plugins.js";
import { publishStorePluginToGitHub, readGitHubAccount, signInToGitHub, signOutOfGitHub } from "./api.js";
import { ExternalLinkFallback, useExternalLink } from "./external-link.js";
import { CircleCheck, ExternalLink, LoaderCircle } from "./icons.js";
import { Alert, Avatar, Button, Dialog } from "./ui/index.js";
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

  const signOut = () => void run(async () => { await signOutOfGitHub(); setAccount(await readGitHubAccount()); });
  const signIn = () => void run(async () => {
    const next = await signInToGitHub();
    setAccount(next);
    if (next.signIn) openGitHub(next.signIn);
  });

  const footer = published ? <>
    <Button icon={<ExternalLink size={14} />} onClick={() => void link.open(published.release)}>{t("pluginBuilder.publish.openRelease")}</Button>
    <Button variant="primary" onClick={onClose}>{t("common.done")}</Button>
  </> : <>
    <Button disabled={busy} onClick={onClose}>{t("common.cancel")}</Button>
    {login ? <Button variant="primary" disabled={busy} icon={busy ? <LoaderCircle className="spin" size={14} /> : undefined}
      onClick={() => void run(async () => setPublished(await publishStorePluginToGitHub(plugin.id)))}>
      {busy ? t("pluginBuilder.publish.publishing") : t("pluginBuilder.publish.publish")}</Button>
      : account?.signIn ? <Button variant="primary" icon={<ExternalLink size={14} />} onClick={() => openGitHub(account.signIn!)}>{t("pluginBuilder.publish.openGitHub")}</Button>
      : account ? <Button variant="primary" disabled={busy} onClick={signIn}>{t("pluginBuilder.publish.signIn")}</Button> : null}
  </>;
  return <Dialog open title={t("pluginBuilder.publish.title")} onClose={() => { if (!busy) onClose(); }} footer={footer}>
    <div className="plugin-publish">
      {published ? <div className="plugin-publish-done">
        <CircleCheck size={28} />
        <strong>{t("pluginBuilder.publish.published", { name: plugin.displayName, version: published.version })}</strong>
        <p>{t("pluginBuilder.publish.publishedHint", { id: published.id })}</p>
      </div> : !account ? (error ? null : <p role="status" className="plugin-publish-note"><LoaderCircle className="spin" size={13} /></p>)
        : account.signIn ? <div className="plugin-publish-code">
          <p>{t("pluginBuilder.publish.enterCode")}</p>
          <div className="settings-device-code">{account.signIn.userCode}</div>
          <p role="status" className="plugin-publish-note"><LoaderCircle className="spin" size={13} /> {t("pluginBuilder.publish.waiting")}</p>
        </div> : login ? <>
          <div className="plugin-publish-account">
            <Avatar name={login} size={28} />
            <span className="plugin-publish-login">{login}</span>
            <Button variant="ghost" size="sm" disabled={busy} onClick={signOut}>{t("pluginBuilder.publish.signOut")}</Button>
          </div>
          <dl className="plugin-publish-facts">
            <div><dt>{t("pluginBuilder.publish.plugin")}</dt><dd>{plugin.displayName} <span>{plugin.version}</span></dd></div>
            <div><dt>{t("pluginBuilder.publish.repository")}</dt><dd>github.com/{login}/{name}</dd></div>
          </dl>
          <p className="plugin-publish-note">{t("pluginBuilder.publish.summary")}</p>
        </> : <div className="plugin-publish-intro">
          <p>{t("pluginBuilder.publish.signInHint")}</p>
          <p className="plugin-publish-note">{t("pluginBuilder.publish.signInNote")}</p>
        </div>}
      <ExternalLinkFallback url={link.failedUrl} />
      {error ?? account?.error ? <Alert tone="danger" title={error ?? account?.error} /> : null}
    </div>
  </Dialog>;
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
