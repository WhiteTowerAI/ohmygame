import { useEffect, useLayoutEffect, useState } from "react";
import type { PluginMention, ProjectState, PromptAttachment, PromptImage, PromptMode, ProjectType } from "../shared/contracts.js";
import { FilePlus } from "./icons.js";
import { pickProjectFolder, ProjectCreateDialog, type FirstMessage } from "./project-create-dialog.js";
import { ProjectPromptCreator } from "./project-prompt-creator.js";
import { GameIcon, type GameIconName, type GameIconTone } from "./game-icon.js";
import { isAppProjectType, projectTypeDescription, projectTypeLabel } from "./project-types.js";
import { usePluginProjectTypes } from "./project-type-choices.js";
import type { AvailableProjectType } from "./api.js";
import { createdProjectView, settingsHash } from "./routes.js";
import { templateAssetUrl } from "./template-assets.js";
import { Button, Dialog, useToast } from "./ui/index.js";
import { t } from "./i18n.js";
import "./new-game.css";

// Every way to start a game opens one dialog: Home's type cards on their type,
// and 直接描述, ⌘N, the command menu and the project rail's + on 通用游戏. The
// dialog keeps Home's prompt (one draft), so closing it loses nothing.
// Importing a folder starts from Home instead: the folder brings its own type.

/** The order types are offered in; plugins' types follow, then 更多类型. */
export const NEW_GAME_TYPES = ["web-game", "godot-game", "interactive-story", "general", "asset-canvas"] as const satisfies readonly ProjectType[];

/** Each app type's picture. Plugins' types and any type without one get a quiet mark instead. */
const TYPE_ART: Partial<Record<string, string>> = {
  "web-game": "examples/scenes-cover.webp",
  "godot-game": "examples/terrain-cover.webp",
  "interactive-story": "examples/characters-cover.webp",
  general: "examples/creatures-cover.webp",
  "asset-canvas": "examples/objects-cover.webp",
};

const OPEN_EVENT = "ohmygame:new-game";
const DRAFT_KEY = "home";

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
  window.dispatchEvent(new CustomEvent<OpenDetail>(OPEN_EVENT, { detail: { type: request.type, from, start: request.start } }));
}

interface OpenDetail { type?: string; from?: DOMRect; start?: "blank" | "import" }

/** What the project dialog opens with once the person has said what to make. */
interface CreateRequest {
  firstMessage?: FirstMessage;
  clearDraft?: () => void;
  workspacePath?: string;
  type?: ProjectType;
}

export function NewGameHost({ onCreate, onOpen }: {
  onCreate: (project: ProjectState, conversationId: string, prompt: string, mentions: PluginMention[], images: PromptImage[], mode: PromptMode, attachments?: PromptAttachment[]) => void;
  onOpen: (projectId: string, view?: "design") => void;
}) {
  const [open, setOpen] = useState<{ type: string; from?: DOMRect }>();
  const [creating, setCreating] = useState<CreateRequest>();
  const toast = useToast();

  useEffect(() => {
    const onOpenRequest = (event: Event) => {
      const detail = (event as CustomEvent<OpenDetail>).detail ?? {};
      if (detail.start === "blank") setCreating({ type: detail.type && isAppProjectType(detail.type) ? detail.type : undefined });
      else if (detail.start === "import") void importFolder();
      else setOpen({ type: detail.type ?? "general", from: detail.from });
    };
    window.addEventListener(OPEN_EVENT, onOpenRequest);
    return () => window.removeEventListener(OPEN_EVENT, onOpenRequest);
  }, []);

  // An existing folder opens its project if it has one, or becomes a new project's workspace.
  async function importFolder(): Promise<void> {
    try {
      const picked = await pickProjectFolder();
      if (!picked) return;
      setOpen(undefined);
      if ("owner" in picked) onOpen(picked.owner.id);
      else setCreating({ workspacePath: picked.path });
    } catch (cause) {
      toast({ title: cause instanceof Error ? cause.message : String(cause), tone: "danger" });
    }
  }

  return <>
    {open ? <NewGameDialog
      type={open.type}
      from={open.from}
      sending={!!creating?.firstMessage}
      onClose={() => setOpen(undefined)}
      onSubmit={(firstMessage, clearDraft) => setCreating({ firstMessage, clearDraft })}
      onBlank={() => setCreating({ type: isAppProjectType(open.type) ? open.type : undefined })}
    /> : null}
    {/* The project dialog shows only for what needs the person when a prompt starts it. */}
    {creating ? <ProjectCreateDialog
      firstMessage={creating.firstMessage}
      direct={!!creating.firstMessage}
      initialType={creating.type}
      initialWorkspacePath={creating.workspacePath}
      onClose={() => setCreating(undefined)}
      onOpenProject={(projectId) => { setCreating(undefined); setOpen(undefined); onOpen(projectId); }}
      onCreated={(project, start) => {
        setCreating(undefined);
        setOpen(undefined);
        if (start) {
          creating.clearDraft?.();
          onCreate(project, start.conversationId, start.prompt, start.mentions, [], start.mode, start.attachments);
        } else onOpen(project.id, createdProjectView(project.type));
      }}
    /> : null}
  </>;
}

