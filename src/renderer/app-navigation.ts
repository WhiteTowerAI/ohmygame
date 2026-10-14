import { useCallback, useEffect, useRef, useState } from "react";
import {
  parseAppRoute,
  pluginHash,
  projectsHash,
  settingsHash,
  type AppRoute,
} from "./routes.js";
import { t } from "./i18n.js";

interface NavigationLocation {
  hash: string;
  route: AppRoute;
  state: Record<string, unknown>;
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
    ["project", "playtest", "thumbnail", "plugin-builder"].includes(route.page)
  )
    return;
  if (route.page === "home" && hash !== "#/" && hash !== "#/home") return;
  return hash;
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
  const route = parseAppRoute(hash);
  let state = historyState();
  if (
    route.page === "settings" &&
    route.section === "plugins" &&
    hash.startsWith("#/plugins")
  ) {
    hash = route.pluginId
      ? pluginHash(route.pluginId)
      : settingsHash("plugins");
    window.history.replaceState(state, "", hash);
  }
  if (route.page === "project" && !returnHash(state.projectReturnTo)) {
    state = {
      ...state,
      projectReturnTo: entryHash(previous),
    };
    window.history.replaceState(state, "", window.location.href);
  }
  return { hash, route, state };
}

function returnPageLabel(hash: string): string {
  const route = parseAppRoute(hash);
  switch (route.page) {
    case "home":
      return t("sidebar.home");
    case "general":
      return t("projectType.general");
    case "web-game":
      return t("projectType.web-game");
    case "interactive-story":
      return t("projectType.interactive-story");
    case "godot":
      return t("projectType.godot-game");
    case "asset-canvas":
      return t("projectType.asset-canvas");
    case "library":
      return t("sidebar.library");
    case "community":
      return t("sidebar.community");
    case "game":
      return t("community.game");
    case "settings":
      return route.section === "plugins"
        ? t("settings.nav.plugins")
        : t("common.settings");
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
