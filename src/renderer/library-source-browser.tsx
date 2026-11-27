import { useEffect, useRef, useState } from "react";
import type { LibrarySource, LibrarySourceItem } from "../shared/contracts.js";
import { addLibrarySourceItem, searchLibrarySource } from "./api.js";
import { cachedSourceBrowse, runSourceSearch, sourceMedia, updateSourceBrowse } from "./library-source-searches.js";
import { isPixelArt } from "./library-assets.js";
import { mediaTypeLabel } from "./asset-browser.js";
import { Box, Check, ExternalLink, Layers3, Spinner, Plus, RefreshCw } from "./icons.js";
import { AudioTile, sourcePreviewAudio, useTileAudio } from "./library-tile-audio.js";
import { Alert, Button, CategoryMark, Empty, MediaTile, Sheet, Skeleton, Tabs } from "./ui/index.js";
import { t } from "./i18n.js";

type Media = LibrarySource["media"][number];

/**
 * A plugin's source in the Library: its search results, a page at a time,
 * and adding one to the Library. Nothing downloads until it is added.
 */
export function LibrarySourceBrowser({ source, query, inLibrary, onAdded, onShowInLocal }: {
  source: LibrarySource;
  query: string;
  /** The Library's asset for each of this source's items already in it. */
  inLibrary: ReadonlyMap<string, string>;
  /** Reloads the Library, so `inLibrary` has what was just added. */
  onAdded: () => Promise<void>;
  onShowInLocal: (assetId: string) => void;
}) {
  // A source with its own collections is browsed by them, in place of media kinds.
  const collections = source.collections;
  const [media, setMedia] = useState<Media | "all">(() => {
    const chosen = sourceMedia.get(source.id);
    return source.media.length === 1 ? source.media[0]! : (source.media as string[]).includes(chosen ?? "") ? chosen as Media : "all";
  });
  const [collection, setCollection] = useState<string | undefined>(() => {
    const chosen = sourceMedia.get(source.id);
    return collections?.some((candidate) => candidate.id === chosen) ? chosen : collections?.[0]?.id;
  });
  const request = {
    source: source.id,
    query: query.trim(),
    ...(collection ? { collection } : media === "all" ? {} : { media }),
  };
  const shown = cachedSourceBrowse(request);
  const [items, setItems] = useState<LibrarySourceItem[]>(shown?.items ?? []);
  const [next, setNext] = useState<string | undefined>(shown?.next);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">(shown ? "ready" : "loading");
  const [error, setError] = useState<string>();
  const [more, setMore] = useState(false);
  // A page that brought nothing new: the next waits for Show more, so a source repeating itself can't load in a loop.
  const [stalled, setStalled] = useState(false);
  const [selected, setSelected] = useState<LibrarySourceItem>();
  const [adding, setAdding] = useState<string>();
  const [addError, setAddError] = useState<string>();
  // Raised by Retry and Refresh, which search the plugin again past what was kept.
  const [attempt, setAttempt] = useState(0);
  const refreshing = useRef<string>(undefined);
  const audio = useTileAudio();
  const current = useRef(request);
  current.current = request;
  const panel = useRef<HTMLDivElement>(null);
  const end = useRef<HTMLDivElement>(null);
  const key = JSON.stringify(request);

  // A browse shown before comes back as it was; anything else waits for typing to pause.
  useEffect(() => {
    const asked = current.current;
    const force = refreshing.current === key;
    refreshing.current = undefined;
    const kept = force ? undefined : cachedSourceBrowse(asked);
    if (kept) {
      setItems(kept.items);
      setNext(kept.next);
      setError(undefined);
      setPhase("ready");
      return;
    }
    let live = true;
    setStalled(false);
    setPhase("loading");
    setError(undefined);
    const timer = window.setTimeout(() => {
      runSourceSearch(asked, source.cacheSeconds).then((results) => {
        if (!live) return;
        setItems(results.items);
        setNext(results.next);
        setPhase("ready");
      }, (cause: unknown) => {
        if (!live) return;
        setError(errorMessage(cause));
        setPhase("error");
      });
    }, 300);
    return () => { live = false; window.clearTimeout(timer); };
  }, [key, attempt]);

  // The page's scroll position goes with a kept browse, for when the tab comes back.
  useEffect(() => {
    const scroller = panel.current?.closest(".sidebar-page");
    const kept = cachedSourceBrowse(current.current);
    if (scroller && kept?.scrollTop) scroller.scrollTop = kept.scrollTop;
    return () => { if (scroller) updateSourceBrowse(current.current, { scrollTop: scroller.scrollTop }); };
  }, [key]);

  function searchAgain(): void {
    refreshing.current = key;
    setAttempt((count) => count + 1);
  }

  function chooseMedia(kind: Media | "all"): void {
    sourceMedia.set(source.id, kind);
    setMedia(kind);
  }

  function chooseCollection(id: string): void {
    sourceMedia.set(source.id, id);
    setCollection(id);
  }

  async function loadMore(): Promise<void> {
    if (!next || more) return;
    const asked = current.current;
    setMore(true);
    setError(undefined);
    try {
      const results = await searchLibrarySource({ ...asked, cursor: next });
      if (JSON.stringify(asked) !== JSON.stringify(current.current)) return;
      setItems((shownItems) => {
        const added = results.items.filter((item) => !shownItems.some((existing) => existing.id === item.id));
        setStalled(added.length === 0);
        const all = [...shownItems, ...added];
        updateSourceBrowse(asked, { items: all, next: results.next });
        return all;
      });
      setNext(results.next);
    } catch (cause) {
      if (JSON.stringify(asked) === JSON.stringify(current.current)) setError(errorMessage(cause));
    } finally {
      setMore(false);
    }
  }

  // Like the Local tab, the next page loads when the end of the list comes into view.
  // After a failed page it waits for the button, so it doesn't retry in a loop.
  useEffect(() => {
    const node = end.current;
    if (!node || !next || more || error || stalled || typeof IntersectionObserver === "undefined") return;
    // A notification already queued still arrives after disconnect, with this render's query and cursor.
    let gone = false;
    const observer = new IntersectionObserver(([entry]) => {
      if (gone || !entry?.isIntersecting) return;
      observer.disconnect();
      void loadMore();
    }, { rootMargin: "160px" });
    observer.observe(node);
    return () => { gone = true; observer.disconnect(); };
  });

  async function add(item: LibrarySourceItem): Promise<void> {
    setAdding(item.id);
    setAddError(undefined);
    try {
      await addLibrarySourceItem(source.id, item);
      await onAdded();
    } catch (cause) {
      setAddError(errorMessage(cause));
    } finally {
      setAdding(undefined);
    }
  }

  const addedId = selected ? inLibrary.get(selected.id) : undefined;
  return <>
    <div className="library-filter-row" ref={panel}>
      {collections && collection ? <Tabs<string> variant="pills" label={t("library.sourceCollections", { title: source.title })} value={collection} onChange={chooseCollection}
        tabs={collections.map((candidate) => ({ value: candidate.id, label: candidate.title }))} />
      : source.media.length > 1 ? <Tabs<Media | "all"> variant="pills" label={t("assets.mediaTypes")} value={media} onChange={chooseMedia} tabs={[
        { value: "all", label: t("assets.filter.all"), icon: <Layers3 size="sm" /> },
        ...source.media.map((kind) => ({ value: kind, label: t(`assets.filter.${kind}`), icon: <CategoryMark category={kind} /> })),
      ]} /> : null}
      <span className="library-filter-spacer" />
      <Button size="sm" variant="ghost" icon={<RefreshCw size="sm" />} disabled={phase === "loading"} onClick={searchAgain}>{t("common.refresh")}</Button>
    </div>
    {source.description ? <p className="library-source-description">{source.description} · {t("library.sourceBy", { plugin: source.pluginName })}</p> : null}
    {phase === "loading" ? <div className="library-tiles" aria-busy="true" aria-label={t("library.loading")}>{Array.from({ length: 8 }, (_, index) => <span className="library-skeleton" key={index}><Skeleton height="auto" radius={12} /><Skeleton width="60%" /></span>)}</div>
      : phase === "error" ? <Empty title={t("library.sourceFailed", { title: source.title })} description={error} action={<Button size="sm" onClick={searchAgain}>{t("common.retry")}</Button>} />
      : items.length === 0 && !next ? <Empty title={t("library.sourceEmpty")} />
      : <>
        <div className="library-tiles">{items.map((item) => {
          const tile = <MediaTile key={item.id} category={item.mediaType} name={item.name} meta={itemMeta(item)} selected={selected?.id === item.id}
            onClick={() => { audio.stop(); setAddError(undefined); setSelected(item); }}
            preview={<SourcePreview item={item} />}
            badge={inLibrary.has(item.id) ? <Check size="xs" aria-label={t("library.added")} /> : undefined} />;
          const preview = item.mediaType === "audio" ? item.preview : undefined;
          return preview ? <AudioTile key={item.id} name={item.name} state={audio.playing?.id === item.id ? audio.playing.state : undefined}
            onToggle={() => audio.toggle(item.id, async () => sourcePreviewAudio(preview))}>{tile}</AudioTile> : tile;
        })}</div>
        {error ? <Alert tone="danger" title={error} /> : null}
        {next ? <div ref={end} className="library-source-more"><Button size="sm" variant="ghost" disabled={more} icon={more ? <Spinner size="sm" /> : undefined} onClick={() => void loadMore()}>{t("common.showMore")}</Button></div> : null}
      </>}

    <Sheet open={Boolean(selected)} onClose={() => setSelected(undefined)} title={selected?.name ?? ""}
      footer={selected ? <>
        {selected.url ? <Button variant="ghost" icon={<ExternalLink size="sm" />} onClick={() => window.open(selected.url, "_blank", "noopener,noreferrer")}>{t("library.openSourcePage")}</Button> : null}
        <span className="library-filter-spacer" />
        {addedId
          ? <Button variant="primary" onClick={() => onShowInLocal(addedId)}>{t("library.showInLocal")}</Button>
          : <Button variant="primary" disabled={adding !== undefined} icon={adding === selected.id ? <Spinner size="sm" /> : <Plus size="sm" />} onClick={() => void add(selected)}>{adding === selected.id ? t("library.adding") : t("library.addToLibrary")}</Button>}
      </> : undefined}>
      {selected ? <>
        <div className={`library-sheet-preview is-${selected.mediaType}${isPixelArt(selected) ? " is-pixel-art" : ""}${selected.embed ? " is-embed" : ""}`}>
          {selected.embed ? <SourceEmbed key={selected.id} item={selected} embed={selected.embed} /> : <SourcePreview item={selected} />}
        </div>
        {selected.mediaType === "audio" && selected.preview ? <SourceListen key={selected.id} preview={selected.preview} name={selected.name} /> : null}
        <dl className="library-sheet-props">
          <dt>{t("assets.type")}</dt><dd>{mediaTypeLabel(selected.mediaType)}</dd>
          {selected.width && selected.height ? <><dt>{t("library.dimensions")}</dt><dd>{selected.width} × {selected.height}</dd></> : null}
          <dt>{t("assets.source")}</dt><dd>{source.title}</dd>
          {selected.author ? <><dt>{t("library.author")}</dt><dd>{selected.author}</dd></> : null}
          {selected.license ? <><dt>{t("library.license")}</dt><dd>{selected.license}</dd></> : null}
        </dl>
        {addError ? <p className="library-page-dialog-error" role="alert">{addError}</p> : null}
      </> : null}
    </Sheet>
  </>;
}

