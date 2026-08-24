import { X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { useAuth } from "./auth.js";
import { ModelsSettings, type ModelsView } from "./models-settings.js";
import type { DesktopUpdateState } from "../shared/desktop-update.js";

type SettingsSection = "account" | "providers" | "about";

export function SettingsDialog({ onClose }: { onClose: () => void }) {
  const [section, setSection] = useState<SettingsSection>("account");
  const [modelsView, setModelsView] = useState<ModelsView>({ page: "providers" });
  const dialog = useRef<HTMLElement>(null);
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    dialog.current?.focus();
    const handleKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        onCloseRef.current();
        return;
      }
      if (event.key !== "Tab" || !dialog.current) return;
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>("button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), [tabindex]:not([tabindex='-1'])")];
      if (focusable.length === 0) {
        event.preventDefault();
        dialog.current.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (document.activeElement === dialog.current) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", handleKeyboard);
    return () => {
      window.removeEventListener("keydown", handleKeyboard);
      previousFocus?.focus();
    };
  }, []);

  function chooseSection(next: SettingsSection): void {
    setSection(next);
    if (next === "providers") setModelsView({ page: "providers" });
  }

  return (
    <div className="settings-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget) onClose();
    }}>
      <section ref={dialog} className="settings-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-title" tabIndex={-1}>
        <header className="settings-header">
          <h2 id="settings-title">Settings</h2>
          <button type="button" onClick={onClose} aria-label="Close settings"><X size={16} /></button>
        </header>
        <div className="settings-body">
          <nav className="settings-nav" aria-label="Settings sections">
            <NavItem active={section === "account"} label="Account" onClick={() => chooseSection("account")} />
            <NavItem active={section === "providers"} label="Providers" onClick={() => chooseSection("providers")} />
            <NavItem active={section === "about"} label="About" onClick={() => chooseSection("about")} />
          </nav>
          <div className="settings-content">
            {section === "account" ? <AccountSettings onOpenSignIn={onClose} /> : null}
            {section === "providers" ? <ModelsSettings view={modelsView} onViewChange={setModelsView} /> : null}
            {section === "about" ? <AboutSettings /> : null}
          </div>
        </div>
      </section>
    </div>
  );
}

function NavItem({ active, label, onClick }: { active: boolean; label: string; onClick: () => void }) {
  return <button className={active ? "settings-nav-active" : ""} type="button" onClick={onClick}>{label}</button>;
}

function AccountSettings({ onOpenSignIn }: { onOpenSignIn: () => void }) {
  const auth = useAuth();
  const [error, setError] = useState<string>();
  return (
    <section className="settings-panel">
      <h3>Account</h3>
      {auth.state.status === "signed-in" ? (
        <>
          <div className="settings-account-row"><span>Signed in as</span><strong>{auth.state.user.email ?? auth.state.user.name}</strong></div>
          <button className="settings-danger-button" type="button" onClick={() => void auth.signOut().catch((cause) => setError(errorMessage(cause)))}>Sign out</button>
        </>
      ) : (
        <button className="settings-primary-button" type="button" onClick={() => {
          onOpenSignIn();
          auth.openSignIn();
        }}>Sign in</button>
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
    <section className="settings-panel">
      <h3>About</h3>
      <div className="settings-about-row">
        <span>Version</span>
        <strong>{update?.currentVersion ?? "0.0.0-alpha.1"}</strong>
      </div>
      <p className="settings-about-status">{message}</p>
      {updates ? (
        <div className="settings-about-actions">
          {status?.type === "available" ? <button className="settings-primary-button" type="button" onClick={() => void updates.download()}>Download update</button> : null}
          {status?.type === "ready" ? <button className="settings-primary-button" type="button" onClick={() => void updates.install()}>Restart to update</button> : null}
          <button className="settings-secondary-button" type="button" disabled={busy} onClick={() => void updates.check()}>
            {status?.type === "error" ? "Check again" : "Check for updates"}
          </button>
        </div>
      ) : null}
    </section>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
