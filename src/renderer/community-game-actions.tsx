import { t } from "./i18n.js";
import { useEffect, useId, useRef, useState } from "react";
import type { CommunityGame, ProjectState } from "../shared/contracts.js";
import {
  listProjects,
  publishProject,
  unpublishCommunityGame,
  updateCommunityGame,
} from "./api.js";
import { useAuth } from "./auth.js";
import {
  CircleStop,
  FolderOpen,
  LoaderCircle,
  MoreHorizontal,
  Pencil,
  Upload,
  X,
} from "./icons.js";
import { PublishDialog } from "./publish-dialog.js";
import { communityProfileHash, projectHash } from "./routes.js";
import { DropdownMenu, IconButton, type MenuEntry } from "./ui/index.js";

/** Mounted only for the signed-in author; the local project lookup waits until
 * the menu or the editor opens. */
export function CommunityGameActions({
  game,
  accessToken,
  onChange,
  onUnpublished,
}: {
  game: CommunityGame;
  accessToken?: string;
  onChange: (change: Partial<CommunityGame>) => void;
  onUnpublished: () => void;
}) {
  const auth = useAuth();
  const [menuOpened, setMenuOpened] = useState(false);
  const [editing, setEditing] = useState(false);
  const [project, setProject] = useState<ProjectState>();
  const [confirming, setConfirming] = useState(false);
  const [unpublishing, setUnpublishing] = useState(false);
  const [error, setError] = useState<string>();
  const [publishingProject, setPublishingProject] = useState<ProjectState>();
  const [publishing, setPublishing] = useState(false);
  const [justPublished, setJustPublished] = useState(false);
  const moreButton = useRef<HTMLButtonElement | null>(null);
  const mounted = useRef(false);
  const lookUpProject = menuOpened || editing;
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  useEffect(() => {
    if (!lookUpProject) return;
    let active = true;
    void listProjects()
      .catch(() => [])
      .then((projects) => {
        if (active)
          setProject(
            projects.find((project) => project.publication?.gameId === game.id),
          );
      });
    return () => {
      active = false;
    };
  }, [lookUpProject, game.id]);

  async function unpublish() {
    if (unpublishing) return;
    setUnpublishing(true);
    setError(undefined);
    try {
      const token = await auth.requestAccessToken();
      if (!mounted.current) return;
      if (!token) throw new Error(t("community.manageSignIn"));
      await unpublishCommunityGame(game.id, token);
      if (mounted.current) onUnpublished();
    } catch (cause) {
      if (mounted.current)
        setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      if (mounted.current) setUnpublishing(false);
    }
  }

  const items: MenuEntry[] = [
    {
      label: t("community.editGame"),
      icon: <Pencil size={14} />,
      onSelect: () => setEditing(true),
    },
    ...(project
      ? [
          {
            label: t("community.openProject"),
            icon: <FolderOpen size={14} />,
            onSelect: () => {
              window.location.hash = projectHash(project.id);
            },
          },
        ]
      : []),
    "separator",
    {
      label: t("community.unpublish"),
      icon: <CircleStop size={14} />,
      danger: true,
      onSelect: () => {
        setError(undefined);
        setConfirming(true);
      },
    },
  ];

  return (
    <>
      <DropdownMenu
        placement="bottom-end"
        items={items}
        trigger={({ ref, onClick, ...props }) => (
          <IconButton
            {...props}
            ref={(node) => {
              ref.current = node;
              moreButton.current = node;
            }}
            label={t("community.moreActions")}
            onClick={() => {
              setMenuOpened(true);
              onClick();
            }}
          >
            <MoreHorizontal size={16} />
          </IconButton>
        )}
      />
      {confirming ? (
        <UnpublishConfirmation
          game={game}
          busy={unpublishing}
          error={error}
          returnFocus={moreButton.current}
          onCancel={() => setConfirming(false)}
          onConfirm={() => void unpublish()}
        />
      ) : null}
      {editing ? (
        <CommunityGameEditor
          game={game}
          project={project}
          onClose={() => setEditing(false)}
          onSave={async (metadata) => {
            const token = await auth.requestAccessToken();
            if (!token || !mounted.current) return false;
            const saved = await updateCommunityGame(game.id, token, metadata);
            if (!mounted.current) return false;
            onChange(saved);
            setEditing(false);
            return true;
          }}
          onPublish={
            project
              ? (metadata) => {
                  setJustPublished(false);
                  setPublishingProject({
                    ...project,
                    publication: {
                      ...project.publication!,
                      ...metadata,
                    },
                  });
                  setEditing(false);
                }
              : undefined
          }
        />
      ) : null}
      {publishingProject ? (
        <PublishDialog
          project={publishingProject}
          publishing={publishing}
          initialEditing
          coverAccessToken={accessToken}
          profileUrl={communityProfileHash(game.author.id)}
          justPublished={justPublished}
          onClose={() => {
            if (!publishing) setPublishingProject(undefined);
          }}
          onPublish={async (metadata) => {
            setPublishing(true);
            try {
              const token = await auth.requestAccessToken();
              if (!token || !mounted.current) return false;
              const result = await publishProject(
                publishingProject.id,
                token,
                metadata,
              );
              if (!mounted.current) return false;
              setPublishingProject((previous) =>
                previous
                  ? {
                      ...previous,
                      publication: {
                        gameId: result.game.id,
                        deploymentId: result.deployment.id,
                        playUrl: result.game.playUrl,
                        publishedAt: result.deployment.publishedAt,
                        title: result.game.title,
                        description: result.game.description,
                      },
                    }
                  : previous,
              );
              onChange({
                title: result.game.title,
                description: result.game.description,
                playUrl: result.game.playUrl,
                deploymentId: result.deployment.id,
                coverUrl: result.deployment.coverUrl,
              });
              setJustPublished(true);
              return true;
            } finally {
              if (mounted.current) setPublishing(false);
            }
          }}
        />
      ) : null}
    </>
  );
}

