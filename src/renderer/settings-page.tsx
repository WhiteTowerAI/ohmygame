import { useEffect, useState, type ReactNode } from "react";
import { Cloud, ExternalLink, Globe2, MessageCircle } from "./icons.js";
import githubMark from "@lobehub/icons-static-svg/icons/github.svg";
import { useAuth } from "./auth.js";
import { ModelsSettings, type ModelsView } from "./models-settings.js";
import { AgentsSettings, OHMYGAME_AGENT } from "./agents-settings.js";
import { PageFrame } from "./page-frame.js";
import type { AppNavigationTarget, SettingsSection } from "./routes.js";
import { UserAvatar } from "./user-avatar.js";
import { BrandLogo } from "./brand-logo.js";
import { WindowDragRegion } from "./window-drag-region.js";
import { useDesktopUpdate } from "./use-desktop-update.js";
import { SETTINGS_NAV as NAV } from "./settings-sections.js";
import {
  readAppearance, readChatFont, readPalette, setAppearance as persistAppearance, setChatFont, setPalette,
  type Appearance, type ChatFont, type Palette,
} from "./appearance.js";
import { ConnectionsSettings } from "./connections-settings.js";
import { WebSearchSettingsPanel } from "./web-search-settings.js";
import { NetworkSettingsPanel } from "./network-settings.js";
import { ExternalAgentsSettings } from "./external-agents-settings.js";
import { readLanguagePreference, setLanguagePreference, t, type LanguagePreference } from "./i18n.js";
import { ChangelogPanel } from "./changelog-panel.js";
import { exportDiagnostics, getProjectLocation, setProjectLocation } from "./api.js";
import { readGeneralPreferences, setGeneralPreference, type GeneralPreferences } from "./general-preferences.js";
import { Badge, Button, Progress, SegmentedControl, Select, Spinner, Switch, Tooltip } from "./ui/index.js";
import { SettingsGroup, SettingsNote, SettingsRow } from "./settings-parts.js";
import "./settings.css";

const BILLING_DASHBOARD_URL = "https://account.ohmygame.ai/account/billing";
const LANGUAGE_OPTIONS: readonly { value: LanguagePreference; label: string }[] = [
  { value: "system", label: t("settings.appearance.system") },
  // Language names stay in their own language so people can find theirs.
  { value: "en", label: "English" },
  { value: "zh-CN", label: "简体中文" },
];

