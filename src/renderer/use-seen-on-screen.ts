import { useEffect, useState } from "react";

/**
 * Whether `element` has come within `margin` of the screen, as for media that
 * should only download once it could be seen. It stays true from then on. An
 * element under a hidden panel is not on screen.
 */
export function useSeenOnScreen(element: Element | null, margin = "200px"): boolean {
  const [seen, setSeen] = useState(false);
  useEffect(() => {
    if (seen || !element) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) setSeen(true);
    }, { rootMargin: margin });
    observer.observe(element);
    return () => observer.disconnect();
  }, [seen, element, margin]);
  return seen;
}
