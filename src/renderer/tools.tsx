import { Download, Image, LoaderCircle, RefreshCw, Sparkles, X } from "lucide-react";
import { useEffect, useRef, useState, type FormEvent } from "react";
import type { ImageSize, ToolDefinition, ToolRun } from "../shared/contracts.js";
import { getToolRunFile, listTools, runTool, waitForRuntime } from "./api.js";
import { AppSidebar } from "./app-sidebar.js";

interface ToolsProps {
  onCommunity: () => void;
  onHome: () => void;
}

export function Tools({ onCommunity, onHome }: ToolsProps) {
  const [tools, setTools] = useState<ToolDefinition[]>([]);
  const [phase, setPhase] = useState<"loading" | "ready" | "error">("loading");
  const [error, setError] = useState<string>();
  const [selectedTool, setSelectedTool] = useState<ToolDefinition>();

  async function load() {
    setPhase("loading");
    setError(undefined);
    try {
      await waitForRuntime();
      setTools(await listTools());
      setPhase("ready");
    } catch (cause) {
      setError(errorMessage(cause));
      setPhase("error");
    }
  }

  useEffect(() => { void load(); }, []);

  return (
    <main className="home-shell">
      <AppSidebar active="tools" onCommunity={onCommunity} onHome={onHome} />
      <section className="tools-content">
        <header className="tools-heading">
          <div>
            <h1>Tools</h1>
            <p>Try creative tools before using them in a project.</p>
          </div>
          {phase === "error" ? (
            <button className="tools-retry" type="button" onClick={() => void load()}>
              <RefreshCw size={14} /> Retry
            </button>
          ) : null}
        </header>

        {phase === "loading" ? <div className="tools-state"><LoaderCircle className="spin" size={18} />Loading tools</div> : null}
        {phase === "error" ? <div className="tools-state tools-error" role="alert">{error}</div> : null}
        {phase === "ready" ? (
          <div className="tools-grid">
            {tools.map((tool) => (
              <button className="tool-card" type="button" key={tool.id} onClick={() => setSelectedTool(tool)}>
                <span className="tool-card-icon"><Image size={24} /></span>
                <span className="tool-card-copy">
                  <strong>{tool.name}</strong>
                  <span>{tool.description}</span>
                </span>
                <span className="tool-card-action">Open</span>
              </button>
            ))}
          </div>
        ) : null}
      </section>

      {selectedTool ? <ToolDialog tool={selectedTool} onClose={() => setSelectedTool(undefined)} /> : null}
    </main>
  );
}

function ToolDialog({ tool, onClose }: { tool: ToolDefinition; onClose: () => void }) {
  const [prompt, setPrompt] = useState("");
  const [size, setSize] = useState<ImageSize>(tool.defaultSize);
  const [generating, setGenerating] = useState(false);
  const [run, setRun] = useState<ToolRun>();
  const [previewUrl, setPreviewUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const dialogRef = useRef<HTMLElement>(null);
  const mountedRef = useRef(true);
  const promptRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    promptRef.current?.focus();
    return () => previousFocus?.focus();
  }, []);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !generating) {
        onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const focusable = focusableElements(dialogRef.current);
      if (focusable.length === 0) {
        event.preventDefault();
        dialogRef.current?.focus();
        return;
      }
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!dialogRef.current?.contains(document.activeElement)) {
        event.preventDefault();
        first?.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [generating, onClose]);

  useEffect(() => () => { mountedRef.current = false; }, []);

  useEffect(() => () => {
    if (previewUrl) URL.revokeObjectURL(previewUrl);
  }, [previewUrl]);

  async function generate(event?: FormEvent) {
    event?.preventDefault();
    const nextPrompt = prompt.trim();
    if (!nextPrompt || generating) return;
    setGenerating(true);
    setError(undefined);
    try {
      const nextRun = await runTool(tool.id, { prompt: nextPrompt, size });
      if (!mountedRef.current) return;
      const file = nextRun.files[0];
      if (!file) throw new Error("The tool did not return an image");
      const blob = await getToolRunFile(nextRun.id, file.name);
      if (!mountedRef.current) return;
      setRun(nextRun);
      setPreviewUrl(URL.createObjectURL(blob));
    } catch (cause) {
      if (mountedRef.current) setError(errorMessage(cause));
    } finally {
      if (mountedRef.current) setGenerating(false);
    }
  }

  return (
    <div className="tool-dialog-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !generating) onClose();
    }}>
      <section ref={dialogRef} className="tool-dialog" role="dialog" aria-modal="true" aria-labelledby="tool-dialog-title" tabIndex={-1}>
        <header className="tool-dialog-header">
          <div>
            <span className="tool-dialog-icon"><Image size={18} /></span>
            <div>
              <h2 id="tool-dialog-title">{tool.name}</h2>
              <p>{tool.description}</p>
            </div>
          </div>
          <button className="icon-button quiet-button" type="button" onClick={onClose} disabled={generating} title="Close" aria-label="Close">
            <X size={15} />
          </button>
        </header>

        <div className="tool-dialog-body">
          {previewUrl ? (
            <div className="tool-result-preview">
              <img src={previewUrl} alt={prompt} />
            </div>
          ) : (
            <form id="tool-form" className="tool-form" onSubmit={generate}>
              <label htmlFor="tool-prompt">Prompt</label>
              <textarea
                id="tool-prompt"
                ref={promptRef}
                rows={5}
                value={prompt}
                disabled={generating}
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="Describe the image you want to create"
              />
              <fieldset disabled={generating}>
                <legend>Size</legend>
                <div className="tool-size-options">
                  {tool.sizes.map((option) => (
                    <button
                      className={option === size ? "tool-size-active" : undefined}
                      type="button"
                      key={option}
                      onClick={() => setSize(option)}
                      aria-pressed={option === size}
                    >
                      {sizeLabel(option)}
                    </button>
                  ))}
                </div>
              </fieldset>
            </form>
          )}
          {error ? <p className="tool-dialog-error" role="alert">{error}</p> : null}
        </div>

        <footer className="tool-dialog-footer">
          {previewUrl && run ? (
            <>
              <button className="tool-secondary-button" type="button" onClick={() => void generate()} disabled={generating}>
                {generating ? <LoaderCircle className="spin" size={15} /> : <RefreshCw size={15} />}
                Regenerate
              </button>
              <a className="tool-primary-button" href={previewUrl} download={run.files[0]?.name ?? "output.webp"}>
                <Download size={15} /> Download
              </a>
            </>
          ) : (
            <button className="tool-primary-button" type="submit" form="tool-form" disabled={!prompt.trim() || generating}>
              {generating ? <LoaderCircle className="spin" size={15} /> : <Sparkles size={15} />}
              {generating ? "Generating..." : "Generate"}
            </button>
          )}
        </footer>
      </section>
    </div>
  );
}

function sizeLabel(size: ImageSize): string {
  if (size === "1536x1024") return "Landscape";
  if (size === "1024x1536") return "Portrait";
  return "Square";
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function focusableElements(container: HTMLElement | null): HTMLElement[] {
  if (!container) return [];
  return Array.from(container.querySelectorAll<HTMLElement>(
    "button:not(:disabled), textarea:not(:disabled), a[href]",
  ));
}
