import { parseAppRoute, type AppRoute } from "./routes.js";

// The renderer is loaded from a file:// URL, so every URL PostHog records
// would carry the install path, including the user's account name. Events
// report the in-app route instead, with ids replaced by placeholders.
const APP_ORIGIN = "app://ohmygame";
const FILE_URL = /file:\/\/[^\s"'<>]*/g;

export function analyticsPath(route: AppRoute): string {
  switch (route.page) {
    case "home": return "/";
    case "projects": return "/projects";
    case "community": return "/community/games";
    case "game": return "/community/games/:id";
    case "settings": return route.pluginId ? "/settings/plugins/:id" : `/settings/${route.section}`;
    case "playtest": return "/playtest/:id";
    case "thumbnail": return "/thumbnail/:id/:id";
    case "project":
      return `/projects/:id${route.conversationId ? "/conversations/:id" : ""}${route.view ? `/${route.view}` : ""}`;
    default: return `/${route.page}`;
  }
}

function pathOfUrl(url: string): string {
  const hashStart = url.indexOf("#");
  return analyticsPath(parseAppRoute(hashStart === -1 ? "" : url.slice(hashStart)));
}

type EventRecord = Record<string, unknown>;

export type AnalyticsEvent = {
  event: string;
  properties: EventRecord;
  $set?: EventRecord;
  $set_once?: EventRecord;
};

/** Rewrites PostHog event properties so no local file path leaves the machine. */
export class AnalyticsUrlScrubber {
  readonly #localPathnames: Set<string>;
  #previousPageviewPath: string | undefined;

  constructor(localPathname: string) {
    this.#localPathnames = new Set([localPathname, safeDecode(localPathname)]);
  }

  scrub(event: AnalyticsEvent, currentUrl: string): void {
    const currentPath = pathOfUrl(currentUrl);
    for (const record of [event.properties, event.$set, event.$set_once]) {
      if (record) this.#scrubRecord(record, currentPath);
    }
    if (event.event === "$pageview") {
      if (this.#previousPageviewPath) event.properties.$prev_pageview_pathname = this.#previousPageviewPath;
      else delete event.properties.$prev_pageview_pathname;
      this.#previousPageviewPath = currentPath;
    }
  }

  #scrubRecord(record: EventRecord, currentPath: string): void {
    const original = { ...record };
    for (const [key, value] of Object.entries(original)) {
      if (typeof value === "string") {
        const path = this.#localPathnames.has(value) ? (pathnameSource(original, key) ?? currentPath) : undefined;
        record[key] = path ?? value.replace(FILE_URL, (url) => APP_ORIGIN + pathOfUrl(url));
      } else if (value && typeof value === "object") {
        this.#scrubRecord(value as EventRecord, currentPath);
      }
    }
  }
}

// A pathname property is rewritten from the URL it was taken from, when the
// same event carries it.
const PATHNAME_URL_KEYS: Record<string, string> = {
  $pathname: "$current_url",
  $initial_pathname: "$initial_current_url",
  $session_entry_pathname: "$session_entry_url",
};

function pathnameSource(record: EventRecord, key: string): string | undefined {
  const urlKey = PATHNAME_URL_KEYS[key];
  const url = urlKey ? record[urlKey] : undefined;
  return typeof url === "string" ? pathOfUrl(url) : undefined;
}

function safeDecode(value: string): string {
  try {
    return decodeURI(value);
  } catch {
    return value;
  }
}