export function SettingsPage({ section, agent, onSectionChange, onNavigate, onOpenOnboarding }: {
  section: SettingsSection;
  /** An agent's own page under Agents (`#/settings/agents/<id>`). */
  agent?: string;
  onSectionChange: (section: SettingsSection, agent?: string) => void;
  onNavigate: (page: AppNavigationTarget) => void;
  onOpenOnboarding?: () => void;
}) {
  const [modelsView, setModelsView] = useState<ModelsView>({ page: "providers" });

  function chooseSection(next: SettingsSection): void {
    if (next === "providers") setModelsView({ page: "providers" });
    onSectionChange(next);
  }

  // Billing is hidden from the list but still answers its link.
  const current = NAV.flatMap((group) => group.items).find((item) => item.section === section)
    ?? (section === "billing" ? { label: t("settings.nav.billing") } : undefined);
  // An agent's own page draws its own head.
  const inDetail = section === "agents" && Boolean(agent);
  return (
    <PageFrame active="settings" onNavigate={onNavigate} aside={
      <nav className="settings-nav" aria-label={t("settings.nav.label")}>
        <div className="settings-nav-title">{t("common.settings")}</div>
        {NAV.map((group, index) => (
          <div className="settings-nav-group" key={index}>
            {group.heading ? <div className="settings-nav-heading">{group.heading}</div> : null}
            {group.items.map((item) => {
              const Icon = item.icon;
              const active = section === item.section;
              return (
                <button className={`settings-nav-item${active ? " is-current" : ""}`} type="button" aria-current={active ? "page" : undefined} onClick={() => chooseSection(item.section)} key={item.section}>
                  <Icon size={16} />
                  <span>{item.label}</span>
                </button>
              );
            })}
          </div>
        ))}
      </nav>
    }>
      <main className="settings-scroll">
        <WindowDragRegion />
        <div className="settings-body">
          {!inDetail && current ? <header className="settings-head"><h1>{current.label}</h1></header> : null}
          {section === "general" ? <GeneralSettings /> : null}
          {section === "appearance" ? <AppearanceSettings /> : null}
          {section === "account" ? <AccountSettings /> : null}
          {section === "billing" ? <BillingSettings /> : null}
          {section === "providers" ? <ModelsSettings view={modelsView} onViewChange={setModelsView} onOpenAgents={() => chooseSection("agents")} onOpenChatModel={() => onSectionChange("agents", OHMYGAME_AGENT)} /> : null}
          {section === "agents" ? <AgentsSettings agent={agent} onOpen={(id) => onSectionChange("agents", id)} onBack={() => onSectionChange("agents")} onOpenSection={chooseSection} onOpenPlugins={() => onNavigate("plugins")} /> : null}
          {section === "web-search" ? <WebSearchSettingsPanel /> : null}
          {section === "network" ? <NetworkSettingsPanel /> : null}
          {section === "connections" ? <ConnectionsSettings /> : null}
          {section === "mcp-server" ? <ExternalAgentsSettings /> : null}
          {section === "about" ? <AboutSettings onOpenNetwork={() => chooseSection("network")} onOpenOnboarding={onOpenOnboarding} /> : null}
        </div>
      </main>
    </PageFrame>
  );
}

// ---------- general ----------

function GeneralSettings() {
  const [language, updateLanguage] = useState<LanguagePreference>(readLanguagePreference);
  const [preferences, updatePreferences] = useState<GeneralPreferences>(readGeneralPreferences);
  const desktop = Boolean(window.ohMyGameDesktop);
  const mod = window.ohMyGameDesktop?.platform === "darwin" || navigator.platform.toLowerCase().includes("mac") ? "⌘" : "Ctrl";
  function change<K extends keyof GeneralPreferences>(key: K, value: GeneralPreferences[K]): void {
    setGeneralPreference(key, value);
    updatePreferences((current) => ({ ...current, [key]: value }));
  }
  return (
    <>
      <SettingsGroup>
        <SettingsRow title={t("settings.general.openTo")} description={t("settings.general.openToHint")}>
          <Select size="sm" label={t("settings.general.openTo")} value={preferences.openTo} onChange={(value) => change("openTo", value)} options={[
            { value: "home", label: t("settings.general.openToHome") },
            { value: "last", label: t("settings.general.openToLast") },
          ]} />
        </SettingsRow>
        <SettingsRow title={t("settings.appearance.language")} description={t("settings.general.languageHint")}>
          <Select size="sm" label={t("settings.appearance.languageLabel")} options={LANGUAGE_OPTIONS} value={language} onChange={(next) => {
            updateLanguage(next);
            setLanguagePreference(next);
          }} />
        </SettingsRow>
        <ProjectLocationRow />
      </SettingsGroup>
      <SettingsGroup title={t("settings.general.conversation")}>
        <SettingsRow title={t("settings.general.sendKey")} description={preferences.sendKey === "enter" ? t("settings.general.sendEnterHint") : t("settings.general.sendModEnterHint", { mod })}>
          <SegmentedControl size="sm" label={t("settings.general.sendKey")} value={preferences.sendKey} onChange={(value) => change("sendKey", value)} options={[
            { value: "enter", label: "Enter" },
            { value: "mod-enter", label: `${mod} Enter` },
          ]} />
        </SettingsRow>
      </SettingsGroup>
      <SettingsGroup title={t("settings.general.notifications")}>
        <SettingsRow title={t("settings.general.runNotifications")} description={t("settings.general.runNotificationsHint")}>
          <Switch label={t("settings.general.runNotifications")} checked={preferences.runNotifications} onChange={(value) => change("runNotifications", value)} />
        </SettingsRow>
        <SettingsRow title={t("settings.general.runSound")} description={t("settings.general.runSoundHint")}>
          <Switch label={t("settings.general.runSound")} checked={preferences.runSound} onChange={(value) => change("runSound", value)} />
        </SettingsRow>
      </SettingsGroup>
      {desktop ? (
        <SettingsGroup title={t("settings.general.system")}>
          <SettingsRow title={t("settings.general.keepAwake")} description={t("settings.general.keepAwakeHint")}>
            <Switch label={t("settings.general.keepAwake")} checked={preferences.keepAwake} onChange={(value) => change("keepAwake", value)} />
          </SettingsRow>
          {window.ohMyGameDesktop?.updates?.setAutomatic ? (
            <SettingsRow title={t("settings.general.autoUpdate")} description={t("settings.general.autoUpdateHint")}>
              <Switch label={t("settings.general.autoUpdate")} checked={preferences.autoUpdate} onChange={(value) => change("autoUpdate", value)} />
            </SettingsRow>
          ) : null}
        </SettingsGroup>
      ) : null}
    </>
  );
}

