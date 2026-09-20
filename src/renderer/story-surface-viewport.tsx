import { useLayoutEffect, useRef, useState, type RefObject } from "react";

export function StorySurfaceViewport({ iframeRef, viewport, className, title, src, onLoad }: {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  viewport: { width: number; height: number };
  className?: string;
  title: string;
  src: string;
  onLoad: () => void;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const [colorScheme, setColorScheme] = useState<"light" | "dark">(() => resolvedColorScheme());

  useLayoutEffect(() => {
    const element = container.current;
    if (!element) return;
    const update = () => setScale(Math.min(element.clientWidth / viewport.width, element.clientHeight / viewport.height));
    update();
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, [viewport.height, viewport.width]);

  useLayoutEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setColorScheme(resolvedColorScheme()));
    observer.observe(root, { attributes: true, attributeFilter: ["data-appearance"] });
    return () => observer.disconnect();
  }, []);

  return <div ref={container} className={`story-surface-viewport${className ? ` ${className}` : ""}`}>
    <iframe
      ref={iframeRef}
      title={title}
      sandbox="allow-scripts"
      src={`${src}?color-scheme=${colorScheme}`}
      onLoad={onLoad}
      style={{
        position: "absolute",
        top: "50%",
        left: "50%",
        width: viewport.width,
        height: viewport.height,
        border: 0,
        background: "transparent",
        transform: `translate(-50%, -50%) scale(${scale})`,
        transformOrigin: "center",
      }}
    />
  </div>;
}

function resolvedColorScheme(): "light" | "dark" {
  return document.documentElement.dataset.appearance === "light" ? "light" : "dark";
}
