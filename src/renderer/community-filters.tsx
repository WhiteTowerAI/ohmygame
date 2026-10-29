import { t } from "./i18n.js";
import type { CommunityGame } from "../shared/contracts.js";
import { Button, FilterChips, SearchInput, Select } from "./ui/index.js";

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

/** Sort chips, the reset and the period menu. The search box sits in the page's
 * title row instead; `search` adds one at the end of this row. */
export function CommunityToolbar({
  value,
  onChange,
  search = false,
}: {
  value: CommunityFilters;
  onChange: (filters: CommunityFilters) => void;
  search?: boolean;
}) {
  const filtered =
    value.search || value.sort !== "latest" || value.period !== "all";
  return (
    <div className="community-filters">
      <FilterChips<CommunityFilters["sort"]>
        label={t("community.sortBy")}
        value={[value.sort]}
        onChange={(sorts) =>
          onChange({
            ...value,
            sort: sorts.find((sort) => sort !== value.sort) ?? value.sort,
          })
        }
        options={[
          { value: "latest", label: t("community.latestListed") },
          { value: "views", label: t("community.mostViewed") },
          { value: "likes", label: t("community.mostLiked") },
        ]}
      />
      <span className="community-spacer" />
      {filtered ? (
        <Button
          size="sm"
          variant="ghost"
          onClick={() => onChange({ ...DEFAULT_COMMUNITY_FILTERS })}
        >
          {t("community.resetFilters")}
        </Button>
      ) : null}
      <Select<CommunityFilters["period"]>
        size="sm"
        label={t("community.firstListed")}
        value={value.period}
        onChange={(period) => onChange({ ...value, period })}
        options={[
          { value: "all", label: t("community.anyTime") },
          { value: "week", label: t("community.pastWeek") },
          { value: "month", label: t("community.pastMonth") },
        ]}
      />
      {search ? (
        <CommunitySearch size="sm" value={value} onChange={onChange} />
      ) : null}
    </div>
  );
}

export function CommunitySearch({
  value,
  onChange,
  size,
}: {
  value: CommunityFilters;
  onChange: (filters: CommunityFilters) => void;
  size?: "sm" | "md";
}) {
  return (
    <SearchInput
      size={size}
      value={value.search}
      onChange={(search) => onChange({ ...value, search })}
      label={t("community.search")}
      placeholder={t("community.searchPlaceholder")}
    />
  );
}