/** Where new projects go when no folder is chosen for them. */
function ProjectLocationRow() {
  const [location, setLocation] = useState<string>();
  const [storage, setStorage] = useState<string>();
  const [loaded, setLoaded] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const choose = window.ohMyGameDesktop?.selectProjectDirectory;
  useEffect(() => {
    let active = true;
    void getProjectLocation()
      .then((value) => { if (active) { setLocation(value.location); setStorage(value.storage); setLoaded(true); } })
      .catch((cause) => { if (active) setError(errorMessage(cause)); });
    return () => { active = false; };
  }, []);
  async function save(next: string | undefined): Promise<void> {
    setBusy(true);
    setError(undefined);
    try {
      const saved = await setProjectLocation(next);
      setLocation(saved.location);
      setStorage(saved.storage);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setBusy(false);
    }
  }
  async function pick(): Promise<void> {
    const selected = await choose?.();
    if (selected) await save(selected);
  }
  return (
    <>
      <SettingsRow title={t("settings.general.projectLocation")} description={t("settings.general.projectLocationHint")}>
        {loaded ? <span className="settings-mono settings-muted settings-location" title={location ?? storage}><bdi>{location ?? storage ?? t("settings.general.projectLocationDefault")}</bdi></span> : null}
        {location ? <Button size="sm" variant="ghost" disabled={busy} onClick={() => void save(undefined)}>{t("settings.general.projectLocationReset")}</Button> : null}
        {choose ? <Button size="sm" disabled={busy || !loaded} onClick={() => void pick()}>{t("settings.general.projectLocationChange")}</Button> : null}
      </SettingsRow>
      {error ? <div className="settings-pad"><SettingsNote tone="danger">{error}</SettingsNote></div> : null}
    </>
  );
}

// ---------- appearance ----------

/** A small drawing of the app in one theme: sidebar, sheet, a line of text. */
function ThemePreview({ appearance, palette }: { appearance: "light" | "dark"; palette: Palette }) {
  return (
    <span className="theme-preview" data-appearance={appearance} data-palette={palette} aria-hidden="true">
      <span className="theme-preview-rail"><i /><i /><i /></span>
      <span className="theme-preview-sheet"><i /><i /><b /></span>
    </span>
  );
}

function ThemeTile({ selected, label, description, onSelect, children }: {
  selected: boolean;
  label: string;
  description?: string;
  onSelect: () => void;
  children: ReactNode;
}) {
  return (
    <button type="button" role="radio" aria-checked={selected} className={`theme-tile${selected ? " is-selected" : ""}`} onClick={onSelect}>
      {children}
      <span>{label}{description ? <small>{description}</small> : null}</span>
    </button>
  );
}

