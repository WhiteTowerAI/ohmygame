import { useCallback, useState } from "react";
import { t } from "./i18n.js";
import { Button } from "./ui/index.js";

const PAGE_SIZE = 48;

/** How far lists that keep it were shown, so one shown again can scroll back to where it was. */
const keptLimits = new Map<string, number>();

/** Keep filters and selection over the full list. Mount another page when its end comes into view. */
export function useListPage(total: number, keepAs?: string) {
  const [limit, setShownLimit] = useState(() => (keepAs && keptLimits.get(keepAs)) || PAGE_SIZE);
  const setLimit = useCallback((next: number) => {
    if (keepAs) keptLimits.set(keepAs, next);
    setShownLimit(next);
  }, [keepAs]);
  const more = limit < total;
  const end = useCallback((node: HTMLDivElement | null) => {
    if (!node || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          observer.disconnect();
          setLimit(limit + PAGE_SIZE);
        }
      },
      { rootMargin: "160px" },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [limit, setLimit]);
  return {
    limit,
    next: more ? (
      <div ref={end}>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setLimit(limit + PAGE_SIZE)}
        >
          {t("common.showMore")}
        </Button>
      </div>
    ) : null,
  };
}