function NewGameDialog({ type, from, sending, onClose, onSubmit, onBlank }: {
  type: string;
  from?: DOMRect;
  sending: boolean;
  onClose: () => void;
  onSubmit: (message: FirstMessage, clearDraft: () => void) => void;
  onBlank: () => void;
}) {
  const { types: pluginTypes = [] } = usePluginProjectTypes();
  const name = typeName(type, pluginTypes);
  useGrowFrom(from);
  return (
    <Dialog
      open
      size="lg"
      className="new-game-dialog"
      onClose={onClose}
      title={name}
      description={typeHint(type, pluginTypes)}
      media={<TypeArt type={type} />}
      footer={<Button variant="ghost" size="sm" icon={<FilePlus size="sm" />} disabled={sending} onClick={onBlank}>{t("home.startBlank")}</Button>}
    >
      <ProjectPromptCreator
        draftKey={DRAFT_KEY}
        type={type}
        autoFocus
        placeholder={typePlaceholder(type)}
        disabled={sending}
        onConnectModel={() => { onClose(); window.location.hash = settingsHash("providers"); }}
        onSubmit={onSubmit}
      />
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
    panel.animate([
      { transform: `translate(${dx}px, ${dy}px) scale(${from.width / to.width}, ${from.height / to.height})`, opacity: 0.4 },
      { transform: "none", opacity: 1 },
    ], { duration: 200, easing: "cubic-bezier(0.2, 0, 0, 1)" });
  }, []);
}

/** A type's card on Home: its picture, name and one line; it opens the dialog on that type. */
export function NewGameCard({ type, pluginTypes }: { type: string; pluginTypes: readonly AvailableProjectType[] }) {
  return (
    <button type="button" className="new-game-card" onClick={(event) => openNewGame({ type, from: event.currentTarget })}>
      <TypeArt type={type} />
      <TypeIcon type={type} size={32} className="new-game-card-icon" />
      <span className="new-game-card-copy">
        <span className="new-game-card-name">{typeName(type, pluginTypes)}</span>
        <span className="new-game-card-hint">{typeHint(type, pluginTypes)}</span>
      </span>
    </button>
  );
}

function TypeArt({ type }: { type: string }) {
  const art = TYPE_ART[type];
  return <span className="new-game-art" aria-hidden="true">
    {art ? <img src={templateAssetUrl(art)} alt="" /> : <span className="new-game-art-mark"><TypeIcon type={type} size={56} /></span>}
  </span>;
}

/** Each type's game icon and tile colour; plugins' types share the puzzle piece. */
const TYPE_ICONS: Partial<Record<string, [GameIconName, GameIconTone]>> = {
  "web-game": ["internet", "blue"],
  "godot-game": ["controller", "green"],
  "interactive-story": ["book", "gold"],
  general: ["random-dice", "pink"],
  "asset-canvas": ["palette", "purple"],
};

function TypeIcon({ type, size, className }: { type: string; size: number; className?: string }) {
  const [name, tone] = TYPE_ICONS[type] ?? ["puzzle-02", "teal"];
  return <GameIcon name={name} tone={tone} size={size} className={className} />;
}

function typeName(type: string, pluginTypes: readonly AvailableProjectType[]): string {
  return isAppProjectType(type) ? projectTypeLabel(type) : pluginTypes.find((option) => option.id === type)?.title ?? type;
}

function typeHint(type: string, pluginTypes: readonly AvailableProjectType[]): string {
  return isAppProjectType(type) ? projectTypeDescription(type) : pluginTypes.find((option) => option.id === type)?.description ?? "";
}

function typePlaceholder(type: string): string {
  return isAppProjectType(type) ? t(`newGame.placeholder.${type}`) : t("home.placeholder");
}