function UnpublishConfirmation({
  game,
  busy,
  error,
  returnFocus,
  onCancel,
  onConfirm,
}: {
  game: CommunityGame;
  busy: boolean;
  error?: string;
  returnFocus: HTMLElement | null;
  onCancel: () => void;
  onConfirm: () => void;
}) {
  const id = useId();
  const dialog = useRef<HTMLDialogElement>(null);
  useEffect(() => {
    const element = dialog.current!;
    element.showModal();
    return () => {
      element.close();
      returnFocus?.focus();
    };
  }, []);
  return (
    <dialog
      ref={dialog}
      className="community-edit-dialog community-unpublish-dialog"
      role="alertdialog"
      aria-labelledby={id}
      aria-describedby={`${id}-description`}
      aria-busy={busy}
      onCancel={(event) => {
        event.preventDefault();
        if (!busy) onCancel();
      }}
    >
      <header>
        <h2 id={id}>{t("community.unpublishTitle", { title: game.title })}</h2>
      </header>
      <p id={`${id}-description`}>{t("community.unpublishDescription")}</p>
      {error ? <p role="alert">{error}</p> : null}
      <footer>
        <button
          type="button"
          aria-label={t("community.cancelUnpublish")}
          autoFocus
          disabled={busy}
          onClick={onCancel}
        >
          {t("common.cancel")}
        </button>
        <button
          type="button"
          className="project-create-submit"
          aria-label={t("community.confirmUnpublish")}
          disabled={busy}
          onClick={onConfirm}
        >
          {busy ? <LoaderCircle size={14} className="spin" /> : null}{" "}
          {t("community.unpublish")}
        </button>
      </footer>
    </dialog>
  );
}

function CommunityGameEditor({
  game,
  project,
  onClose,
  onSave,
  onPublish,
}: {
  game: CommunityGame;
  project?: ProjectState;
  onClose: () => void;
  onSave: (metadata: {
    title: string;
    description: string;
  }) => Promise<boolean>;
  onPublish?: (metadata: Pick<CommunityGame, "title" | "description">) => void;
}) {
  const id = useId();
  const dialog = useRef<HTMLElement>(null);
  const titleInput = useRef<HTMLInputElement>(null);
  const [title, setTitle] = useState(game.title);
  const [description, setDescription] = useState(game.description);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    const focus =
      document.activeElement instanceof HTMLElement
        ? document.activeElement
        : undefined;
    titleInput.current?.focus();
    return () => {
      focus?.focus();
    };
  }, []);
  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const dialogs = document.querySelectorAll(
        '[role="dialog"][aria-modal="true"]',
      );
      if (dialogs[dialogs.length - 1] !== dialog.current) return;
      if (event.key === "Escape" && !busy) {
        event.preventDefault();
        onClose();
      }
      if (event.key !== "Tab" || !dialog.current) return;
      const controls = [
        ...dialog.current.querySelectorAll<HTMLElement>(
          "button:not(:disabled), a[href], input:not(:disabled), textarea:not(:disabled)",
        ),
      ];
      const first = controls[0];
      const last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [busy, onClose]);
  return (
    <div
      className="project-create-backdrop"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        ref={dialog}
        className="community-edit-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={id}
        aria-busy={busy}
      >
        <header>
          <h2 id={id}>{t("community.editGame")}</h2>
          <button
            type="button"
            onClick={onClose}
            disabled={busy}
            aria-label={t("common.close")}
          >
            <X size={16} />
          </button>
        </header>
        <form
          onSubmit={async (event) => {
            event.preventDefault();
            if (busy || !title.trim()) return;
            setBusy(true);
            setError(undefined);
            try {
              if (
                !(await onSave({
                  title: title.trim(),
                  description: description.trim(),
                }))
              )
                setError(t("community.saveFailed"));
            } catch (cause) {
              setError(cause instanceof Error ? cause.message : String(cause));
            } finally {
              setBusy(false);
            }
          }}
        >
          <label>
            <span>{t("common.name")}</span>
            <input
              ref={titleInput}
              value={title}
              required
              maxLength={200}
              disabled={busy}
              onChange={(event) => setTitle(event.target.value)}
            />
          </label>
          <label>
            <span>{t("publish.description")}</span>
            <textarea
              value={description}
              rows={4}
              maxLength={2000}
              disabled={busy}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <div className="community-editor-links">
            {project ? (
              <a href={projectHash(project.id)} onClick={onClose}>
                <Pencil size={14} />
                {t("community.openProject")}
              </a>
            ) : null}
            {onPublish ? (
              <button
                type="button"
                onClick={() =>
                  onPublish({
                    title: title.trim(),
                    description: description.trim(),
                  })
                }
                disabled={busy || !title.trim()}
              >
                <Upload size={14} />
                {t("publish.update")}
              </button>
            ) : null}
          </div>
          {!project ? (
            <p className="community-profile-note">
              {t("community.updateFromProject")}
            </p>
          ) : null}
          {error ? (
            <p className="project-create-error" role="alert">
              {error}
            </p>
          ) : null}
          <footer>
            <button type="button" onClick={onClose} disabled={busy}>
              {t("common.cancel")}
            </button>
            <button
              className="project-create-submit"
              type="submit"
              disabled={busy || !title.trim()}
            >
              {busy ? <LoaderCircle size={14} className="spin" /> : null}
              {busy ? t("common.saving") : t("common.saveChanges")}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
