import { useLayoutEffect, useState, type RefObject } from "react";

export function StorySurfaceViewport({ iframeRef, className, title, src, onLoad }: {
  iframeRef: RefObject<HTMLIFrameElement | null>;
  className?: string;
  title: string;
  src: string;
  onLoad: () => void;
}) {
  const [colorScheme, setColorScheme] = useState<"light" | "dark">(() => resolvedColorScheme());

  useLayoutEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setColorScheme(resolvedColorScheme()));
    observer.observe(root, { attributes: true, attributeFilter: ["data-appearance"] });
    return () => observer.disconnect();
  }, []);

  return <div className={`story-surface-viewport${className ? ` ${className}` : ""}`}>
    <iframe
      ref={iframeRef}
      title={title}
      sandbox="allow-scripts"
      src={`${src}?color-scheme=${colorScheme}`}
      onLoad={onLoad}
      style={{
        position: "absolute",
        inset: 0,
        width: "100%",
        height: "100%",
        border: 0,
        background: "transparent",
      }}
    />
  </div>;
}

function resolvedColorScheme(): "light" | "dark" {
  return document.documentElement.dataset.appearance === "light" ? "light" : "dark";
}