function AppearanceSettings() {
  const [appearance, updateAppearance] = useState<Appearance>(readAppearance);
  const [palette, updatePalette] = useState<Palette>(readPalette);
  const [chatFont, updateChatFont] = useState<ChatFont>(readChatFont);
  const system = window.matchMedia("(prefers-color-scheme: dark)").matches ? "dark" : "light";
  const shown = appearance === "system" ? system : appearance;
  const themes: Appearance[] = ["system", "light", "dark"];
  const palettes: Palette[] = ["neutral", "warm", "contrast"];
  return (
    <>
      <SettingsGroup title={t("settings.appearance.theme")} bare>
        <div className="theme-tiles" role="radiogroup" aria-label={t("settings.appearance.theme")}>
          {themes.map((value) => (
            <ThemeTile key={value} selected={appearance === value} label={t(`settings.appearance.${value}`)} onSelect={() => {
              updateAppearance(value);
              persistAppearance(value);
            }}>
              {value === "system" ? (
                <span className="theme-preview-split"><ThemePreview appearance="light" palette={palette} /><ThemePreview appearance="dark" palette={palette} /></span>
              ) : <ThemePreview appearance={value} palette={palette} />}
            </ThemeTile>
          ))}
        </div>
      </SettingsGroup>
      <SettingsGroup title={t("settings.appearance.palette")} description={t("settings.appearance.paletteHint")} bare>
        <div className="theme-tiles" role="radiogroup" aria-label={t("settings.appearance.palette")}>
          {palettes.map((value) => (
            <ThemeTile key={value} selected={palette === value} label={t(`settings.appearance.palettes.${value}`)} description={t(`settings.appearance.palettes.${value}Hint`)} onSelect={() => {
              updatePalette(value);
              setPalette(value);
            }}>
              <ThemePreview appearance={shown} palette={value} />
            </ThemeTile>
          ))}
        </div>
      </SettingsGroup>
      <SettingsGroup title={t("settings.appearance.text")}>
        <SettingsRow title={t("settings.appearance.chatFont")} description={<span className={`font-sample${chatFont === "serif" ? " is-serif" : ""}`}>{t("settings.appearance.chatFontSample")}</span>}>
          <SegmentedControl size="sm" label={t("settings.appearance.chatFont")} value={chatFont} onChange={(next) => {
            updateChatFont(next);
            setChatFont(next);
          }} options={[
            { value: "sans", label: t("settings.appearance.fontDefault") },
            { value: "serif", label: t("settings.appearance.fontSerif") },
          ]} />
        </SettingsRow>
      </SettingsGroup>
    </>
  );
}

// ---------- account and billing ----------

function AccountSettings() {
  const auth = useAuth();
  const [error, setError] = useState<string>();
  if (auth.state.status !== "signed-in") {
    const loading = auth.state.status === "loading";
    return (
      <SettingsGroup>
        <SettingsRow title={loading ? t("settings.account.loading") : t("settings.account.signedOut")} description={t("settings.account.signedOutHint")}>
          <Button variant="primary" disabled={loading} onClick={auth.openSignIn}>{t("common.signIn")}</Button>
        </SettingsRow>
      </SettingsGroup>
    );
  }
  const { user } = auth.state;
  return (
    <>
      <SettingsGroup>
        <div className="settings-identity">
          <UserAvatar className="settings-avatar" name={user.name} avatarUrl={user.avatarUrl} />
          <div className="settings-identity-text">
            <strong>{user.name}</strong>
            <span>{user.email ? t("settings.account.signedInWith", { email: user.email }) : t("settings.account.signedInAs")}</span>
          </div>
          <Button onClick={() => void auth.signOut().catch((cause) => setError(errorMessage(cause)))}>{t("common.signOut")}</Button>
        </div>
      </SettingsGroup>
      {error ? <SettingsNote tone="danger">{error}</SettingsNote> : null}
    </>
  );
}

async function openExternal(url: string): Promise<void> {
  if (window.ohMyGameDesktop?.openExternal) await window.ohMyGameDesktop.openExternal(url);
  else window.open(url, "_blank", "noopener,noreferrer");
}

