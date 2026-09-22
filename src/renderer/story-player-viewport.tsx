import { useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { StoryPlayerConfig } from "../shared/contracts.js";

export function StoryPlayerViewport({ viewport, children }: {
  viewport: StoryPlayerConfig["viewport"];
  children: ReactNode;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const update = () => setScale(Math.min(element.clientWidth / viewport.width, element.clientHeight / viewport.height));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [viewport.height, viewport.width]);

  return <div ref={container} className="story-player-viewport">
    <div className="story-player-stage" style={{ width: viewport.width, height: viewport.height, transform: `translate(-50%, -50%) scale(${scale})` }}>
      {children}
    </div>
  </div>;
}
