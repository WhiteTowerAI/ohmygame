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

function loadHighlighter() {
  highlighterPromise ??= Promise.all([
    import("shiki/core"),
    import("shiki/engine/javascript"),
    import("shiki/themes/github-dark.mjs"),
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
  ]).then(([core, engine, theme, ...languages]) => core.createHighlighterCore({
    engine: engine.createJavaScriptRegexEngine(),
    themes: [theme.default],
    langs: languages.map((language) => language.default),
  }));
  return highlighterPromise;
}

export function HighlightedCode({ path, content }: { path: string; content: string }) {
  const language = workspaceLanguage(path);
  const [html, setHtml] = useState<string>();

  useEffect(() => {
    setHtml(undefined);
    if (!language) return;
    let disposed = false;
    void loadHighlighter()
      .then((highlighter) => highlighter.codeToHtml(content, { lang: language, theme: "github-dark" }))
      .then((result) => {
        if (!disposed) setHtml(result);
      })
      .catch(() => {
        if (!disposed) setHtml(undefined);
      });
    return () => {
      disposed = true;
    };
  }, [content, language]);

  if (!html) return <pre className="workspace-code">{content}</pre>;
  return <div className="workspace-code workspace-code-highlighted" dangerouslySetInnerHTML={{ __html: html }} />;
}