/** The details' player for a result's `preview`, before it is added. */
function SourceListen({ preview, name }: { preview: string; name: string }) {
  const [source, setSource] = useState<{ url: string; revoke: boolean }>();
  useEffect(() => {
    let made: { url: string; revoke: boolean } | undefined;
    try {
      made = sourcePreviewAudio(preview);
      setSource(made);
    } catch {
      setSource(undefined);
    }
    return () => { if (made?.revoke) URL.revokeObjectURL(made.url); };
  }, [preview]);
  return source ? <audio className="library-source-listen" controls src={source.url} aria-label={t("library.playAudio", { name })} /> : null;
}

/** A result's picture, whole: a search shows what adding it gets. */
function SourcePreview({ item }: { item: LibrarySourceItem }) {
  const [failed, setFailed] = useState(false);
  if (item.thumbnail && !failed) return <img className={`library-source-thumb${isPixelArt(item) ? " library-pixel-art" : ""}`} src={item.thumbnail} alt="" draggable={false} referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
  return <span className="library-file-mark"><CategoryMark category={item.mediaType} size={22} /></span>;
}

/**
 * A result's own page, such as a 3D viewer, loaded only when the person asks:
 * until then nothing reaches its site. It runs sandboxed, with no feature
 * handed to it, can't send the app's address, and in the desktop app stays on
 * its own site.
 */
