import { useEffect, useId, useRef, useState } from "react";
import type { ProjectCoverMode, ProjectState, PublicationState } from "../shared/contracts.js";
import { getExploreGameCover, getProjectCover, getProjectCoverState, restoreAutomaticProjectCover, setProjectCover } from "./api.js";
import { imageToWebP } from "./image.js";
import { Check, Copy, ExternalLink, Image, InfoCircle, LoaderCircle, RefreshCw, Upload, X } from "./icons.js";
import { localDebug } from "./auth.js";
import { gameHash } from "./routes.js";

export interface PublishDetails {
  title: string;
  description: string;
}

export function PublishDialog({ project, publishing, justPublished = false, onClose, onPublish }: {
  project: ProjectState;
  publishing: boolean;
  onClose: () => void;
  justPublished?: boolean;
  onPublish: (details: PublishDetails) => Promise<boolean>;
}) {
  const titleId = useId();
  const coverInputId = useId();
  const dialog = useRef<HTMLElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const coverSelection = useRef(0);
  const [title, setTitle] = useState(project.publication?.title ?? project.name);
  const [description, setDescription] = useState(project.publication?.description ?? "");
  const [savedCover, setSavedCover] = useState<Blob>();
  const [pendingCover, setPendingCover] = useState<Blob>();
  const [coverMode, setCoverMode] = useState<ProjectCoverMode>();
  const coverUrl = useCoverUrl(pendingCover ?? savedCover);
  const [coverLoading, setCoverLoading] = useState(true);
  const [coverOperation, setCoverOperation] = useState<"process" | "apply" | "restore">();
  const [coverNotice, setCoverNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [editing, setEditing] = useState(!project.publication);
  const publication = editing ? undefined : project.publication;
  const busy = publishing || submitting || Boolean(coverOperation);
  const submitLabel = coverOperation === "process" ? "Processing cover..." : coverOperation ? "Saving cover..." : busy ? "Publishing..." : project.publication ? "Publish update" : "Publish";

  useEffect(() => {
    if (!editing) return;
    let active = true;
    setCoverLoading(true);
    void Promise.all([getProjectCover(project.id), getProjectCoverState(project.id)]).then(([value, state]) => {
      if (!active) return;
      setSavedCover(value);
      setCoverMode(state.mode);
    }).catch((cause) => {
      if (active) setError(cause instanceof Error ? cause.message : String(cause));
    }).finally(() => { if (active) setCoverLoading(false); });
    return () => {
      active = false;
      coverSelection.current += 1;
    };
  }, [project.id, editing]);

  useEffect(() => {
    const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : undefined;
    return () => previousFocus?.focus();
  }, []);

  useEffect(() => {
    if (editing) titleInput.current?.focus();
    else dialog.current?.focus();
  }, [editing]);

  useEffect(() => {
    const handleKeyboard = (event: KeyboardEvent) => {
      // Auth can open above this dialog while publishing waits for a token.
      const dialogs = document.querySelectorAll('[role="dialog"][aria-modal="true"]');
      if (dialogs[dialogs.length - 1] !== dialog.current) return;
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onClose();
      }
      if (event.key !== "Tab" || !dialog.current) return;
      const focusable = [...dialog.current.querySelectorAll<HTMLElement>("button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex='-1'])")];
      const first = focusable[0];
      const last = focusable[focusable.length - 1];
      if (!first || !last) {
        event.preventDefault();
        dialog.current.focus();
        return;
      }
      if (document.activeElement === dialog.current || (!event.shiftKey && document.activeElement === last)) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
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
    setCoverNotice(undefined);
    setCoverOperation("process");
    try {
      const nextCover = await imageToWebP(file);
      if (selection !== coverSelection.current) return;
      setPendingCover(nextCover);
    } catch (cause) {
      if (selection === coverSelection.current) setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (selection === coverSelection.current) setCoverOperation(undefined);
    }
  }

  async function applyCover(): Promise<void> {
    if (!pendingCover || busy) return;
    const nextCover = pendingCover;
    setCoverOperation("apply");
    setError(undefined);
    try {
      await setProjectCover(project.id, nextCover);
      setSavedCover(nextCover);
      setPendingCover(undefined);
      setCoverMode("custom");
      setCoverNotice("Cover applied. Automatic replacement is off.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCoverOperation(undefined);
    }
  }

  async function restoreCover(): Promise<void> {
    if (busy) return;
    setCoverOperation("restore");
    setError(undefined);
    setCoverNotice(undefined);
    try {
      await restoreAutomaticProjectCover(project.id);
      setCoverMode("auto");
      setSavedCover(undefined);
      setSavedCover(await getProjectCover(project.id));
      setCoverNotice("Automatic cover restored.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCoverOperation(undefined);
    }
  }

  async function submit(event: React.FormEvent): Promise<void> {
    event.preventDefault();
    const normalizedTitle = title.trim();
    if (!normalizedTitle || busy || coverLoading) return;
    if (pendingCover) {
      setError("Apply or cancel the selected cover before publishing.");
      return;
    }
    setError(undefined);
    setSubmitting(true);
    try {
      if (await onPublish({ title: normalizedTitle, description: description.trim() })) {
        setEditing(false);
      } else setError("Publishing did not complete. Please try again.");
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  }

  return <div className="project-create-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section ref={dialog} className="publish-dialog" role="dialog" aria-modal="true" aria-busy={busy} aria-labelledby={titleId} tabIndex={-1}>
      <header><h2 id={titleId}>{publication ? justPublished ? "Game published" : "Published game" : project.publication ? "Publish update" : "Publish game"}</h2><button type="button" disabled={busy} onClick={onClose} aria-label="Close"><X size={16} /></button></header>
      {publication ? <PublicationDetails
        publication={publication}
        name={project.name}
        justPublished={justPublished}
        onClose={onClose}
        onUpdate={() => {
          setEditing(true);
          setError(undefined);
        }}
      /> : <form onSubmit={(event) => void submit(event)}>
        <div className="publish-cover-field">
          <label htmlFor={coverInputId}>
            <span className="publish-cover-heading">Cover{pendingCover ? <span>Not applied</span> : coverMode ? <span>{coverMode === "custom" ? "Custom" : "Automatic"}</span> : null}</span>
            <span className="publish-cover-preview">
              {coverUrl ? <img src={coverUrl} alt="Game cover preview" /> : <span>{coverLoading ? <LoaderCircle className="spin" size={22} /> : <Image size={22} />}{coverLoading ? "Loading cover..." : "The preview is captured automatically"}</span>}
              <span className="publish-cover-action"><Upload size={14} />Replace cover</span>
            </span>
          </label>
          <input id={coverInputId} hidden type="file" accept="image/png,image/jpeg,image/webp" disabled={busy || coverLoading} onChange={(event) => {
            void selectCover(event.target.files?.[0]);
            event.target.value = "";
          }} />
          {pendingCover ? <div className="publish-cover-controls">
            <button type="button" disabled={busy} onClick={() => { setPendingCover(undefined); setError(undefined); setCoverNotice(undefined); }}>Cancel selection</button>
            <button className="project-create-submit" type="button" disabled={busy} onClick={() => void applyCover()}>{coverOperation === "apply" ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />}Apply cover</button>
          </div> : coverMode === "custom" ? <div className="publish-cover-controls">
            <button type="button" disabled={busy || coverLoading} onClick={() => void restoreCover()}><RefreshCw className={coverOperation === "restore" ? "spin" : undefined} size={14} />Restore automatic cover</button>
          </div> : null}
          <p className="publish-cover-status" role="status">{pendingCover ? "Apply or cancel the selected cover before publishing." : coverNotice ?? (coverMode === "custom" ? "Automatic replacement is off." : "The cover updates automatically with your project preview.")}</p>
          {project.publication ? <p className="publish-cover-status">This is your local project cover. Publish an update to change the Community cover.</p> : null}
        </div>
        <label><span>Name</span><input ref={titleInput} value={title} maxLength={200} disabled={busy} required onChange={(event) => setTitle(event.target.value)} /></label>
        <label><span>Description</span><textarea value={description} maxLength={2000} disabled={busy} rows={4} placeholder="Describe what makes this game worth playing" onChange={(event) => setDescription(event.target.value)} /></label>
        {localDebug ? <LocalPublishNotice /> : null}
        {error ? <p className="project-create-error" role="alert">{error}</p> : null}
        <footer><button type="button" disabled={busy} onClick={onClose}>Close</button><button className="project-create-submit" type="submit" aria-label={submitLabel} disabled={busy || coverLoading || Boolean(pendingCover) || !title.trim()}>{busy ? <LoaderCircle className="spin" size={14} /> : <Upload size={14} />}<span role={busy ? "status" : undefined}>{submitLabel}</span></button></footer>
      </form>}
    </section>
  </div>;
}

function useCoverUrl(cover: Blob | undefined): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    if (!cover) {
      setUrl(undefined);
      return;
    }
    const nextUrl = URL.createObjectURL(cover);
    setUrl(nextUrl);
    return () => URL.revokeObjectURL(nextUrl);
  }, [cover]);
  return url;
}

export function PublicationDetails({ publication, name, justPublished = false, onClose, onUpdate }: {
  publication: PublicationState;
  name: string;
  justPublished?: boolean;
  onClose: () => void;
  onUpdate: () => void;
}) {
  const linkId = useId();
  const [cover, setCover] = useState<Blob>();
  const coverUrl = useCoverUrl(cover);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  useEffect(() => { setCopied(false); setCopyError(false); }, [publication.playUrl]);

  useEffect(() => {
    let active = true;
    setCover(undefined);
    void getExploreGameCover(publication.gameId, publication.deploymentId)
      .then((value) => { if (active) setCover(value); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [publication.gameId, publication.deploymentId]);

  async function copyLink(): Promise<void> {
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(publication.playUrl);
      setCopied(true);
    } catch {
      setCopied(false);
      setCopyError(true);
    }
  }

  return <div className="publication-details">
    <div className="publication-summary">
      {coverUrl ? <img src={coverUrl} alt="Game cover" /> : <Check className="publication-check" size={22} />}
      <div>
        <h3>{publication.title ?? name}</h3>
        {justPublished ? <p role="status">Published successfully</p> : null}
        <time dateTime={publication.publishedAt} title="Last published"><RefreshCw size={12} aria-hidden="true" />{publicationTime(publication.publishedAt)}</time>
      </div>
    </div>
    {publication.gameId.startsWith("local-") ? <LocalPublishNotice /> : null}
    <div className="publication-link-field">
      <label htmlFor={linkId}>Game link</label>
      <div>
        <input id={linkId} readOnly value={publication.playUrl} onFocus={(event) => event.currentTarget.select()} />
        <button type="button" className="icon-button" onClick={() => void copyLink()} title={copied ? "Link copied" : "Copy game link"} aria-label="Copy game link">
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </button>
        <a className="icon-button" href={publication.playUrl} target="_blank" rel="noopener noreferrer" title="Open game" aria-label="Open game"><ExternalLink size={16} /></a>
      </div>
      <p className={`publication-copy-status${copyError ? " is-error" : ""}`} role={copyError ? "alert" : "status"}>{copyError ? "Could not copy the link." : copied ? "Link copied" : ""}</p>
    </div>
    <div className="publication-secondary-actions">
      <a href={gameHash(publication.gameId)} onClick={onClose}>View in Community</a>
      <button type="button" onClick={onUpdate}><Upload size={13} />Publish update</button>
    </div>
  </div>;
}

function LocalPublishNotice() {
  return <p className="publish-local-notice"><InfoCircle size={15} /><span>Local debug publish. This link only works on this computer until the local runtime stops or restarts.</span></p>;
}

function publicationTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(undefined, { dateStyle: "medium", timeStyle: "short" }).format(date) : "Unknown publication time";
}
