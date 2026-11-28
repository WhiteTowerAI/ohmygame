import { useCallback, useEffect, useRef, useState } from "react";
import {
  parseAppRoute,
  pluginHash,
  pluginsTabHash,
  projectsHash,
  type AppRoute,
} from "./routes.js";
import { t } from "./i18n.js";

// Project navigation reports save failures on the current page. A creation
// dialog awaits the same save and presents failures in its own retry flow.
type LeaveGuard = { save: () => Promise<void> | undefined; onError: (cause: unknown) => void };
let activeGuard: { current: LeaveGuard } | undefined;

export function useLeaveGuard(save: LeaveGuard["save"], onError: LeaveGuard["onError"]): void {
  const guard = useRef({ save, onError });
  guard.current = { save, onError };
  useEffect(() => {
    activeGuard = guard;
    return () => { if (activeGuard === guard) activeGuard = undefined; };
  }, []);
}

export function saveBeforeLeaving(): Promise<void> | undefined {
  return activeGuard?.current.save();
}

export function leave(go: () => void): void {
  const guard = activeGuard?.current;
  const saving = guard?.save();
  if (guard && saving) void saving.then(go).catch(guard.onError);
  else go();
}

interface NavigationLocation {
  hash: string;
  route: AppRoute;
  state: Record<string, unknown>;
  /** Read by `readLocation`, so the hash is already trimmed and the state complete. */
  read?: true;
}

export function historyState(): Record<string, unknown> {
  return window.history.state && typeof window.history.state === "object"
    ? (window.history.state as Record<string, unknown>)
    : {};
}

function returnHash(hash: unknown): string | undefined {
  if (typeof hash !== "string" || !hash.startsWith("#/")) return;
  const route = parseAppRoute(hash);
  if (
    ["project", "plugin-builder"].includes(route.page)
  )
    return;
  if (route.page === "home" && hash !== "#/" && hash !== "#/home") return;
  if (route.page === "plugins") return pluginsPageHash(route);
  return hash;
}

/** A Plugins page link without what it only says once, such as `section`; its tab stays. */
function pluginsPageHash(route: Extract<AppRoute, { page: "plugins" }>): string {
  if (route.pluginId) return pluginHash(route.pluginId, route.tab === "installed" ? route.tab : undefined);
  return route.tab ? pluginsTabHash(route.tab) : pluginHash();
}

function projectReturnHash(state: Record<string, unknown>): string {
  return returnHash(state.projectReturnTo) ?? projectsHash();
}

function entryHash(location: NavigationLocation): string {
  return location.route.page === "project"
    ? projectReturnHash(location.state)
    : (returnHash(location.hash || "#/") ?? projectsHash());
}

function readLocation(previous: NavigationLocation): NavigationLocation {
  let hash = window.location.hash;
  // A hash change fires popstate and then hashchange. On Plugins the first has
  // already trimmed what a link says once, such as `section`, so the second keeps
  // what the first read.
  if (previous.read && previous.route.page === "plugins" && hash === previous.hash) return { ...previous, state: historyState() };
  const route = parseAppRoute(hash);
  let state = historyState();
  if (
    route.page === "plugins" &&
    hash !== pluginsPageHash(route)
  ) {
    hash = pluginsPageHash(route);
    window.history.replaceState(state, "", hash);
  }
  if (route.page === "project" && !returnHash(state.projectReturnTo)) {
    state = {
      ...state,
      projectReturnTo: entryHash(previous),
    };
    window.history.replaceState(state, "", window.location.href);
  }
  return { hash, route, state, read: true };
}

function returnPageLabel(hash: string): string {
  const route = parseAppRoute(hash);
  switch (route.page) {
    case "home":
      return t("sidebar.home");
    case "library":
      return t("sidebar.library");
    case "community":
      return t("sidebar.community");
    case "game":
      return t("community.game");
    case "plugins":
      return t("sidebar.plugins");
    case "settings":
      return t("common.settings");
    default:
      return t("sidebar.projects");
  }
}

/** Keeps a project's entry page on each history entry, including hash links. */
export function useAppNavigation() {
  const [location, setLocation] = useState(() => ({
    hash: window.location.hash,
    route: parseAppRoute(window.location.hash),
    state: historyState(),
  }));
  const current = useRef(location);
  const syncLocation = useCallback(() => {
    const next = readLocation(current.current);
    current.current = next;
    setLocation(next);
  }, []);

  useEffect(() => {
    syncLocation();
    window.addEventListener("hashchange", syncLocation);
    window.addEventListener("popstate", syncLocation);
    return () => {
      window.removeEventListener("hashchange", syncLocation);
      window.removeEventListener("popstate", syncLocation);
    };
  }, [syncLocation]);

  const navigate = useCallback(
    (
      hash: string,
      options: { replace?: boolean; state?: Record<string, unknown> } = {},
    ) => {
      window.history[options.replace ? "replaceState" : "pushState"](
        options.state ?? {},
        "",
        hash,
      );
      syncLocation();
    },
    [syncLocation],
  );

  const projectReturnTo = projectReturnHash(location.state);
  return {
    route: location.route,
    navigate,
    projectReturnTo,
    projectBackLabel: t("navigation.backTo", {
      page: returnPageLabel(projectReturnTo),
    }),
  };
}
