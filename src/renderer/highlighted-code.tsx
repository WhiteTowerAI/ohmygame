import { useEffect, useMemo, useState } from "react";

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

function lineNumbers(content: string): string {
  let count = 1;
  for (let index = content.indexOf("\n"); index !== -1; index = content.indexOf("\n", index + 1)) count++;
  return Array.from({ length: count }, (_, index) => index + 1).join("\n");
}

export function HighlightedCode({ path, content: text }: { path: string; content: string }) {
  // A file's final newline would show as an empty, numbered line.
  const content = text.endsWith("\n") ? text.slice(0, -1) : text;
  const language = workspaceLanguage(path);
  const gutter = useMemo(() => lineNumbers(content), [content]);
  const [result, setResult] = useState<{ content: string; language: string; html: string }>();

  useEffect(() => {
    if (!language || !content || typeof Worker === "undefined") return;
    let cancelled = false;
    let worker: Worker | undefined;
    void import("./code-highlight.worker.ts?worker&inline").then(({ default: HighlightWorker }) => {
      if (cancelled) return;
      worker = new HighlightWorker();
      worker.onmessage = (event: MessageEvent<string>) => {
        if (!cancelled) setResult({ content, language, html: event.data });
        worker?.terminate();
      };
      worker.onerror = () => worker?.terminate();
      worker.postMessage(JSON.stringify({ language, code: content, immediateClose: true }));
    }).catch(() => { /* Keep the readable plain text if the worker cannot load. */ });
    return () => { cancelled = true; worker?.terminate(); };
  }, [content, language]);

  return <pre className="workspace-code workspace-code-plain">
    <span className="workspace-code-gutter" aria-hidden="true">{gutter}</span>
    {result && result.content === content && result.language === language
      ? <code dangerouslySetInnerHTML={{ __html: result.html }} />
      : <code>{content}</code>}
  </pre>;
}
