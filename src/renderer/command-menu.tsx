import { useEffect, useReducer, useRef, useState } from "react";
import { CirclePlus, Gamepad2, Globe2, House, Image, Palette, Plug } from "./icons.js";
import { listProjects } from "./api.js";
import { setAppearance } from "./appearance.js";
import { parseAppRoute, projectHash, settingsHash, sidebarHash, type SidebarPage } from "./routes.js";
import { SETTINGS_NAV } from "./settings-sections.js";
import { CommandMenu, type Command } from "./ui/index.js";
import { t } from "./i18n.js";
import type { ProjectState } from "../shared/contracts.js";

// The command menu (⌘K, Ctrl+K elsewhere) lists the app's pages, projects,
// settings and actions, and whatever the page in view adds with useCommands,
// such as a project's panels. ⌘N starts a project and ⌘, opens Settings.

const OPEN_EVENT = "ohmygame:command-menu";

/** Opens the command menu from anywhere, such as the sidebar's Search. */
export function openCommandMenu(): void {
  window.dispatchEvent(new Event(OPEN_EVENT));
}

// What mounted pages add, read when the menu renders; the host renders again
// when a page comes or goes, so an open menu drops a page that has left.
const sources = new Set<{ current: () => Command[] }>();
const sourceListeners = new Set<() => void>();
const sourcesChanged = () => sourceListeners.forEach((listener) => listener());

/** Adds commands to the menu while the calling component is mounted. */
export function useCommands(commands: () => Command[]): void {
  const source = useRef(commands);
  source.current = commands;
  useEffect(() => {
    const entry = source;
    sources.add(entry);
    sourcesChanged();
    return () => {
      sources.delete(entry);
      sourcesChanged();
    };
  }, []);
}

// A page with work to save before it goes, such as an open project, guards
// leaving it; the menu and the shortcuts leave through the guard.
let leaveGuard: ((go: () => void) => void) | undefined;

/** Runs `guard` before the menu or a shortcut leaves the calling component's page. */
export function useLeaveGuard(guard: (go: () => void) => void): void {
  const current = useRef(guard);
  current.current = guard;
  useEffect(() => {
    const entry = (go: () => void) => current.current(go);
    leaveGuard = entry;
    return () => { if (leaveGuard === entry) leaveGuard = undefined; };
  }, []);
}

// Escape while the menu is open is the menu's alone. This listens on the window
// in the capture phase, ahead of an open popover's own Escape listener on the
// document, even one that captures too.
let closeOpenMenu: (() => void) | undefined;
if (typeof window !== "undefined") window.addEventListener("keydown", (event) => {
  if (event.key !== "Escape" || event.isComposing || !closeOpenMenu) return;
  event.preventDefault();
  event.stopImmediatePropagation();
  closeOpenMenu();
}, true);

// A dialog in the way, such as Sign In or a rename, keeps its keys: the menu
// and the shortcuts wait until it closes rather than open over it.
function otherModalOpen(): boolean {
  return !!document.querySelector('[aria-modal="true"]:not(.ui-command)')
    || [...document.querySelectorAll("dialog[open]")].some(isModalDialog);
}

// A native <dialog> opened with showModal(), such as Community's confirmations.
function isModalDialog(dialog: Element): boolean {
  try {
    return dialog.matches(":modal");
  } catch {
    return true;
  }
}

/** Leaves the page in view through its guard, as the menu and the title bar do. */
export function leave(go: () => void): void {
  if (leaveGuard) leaveGuard(go);
  else go();
}

function isMac(): boolean {
  const platform = window.ohMyGameDesktop?.platform;
  return platform ? platform === "darwin" : /Mac/.test(navigator.platform);
}

/** The platform's modifier before a key, as the menus show shortcuts. */
export function shortcut(key: string): string {
  return isMac() ? `⌘${key.toUpperCase()}` : `Ctrl+${key.toUpperCase()}`;
}

const PAGES: { page: SidebarPage; label: () => string; icon: typeof House }[] = [
  { page: "home", label: () => t("sidebar.home"), icon: House },
  { page: "projects", label: () => t("sidebar.projects"), icon: Gamepad2 },
  { page: "library", label: () => t("sidebar.library"), icon: Image },
  { page: "community", label: () => t("sidebar.community"), icon: Globe2 },
  { page: "plugins", label: () => t("sidebar.plugins"), icon: Plug },
];

