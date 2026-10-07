import { useEffect, useState } from "react";

const LANGUAGE_BY_EXTENSION: Record<string, string> = {
  css: "css",
  html: "html",
  htm: "html",
  js: "javascript",
  jsx: "jsx",
  json: "json",
  md: "markdown",
  mjs: "javascript",
  py: "python",
  ts: "typescript",
  tsx: "tsx",
  yaml: "yaml",
  yml: "yaml",
};

export function workspaceLanguage(path: string): string | undefined {
  const extension = path.split(".").pop()?.toLowerCase();
  return extension ? LANGUAGE_BY_EXTENSION[extension] : undefined;
}

let highlighterPromise: Promise<import("shiki/core").HighlighterCore> | undefined;
type ShikiTheme = "github-dark" | "github-light";

function resolvedShikiTheme(): ShikiTheme {
  return typeof document !== "undefined" && document.documentElement.dataset.appearance === "light"
    ? "github-light"
    : "github-dark";
}

function loadHighlighter() {
  highlighterPromise ??= Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    import("shiki/themes/github-dark.mjs"),
    import("shiki/themes/github-light.mjs"),
    import("shiki/langs/css.mjs"),
    import("shiki/langs/html.mjs"),
    import("shiki/langs/javascript.mjs"),
    import("shiki/langs/jsx.mjs"),
    import("shiki/langs/json.mjs"),
    import("shiki/langs/markdown.mjs"),
    import("shiki/langs/python.mjs"),
    import("shiki/langs/tsx.mjs"),
    import("shiki/langs/typescript.mjs"),
    import("shiki/langs/yaml.mjs"),
  ]).then(([core, engine, darkTheme, lightTheme, ...languages]) => core.createHighlighterCore({
    engine: engine.createJavaScriptRegexEngine(),
    themes: [darkTheme.default, lightTheme.default],
    langs: languages.map((language) => language.default),
  })).catch((error: unknown) => {
    highlighterPromise = undefined;
    throw error;
  });
  return highlighterPromise;
}

export async function highlightWorkspaceCode(content: string, language: string, theme: ShikiTheme): Promise<string> {
  const highlighter = await loadHighlighter();
  return highlighter.codeToHtml(content, { lang: language, theme });
}

export function HighlightedCode({ path, content }: { path: string; content: string }) {
  const language = workspaceLanguage(path);
  const [theme, setTheme] = useState<ShikiTheme>(resolvedShikiTheme);
  const [html, setHtml] = useState<string>();

  useEffect(() => {
    const root = document.documentElement;
    const syncTheme = () => setTheme(resolvedShikiTheme());
    const observer = new MutationObserver(syncTheme);
    observer.observe(root, { attributes: true, attributeFilter: ["data-appearance"] });
    syncTheme();
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    setHtml(undefined);
    if (!language) return;
    let disposed = false;
    void highlightWorkspaceCode(content, language, theme)
      .then((result) => {
        if (!disposed) setHtml(result);
      })
      .catch((error: unknown) => {
        if (!disposed) {
          console.warn("Workspace code highlighting failed.", error);
          setHtml(undefined);
        }
      });
    return () => {
      disposed = true;
    };
  }, [content, language, theme]);

  if (!html) return <pre className="workspace-code">{content}</pre>;
  return <div className="workspace-code workspace-code-highlighted" dangerouslySetInnerHTML={{ __html: html }} />;
}
