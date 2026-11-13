import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from "react";
import {
  BROWSER_MAX_SHORTCUTS,
  BROWSER_SEARCH_ENGINES,
  browserAddress,
  isBrowserUrl,
  type BrowserMenuLabels,
  type BrowserSearchEngine,
  type BrowserSettings,
  type BrowserState,
  type BrowserVisit,
  type DesktopBrowserBridge,
  type PluginBrowserShortcut,
} from "../shared/browser.js";
import {
  getBrowserSettings,
  getPluginBrowserShortcuts,
  getProjectBrowser,
  recordBrowserVisit,
  saveBrowserTabs,
  setBrowserSettings,
} from "./api.js";
import {
  desktopPreviewLayout,
  useNativeViewPlacement,
} from "./desktop-game-preview.js";
import {
  ArrowLeft,
  ArrowRight,
  ExternalLink,
  Globe2,
  LoaderCircle,
  Pencil,
  Plus,
  RefreshCw,
  X,
} from "./icons.js";
import { Button, IconButton, Input, Select } from "./ui/index.js";
import { t } from "./i18n.js";
import { useReadyRuntimeGeneration } from "./runtime-connection.js";
import "./browser-panel.css";

/** How many of a project's sites its new-tab page lists. */
const FREQUENT_SITES = 8;

function menuLabels(): BrowserMenuLabels {
  return {
    openLinkInNewTab: t("browser.menu.openLinkInNewTab"),
    copyLink: t("browser.menu.copyLink"),
    back: t("browser.back"),
    forward: t("browser.forward"),
    reload: t("browser.reload"),
    inspect: t("browser.menu.inspect"),
  };
}

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

/** The sites visited most in this project, most recent first among equals. */
export function frequentSites(
  visits: readonly BrowserVisit[],
  limit = FREQUENT_SITES,
): BrowserVisit[] {
  return [...visits]
    .sort((a, b) => b.count - a.count || b.last.localeCompare(a.last))
    .slice(0, limit);
}

/** An address something else in the app asks the panel to open in a new tab; a new object for each ask. */
export interface BrowserOpenRequest {
  url: string;
}

/**
 * The Browser panel: a project's tabs, an address box and, on a new tab,
 * shortcuts and the sites visited in this project. Pages are native views
 * the desktop app places over the panel, in a session of their own.
 */
