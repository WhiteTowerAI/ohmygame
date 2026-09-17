import { useEffect, useState, type CSSProperties } from "react";
import { ArrowLeft, InfoCircle, Plug, Server, UserRound } from "./icons.js";
import { useAuth } from "./auth.js";
import { readSidebarWidth } from "./app-sidebar.js";
import { ModelsSettings, type ModelsView } from "./models-settings.js";
import type { SettingsSection } from "./routes.js";
import { UserAvatar } from "./user-avatar.js";
import { WindowDragRegion } from "./window-drag-region.js";
import type { DesktopUpdateState } from "../shared/desktop-update.js";
import { ConnectionsSettings } from "./connections-settings.js";

const SETTINGS_SECTIONS: Array<{ section: SettingsSection; label: string; icon: typeof UserRound }> = [
  { section: "account", label: "Account", icon: UserRound },
  { section: "providers", label: "Providers", icon: Server },
  { section: "connections", label: "Connections", icon: Plug },
  { section: "about", label: "About", icon: InfoCircle },
];

export function SettingsPage({ section, onBack, onSectionChange }: {
  section: SettingsSection;
  onBack: () => void;
  onSectionChange: (section: SettingsSection) => void;
}) {
  const [modelsView, setModelsView] = useState<ModelsView>({ page: "providers" });
  const sidebarStyle = { "--sidebar-width": `${readSidebarWidth()}px` } as CSSProperties;

  function chooseSection(next: SettingsSection): void {
    if (next === "providers") setModelsView({ page: "providers" });
    onSectionChange(next);
  }

  return (
    <main className="home-shell settings-page-shell" style={sidebarStyle}>
      <aside className="home-sidebar settings-page-sidebar">
        <div className="home-sidebar-traffic" aria-hidden="true">
          <span className="home-sidebar-traffic-red" />
          <span className="home-sidebar-traffic-yellow" />
          <span className="home-sidebar-traffic-green" />
        </div>
        <button className="settings-page-back" type="button" onClick={onBack}>
          <ArrowLeft size={17} />
          <span>Back to app</span>
        </button>
        <nav className="settings-page-nav" aria-label="Settings sections">
          <div className="home-nav-label">SETTINGS</div>
          {SETTINGS_SECTIONS.map((item) => {
            const Icon = item.icon;
            const active = section === item.section;
            return (
              <button className={`settings-page-nav-item${active ? " is-active" : ""}`} type="button" aria-current={active ? "page" : undefined} onClick={() => chooseSection(item.section)} key={item.section}>
                <Icon size={17} />
                <span>{item.label}</span>
              </button>
            );
          })}
        </nav>
      </aside>
      <section className="settings-page-content">
        <WindowDragRegion />
        <div className="settings-page-inner">
          {section === "account" ? <AccountSettings /> : null}
          {section === "providers" ? <ModelsSettings view={modelsView} onViewChange={setModelsView} /> : null}
          {section === "connections" ? <ConnectionsSettings /> : null}
          {section === "about" ? <AboutSettings /> : null}
        </div>
      </section>
    </main>
  );
}

function AccountSettings() {
  const auth = useAuth();
  const [error, setError] = useState<string>();
  return (
    <section className="settings-panel settings-overview-panel settings-account-panel">
      <header className="settings-panel-header"><h3>Account</h3></header>
      {auth.state.status === "signed-in" ? (
        <div className="settings-account-row">
          <div className="settings-account-profile">
            <UserAvatar className="settings-account-avatar" name={auth.state.user.name} avatarUrl={auth.state.user.avatarUrl} />
            <span className="settings-account-copy">
              <small>Signed in as</small>
              <strong>{auth.state.user.name}</strong>
              {auth.state.user.email ? <span>{auth.state.user.email}</span> : null}
            </span>
          </div>
          <button className="settings-danger-button" type="button" onClick={() => void auth.signOut().catch((cause) => setError(errorMessage(cause)))}>Sign out</button>
        </div>
      ) : (
        <button className="settings-primary-button" type="button" onClick={auth.openSignIn}>Sign in</button>
      )}
      {error ? <p className="settings-error" role="alert">{error}</p> : null}
    </section>
  );
}

function AboutSettings() {
  const [update, setUpdate] = useState<DesktopUpdateState | null>(null);
  const updates = window.openGameDesktop?.updates;
  useEffect(() => {
    if (!updates) return;
    let disposed = false;
    void updates.state().then((state) => { if (!disposed) setUpdate(state); }).catch(() => undefined);
    const unsubscribe = updates.onState(setUpdate);
    return () => { disposed = true; unsubscribe(); };
  }, [updates]);
  const status = update?.status;
  const message = status?.type === "up-to-date" ? "You're up to date"
    : status?.type === "checking" ? "Checking for updates..."
      : status?.type === "available" ? `Update available: ${status.version}`
        : status?.type === "downloading" ? `Downloading update (${status.percent}%)`
          : status?.type === "ready" ? `Ready to restart: ${status.version}`
            : status?.type === "error" ? status.message : "Not checked yet";
  const busy = status?.type === "checking" || status?.type === "downloading";
  return (
    <section className="settings-panel settings-overview-panel">
      <header className="settings-panel-header"><h3>About</h3></header>
      <div className="settings-about-list">
        <div className="settings-about-row">
          <span>Version</span>
          <strong>{update?.currentVersion ?? __APP_VERSION__}</strong>
        </div>
        <div className="settings-about-row">
          <span>Updates</span>
          <div className="settings-about-update">
            <span className="settings-about-status">{message}</span>
            {updates ? (
              <div className="settings-about-actions">
                {status?.type === "available" ? <button className="settings-primary-button" type="button" onClick={() => void updates.download()}>Download update</button> : null}
                {status?.type === "ready" ? <button className="settings-primary-button" type="button" onClick={() => void updates.install()}>Restart to update</button> : null}
                <button className="settings-secondary-button" type="button" disabled={busy} onClick={() => void updates.check()}>
                  {status?.type === "error" ? "Check again" : "Check for updates"}
                </button>
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
