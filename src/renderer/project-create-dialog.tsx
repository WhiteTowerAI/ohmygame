import { Clapperboard, LoaderCircle, Plus, X } from "./icons.js";
import { useEffect, useId, useRef, useState } from "react";
import type { CreateProjectRequest, ProjectState, ProjectType } from "../shared/contracts.js";
import { INTERACTIVE_DRAMA_STARTER } from "../shared/interactive-drama-starter.js";
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
  const [templateId, setTemplateId] = useState<CreateProjectRequest["templateId"]>();
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
        name: name.trim() || (templateId ? INTERACTIVE_DRAMA_STARTER.name : defaultProjectName(type)),
        type,
        ...(type === "interactive-drama" && templateId ? { templateId } : {}),
      });
      onCreated(project);
    } catch (cause) {
      setError(errorMessage(cause));
      setCreating(false);
    }
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
            <input ref={nameInput} value={name} maxLength={120} disabled={creating} placeholder={templateId ? INTERACTIVE_DRAMA_STARTER.name : defaultProjectName(type)} onChange={(event) => setName(event.target.value)} />
          </label>
          {!fixedType ? (
            <fieldset className="project-create-types">
              <legend>Type</legend>
              {PROJECT_TYPES.map((option) => (
                <button className={option.value === type ? "is-active" : undefined} type="button" key={option.value} aria-pressed={option.value === type} disabled={creating} onClick={() => { setType(option.value); if (option.value !== "interactive-drama") setTemplateId(undefined); }}>
                  <ProjectTypeIcon type={option.value} size={17} />
                  <span>{option.label}</span>
                </button>
              ))}
            </fieldset>
          ) : null}
          {type === "interactive-drama" ? (
            <fieldset className="project-create-templates">
              <legend>Start from</legend>
              <button className={templateId === undefined ? "is-active" : undefined} type="button" aria-pressed={templateId === undefined} disabled={creating} onClick={() => setTemplateId(undefined)}>
                <Plus size={17} />
                <span><strong>Blank project</strong><small>Basic story flow</small></span>
              </button>
              <button className={templateId === INTERACTIVE_DRAMA_STARTER.id ? "is-active" : undefined} type="button" aria-pressed={templateId === INTERACTIVE_DRAMA_STARTER.id} disabled={creating} onClick={() => setTemplateId(INTERACTIVE_DRAMA_STARTER.id)}>
                <Clapperboard size={17} />
                <span><strong>{INTERACTIVE_DRAMA_STARTER.name}</strong><small>Sample interactive drama</small></span>
              </button>
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
