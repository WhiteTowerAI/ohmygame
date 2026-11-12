import { useEffect, useRef, useState } from "react";
import type { LibrarySource, LibrarySourceItem } from "../shared/contracts.js";
import { addLibrarySourceItem, searchLibrarySource } from "./api.js";
import { mediaTypeLabel } from "./asset-browser.js";
import { Check, ExternalLink, Layers3, LoaderCircle, Plus } from "./icons.js";
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
  const [media, setMedia] = useState<Media | "all">(source.media.length === 1 ? source.media[0]! : "all");
  const [items, setItems] = useState<LibrarySourceItem[]>([]);
  const [next, setNext] = useState<string>();
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();
  const [more, setMore] = useState(false);
  const [selected, setSelected] = useState<LibrarySourceItem>();
  const [adding, setAdding] = useState<string>();
  const [addError, setAddError] = useState<string>();
  const [attempt, setAttempt] = useState(0);
  const search = useRef<AbortController>(undefined);
  const end = useRef<HTMLDivElement>(null);

  // A new query waits for typing to pause; each search stops the one before.
  useEffect(() => {
    const controller = new AbortController();
    search.current?.abort();
    search.current = controller;
    setPhase("loading");
    setError(undefined);
    const timer = window.setTimeout(() => {
      searchLibrarySource({ source: source.id, query: query.trim(), ...(media === "all" ? {} : { media }) }, controller.signal).then((results) => {
        if (controller.signal.aborted) return;
        setItems(results.items);
        setNext(results.next);
        setPhase("ready");
      }, (cause: unknown) => {
        if (controller.signal.aborted) return;
        setError(errorMessage(cause));
        setPhase("error");
      });
    }, 300);
    return () => { window.clearTimeout(timer); controller.abort(); };
  }, [source.id, query, media, attempt]);

  async function loadMore(): Promise<void> {
    if (!next || more) return;
    const controller = search.current;
    setMore(true);
    setError(undefined);
    try {
      const results = await searchLibrarySource({ source: source.id, query: query.trim(), ...(media === "all" ? {} : { media }), cursor: next }, controller?.signal);
      if (controller?.signal.aborted) return;
      setItems((current) => [...current, ...results.items.filter((item) => !current.some((existing) => existing.id === item.id))]);
      setNext(results.next);
    } catch (cause) {
      if (!controller?.signal.aborted) setError(errorMessage(cause));
    } finally {
      setMore(false);
    }
  }

  // Like the Local tab, the next page loads when the end of the list comes into view.
  // After a failed page it waits for the button, so it doesn't retry in a loop.
  useEffect(() => {
    const node = end.current;
    if (!node || !next || more || error || typeof IntersectionObserver === "undefined") return;
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
    {source.media.length > 1 ? <div className="library-filter-row">
      <Tabs<Media | "all"> variant="pills" label={t("assets.mediaTypes")} value={media} onChange={setMedia} tabs={[
        { value: "all", label: t("assets.filter.all"), icon: <Layers3 size={14} /> },
        ...source.media.map((kind) => ({ value: kind, label: t(`assets.filter.${kind}`), icon: <CategoryMark category={kind} /> })),
      ]} />
    </div> : null}
    {source.description ? <p className="library-source-description">{source.description} · {t("library.sourceBy", { plugin: source.pluginName })}</p> : null}
    {phase === "loading" ? <div className="library-tiles" aria-busy="true" aria-label={t("library.loading")}>{Array.from({ length: 8 }, (_, index) => <span className="library-skeleton" key={index}><Skeleton height="auto" radius={12} /><Skeleton width="60%" /></span>)}</div>
      : phase === "error" ? <Empty title={t("library.sourceFailed", { title: source.title })} description={error} action={<Button size="sm" onClick={() => setAttempt((count) => count + 1)}>{t("common.retry")}</Button>} />
      : items.length === 0 && !next ? <Empty title={t("library.sourceEmpty")} />
      : <>
        <div className="library-tiles">{items.map((item) => <MediaTile key={item.id} category={item.mediaType} name={item.name} meta={itemMeta(item)} selected={selected?.id === item.id}
          onClick={() => { setAddError(undefined); setSelected(item); }}
          preview={<SourcePreview item={item} />}
          badge={inLibrary.has(item.id) ? <Check size={12} aria-label={t("library.added")} /> : undefined} />)}</div>
        {error ? <Alert tone="danger" title={error} /> : null}
        {next ? <div ref={end} className="library-source-more"><Button size="sm" variant="ghost" disabled={more} icon={more ? <LoaderCircle className="spin" size={14} /> : undefined} onClick={() => void loadMore()}>{t("common.showMore")}</Button></div> : null}
      </>}

    <Sheet open={Boolean(selected)} onClose={() => setSelected(undefined)} title={selected?.name ?? ""}
      footer={selected ? <>
        {selected.url ? <Button variant="ghost" icon={<ExternalLink size={14} />} onClick={() => window.open(selected.url, "_blank", "noopener,noreferrer")}>{t("library.openSourcePage")}</Button> : null}
        <span className="library-filter-spacer" />
        {addedId
          ? <Button variant="primary" onClick={() => onShowInLocal(addedId)}>{t("library.showInLocal")}</Button>
          : <Button variant="primary" disabled={adding !== undefined} icon={adding === selected.id ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />} onClick={() => void add(selected)}>{adding === selected.id ? t("library.adding") : t("library.addToLibrary")}</Button>}
      </> : undefined}>
      {selected ? <>
        <div className={`library-sheet-preview is-${selected.mediaType}`}><SourcePreview item={selected} /></div>
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

function SourcePreview({ item }: { item: LibrarySourceItem }) {
  const [failed, setFailed] = useState(false);
  if (item.thumbnail && !failed) return <img src={item.thumbnail} alt="" draggable={false} referrerPolicy="no-referrer" onError={() => setFailed(true)} />;
  return <span className="library-file-mark"><CategoryMark category={item.mediaType} size={22} /></span>;
}

function itemMeta(item: LibrarySourceItem): string {
  return [item.author, item.license].filter(Boolean).join(" · ") || mediaTypeLabel(item.mediaType);
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
