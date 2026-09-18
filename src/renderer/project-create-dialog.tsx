import { LoaderCircle, X } from "./icons.js";
import { useEffect, useId, useRef, useState } from "react";
import type { ProjectState, ProjectType } from "../shared/contracts.js";
import { createProject } from "./api.js";
import { defaultProjectName, PROJECT_TYPES, ProjectTypeIcon, projectTypeLabel } from "./project-types.js";

export function ProjectCreateDialog({ initialType = "web-game", fixedType, onClose, onCreated }: {
  initialType?: ProjectType;
  fixedType?: ProjectType;
  onClose: () => void;
  onCreated: (project: ProjectState) => void;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLElement>(null);
  const nameInput = useRef<HTMLInputElement>(null);
  const creatingRef = useRef(false);
  const onCloseRef = useRef(onClose);
  const [name, setName] = useState("");
  const [type, setType] = useState<ProjectType>(fixedType ?? initialType);
  const [workspacePath, setWorkspacePath] = useState<string>();
  const [selectingWorkspace, setSelectingWorkspace] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  creatingRef.current = creating;
  onCloseRef.current = onClose;

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    nameInput.current?.focus();
    const handleKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !creatingRef.current) onCloseRef.current();
      if (event.key !== "Tab" || !dialog.current) return;
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), [tabindex]:not([tabindex='-1'])")];
      if (!focusable.length) return;
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (document.activeElement === dialog.current || (!event.shiftKey && document.activeElement === last)) {
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
  }, []);

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    if (creating) return;
    setCreating(true);
    setError(undefined);
    try {
      const project = await createProject({
        name: name.trim() || defaultProjectName(type),
        type,
        ...(workspacePath ? { workspacePath } : {}),
      });
      onCreated(project);
    } catch (cause) {
      setError(errorMessage(cause));
      setCreating(false);
    }
  }

  async function chooseWorkspace(): Promise<void> {
    if (creating || selectingWorkspace) return;
    const selectDirectory = window.openGameDesktop?.selectProjectDirectory;
    if (!selectDirectory) {
      setError("Restart the OpenGame desktop app to enable folder selection.");
      return;
    }
    setSelectingWorkspace(true);
    setError(undefined);
    try {
      const selected = await selectDirectory();
      if (!selected) return;
      setWorkspacePath(selected);
    } catch (cause) {
      setError(errorMessage(cause));
    } finally {
      setSelectingWorkspace(false);
    }
  }

  function clearWorkspace(): void {
    setWorkspacePath(undefined);
    setError(undefined);
  }

  return (
    <div className="project-create-backdrop" onMouseDown={(event) => {
      if (event.target === event.currentTarget && !creating) onClose();
    }}>
      <section ref={dialog} className="project-create-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
        <header>
          <h2 id={titleId}>{fixedType ? `New ${projectTypeLabel(fixedType)}` : "New project"}</h2>
          <button type="button" disabled={creating} onClick={onClose} aria-label="Close"><X size={16} /></button>
        </header>
        <form onSubmit={(event) => void submit(event)}>
          <label className="project-create-name">
            <span>Name</span>
            <input ref={nameInput} value={name} maxLength={120} disabled={creating} placeholder={defaultProjectName(type)} onChange={(event) => setName(event.target.value)} />
          </label>
          <fieldset className="project-create-workspace">
            <legend>Workspace</legend>
            <div className="project-create-workspace-selection">
              {workspacePath ? <span className="is-selected" title={workspacePath}>{workspacePath}</span> : null}
              <div>
                <button type="button" disabled={creating || selectingWorkspace} onClick={() => void chooseWorkspace()}>
                  {selectingWorkspace ? "Opening…" : workspacePath ? "Choose another…" : "Choose folder…"}
                </button>
                {workspacePath ? <button type="button" disabled={creating || selectingWorkspace} onClick={clearWorkspace}>Clear</button> : null}
              </div>
            </div>
          </fieldset>
          {!fixedType ? (
            <fieldset className="project-create-types">
              <legend>Type</legend>
              {PROJECT_TYPES.map((option) => (
                <button className={option.value === type ? "is-active" : undefined} type="button" key={option.value} aria-pressed={option.value === type} disabled={creating} onClick={() => setType(option.value)}>
                  <ProjectTypeIcon type={option.value} size={17} />
                  <span>{option.label}</span>
                </button>
              ))}
            </fieldset>
          ) : null}
          {error ? <p className="project-create-error" role="alert">{error}</p> : null}
          <footer>
            <button type="button" disabled={creating} onClick={onClose}>Cancel</button>
            <button className="project-create-submit" type="submit" disabled={creating}>
              {creating ? <LoaderCircle className="spin" size={14} /> : null}
              Create
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
