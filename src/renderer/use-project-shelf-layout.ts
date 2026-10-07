import { useLayoutEffect, useRef, useState } from "react";

export const MAX_RECENT_PROJECTS = 6;

/** Read the shared CSS column count so project and example limits follow the grid. */
export function useProjectShelfLayout() {
  const sectionRef = useRef<HTMLElement>(null);
  const [columns, setColumns] = useState(4);

  useLayoutEffect(() => {
    const section = sectionRef.current;
    const heading = section?.querySelector(".studio-section-heading");
    if (!section || !heading) return;
    const update = () => {
      const count = Number.parseInt(getComputedStyle(heading).getPropertyValue("--project-shelf-columns"), 10);
      if (count >= 2 && count <= 4) setColumns(count);
    };
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(section);
    return () => observer.disconnect();
  }, []);

  return { sectionRef, columns, recentProjectLimit: columns === 4 ? 4 : MAX_RECENT_PROJECTS };
}