export function SourceEmbed({ item, embed }: { item: LibrarySourceItem; embed: string }) {
  const [state, setState] = useState<"idle" | "loading" | "shown">("idle");
  const [error, setError] = useState<string>();
  const host = new URL(embed).hostname;
  async function load() {
    setState("loading");
    setError(undefined);
    try {
      await window.ohMyGameDesktop?.allowLibraryEmbed?.(embed);
      setState("shown");
    } catch (cause) {
      setError(errorMessage(cause));
      setState("idle");
    }
  }
  if (state === "shown")
    return <iframe className="library-source-embed" src={embed} title={t("library.embedTitle", { name: item.name })}
      sandbox="allow-scripts allow-same-origin allow-popups" allow="" referrerPolicy="no-referrer" />;
  return <div className="library-source-embed-offer">
    <SourcePreview item={item} />
    <div className="library-source-embed-action">
      <Button size="sm" icon={state === "loading" ? <Spinner size="sm" /> : <Box size="sm" />} disabled={state === "loading"} onClick={() => void load()}>{t("library.loadEmbed")}</Button>
      <span>{t("library.embedFrom", { host })}</span>
      {error ? <Alert tone="danger" title={error} /> : null}
    </div>
  </div>;
}

function itemMeta(item: LibrarySourceItem): string {
  return [item.author, item.license].filter(Boolean).join(" · ") || mediaTypeLabel(item.mediaType);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