export function BrowserPanel({
  bridge,
  projectId,
  visible,
  pluginsRevision = 0,
  openRequests = [],
  onOpened,
}: {
  bridge: DesktopBrowserBridge;
  projectId: string;
  visible: boolean;
  /** Grows when the project's plugins change, so their shortcuts are read again. */
  pluginsRevision?: number;
  openRequests?: readonly BrowserOpenRequest[];
  onOpened?: (request: BrowserOpenRequest) => void;
}) {
  const generation = useReadyRuntimeGeneration();
  const host = useRef<HTMLDivElement>(null);
  const address = useRef<HTMLInputElement>(null);
  const [attachment] = useState(() => crypto.randomUUID());
  const [state, setState] = useState<BrowserState>();
  const [settings, setSettings] = useState<BrowserSettings>();
  const [visits, setVisits] = useState<BrowserVisit[]>([]);
  const [pluginShortcuts, setPluginShortcuts] = useState<
    PluginBrowserShortcut[]
  >([]);
  const [draft, setDraft] = useState<string>();
  const [error, setError] = useState<string>();
  const active = state?.tabs.find((tab) => tab.id === state.active);
  const showsPage = !!active?.url && !active.error;
  const live = useRef({ visible, showsPage });
  live.current = { visible, showsPage };
  // An ask that comes before the tabs are back waits for them, so it opens beside them.
  const ready = useRef(false);
  const handledOpen = useRef(new WeakSet<BrowserOpenRequest>());
  const opening = useRef(Promise.resolve());
  const latestOpen = useRef({ requests: openRequests, onOpened });
  latestOpen.current = { requests: openRequests, onOpened };
  /** The address each tab last counted as a visit, so a reload or a restored tab isn't counted again. */
  const counted = useRef(new Map<string, string>());

  const { still, synchronize } = useNativeViewPlacement(
    host,
    {
      wanted: () => live.current.visible && live.current.showsPage,
      capture: () => bridge.capture(projectId),
      layout: (layout) => bridge.layout(projectId, attachment, layout),
      detach: () => bridge.detach(projectId, attachment),
    },
    [bridge, projectId, attachment],
  );

  useEffect(() => {
    let disposed = false;
    const run = async () => {
      const [saved, loadedSettings] = await Promise.all([
        getProjectBrowser(projectId),
        getBrowserSettings(),
      ]);
      if (disposed || !host.current) return;
      setSettings(loadedSettings);
      setError(saved.problem ?? loadedSettings.problem);
      setVisits(saved.visits);
      for (const tab of saved.tabs)
        if (tab.url) counted.current.set(tab.id, tab.url);
      const restoredActive =
        saved.tabs.find((tab) => tab.id === saved.active) ?? saved.tabs[0];
      const layout = desktopPreviewLayout(
        host.current,
        live.current.visible && !!restoredActive?.url,
      );
      let next = await bridge.attach(
        projectId,
        attachment,
        layout,
        saved,
        menuLabels(),
      );
      if (disposed) return;
      if (!next.tabs.length) {
        // A project with no tabs opens on what was asked for, if anything, rather than beside a blank one.
        const asked = latestOpen.current.requests[0];
        if (asked) handledOpen.current.add(asked);
        next = await bridge.open(projectId, asked?.url);
        if (asked) latestOpen.current.onOpened?.(asked);
      }
      if (disposed) return;
      ready.current = true;
      setState(next);
      synchronize.current();
    };
    run().catch((cause: unknown) => {
      if (!disposed)
        setError(cause instanceof Error ? cause.message : String(cause));
    });
    return () => {
      disposed = true;
      ready.current = false;
    };
  }, [bridge, projectId, attachment]);

  useEffect(() => {
    let disposed = false;
    // A project whose plugins can't be read has no plugin shortcuts.
    void getPluginBrowserShortcuts(projectId)
      .catch((): PluginBrowserShortcut[] => [])
      .then((next) => {
        if (!disposed) setPluginShortcuts(next);
      });
    return () => {
      disposed = true;
    };
  }, [projectId, pluginsRevision, generation]);

  useEffect(() => {
    if (!state) return;
    for (const request of openRequests) {
      if (handledOpen.current.has(request)) continue;
      handledOpen.current.add(request);
      opening.current = opening.current.then(async () => {
        if (!ready.current) return;
        await openTab(request.url);
        latestOpen.current.onOpened?.(request);
      });
    }
  }, [!!state, openRequests]);

  useEffect(
    () =>
      bridge.onState((next) => {
        if (ready.current && next.projectId === projectId) setState(next);
      }),
    [bridge, projectId],
  );
  useEffect(
    () =>
      bridge.onCommand((id, command) => {
        if (id !== projectId) return;
        if (command === "focus-address") focusAddress();
        else void openTab();
      }),
    [bridge, projectId],
  );
  useLayoutEffect(() => {
    synchronize.current();
  }, [visible, showsPage]);

  // Tabs are saved as they change, so a restart opens the same pages.
  const savedTabs = state
    ? JSON.stringify([
        state.tabs.map(({ id, url, title }) => ({
          id,
          url: isBrowserUrl(url) ? url : "",
          title: isBrowserUrl(url) ? title : "",
        })),
        state.active,
      ])
    : undefined;
  useEffect(() => {
    if (!state || !savedTabs) return;
    void saveBrowserTabs(
      projectId,
      state.tabs.map(({ id, url, title }) => ({
        id,
        url: isBrowserUrl(url) ? url : "",
        title: isBrowserUrl(url) ? title : "",
      })),
      state.active,
    ).catch(() => {});
  }, [savedTabs]);

  // A page counts as a visit once it has loaded.
  useEffect(() => {
    for (const tab of state?.tabs ?? []) {
      if (
        !isBrowserUrl(tab.url) ||
        tab.loading ||
        tab.error ||
        counted.current.get(tab.id) === tab.url
      )
        continue;
      counted.current.set(tab.id, tab.url);
      const { url, title } = tab;
      void recordBrowserVisit(projectId, url, title).catch(() => {});
      setVisits((current) => {
        const known = current.find((visit) => visit.url === url);
        return [
          {
            url,
            title: title || known?.title || "",
            count: (known?.count ?? 0) + 1,
            last: new Date().toISOString(),
          },
          ...current.filter((visit) => visit.url !== url),
        ];
      });
    }
  }, [state]);

  // The address shows the page's own unless the person is typing one.
  useEffect(() => {
    setDraft(undefined);
  }, [active?.id, active?.url]);

  function focusAddress(): void {
    address.current?.focus();
    address.current?.select();
  }

  async function openTab(url?: string): Promise<void> {
    try {
      setState(await bridge.open(projectId, url));
      setError(undefined);
      if (!url) requestAnimationFrame(focusAddress);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function go(url: string): void {
    if (!isBrowserUrl(url)) return;
    setDraft(undefined);
    if (active)
      void bridge
        .navigate(projectId, active.id, url)
        .catch((cause: unknown) =>
          setError(cause instanceof Error ? cause.message : String(cause)),
        );
    else void openTab(url);
  }

  function submit(event: FormEvent): void {
    event.preventDefault();
    const url = browserAddress(
      draft ?? active?.url ?? "",
      settings?.searchEngine ?? "bing",
    );
    if (url) go(url);
    address.current?.blur();
  }

  function keyDown(event: KeyboardEvent): void {
    const command = navigator.platform.startsWith("Mac")
      ? event.metaKey
      : event.ctrlKey;
    if (!command || event.altKey || event.shiftKey) return;
    const key = event.key.toLowerCase();
    if (key === "l") {
      event.preventDefault();
      focusAddress();
    } else if (key === "t") {
      event.preventDefault();
      void openTab();
    }
  }

  async function saveSettings(next: BrowserSettings): Promise<void> {
    const previous = settings;
    setSettings(next);
    try {
      setSettings(await setBrowserSettings(next));
      setError(undefined);
    } catch (cause) {
      setSettings(previous);
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  const call = (run: () => Promise<void>) =>
    void run().catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : String(cause)),
    );

  return (
    <section
      className="browser-panel"
      aria-label={t("panels.browser")}
      onKeyDown={keyDown}
    >
      <div
        className="browser-tabs"
        role="tablist"
        aria-label={t("browser.tabs")}
      >
        {state?.tabs.map((tab) => {
          const title =
            tab.title || (tab.url ? hostOf(tab.url) : t("browser.newTab"));
          const selected = tab.id === state.active;
          return (
            <div
              key={tab.id}
              className={`browser-tab${selected ? " is-active" : ""}`}
            >
              <button
                type="button"
                role="tab"
                aria-selected={selected}
                className="browser-tab-select"
                title={tab.url || title}
                onClick={() => call(() => bridge.select(projectId, tab.id))}
                onAuxClick={(event) => {
                  if (event.button === 1)
                    call(() => bridge.close(projectId, tab.id));
                }}
              >
                {tab.loading ? (
                  <LoaderCircle className="spin" size={13} />
                ) : tab.favicon ? (
                  <img
                    src={tab.favicon}
                    alt=""
                    width={14}
                    height={14}
                    onError={(event) => {
                      event.currentTarget.hidden = true;
                    }}
                  />
                ) : (
                  <Globe2 size={13} />
                )}
                <span>{title}</span>
              </button>
              <button
                type="button"
                className="browser-tab-close"
                aria-label={t("browser.closeTab", { title })}
                title={t("browser.closeTab", { title })}
                onClick={() => call(() => bridge.close(projectId, tab.id))}
              >
                <X size={12} />
              </button>
            </div>
          );
        })}
        <IconButton
          size="sm"
          label={t("browser.newTab")}
          onClick={() => void openTab()}
        >
          <Plus size={14} />
        </IconButton>
      </div>
      <form className="browser-toolbar" onSubmit={submit}>
        <IconButton
          size="sm"
          label={t("browser.back")}
          disabled={!active?.canGoBack}
          onClick={() =>
            active && call(() => bridge.back(projectId, active.id))
          }
        >
          <ArrowLeft size={14} />
        </IconButton>
        <IconButton
          size="sm"
          label={t("browser.forward")}
          disabled={!active?.canGoForward}
          onClick={() =>
            active && call(() => bridge.forward(projectId, active.id))
          }
        >
          <ArrowRight size={14} />
        </IconButton>
        <IconButton
          size="sm"
          label={active?.loading ? t("browser.stop") : t("browser.reload")}
          disabled={!active?.url}
          onClick={() =>
            active &&
            call(() => bridge.reload(projectId, active.id, active.loading))
          }
        >
          {active?.loading ? <X size={14} /> : <RefreshCw size={14} />}
        </IconButton>
        <input
          ref={address}
          className="browser-address"
          value={draft ?? active?.url ?? ""}
          placeholder={t("browser.addressPlaceholder")}
          aria-label={t("browser.address")}
          spellCheck={false}
          autoComplete="off"
          onFocus={(event) => event.currentTarget.select()}
          onChange={(event) => setDraft(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape") {
              setDraft(undefined);
              event.currentTarget.blur();
            }
          }}
        />
        <IconButton
          size="sm"
          label={t("browser.openExternal")}
          disabled={!active?.url}
          onClick={() => {
            if (active?.url)
              void window.ohMyGameDesktop
                ?.openExternal?.(active.url)
                .catch(() => {});
          }}
        >
          <ExternalLink size={14} />
        </IconButton>
      </form>
      {error ? (
        <p className="browser-note" role="alert">
          {error}
        </p>
      ) : null}
      <div className="browser-page">
        <div
          ref={host}
          className="browser-view"
          data-native-browser={projectId}
        >
          {still && showsPage ? (
            <img className="preview-frame-still" src={still} alt="" />
          ) : null}
        </div>
        {active && !active.url && settings ? (
          <NewTabPage
            settings={settings}
            visits={visits}
            pluginShortcuts={pluginShortcuts}
            onOpen={go}
            onSettings={(next) => void saveSettings(next)}
          />
        ) : null}
        {active?.error ? (
          <div className="browser-error" role="alert">
            <Globe2 size={28} />
            <strong>{t("browser.failed")}</strong>
            <p>{active.error}</p>
            <code>{active.url}</code>
            <Button
              size="sm"
              onClick={() => call(() => bridge.reload(projectId, active.id))}
            >
              {t("browser.reload")}
            </Button>
          </div>
        ) : null}
        {!state && !error ? (
          <div className="browser-loading">
            <LoaderCircle className="spin" size={18} />
          </div>
        ) : null}
      </div>
    </section>
  );
}

const ENGINE_NAMES: Record<BrowserSearchEngine, string> = {
  bing: "Bing",
  google: "Google",
  baidu: "Baidu",
  duckduckgo: "DuckDuckGo",
};

function NewTabPage({
  settings,
  visits,
  pluginShortcuts,
  onOpen,
  onSettings,
}: {
  settings: BrowserSettings;
  visits: readonly BrowserVisit[];
  pluginShortcuts: readonly PluginBrowserShortcut[];
  onOpen: (url: string) => void;
  onSettings: (settings: BrowserSettings) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [adding, setAdding] = useState<{ title: string; url: string }>();
  const frequent = frequentSites(visits);
  const addUrl = adding
    ? browserAddress(adding.url, settings.searchEngine)
    : "";
  const canAdd =
    !!adding?.title.trim() &&
    !!adding.url.trim() &&
    isBrowserUrl(addUrl) &&
    !/\s/.test(adding.url.trim());

  function add(event: FormEvent): void {
    event.preventDefault();
    if (!adding || !canAdd) return;
    onSettings({
      ...settings,
      shortcuts: [
        ...settings.shortcuts,
        { title: adding.title.trim(), url: addUrl },
      ],
    });
    setAdding(undefined);
  }

  return (
    <div className="browser-new-tab">
      <section className="browser-new-tab-section">
        <header>
          <h2>{t("browser.shortcuts")}</h2>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              setEditing(!editing);
              setAdding(undefined);
            }}
          >
            {editing ? (
              t("browser.doneEditing")
            ) : (
              <>
                <Pencil size={13} />
                {t("browser.editShortcuts")}
              </>
            )}
          </Button>
        </header>
        <ul className="browser-shortcuts">
          {settings.shortcuts.map((shortcut, index) => (
            <li key={`${shortcut.url}:${index}`}>
              <button
                type="button"
                className="browser-shortcut"
                title={shortcut.url}
                onClick={() => onOpen(shortcut.url)}
              >
                <span className="browser-shortcut-mark" aria-hidden="true">
                  {shortcut.title.slice(0, 1).toUpperCase()}
                </span>
                <span className="browser-shortcut-title">{shortcut.title}</span>
              </button>
              {editing ? (
                <button
                  type="button"
                  className="browser-shortcut-remove"
                  aria-label={t("browser.removeShortcut", {
                    title: shortcut.title,
                  })}
                  title={t("browser.removeShortcut", { title: shortcut.title })}
                  onClick={() =>
                    onSettings({
                      ...settings,
                      shortcuts: settings.shortcuts.filter(
                        (_entry, position) => position !== index,
                      ),
                    })
                  }
                >
                  <X size={11} />
                </button>
              ) : null}
            </li>
          ))}
          {editing &&
          !adding &&
          settings.shortcuts.length < BROWSER_MAX_SHORTCUTS ? (
            <li>
              <button
                type="button"
                className="browser-shortcut is-add"
                onClick={() => setAdding({ title: "", url: "" })}
              >
                <span className="browser-shortcut-mark" aria-hidden="true">
                  <Plus size={14} />
                </span>
                <span className="browser-shortcut-title">
                  {t("browser.addShortcut")}
                </span>
              </button>
            </li>
          ) : null}
        </ul>
        {adding ? (
          <form className="browser-shortcut-form" onSubmit={add}>
            <Input
              size="sm"
              value={adding.title}
              placeholder={t("browser.shortcutTitle")}
              aria-label={t("browser.shortcutTitle")}
              onChange={(event) =>
                setAdding({ ...adding, title: event.target.value })
              }
            />
            <Input
              size="sm"
              value={adding.url}
              placeholder="example.com"
              aria-label={t("browser.shortcutUrl")}
              onChange={(event) =>
                setAdding({ ...adding, url: event.target.value })
              }
            />
            <Button
              size="sm"
              type="submit"
              variant="primary"
              disabled={!canAdd}
            >
              {t("common.add")}
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setAdding(undefined)}
            >
              {t("common.cancel")}
            </Button>
          </form>
        ) : null}
      </section>
      {pluginShortcuts.length ? (
        <section className="browser-new-tab-section">
          <header>
            <h2>{t("browser.fromPlugins")}</h2>
          </header>
          <ul className="browser-shortcuts">
            {pluginShortcuts.map((shortcut, index) => (
              <li key={`${shortcut.plugin}:${index}`}>
                <button
                  type="button"
                  className="browser-shortcut"
                  title={`${shortcut.url} · ${shortcut.pluginTitle}`}
                  onClick={() => onOpen(shortcut.url)}
                >
                  <span className="browser-shortcut-mark" aria-hidden="true">
                    {shortcut.title.slice(0, 1).toUpperCase()}
                  </span>
                  <span className="browser-shortcut-title">
                    {shortcut.title}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      {frequent.length ? (
        <section className="browser-new-tab-section">
          <header>
            <h2>{t("browser.frequent")}</h2>
          </header>
          <ul className="browser-frequent">
            {frequent.map((visit) => (
              <li key={visit.url}>
                <button
                  type="button"
                  onClick={() => onOpen(visit.url)}
                  title={visit.url}
                >
                  <span>{visit.title || hostOf(visit.url)}</span>
                  <small>{hostOf(visit.url)}</small>
                </button>
              </li>
            ))}
          </ul>
        </section>
      ) : null}
      <footer className="browser-new-tab-footer">
        <span>{t("browser.searchWith")}</span>
        <Select
          size="sm"
          label={t("browser.searchWith")}
          value={settings.searchEngine}
          options={BROWSER_SEARCH_ENGINES.map((engine) => ({
            value: engine,
            label: ENGINE_NAMES[engine],
          }))}
          onChange={(searchEngine) => onSettings({ ...settings, searchEngine })}
        />
      </footer>
    </div>
  );
}