function BillingSettings() {
  return (
    <SettingsGroup>
      <SettingsRow title={t("settings.billing.title")} description={t("settings.billing.description")}>
        <Button icon={<ExternalLink size={14} />} onClick={() => void openExternal(BILLING_DASHBOARD_URL)}>{t("settings.billing.open")}</Button>
      </SettingsRow>
    </SettingsGroup>
  );
}

// ---------- about ----------

const PROJECT_LINKS = [
  { href: "https://github.com/WhiteTowerAI/ohmygame", title: () => "GitHub", icon: <span className="settings-about-github" aria-hidden="true" style={{ maskImage: `url("${githubMark}")` }} /> },
  { href: "https://ohmygame.ai", title: () => t("settings.about.website"), icon: <Globe2 size={16} aria-hidden="true" /> },
  { href: "https://github.com/WhiteTowerAI/ohmygame/issues", title: () => t("settings.about.reportIssue"), icon: <MessageCircle size={16} aria-hidden="true" /> },
];

function AboutSettings({ onOpenNetwork, onOpenOnboarding }: { onOpenNetwork: () => void; onOpenOnboarding?: () => void }) {
  const update = useDesktopUpdate();
  const [copied, setCopied] = useState(false);
  const updates = window.ohMyGameDesktop?.updates;
  const status = update?.status;
  const version = update?.currentVersion ?? __APP_VERSION__;
  const retry = () => {
    if (status?.type !== "error" || !updates) return;
    if (status.retry === "download") void updates.download();
    else if (status.retry === "install") void updates.install();
    else void updates.check();
  };
  const copyDetails = async () => {
    if (status?.type !== "error") return;
    await navigator.clipboard.writeText([
      `OhMyGame ${version}`,
      `Update ${status.phase}/${status.code}`,
      status.detail,
    ].join("\n"));
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2_000);
  };
  return (
    <>
      <SettingsGroup label={t("settings.nav.about")}>
        <div className="settings-identity">
          <span className="settings-about-logo"><BrandLogo size={44} /></span>
          <div className="settings-identity-text">
            <strong>OhMyGame</strong>
            <span className="settings-mono">v{version}</span>
          </div>
          <nav className="settings-about-links" aria-label={t("settings.about.projectLinks")}>
            {PROJECT_LINKS.map((link) => (
              // The card clips what overflows it, so the tooltip floats above the page.
              <Tooltip key={link.href} content={link.title()} placement="bottom">
                <a className="ui-icon-button ui-icon-button-md" href={link.href} target="_blank" rel="noreferrer"
                  aria-label={link.title()}>{link.icon}</a>
              </Tooltip>
            ))}
          </nav>
          {updates ? <UpdateControl status={status} onRetry={retry} /> : null}
        </div>
        {status?.type === "error" ? (
          <div className="settings-pad settings-form" role="alert">
            <div>
              <p>{status.message}</p>
              {status.dataSafe ? <p className="settings-muted">{t("settings.about.dataSafe")}</p> : null}
            </div>
            <details className="settings-details">
              <summary>{t("common.technicalDetails")}</summary>
              <code>{status.detail}</code>
            </details>
            <div className="settings-actions is-start">
              {status.code === "network" ? <Button size="sm" onClick={onOpenNetwork}>{t("settings.about.networkSettings")}</Button> : null}
              <Button size="sm" variant="ghost" onClick={() => void copyDetails()}>{copied ? t("common.copied") : t("common.copyDetails")}</Button>
            </div>
          </div>
        ) : null}
      </SettingsGroup>
      {onOpenOnboarding ? (
        <SettingsGroup label={t("settings.about.gettingStarted")}>
          <SettingsRow title={t("settings.about.gettingStarted")} description={t("settings.about.gettingStartedHint")}>
            <Button size="sm" variant="ghost" onClick={onOpenOnboarding}>{t("onboarding.reopen")}</Button>
          </SettingsRow>
        </SettingsGroup>
      ) : null}
      <ChangelogPanel currentVersion={version} availableRelease={update?.availableRelease} />
      <DiagnosticsSettings />
    </>
  );
}