/** Opens the command menu on ⌘K or when asked, and handles ⌘N and ⌘,. */
export function CommandMenuHost({ navigate }: { navigate: (hash: string) => void }) {
  const [open, setOpen] = useState(false);
  const [projects, setProjects] = useState<ProjectState[]>([]);
  const latestNavigate = useRef(navigate);
  latestNavigate.current = navigate;
  const [, refresh] = useReducer((count: number) => count + 1, 0);

  useEffect(() => {
    sourceListeners.add(refresh);
    return () => { sourceListeners.delete(refresh); };
  }, []);

  useEffect(() => {
    const show = () => { if (!otherModalOpen()) setOpen(true); };
    const onKey = (event: KeyboardEvent) => {
      // Only the platform's modifier: Ctrl+K and Ctrl+N edit text on macOS.
      // A key an editor already handled, or one mid-composition, is left alone.
      if (event.defaultPrevented || event.isComposing || event.altKey || event.shiftKey) return;
      const mac = isMac();
      if (!(mac ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey)) return;
      if (otherModalOpen()) return;
      const key = event.key.toLowerCase();
      if (key === "k") {
        event.preventDefault();
        setOpen((value) => !value);
      } else if (key === "n") {
        event.preventDefault();
        setOpen(false);
        leave(newProject);
      } else if (key === ",") {
        event.preventDefault();
        setOpen(false);
        if (parseAppRoute(window.location.hash).page !== "settings") leave(() => go(settingsHash("general")));
      }
    };
    window.addEventListener(OPEN_EVENT, show);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener(OPEN_EVENT, show);
      window.removeEventListener("keydown", onKey);
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    closeOpenMenu = close;
    return () => { if (closeOpenMenu === close) closeOpenMenu = undefined; };
  }, [open]);

  // The projects are read each time the menu opens, most recently edited first.
  useEffect(() => {
    if (!open) return;
    let current = true;
    void listProjects().then((list) => {
      if (current) setProjects([...list].sort((a, b) => b.updatedAt.localeCompare(a.updatedAt)));
    }, () => {});
    return () => { current = false; };
  }, [open]);

  function go(hash: string): void {
    if (window.location.hash !== hash) latestNavigate.current(hash);
  }

  // Projects start from Home's prompt, so a new one goes there and focuses it
  // once Home has rendered, which can take a few frames.
  function newProject(): void {
    go(sidebarHash("home"));
    let frames = 30;
    const focus = () => {
      const prompt = document.querySelector<HTMLTextAreaElement>(".home-hero textarea");
      if (prompt) prompt.focus();
      else if (--frames > 0) window.requestAnimationFrame(focus);
    };
    window.requestAnimationFrame(focus);
  }

  const commands: Command[] = open ? [
    ...[...sources].flatMap((source) => source.current()),
    ...PAGES.map(({ page, label, icon: Icon }): Command => ({
      id: `page-${page}`, group: t("commandMenu.goTo"), label: label(), keywords: page, icon: <Icon size={16} />,
      run: () => leave(() => go(sidebarHash(page))),
    })),
    {
      id: "new-project", group: t("commandMenu.goTo"), label: t("sidebar.newProject"), keywords: "new create", icon: <CirclePlus size={16} />,
      shortcut: shortcut("n"), run: () => leave(newProject),
    },
    ...projects.map((project): Command => ({
      id: `project-${project.id}`, group: t("commandMenu.projects"), label: project.name, keywords: project.type, icon: <Gamepad2 size={16} />,
      run: () => leave(() => go(projectHash(project.id))),
    })),
    ...SETTINGS_NAV.flatMap((group) => group.items).map(({ section, label, icon: Icon }): Command => ({
      id: `settings-${section}`, group: t("commandMenu.settings"), label, keywords: section, icon: <Icon size={16} />,
      ...(section === "general" ? { shortcut: shortcut(",") } : {}),
      run: () => leave(() => go(settingsHash(section))),
    })),
    {
      id: "toggle-appearance", group: t("commandMenu.actions"), label: t("commandMenu.toggleAppearance"), keywords: "theme dark light", icon: <Palette size={16} />,
      run: () => setAppearance(document.documentElement.dataset.appearance === "light" ? "dark" : "light"),
    },
  ] : [];

  return <CommandMenu open={open} onClose={() => setOpen(false)} commands={commands} />;
}
