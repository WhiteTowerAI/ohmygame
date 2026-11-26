import { useEffect, useLayoutEffect, useState } from "react";
import type {
  PluginMention,
  ProjectState,
  PromptAttachment,
  PromptImage,
  PromptMode,
  ProjectType,
} from "../shared/contracts.js";
import { FilePlus, FolderOpen, Plug } from "./icons.js";
import {
  pickProjectFolder,
  ProjectCreateDialog,
  type FirstMessage,
} from "./project-create-dialog.js";
import { ProjectPromptCreator } from "./project-prompt-creator.js";
import {
  isAppProjectType,
  ProjectTypeIcon,
  projectTypeDescription,
} from "./project-types.js";
import {
  projectTypeChoiceLabel,
  usePluginProjectTypes,
} from "./project-type-choices.js";
import { readProjectTypeCover, type AvailableProjectType } from "./api.js";
import { createdProjectView, settingsHash } from "./routes.js";
import { PLUGIN_TYPE_IMAGE, TYPE_IMAGES } from "./project-type-images.js";
import { PluginGlyph } from "./plugin-icons.js";
import { Button, Dialog } from "./ui/index.js";
import { t } from "./i18n.js";
import "./new-game.css";

// Every way to start a game opens one dialog: Home's type cards, its
// 直接描述, ⌘N, the command menu and the project rail's +. The dialog keeps
// Home's prompt (one draft), so switching types or closing loses nothing.

/** The order types are offered in; plugins' types follow. */
export const NEW_GAME_TYPES = [
  "web-game",
  "godot-game",
  "general",
  "asset-canvas",
] as const satisfies readonly ProjectType[];

const OPEN_EVENT = "ohmygame:new-game";
const TYPE_KEY = "ohmygame.home.projectType";

export interface NewGameRequest {
  /** The type to start with: an app type or a plugin's `publisher/name:type`. */
  type?: string;
  /** The card it was opened from, so the dialog grows out of it. */
  from?: Element | null;
  /** Skip the prompt: a blank project, or a folder to open or import. */
  start?: "blank" | "import";
}

/** Opens the new game dialog wherever the app is. */
export function openNewGame(request: NewGameRequest = {}): void {
  const from = request.from?.getBoundingClientRect();
  window.dispatchEvent(
    new CustomEvent<OpenDetail>(OPEN_EVENT, {
      detail: { type: request.type, from, start: request.start },
    }),
  );
}

function rememberedType(): string {
  try {
    const saved = localStorage.getItem(TYPE_KEY);
    // Remove with the local Interactive Story project migration after its compatibility window.
    return saved === "interactive-story"
      ? "web-game"
      : (saved ?? NEW_GAME_TYPES[0]);
  } catch {
    return NEW_GAME_TYPES[0];
  }
}

interface OpenDetail {
  type?: string;
  from?: DOMRect;
  start?: "blank" | "import";
}

/** What the project dialog opens with once the person has said what to make. */
interface CreateRequest {
  firstMessage?: FirstMessage;
  clearDraft?: () => void;
  workspacePath?: string;
  type?: string;
}

