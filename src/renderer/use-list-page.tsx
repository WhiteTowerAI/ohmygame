import { useCallback, useState } from "react";
import { t } from "./i18n.js";
import { Button } from "./ui/index.js";

const PAGE_SIZE = 48;

/** Keep filters and selection over the full list. Mount another page when its end comes into view. */
export function useListPage(total: number) {
  const [limit, setLimit] = useState(PAGE_SIZE);
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
  }, [limit]);
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
