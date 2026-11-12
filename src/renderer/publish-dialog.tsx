import { useEffect, useId, useRef, useState, type FormEvent } from "react";
import type { ProjectCoverMode, ProjectState, PublicationState } from "../shared/contracts.js";
import { ApiError, communityGameNameAvailability, getExploreGameCover, getProjectCover, getProjectCoverState, setCommunityGameName, setProjectCoverMode, setProjectCover } from "./api.js";
import { GAME_NAME_MAX_LENGTH, GAME_NAME_PATTERN, gameShareUrl, normalizeGameName, readableUrl, withRename, type GameNameAvailability, type GameRename } from "../shared/publish-v1.js";
import { imageToWebP } from "./image.js";
import { Check, Copy, ExternalLink, Image, InfoCircle, LoaderCircle, Pencil, RefreshCw, Upload, X } from "./icons.js";
import { Button, Field, IconButton, Input, Switch, Textarea } from "./ui/index.js";
import { localDebug, useOptionalAuth } from "./auth.js";
import { gameHash } from "./routes.js";
import { language, t } from "./i18n.js";

export interface PublishDetails {
  title: string;
  description: string;
}

export function PublishDialog({ project, publishing, justPublished = false, initialEditing = false, coverAccessToken, profileUrl, onClose, onPublish, onRenamed }: {
  project: ProjectState;
  publishing: boolean;
  onClose: () => void;
  /** The game's page got a new name. It may arrive after other changes, so it is merged, not set. */
  onRenamed?: (renamed: GameRename) => void;
  justPublished?: boolean;
  initialEditing?: boolean;
  coverAccessToken?: string;
  profileUrl?: string;
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
  const [coverOperation, setCoverOperation] = useState<"process" | "apply" | "mode">();
  const [coverNotice, setCoverNotice] = useState<string>();
  const [error, setError] = useState<string>();
  const [submitting, setSubmitting] = useState(false);
  const [editing, setEditing] = useState(!project.publication || initialEditing);
  const publication = editing ? undefined : project.publication;
  const busy = publishing || submitting || Boolean(coverOperation);
  const submitLabel = coverOperation === "process" ? t("publish.processingCover") : coverOperation ? t("publish.savingCover") : busy ? t("publish.publishing") : project.publication ? t("publish.update") : t("publish.publish");

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
      setCoverNotice(t("publish.coverApplied"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCoverOperation(undefined);
    }
  }

  async function toggleAutomaticCover(): Promise<void> {
    if (busy || coverLoading || pendingCover || !coverMode) return;
    const nextMode = coverMode === "auto" ? "custom" : "auto";
    setCoverOperation("mode");
    setError(undefined);
    setCoverNotice(undefined);
    try {
      await setProjectCoverMode(project.id, nextMode);
      setCoverMode(nextMode);
      setSavedCover(await getProjectCover(project.id));
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
      setError(t("publish.applyCover"));
      return;
    }
    setError(undefined);
    setSubmitting(true);
    try {
      if (await onPublish({ title: normalizedTitle, description: description.trim() })) {
        setEditing(false);
      } else setError(t("publish.failed"));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSubmitting(false);
    }
  }

  return <div className="ui-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget && !busy) onClose(); }}>
    <section ref={dialog} className="ui-dialog ui-dialog-md publish-dialog" role="dialog" aria-modal="true" aria-busy={busy} aria-labelledby={titleId} tabIndex={-1}>
      <div className="ui-dialog-head">
        <h2 id={titleId} className="ui-dialog-title">{publication ? justPublished ? t("publish.gamePublished") : t("publish.publishedGame") : project.publication ? t("publish.update") : t("publish.publishGame")}</h2>
        <IconButton size="sm" label={t("common.close")} className="ui-dialog-close" disabled={busy} onClick={onClose}><X size={16} /></IconButton>
      </div>
      {publication ? <div className="ui-dialog-body"><PublicationDetails
        publication={publication}
        coverAccessToken={coverAccessToken}
        profileUrl={profileUrl}
        name={project.name}
        justPublished={justPublished}
        onClose={onClose}
        onRenamed={onRenamed}
        onUpdate={() => {
          setEditing(true);
          setError(undefined);
        }}
      /></div> : <form className="publish-form" onSubmit={(event) => void submit(event)}>
        <div className="ui-dialog-body">
          <div className="publish-cover-field">
            <div className="publish-cover-heading">
              <span className="publish-cover-label">{t("publish.cover")}{pendingCover ? <span>{t("publish.notApplied")}</span> : null}</span>
              <span className="publish-cover-automatic" title={t("publish.automaticTitle")}>
                {t("publish.automatic")}<Switch size="sm" label={t("publish.automaticLabel")} checked={coverMode === "auto"} disabled={busy || coverLoading || Boolean(pendingCover) || !coverMode} onChange={() => void toggleAutomaticCover()} />
              </span>
            </div>
            <label htmlFor={coverInputId} className="publish-cover-preview">
              {coverUrl ? <img src={coverUrl} alt={t("publish.coverPreview")} /> : <span className="publish-cover-empty">{coverLoading ? <LoaderCircle className="spin" size={20} /> : <Image size={20} />}{coverLoading ? t("publish.loadingCover") : coverMode === "custom" ? t("publish.noCover") : t("publish.autoCaptured")}</span>}
              <span className="publish-cover-action"><Upload size={14} />{t("publish.replaceCover")}</span>
            </label>
            <input id={coverInputId} hidden type="file" accept="image/png,image/jpeg,image/webp" disabled={busy || coverLoading} onChange={(event) => {
              void selectCover(event.target.files?.[0]);
              event.target.value = "";
            }} />
            {pendingCover ? <div className="publish-cover-controls">
              <Button size="sm" variant="ghost" disabled={busy} onClick={() => { setPendingCover(undefined); setError(undefined); setCoverNotice(undefined); }}>{t("publish.cancelSelection")}</Button>
              <Button size="sm" variant="primary" disabled={busy} icon={coverOperation === "apply" ? <LoaderCircle className="spin" size={14} /> : <Check size={14} />} onClick={() => void applyCover()}>{t("publish.applyCoverButton")}</Button>
            </div> : null}
            <p className={`publish-cover-status${pendingCover || coverNotice ? "" : " visually-hidden"}`} role="status">{pendingCover ? t("publish.applyCover") : coverNotice}</p>
            {project.publication ? <p className="publish-cover-status">{t("publish.localCover")}</p> : null}
          </div>
          <Field label={t("common.name")}>{(props) => <Input {...props} ref={titleInput} value={title} maxLength={200} disabled={busy} required onChange={(event) => setTitle(event.target.value)} />}</Field>
          <Field label={t("publish.description")}>{(props) => <Textarea {...props} value={description} maxLength={2000} disabled={busy} rows={4} placeholder={t("publish.descriptionPlaceholder")} onChange={(event) => setDescription(event.target.value)} />}</Field>
          {localDebug ? <LocalPublishNotice /> : null}
          {error ? <p className="publish-error" role="alert">{error}</p> : null}
        </div>
        <div className="ui-dialog-footer">
          <Button disabled={busy} onClick={onClose}>{t("common.close")}</Button>
          <Button variant="primary" type="submit" aria-label={submitLabel} disabled={busy || coverLoading || Boolean(pendingCover) || !title.trim()} icon={busy ? <LoaderCircle className="spin" size={14} /> : <Upload size={14} />}><span role={busy ? "status" : undefined}>{submitLabel}</span></Button>
        </div>
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

export function PublicationDetails({ publication: initialPublication, name, justPublished = false, coverAccessToken, profileUrl, onClose, onUpdate, onRenamed }: {
  publication: PublicationState;
  name: string;
  justPublished?: boolean;
  coverAccessToken?: string;
  profileUrl?: string;
  onClose: () => void;
  onUpdate: () => void;
  onRenamed?: (renamed: GameRename) => void;
}) {
  const linkId = useId();
  const auth = useOptionalAuth();
  const [publication, setPublication] = useState(initialPublication);
  useEffect(() => setPublication(initialPublication), [initialPublication]);
  const [renaming, setRenaming] = useState(false);
  const [cover, setCover] = useState<Blob>();
  const coverUrl = useCoverUrl(cover);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  const shareUrl = gameShareUrl(publication);
  useEffect(() => { setCopied(false); setCopyError(false); }, [shareUrl]);
  // Only games on OhMyGame Cloud have a page whose name can change.
  const canRename = Boolean(auth && publication.name && publication.pageUrl && !publication.gameId.startsWith("local-"));

  useEffect(() => {
    let active = true;
    setCover(undefined);
    void getExploreGameCover(publication.gameId, publication.deploymentId, coverAccessToken)
      .then((value) => { if (active) setCover(value); })
      .catch(() => undefined);
    return () => { active = false; };
  }, [publication.gameId, publication.deploymentId, coverAccessToken]);

  async function copyLink(): Promise<void> {
    setCopyError(false);
    try {
      await navigator.clipboard.writeText(shareUrl);
      setCopied(true);
    } catch {
      setCopied(false);
      setCopyError(true);
    }
  }

  return <div className="publication-details">
    <div className="publication-summary">
      {coverUrl ? <img src={coverUrl} alt={t("publish.gameCover")} /> : <Check className="publication-check" size={22} />}
      <div>
        <h3>{publication.title ?? name}</h3>
        {justPublished ? <p role="status">{t("publish.success")}</p> : null}
        <time dateTime={publication.publishedAt} title={t("publish.lastPublished")}><RefreshCw size={12} aria-hidden="true" />{publicationTime(publication.publishedAt)}</time>
      </div>
    </div>
    {publication.gameId.startsWith("local-") ? <LocalPublishNotice /> : null}
    {renaming && auth ? <GameNameField
      publication={publication}
      signedIn={auth.state.status === "signed-in"}
      requestAccessToken={auth.requestAccessToken}
      onCancel={() => setRenaming(false)}
      onRenamed={(renamed) => {
        setPublication((current) => withRename(current, renamed));
        setRenaming(false);
        onRenamed?.(renamed);
      }}
    /> : <div className="publication-link-field">
      <label htmlFor={linkId}>{t("community.link")}</label>
      <div>
        <Input id={linkId} readOnly value={readableUrl(shareUrl)} onFocus={(event) => event.currentTarget.select()} />
        {canRename ? <IconButton label={t("publish.changeName")} title={t("publish.changeName")} onClick={() => setRenaming(true)}><Pencil size={16} /></IconButton> : null}
        <IconButton label={t("publish.copyLink")} title={copied ? t("publish.linkCopied") : t("publish.copyLink")} onClick={() => void copyLink()}>
          {copied ? <Check size={16} /> : <Copy size={16} />}
        </IconButton>
        <a className="ui-icon-button ui-icon-button-md" href={shareUrl} target="_blank" rel="noopener noreferrer" title={t("publish.openGame")} aria-label={t("publish.openGame")}><ExternalLink size={16} /></a>
      </div>
      <p className={`publication-copy-status${copyError ? " is-error" : ""}`} role={copyError ? "alert" : "status"}>{copyError ? t("publish.copyFailed") : copied ? t("publish.linkCopied") : ""}</p>
    </div>}
    <div className="publication-secondary-actions">
      <a href={profileUrl ?? gameHash(publication.gameId)} onClick={onClose}>{profileUrl ? t("community.viewOnProfile") : t("publish.viewInCommunity")}</a>
      <Button size="sm" icon={<Upload size={14} />} onClick={onUpdate}>{t("publish.update")}</Button>
    </div>
  </div>;
}

/** What the Cloud said of a name: free, or why it isn't. */
type NameCheck = { name: string; status: "checking" | "available" | "error" | NonNullable<GameNameAvailability["reason"]> };

/** Edits the name at the end of the game's page address. The address before keeps leading to it. */
function GameNameField({ publication, signedIn, requestAccessToken, onCancel, onRenamed }: {
  publication: PublicationState;
  signedIn: boolean;
  requestAccessToken: () => Promise<string | undefined>;
  onCancel: () => void;
  onRenamed: (renamed: GameRename) => void;
}) {
  const inputId = useId();
  const statusId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [draft, setDraft] = useState(publication.name ?? "");
  const [check, setCheck] = useState<NameCheck>();
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string>();
  const name = normalizeGameName(draft);
  const unchanged = name === publication.name;
  const valid = GAME_NAME_PATTERN.test(name);

  useEffect(() => input.current?.select(), []);
  // The token callback changes with each sign-in; the check below shouldn't restart for that.
  const tokenRequest = useRef(requestAccessToken);
  tokenRequest.current = requestAccessToken;

  // Asks the Cloud once typing pauses; the answer is only advice, as saving checks again.
  // Signed out, it waits: asking for a token would open sign-in, and take over Save's.
  useEffect(() => {
    if (unchanged || !valid || !signedIn) {
      setCheck(undefined);
      return;
    }
    let active = true;
    setCheck({ name, status: "checking" });
    const timer = setTimeout(() => {
      void tokenRequest.current().then(async (token) => {
        if (!token) return;
        const answer = await communityGameNameAvailability(name, publication.gameId, token);
        if (!active) return;
        setCheck({ name, status: answer.available ? "available" : answer.reason ?? "taken" });
      }).catch(() => {
        if (active) setCheck({ name, status: "error" });
      });
    }, 400);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [name, unchanged, valid, signedIn, publication.gameId]);

  async function save(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (unchanged) return onCancel();
    setSaving(true);
    setError(undefined);
    try {
      const token = await requestAccessToken();
      if (!token) return;
      const result = await setCommunityGameName(publication.gameId, token, name);
      onRenamed({ gameId: publication.gameId, ...result });
    } catch (cause) {
      setError(nameErrorMessage(cause));
    } finally {
      setSaving(false);
    }
  }

  const status = error ? { text: error, error: true }
    : draft && !valid ? { text: t("publish.nameRules"), error: true }
    : check?.name !== name ? { text: t("publish.nameHint"), error: false }
    : check.status === "checking" ? { text: t("publish.nameChecking"), error: false }
    : check.status === "available" ? { text: t("publish.nameAvailable"), error: false }
    : check.status === "error" ? { text: t("publish.nameCheckFailed"), error: true }
    : { text: check.status === "reserved" ? t("publish.nameReserved") : check.status === "invalid" ? t("publish.nameRules") : t("publish.nameTaken"), error: true };
  const blocked = !valid || check?.name === name && ["invalid", "reserved", "taken"].includes(check.status);

  return <form className="publication-link-field" onSubmit={(event) => void save(event)}>
    <label htmlFor={inputId}>{t("publish.pageName")}</label>
    <div>
      <Input
        id={inputId}
        ref={input}
        prefix={readableUrl(publication.pageUrl!).slice(0, -publication.name!.length)}
        value={draft}
        maxLength={GAME_NAME_MAX_LENGTH}
        autoComplete="off"
        spellCheck={false}
        disabled={saving}
        aria-describedby={statusId}
        aria-invalid={status.error || undefined}
        onChange={(event) => {
          setDraft(event.target.value);
          setError(undefined);
        }}
        onKeyDown={(event) => {
          if (event.key !== "Escape") return;
          event.preventDefault();
          event.stopPropagation();
          onCancel();
        }}
      />
      <IconButton label={t("common.cancel")} title={t("common.cancel")} disabled={saving} onClick={onCancel}><X size={16} /></IconButton>
      <IconButton type="submit" label={t("publish.saveName")} title={t("publish.saveName")} disabled={saving || blocked}>
        {saving ? <LoaderCircle className="spin" size={16} /> : <Check size={16} />}
      </IconButton>
    </div>
    <p id={statusId} className={`publication-copy-status${status.error ? " is-error" : ""}`} role={status.error ? "alert" : "status"}>{status.text}</p>
  </form>;
}

function nameErrorMessage(cause: unknown): string {
  const code = cause instanceof ApiError ? cause.code : undefined;
  if (code === "name_taken") return t("publish.nameTaken");
  if (code === "name_reserved") return t("publish.nameReserved");
  if (code === "name_invalid") return t("publish.nameRules");
  return cause instanceof Error ? cause.message : String(cause);
}

function LocalPublishNotice() {
  return <p className="publish-local-notice"><InfoCircle size={15} /><span>{t("publish.localDebug")}</span></p>;
}

function publicationTime(value: string): string {
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat(language, { dateStyle: "medium", timeStyle: "short" }).format(date) : t("publish.unknownTime");
}