export function NewGameHost({
  onCreate,
  onOpen,
}: {
  onCreate: (
    project: ProjectState,
    conversationId: string,
    prompt: string,
    mentions: PluginMention[],
    images: PromptImage[],
    mode: PromptMode,
    attachments?: PromptAttachment[],
  ) => void;
  onOpen: (projectId: string, view?: "design") => void;
}) {
  const [open, setOpen] = useState<{ type: string; from?: DOMRect }>();
  const [creating, setCreating] = useState<CreateRequest>();
  const [error, setError] = useState<string>();

  useEffect(() => {
    const onOpenRequest = (event: Event) => {
      const detail = (event as CustomEvent<OpenDetail>).detail ?? {};
      setError(undefined);
      if (detail.start === "blank") setCreating({ type: detail.type });
      else if (detail.start === "import") void importFolder();
      else
        setOpen({ type: detail.type ?? rememberedType(), from: detail.from });
    };
    window.addEventListener(OPEN_EVENT, onOpenRequest);
    return () => window.removeEventListener(OPEN_EVENT, onOpenRequest);
  }, []);

  // An existing folder opens its project if it has one, or becomes a new project's workspace.
  async function importFolder(): Promise<void> {
    setError(undefined);
    try {
      const picked = await pickProjectFolder();
      if (!picked) return;
      setOpen(undefined);
      if ("owner" in picked) onOpen(picked.owner.id);
      else setCreating({ workspacePath: picked.path });
    } catch (cause) {
      setOpen((current) => current ?? { type: NEW_GAME_TYPES[0] });
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  function chooseType(type: string): void {
    try {
      localStorage.setItem(TYPE_KEY, type);
    } catch {
      /* The choice still applies to this dialog. */
    }
    setOpen((current) => current && { ...current, type });
  }

  return (
    <>
      {open ? (
        <NewGameDialog
          type={open.type}
          from={open.from}
          sending={!!creating?.firstMessage}
          error={error}
          onType={chooseType}
          onClose={() => setOpen(undefined)}
          onSubmit={(firstMessage, clearDraft) =>
            setCreating({ firstMessage, clearDraft })
          }
          onBlank={(type) => setCreating({ type })}
          onImport={() => void importFolder()}
        />
      ) : null}
      {/* The project dialog shows only for what needs the person when a prompt starts it. */}
      {creating ? (
        <ProjectCreateDialog
          firstMessage={creating.firstMessage}
          direct={!!creating.firstMessage}
          initialType={creating.type}
          initialWorkspacePath={creating.workspacePath}
          onClose={() => setCreating(undefined)}
          onOpenProject={(projectId) => {
            setCreating(undefined);
            setOpen(undefined);
            onOpen(projectId);
          }}
          onCreated={(project, start) => {
            setCreating(undefined);
            setOpen(undefined);
            if (start) {
              creating.clearDraft?.();
              onCreate(
                project,
                start.conversationId,
                start.prompt,
                start.mentions,
                [],
                start.mode,
                start.attachments,
              );
            } else onOpen(project.id, createdProjectView(project.type));
          }}
        />
      ) : null}
    </>
  );
}

function NewGameDialog({
  type,
  from,
  sending,
  error,
  onType,
  onClose,
  onSubmit,
  onBlank,
  onImport,
}: {
  type: string;
  from?: DOMRect;
  sending: boolean;
  error?: string;
  onType: (type: string) => void;
  onClose: () => void;
  onSubmit: (message: FirstMessage, clearDraft: () => void) => void;
  onBlank: (type: string) => void;
  onImport: () => void;
}) {
  const { types, failed, retry } = usePluginProjectTypes();
  const pluginTypes = types ?? [];
  const needsType =
    !isAppProjectType(type) &&
    !pluginTypes.some((option) => option.id === type);
  const canImport = !!window.ohMyGameDesktop?.selectProjectDirectory;
  const name = projectTypeChoiceLabel(type, pluginTypes);
  useGrowFrom(from);
  return (
    <Dialog
      open
      size="lg"
      className="new-game-dialog"
      onClose={onClose}
      title={name}
      description={typeHint(type, pluginTypes)}
      media={<TypeArt type={type} pluginTypes={pluginTypes} />}
      footer={
        <>
          <Button
            variant="ghost"
            size="sm"
            icon={<FilePlus size="sm" />}
            disabled={sending || needsType}
            onClick={() => onBlank(type)}
          >
            {t("home.startBlank")}
          </Button>
          {canImport ? (
            <Button
              variant="ghost"
              size="sm"
              icon={<FolderOpen size="sm" />}
              disabled={sending}
              onClick={onImport}
            >
              {t("home.importFolder")}
            </Button>
          ) : null}
        </>
      }
    >
      <div
        className="new-game-types"
        role="radiogroup"
        aria-label={t("newGame.types")}
      >
        {[...NEW_GAME_TYPES, ...pluginTypes.map((option) => option.id)].map(
          (value) => (
            <button
              key={value}
              type="button"
              role="radio"
              aria-checked={value === type}
              className="new-game-type"
              disabled={sending}
              onClick={() => onType(value)}
            >
              <TypeGlyph type={value} pluginTypes={pluginTypes} />
              <span>{projectTypeChoiceLabel(value, pluginTypes)}</span>
            </button>
          ),
        )}
      </div>
      <ProjectPromptCreator
        draftKey="home"
        typePending={needsType}
        type={type}
        autoFocus
        placeholder={typePlaceholder(type)}
        disabled={sending}
        onConnectModel={() => {
          onClose();
          window.location.hash = settingsHash("providers");
        }}
        onSubmit={onSubmit}
      />
      {needsType && types ? (
        <p className="home-notice" role="alert">
          {t("newGame.unavailableType")}
        </p>
      ) : null}
      {failed ? (
        <p className="home-notice" role="alert">
          {t("createDialog.pluginsFailed")}{" "}
          <Button size="sm" variant="ghost" onClick={retry}>
            {t("common.retry")}
          </Button>
        </p>
      ) : null}
      {error ? (
        <p className="home-notice" role="alert">
          {error}
        </p>
      ) : null}
    </Dialog>
  );
}

/** The dialog grows out of the card it was opened from; with reduced motion it only fades in. */
function useGrowFrom(from?: DOMRect): void {
  useLayoutEffect(() => {
    const panel = document.querySelector<HTMLElement>(".new-game-dialog");
    if (!panel || !from || typeof panel.animate !== "function") return;
    if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return;
    const to = panel.getBoundingClientRect();
    if (!to.width || !to.height) return;
    const dx = from.left + from.width / 2 - (to.left + to.width / 2);
    const dy = from.top + from.height / 2 - (to.top + to.height / 2);
    panel.animate(
      [
        {
          transform: `translate(${dx}px, ${dy}px) scale(${from.width / to.width}, ${from.height / to.height})`,
          opacity: 0.4,
        },
        { transform: "none", opacity: 1 },
      ],
      { duration: 200, easing: "cubic-bezier(0.2, 0, 0, 1)" },
    );
  }, []);
}

/** A type's card on Home: its words on the left, its picture dissolving in on the right; it opens the dialog on that type. */
export function NewGameCard({
  type,
  pluginTypes,
}: {
  type: string;
  pluginTypes: readonly AvailableProjectType[];
}) {
  return (
    <button
      type="button"
      className="new-game-card"
      onClick={(event) => openNewGame({ type, from: event.currentTarget })}
    >
      <TypeArt type={type} pluginTypes={pluginTypes} />
      <span className="new-game-card-copy">
        <TypeGlyph type={type} pluginTypes={pluginTypes} />
        <span className="new-game-card-name">
          {projectTypeChoiceLabel(type, pluginTypes)}
        </span>
        <span className="new-game-card-hint">
          {typeHint(type, pluginTypes)}
        </span>
      </span>
    </button>
  );
}

/**
 * A type's picture: the app's types have their own (project-type-images.ts),
 * a plugin's type shows the cover it gives, and one without gets the
 * picture for plugin types. Nothing shows while a cover loads, so it doesn't
 * swap pictures in front of the person.
 */
function TypeArt({
  type,
  pluginTypes,
}: {
  type: string;
  pluginTypes: readonly AvailableProjectType[];
}) {
  const option = pluginTypes.find((item) => item.id === type);
  const cover = useProjectTypeCover(
    option?.cover ? type : undefined,
    option?.plugin?.revision,
  );
  const src = TYPE_IMAGES[type] ?? (option?.cover ? cover : PLUGIN_TYPE_IMAGE);
  return (
    <span className="new-game-art" aria-hidden="true">
      {src ? <img src={src} alt="" draggable={false} /> : null}
    </span>
  );
}

/** A plugin type's cover as an object URL while it's shown; nothing while it loads or when it can't. */
function useProjectTypeCover(
  type: string | undefined,
  revision: string | undefined,
): string | undefined {
  const [url, setUrl] = useState<string>();
  useEffect(() => {
    setUrl(undefined);
    if (!type) return;
    const controller = new AbortController();
    let made: string | undefined;
    readProjectTypeCover(type, controller.signal)
      .then((blob) => {
        if (!controller.signal.aborted)
          setUrl((made = URL.createObjectURL(blob)));
      })
      .catch(() => {});
    return () => {
      controller.abort();
      if (made) URL.revokeObjectURL(made);
    };
  }, [type, revision]);
  return url;
}

/** A type's small mark over its name: the app's line icon, the plugin's own icon, or the plug. */
function TypeGlyph({
  type,
  pluginTypes,
}: {
  type: string;
  pluginTypes: readonly AvailableProjectType[];
}) {
  if (isAppProjectType(type))
    return (
      <span className="new-game-glyph">
        <ProjectTypeIcon type={type} size={16} />
      </span>
    );
  const option = pluginTypes.find((item) => item.id === type);
  const plugin = option?.plugin;
  // A lone letter reads as noise this small, so a plugin without an icon gets the plug.
  return (
    <span className="new-game-glyph">
      {plugin?.icon ? (
        <PluginGlyph
          plugin={{
            id: plugin.id,
            icon: { type: "asset", path: plugin.icon },
            iconRevision: plugin.revision,
          }}
          size={16}
          name={option?.title ?? type}
        />
      ) : (
        <Plug size="md" />
      )}
    </span>
  );
}

function typeHint(
  type: string,
  pluginTypes: readonly AvailableProjectType[],
): string {
  return isAppProjectType(type)
    ? projectTypeDescription(type)
    : (pluginTypes.find((option) => option.id === type)?.description ?? "");
}

function typePlaceholder(type: string): string {
  return isAppProjectType(type)
    ? t(`newGame.placeholder.${type}`)
    : t("home.placeholder");
}