// The update, in whatever state the sidebar shows it.
function UpdateControl({ status, onRetry }: { status?: NonNullable<ReturnType<typeof useDesktopUpdate>>["status"]; onRetry: () => void }) {
  const updates = window.ohMyGameDesktop?.updates;
  if (!updates) return null;
  switch (status?.type) {
    case "available":
      return <div className="settings-actions">
        <Badge tone="ink">{t("settings.about.available", { version: status.version })}</Badge>
        <span className="settings-about-actions"><Button variant="primary" onClick={() => void updates.download()}>{t("settings.about.download")}</Button></span>
      </div>;
    case "downloading":
      return <div className="settings-progress" role="status">
        <Progress value={status.percent / 100} label={t("settings.about.downloading", { percent: status.percent })} />
        <span>{t("settings.about.downloading", { percent: status.percent })}</span>
      </div>;
    case "ready":
      return <div className="settings-actions">
        <Badge tone="success">{t("settings.about.ready", { version: status.version })}</Badge>
        <span className="settings-about-actions"><Button variant="primary" onClick={() => void updates.install()}>{t("settings.about.restart")}</Button></span>
      </div>;
    case "installing":
      return <span className="settings-muted" role="status">{t("settings.about.installing")}</span>;
    case "error":
      return <div className="settings-actions">
        <Badge tone="danger">{status.title}</Badge>
        <span className="settings-about-actions"><Button onClick={onRetry}>{t("common.tryAgain")}</Button></span>
      </div>;
    default:
      return <div className="settings-actions">
        {status?.type === "up-to-date" ? <Badge tone="success">{t("settings.about.upToDate")}</Badge> : null}
        {status?.type === "checking" ? <Spinner label={t("settings.about.checking")} /> : null}
        <span className="settings-about-actions"><Button icon={<Cloud size={14} />} disabled={status?.type === "checking"} onClick={() => void updates.check()}>{t("settings.about.check")}</Button></span>
      </div>;
  }
}

function DiagnosticsSettings() {
  const [exporting, setExporting] = useState(false);
  const [error, setError] = useState<string>();
  const openLogsDirectory = window.ohMyGameDesktop?.openLogsDirectory;
  const openLogs = async () => {
    setError(undefined);
    try {
      await openLogsDirectory?.();
    } catch (cause) {
      setError(t("settings.diagnostics.openLogsFailed", { message: errorMessage(cause) }));
    }
  };
  const download = async () => {
    setExporting(true);
    setError(undefined);
    try {
      const { blob, fileName } = await exportDiagnostics();
      const url = URL.createObjectURL(blob);
      const link = window.document.createElement("a");
      link.href = url;
      link.download = fileName;
      link.click();
      window.setTimeout(() => URL.revokeObjectURL(url), 0);
    } catch (cause) {
      setError(t("settings.diagnostics.exportFailed", { message: errorMessage(cause) }));
    } finally {
      setExporting(false);
    }
  };
  return (
    <SettingsGroup title={t("settings.diagnostics.title")} description={t("settings.diagnostics.description")}>
      <SettingsRow title={t("settings.diagnostics.exportTitle")}>
        <Button disabled={exporting} onClick={() => void download()}>
          {exporting ? t("settings.diagnostics.exporting") : t("settings.diagnostics.export")}
        </Button>
      </SettingsRow>
      {openLogsDirectory ? (
        <SettingsRow title={t("settings.diagnostics.logsTitle")}>
          <Button onClick={() => void openLogs()}>{t("settings.diagnostics.openLogs")}</Button>
        </SettingsRow>
      ) : null}
      {error ? <div className="settings-pad"><SettingsNote tone="danger">{error}</SettingsNote></div> : null}
    </SettingsGroup>
  );
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
