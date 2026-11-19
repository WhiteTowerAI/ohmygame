import type {
  LibrarySourceItem,
  LibrarySourceResults,
  LibrarySourceSearchRequest,
} from "../shared/contracts.js";
import { searchLibrarySource } from "./api.js";

/** How long a browse of a source is shown again when its manifest doesn't say (`cacheSeconds`). */
export const SOURCE_CACHE_SECONDS = 10 * 60;
/** The browses kept, most recently used last; results may carry sounds, so not many. */
export const SOURCE_BROWSES_KEPT = 20;

/** A browse of a plugin's source, with every page loaded so far. */
export interface SourceBrowse {
  items: LibrarySourceItem[];
  next?: string | undefined;
  /** When it is asked for again. */
  expires: number;
  /** Where the page was scrolled when the tab was left. */
  scrollTop?: number;
}

type Request = Omit<LibrarySourceSearchRequest, "cursor">;

// For this session of the page, a source's browse (no search words, by kind)
// comes back when its tab does, or the Library page, instead of asking the
// plugin again, which may count requests against a limit (Openverse) or make
// new results. A search with words always asks. Only what was shown is kept,
// never written anywhere.
const browses = new Map<string, SourceBrowse>();
const searching = new Map<string, Promise<LibrarySourceResults>>();

const browseKey = ({ source, media, collection }: Request) =>
  JSON.stringify([source, media ?? null, collection ?? null]);
const isBrowse = (request: Request) => request.query === "";

/** A browse shown before and not yet stale; never a search with words. */
export function cachedSourceBrowse(
  request: Request,
  now = Date.now(),
): SourceBrowse | undefined {
  if (!isBrowse(request)) return undefined;
  const key = browseKey(request);
  const browse = browses.get(key);
  if (!browse) return undefined;
  browses.delete(key);
  if (now >= browse.expires) return undefined;
  browses.set(key, browse);
  return browse;
}

/**
 * The first page of a search, from the plugin; a browse is kept for
 * `cacheSeconds`. A tab left while it runs doesn't stop it, and one that asks
 * the same meanwhile waits for the same request.
 */
export function runSourceSearch(
  request: Request,
  cacheSeconds = SOURCE_CACHE_SECONDS,
): Promise<LibrarySourceResults> {
  const key = JSON.stringify([
    request.source,
    request.media ?? null,
    request.collection ?? null,
    request.query,
  ]);
  const running = searching.get(key);
  if (running) return running;
  const search = searchLibrarySource(request)
    .then((results) => {
      if (isBrowse(request) && cacheSeconds > 0)
        keep(browseKey(request), {
          items: results.items,
          next: results.next,
          expires: Date.now() + cacheSeconds * 1000,
        });
      return results;
    })
    .finally(() => searching.delete(key));
  searching.set(key, search);
  return search;
}

/** Adds a later page's results, or the scroll position, to a kept browse. */
export function updateSourceBrowse(
  request: Request,
  change: Partial<Omit<SourceBrowse, "expires">>,
): void {
  if (!isBrowse(request)) return;
  const key = browseKey(request);
  const browse = browses.get(key);
  if (browse) browses.set(key, { ...browse, ...change });
}

/** Forgets the browses, and the kind chosen, of the sources `keep` turns down. */
export function forgetSourceSearches(keep: (source: string) => boolean): void {
  for (const key of [...browses.keys()]) {
    const [source] = JSON.parse(key) as [string];
    if (!keep(source)) browses.delete(key);
  }
  for (const source of [...sourceMedia.keys()])
    if (!keep(source)) sourceMedia.delete(source);
}

/** The kind of media, or collection, last chosen in each source's tab, so it opens on it again. */
export const sourceMedia = new Map<string, string>();

function keep(key: string, browse: SourceBrowse): void {
  browses.delete(key);
  browses.set(key, browse);
  for (const oldest of browses.keys()) {
    if (browses.size <= SOURCE_BROWSES_KEPT) break;
    browses.delete(oldest);
  }
}
