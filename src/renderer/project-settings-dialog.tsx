import { ExternalLink, LoaderCircle, X } from "./icons.js";
import {
  useEffect,
  useId,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from "react";
import type {
  PreviewViewport,
  ProjectPackageManager,
  ProjectState,
} from "../shared/contracts.js";
import { updateProjectRunSettings } from "./api.js";

export function ProjectSettingsDialogFrame({
  children,
  busy = false,
  initialFocusRef,
  onClose,
}: {
  children: ReactNode;
  busy?: boolean;
  initialFocusRef?: RefObject<HTMLElement | null>;
  onClose: () => void;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLElement>(null);
  const busyRef = useRef(busy);
  const onCloseRef = useRef(onClose);
  busyRef.current = busy;
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    const initialFocus = initialFocusRef?.current ?? dialog.current;
    initialFocus?.focus();
    if (initialFocus instanceof HTMLInputElement) initialFocus.select();
    const handleKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busyRef.current) onCloseRef.current();
      if (event.key !== "Tab" || !dialog.current) return;
      const focusable = [
        ...dialog.current.querySelectorAll<HTMLElement>(
          "button:not(:disabled), input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])",
        ),
      ];
      const first = focusable[0];
      const last = focusable.at(-1);
      if (!first || !last) {
        event.preventDefault();
        dialog.current.focus();
        return;
      }
      if (
        document.activeElement === dialog.current ||
        (!event.shiftKey && document.activeElement === last)
      ) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    };
    window.addEventListener("keydown", handleKeyboard);
    return () => {
      window.removeEventListener("keydown", handleKeyboard);
      previousFocus?.focus();
    };
  }, [initialFocusRef]);

  return (
    <div
      className="project-settings-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        ref={dialog}
        className="project-settings-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <header>
          <h2 id={titleId}>Project settings</h2>
          <button
            type="button"
            disabled={busy}
            onClick={onClose}
            aria-label="Close"
          >
            <X size={16} />
          </button>
        </header>
        {children}
      </section>
    </div>
  );
}

export function ProjectSettingsDialog({
  project,
  previewUrl: currentPreviewUrl,
  onClose,
  onSaved,
}: {
  project: ProjectState;
  previewUrl?: string;
  onClose: () => void;
  onSaved: (project: ProjectState) => Promise<void> | void;
}) {
  const directoryInput = useRef<HTMLInputElement>(null);
  const [startupDirectory, setStartupDirectory] = useState(
    project.startupDirectory ?? ".",
  );
  const [startupScript, setStartupScript] = useState(
    project.startupScript ?? "dev",
  );
  const [packageManager, setPackageManager] = useState<
    ProjectPackageManager | "auto"
  >(project.packageManager ?? "auto");
  const [previewPath, setPreviewPath] = useState(project.previewPath ?? "/");
  const [previewViewport, setPreviewViewport] = useState<PreviewViewport>(
    project.previewViewport ?? "fit",
  );
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const previewUrl =
    currentPreviewUrl ??
    (project.preview.status === "ready" ? project.preview.url : undefined);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (saving) return;
    setSaving(true);
    setError(undefined);
    try {
      const nextProject = await updateProjectRunSettings(project.id, {
        startupDirectory: startupDirectory.trim() || ".",
        startupScript: startupScript.trim(),
        ...(packageManager === "auto" ? {} : { packageManager }),
        previewPath: previewPath.trim() || "/",
        previewViewport,
      });
      await onSaved(nextProject);
      onClose();
    } catch (cause) {
      setError(errorMessage(cause));
      setSaving(false);
    }
  }

  return (
    <ProjectSettingsDialogFrame
      busy={saving}
      initialFocusRef={directoryInput}
      onClose={onClose}
    >
      <form onSubmit={(event) => void submit(event)}>
        <section className="project-settings-project" aria-label="Project">
          <span>Project</span>
          <strong title={project.name}>{project.name}</strong>
        </section>
        <fieldset className="project-settings-section">
          <legend>Run</legend>
          <label>
            <span>Startup directory</span>
            <input
              ref={directoryInput}
              value={startupDirectory}
              disabled={saving}
              spellCheck={false}
              placeholder="."
              onChange={(event) => setStartupDirectory(event.target.value)}
            />
          </label>
          <div className="project-settings-field-row">
            <label>
              <span>Startup script</span>
              <input
                value={startupScript}
                disabled={saving}
                spellCheck={false}
                onChange={(event) => setStartupScript(event.target.value)}
              />
            </label>
            <label>
              <span>Package manager</span>
              <select
                value={packageManager}
                disabled={saving}
                onChange={(event) =>
                  setPackageManager(
                    event.target.value as ProjectPackageManager | "auto",
                  )
                }
              >
                <option value="auto">Auto</option>
                <option value="npm">npm</option>
                <option value="pnpm">pnpm</option>
                <option value="yarn">yarn</option>
                <option value="bun">bun</option>
              </select>
            </label>
          </div>
        </fieldset>
        <fieldset className="project-settings-section">
          <legend>Playtest</legend>
          <div className="project-settings-field-row">
            <label>
              <span>Default route</span>
              <input
                value={previewPath}
                disabled={saving}
                spellCheck={false}
                onChange={(event) => setPreviewPath(event.target.value)}
              />
            </label>
            <label>
              <span>Device</span>
              <select
                value={previewViewport}
                disabled={saving}
                onChange={(event) =>
                  setPreviewViewport(event.target.value as PreviewViewport)
                }
              >
                <option value="fit">Fit</option>
                <option value="tablet">Tablet</option>
                <option value="mobile">Mobile</option>
              </select>
            </label>
          </div>
        </fieldset>
        <button
          className="project-settings-browser"
          type="button"
          disabled={!previewUrl || saving}
          onClick={() =>
            previewUrl &&
            window.open(previewUrl, "_blank", "noopener,noreferrer")
          }
        >
          <ExternalLink size={14} />
          Open preview in browser
        </button>
        {error ? (
          <p className="project-settings-error" role="alert">
            {error}
          </p>
        ) : null}
        <footer>
          <button type="button" disabled={saving} onClick={onClose}>
            Cancel
          </button>
          <button
            className="project-settings-submit"
            type="submit"
            disabled={saving}
          >
            {saving ? <LoaderCircle className="spin" size={14} /> : null}
            Save
          </button>
        </footer>
      </form>
    </ProjectSettingsDialogFrame>
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
