import { t } from "./i18n.js";
import { useEffect, useRef, useState } from "react";
import type { CommunityGame } from "../shared/contracts.js";
import { Search, SlidersHorizontal, X } from "./icons.js";

export interface CommunityFilters {
  search: string;
  sort: "latest" | "viewers" | "likes";
  period: "all" | "week" | "month";
}

export const DEFAULT_COMMUNITY_FILTERS: CommunityFilters = {
  search: "",
  sort: "latest",
  period: "all",
};

export function filterCommunityGames<T extends CommunityGame>(
  games: T[],
  filters: CommunityFilters,
  now = Date.now(),
): T[] {
  const query = filters.search.trim().toLocaleLowerCase();
  const since =
    filters.period === "all"
      ? -Infinity
      : now - (filters.period === "week" ? 7 : 30) * 86400000;
  return games
    .filter(
      (game) =>
        `${game.title} ${game.description} ${game.author.displayName}`
          .toLocaleLowerCase()
          .includes(query) &&
        Date.parse(game.firstListedAt ?? game.publishedAt) >= since,
    )
    .sort((a, b) => {
      const metric =
        filters.sort === "viewers"
          ? (b.stats?.viewerCount ?? -1) - (a.stats?.viewerCount ?? -1)
          : filters.sort === "likes"
            ? (b.stats?.likeCount ?? -1) - (a.stats?.likeCount ?? -1)
            : 0;
      return (
        metric ||
        (b.firstListedAt ?? b.publishedAt).localeCompare(
          a.firstListedAt ?? a.publishedAt,
        ) ||
        b.id.localeCompare(a.id)
      );
    });
}

export function CommunityFilterButton({
  value,
  onChange,
}: {
  value: CommunityFilters;
  onChange: (filters: CommunityFilters) => void;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const active =
    value.search.trim() || value.sort !== "latest" || value.period !== "all";
  useEffect(() => {
    if (!open) return;
    search.current?.focus();
    const outside = (event: PointerEvent) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false);
    };
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setOpen(false);
        trigger.current?.focus();
      }
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);
  return (
    <div className="community-filter-control" ref={root}>
      <button
        ref={trigger}
        className={`projects-icon-button${active ? " is-active" : ""}`}
        type="button"
        title={t("community.filterGames")}
        aria-label={t("community.filterGames")}
        aria-expanded={open}
        aria-haspopup="dialog"
        onClick={() => setOpen((previous) => !previous)}
      >
        <SlidersHorizontal size={15} />
        {active ? <span className="community-filter-dot" /> : null}
      </button>
      {open ? (
        <section
          className="community-filter-popover"
          role="dialog"
          aria-label={t("community.filterGames")}
        >
          <header>
            <strong>{t("community.filters")}</strong>
            <button
              type="button"
              aria-label={t("community.closeFilters")}
              onClick={() => {
                setOpen(false);
                trigger.current?.focus();
              }}
            >
              <X size={14} />
            </button>
          </header>
          <label>
            <span>{t("community.search")}</span>
            <div className="community-filter-search">
              <Search size={14} />
              <input
                ref={search}
                type="search"
                value={value.search}
                placeholder={t("community.searchPlaceholder")}
                onChange={(event) =>
                  onChange({ ...value, search: event.target.value })
                }
              />
            </div>
          </label>
          <label>
            <span>{t("community.sortBy")}</span>
            <select
              value={value.sort}
              onChange={(event) =>
                onChange({
                  ...value,
                  sort: event.target.value as CommunityFilters["sort"],
                })
              }
            >
              <option value="latest">{t("community.latestListed")}</option>
              <option value="viewers">{t("community.mostViewed")}</option>
              <option value="likes">{t("community.mostLiked")}</option>
            </select>
          </label>
          <label>
            <span>{t("community.firstListed")}</span>
            <select
              value={value.period}
              onChange={(event) =>
                onChange({
                  ...value,
                  period: event.target.value as CommunityFilters["period"],
                })
              }
            >
              <option value="all">{t("community.anyTime")}</option>
              <option value="week">{t("community.pastWeek")}</option>
              <option value="month">{t("community.pastMonth")}</option>
            </select>
          </label>
          <button
            className="community-filter-reset"
            type="button"
            onClick={() => onChange({ ...DEFAULT_COMMUNITY_FILTERS })}
          >
            {t("community.resetFilters")}
          </button>
        </section>
      ) : null}
    </div>
  );
}
