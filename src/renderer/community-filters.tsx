import { t } from "./i18n.js";
import type { CommunityGame } from "../shared/contracts.js";
import { Search, X } from "./icons.js";

export interface CommunityFilters {
  search: string;
  sort: "latest" | "views" | "likes";
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
        filters.sort === "views"
          ? (b.stats?.viewCount ?? -1) - (a.stats?.viewCount ?? -1)
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

export function CommunityToolbar({
  value,
  onChange,
}: {
  value: CommunityFilters;
  onChange: (filters: CommunityFilters) => void;
}) {
  const sorts = [
    ["latest", "community.latestListed"],
    ["views", "community.mostViewed"],
    ["likes", "community.mostLiked"],
  ] as const;
  return (
    <div className="community-toolbar">
      <div
        className="community-sort"
        role="group"
        aria-label={t("community.sortBy")}
      >
        {sorts.map(([sort, label]) => (
          <button
            key={sort}
            type="button"
            aria-pressed={value.sort === sort}
            onClick={() => onChange({ ...value, sort })}
          >
            {t(label)}
          </button>
        ))}
      </div>
      <div className="community-search-controls">
        <select
          className="community-period"
          aria-label={t("community.firstListed")}
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
        <label className="community-search">
          <Search size={15} aria-hidden="true" />
          <input
            type="search"
            aria-label={t("community.search")}
            value={value.search}
            placeholder={t("community.searchPlaceholder")}
            onChange={(event) =>
              onChange({ ...value, search: event.target.value })
            }
          />
        </label>
        {value.search || value.sort !== "latest" || value.period !== "all" ? (
          <button
            className="community-filter-reset"
            type="button"
            aria-label={t("community.resetFilters")}
            title={t("community.resetFilters")}
            onClick={() => onChange({ ...DEFAULT_COMMUNITY_FILTERS })}
          >
            <X size={15} />
          </button>
        ) : null}
      </div>
    </div>
  );
}
