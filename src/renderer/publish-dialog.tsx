import { useEffect, useId, useRef, useState } from "react";
import type { ProjectState } from "../shared/contracts.js";
import { getProjectCover, setProjectCover } from "./api.js";
import { imageToWebP } from "./image.js";
import { Image, LoaderCircle, Upload, X } from "./icons.js";

export interface PublishDetails {
  title: string;
  description: string;
}

export function PublishDialog({ project, publishing, onClose, onPublish }: {
  project: ProjectState;
  publishing: boolean;
  onClose: () => void;
  onPublish: (details: PublishDetails) => Promise<boolean>;
}) {
  const titleId = useId();
  const dialog = useRef<HTMLElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const coverSelection = useRef(0);
  const coverChanged = useRef(false);
  const [title, setTitle] = useState(project.publication?.title ?? project.name);
  const [description, setDescription] = useState(project.publication?.description ?? "");
  const [cover, setCover] = useState<Blob>();
  const [coverUrl, setCoverUrl] = useState<string>();
  const [error, setError] = useState<string>();
  const [coverProcessing, setCoverProcessing] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const busy = publishing || submitting || coverProcessing;

  useEffect(() => {
    let active = true;
    void getProjectCover(project.id).then((value) => { if (active && coverSelection.current === 0) setCover(value); }).catch(() => undefined);
    titleInput.current?.focus();
    return () => {
      active = false;
      coverSelection.current += 1;
    };
  }, [project.id]);

  useEffect(() => {
    if (!cover) {
      setCoverUrl(undefined);
      return;
    }
    const url = URL.createObjectURL(cover);
    setCoverUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [cover]);

  useEffect(() => {
    const handleKeyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape" && !busy) onClose();
      if (event.key !== "Tab" || !dialog.current) return;
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>("button:not(:disabled), input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])")];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) return;
      if (document.activeElement === dialog.current || (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault();
        first.focus();
      } else if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last.focus();
      }
    };
    window.addEventListener("keydown", handleKeyboard);
    return () => window.removeEventListener("keydown", handleKeyboard);
  }, [busy, onClose]);

  async function selectCover(file: File | undefined): Promise<void> {
    if (!file) return;
    const selection = ++coverSelection.current;
    setError(undefined);
    setCoverProcessing(true);
    try {
      const nextCover = await imageToWebP(file);
      if (selection !== coverSelection.current) return;
      coverChanged.current = true;
      setCover(nextCover);
    } catch (cause) {
      if (selection === coverSelection.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (selection === coverSelection.current) setCoverProcessing(false);
    }
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const normalizedTitle = title.trim();
    if (!normalizedTitle || busy) return;
    setError(undefined);
    setSubmitting(true);
    try {
      if (coverChanged.current && cover) await setProjectCover(project.id, cover);
      if (await onPublish({ title: normalizedTitle, description: description.trim() })) onClose();
      else setError("Publishing did not complete. Please try again.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  }

  return <div className="project-create-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section ref={dialog} className="publish-dialog" role="dialog" aria-modal="true" aria-labelledby={titleId} tabIndex={-1}>
      <header><h2 id={titleId}>Publish game</h2><button type="button" disabled={busy} onClick={onClose} aria-label="Close"><X size={16} /></button></header>
      <form onSubmit={(event) => void submit(event)}>
        <label className="publish-cover-field">
          <span>Cover</span>
          <span className="publish-cover-preview">
            {coverUrl ? <img src={coverUrl} alt="Game cover preview" /> : <span><Image size={22} />The preview is captured automatically</span>}
            <span className="publish-cover-action"><Upload size={14} />Replace cover</span>
          </span>
          <input hidden type="file" accept="image/png,image/jpeg,image/webp" disabled={busy} onChange={(event) => void selectCover(event.target.files?.[0])} />
        </label>
        <label><span>Name</span><input ref={titleInput} value={title} maxLength={200} disabled={busy} required onChange={(event) => setTitle(event.target.value)} /></label>
        <label><span>Description</span><textarea value={description} maxLength={2000} disabled={busy} rows={4} placeholder="Describe what makes this game worth playing" onChange={(event) => setDescription(event.target.value)} /></label>
        {error ? <p className="project-create-error" role="alert">{error}</p> : null}
        <footer><button type="button" disabled={busy} onClick={onClose}>Cancel</button><button className="project-create-submit" type="submit" disabled={busy || !title.trim()}>{busy ? <LoaderCircle className="spin" size={14} /> : null}Publish</button></footer>
      </form>
    </section>
  </div>;
}
