import { Clapperboard, LoaderCircle, Plus, X } from "./icons.js";
import { useEffect, useId, useRef, useState } from "react";
import type { CreateProjectRequest, ProjectState, ProjectType } from "../shared/contracts.js";
import { INTERACTIVE_DRAMA_STARTER } from "../shared/interactive-drama-starter.js";
import { createProject } from "./api.js";
import { useExamples } from "./examples.js";
import { defaultProjectName, PROJECT_TYPES, ProjectTypeIcon, projectTypeLabel, type ProjectTypeOption } from "./project-types.js";
import { canvasFormatPreset, type CanvasFormatPresetId } from "../shared/canvas-formats.js";
import { CanvasFormatOptions } from "./canvas-format-options.js";

export function ProjectCreateDialog({ initialType = "web-game", fixedType, projectTypes = PROJECT_TYPES, onClose, onCreated }: {
  initialType?: ProjectType;
  fixedType?: ProjectType;
  projectTypes?: readonly ProjectTypeOption[];
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
  const [templateId, setTemplateId] = useState<CreateProjectRequest["templateId"]>();
  const [canvasFormat, setCanvasFormat] = useState<CanvasFormatPresetId>("landscape");
  const { examples, covers: exampleCovers } = useExamples();
  const [exampleId, setExampleId] = useState<string>();
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string>();
  creatingRef.current = creating;
  onCloseRef.current = onClose;
  const typeExamples = examples.filter((example) => example.type === type);
  const selectedExample = typeExamples.find((example) => example.id === exampleId);
  const namePlaceholder = selectedExample?.name ?? (templateId ? INTERACTIVE_DRAMA_STARTER.name : defaultProjectName(type));

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
        name: name.trim() || namePlaceholder,
        type,
        ...(selectedExample ? { exampleId: selectedExample.id } : {}),
        ...(type === "interactive-drama" && templateId ? { templateId } : {}),
        ...(type === "interactive-drama" && !templateId ? { viewport: canvasFormatPreset(canvasFormat).viewport } : {}),
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
    const selectDirectory = window.ohMyGameDesktop?.selectProjectDirectory;
    if (!selectDirectory) {
      setError("Restart the OhMyGame desktop app to enable folder selection.");
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
            <input ref={nameInput} value={name} maxLength={120} disabled={creating} placeholder={namePlaceholder} onChange={(event) => setName(event.target.value)} />
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
              {projectTypes.map((option) => (
                <button className={option.value === type ? "is-active" : undefined} type="button" key={option.value} aria-pressed={option.value === type} disabled={creating} onClick={() => { setType(option.value); setExampleId(undefined); if (option.value !== "interactive-drama") setTemplateId(undefined); }}>
                  <ProjectTypeIcon type={option.value} size={17} />
                  <span>{option.label}</span>
                </button>
              ))}
            </fieldset>
          ) : null}
          {type !== "interactive-drama" && typeExamples.length > 0 ? (
            <fieldset className="project-create-templates">
              <legend>Start from</legend>
              <button className={exampleId === undefined ? "is-active" : undefined} type="button" aria-pressed={exampleId === undefined} disabled={creating} onClick={() => setExampleId(undefined)}>
                <span className="project-create-template-icon"><Plus size={17} /></span>
                <span><strong>Blank project</strong><small>Empty workspace</small></span>
              </button>
              {typeExamples.map((example) => (
                <button className={["has-cover", example.id === exampleId ? "is-active" : ""].filter(Boolean).join(" ")} type="button" key={example.id} aria-pressed={example.id === exampleId} disabled={creating} onClick={() => setExampleId(example.id)} title={example.description}>
                  {exampleCovers[example.id]
                    ? <img className="project-create-template-cover" src={exampleCovers[example.id]} alt="" />
                    : <span className="project-create-template-cover"><ProjectTypeIcon type={example.type} size={17} /></span>}
                  <span><strong>{example.name}</strong><small>{example.description}</small></span>
                </button>
              ))}
            </fieldset>
          ) : null}
          {type === "interactive-drama" ? (
            <>
              <fieldset className="project-create-templates">
                <legend>Start from</legend>
                <button className={templateId === undefined ? "is-active" : undefined} type="button" aria-pressed={templateId === undefined} disabled={creating} onClick={() => setTemplateId(undefined)}>
                  <span className="project-create-template-icon"><Plus size={17} /></span>
                  <span><strong>Blank project</strong><small>Empty canvas</small></span>
                </button>
                <button className={templateId === INTERACTIVE_DRAMA_STARTER.id ? "is-active" : undefined} type="button" aria-pressed={templateId === INTERACTIVE_DRAMA_STARTER.id} disabled={creating} onClick={() => setTemplateId(INTERACTIVE_DRAMA_STARTER.id)}>
                  <span className="project-create-template-icon"><Clapperboard size={17} /></span>
                  <span><strong>Sample project</strong><small>Complete interactive drama</small></span>
                </button>
              </fieldset>
              {!templateId ? <fieldset className="project-create-format">
                <legend>Canvas format</legend>
                <CanvasFormatOptions value={canvasFormat} disabled={creating} onChange={setCanvasFormat} />
              </fieldset> : null}
            </>
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
