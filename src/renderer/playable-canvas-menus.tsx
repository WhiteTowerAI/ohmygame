import {
  Check,
  CircleStop,
  Clapperboard,
  Clipboard,
  Copy,
  Eye,
  Flag,
  LoaderCircle,
  Maximize,
  Plus,
  Redo2,
  Trash2,
  Undo2,
} from "./icons.js";
import {
  useCallback,
  useState,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { CanvasContextMenu, useCanvasCenter, type CanvasContextMenuState } from "./editor-canvas.js";
import { type PlayablePresetSummary } from "../shared/playable-editor.js";
import { PlayableTemplateDialog } from "./playable-template-dialog.js";

/** Opens Add a Scene and adds the chosen Template at the center of the canvas. */
export function PlayableAddControl({ presets, busy, onAdd, className, children }: {
  presets: readonly PlayablePresetSummary[];
  busy: boolean;
  onAdd: (presetId: string, position: { x: number; y: number }) => void;
  className?: string;
  /** The button's content; the tool bar's + by default. */
  children?: ReactNode;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const canvasCenter = useCanvasCenter();
  const closeAdd = useCallback(() => setAddOpen(false), []);

  return <>
    <button className={[className, addOpen ? "is-active" : undefined].filter(Boolean).join(" ") || undefined} type="button" title="Add Scene" {...(children ? {} : { "aria-label": "Add Scene" })} aria-haspopup="dialog" aria-expanded={addOpen} onClick={() => setAddOpen(true)}>
      {children ?? (busy ? <LoaderCircle className="spin" size={18} /> : <Plus size={18} />)}
    </button>
    {addOpen ? createPortal(<PlayableTemplateDialog
      presets={presets}
      busy={busy}
      onClose={closeAdd}
      onChoose={(presetId) => {
        const position = canvasCenter();
        if (position) onAdd(presetId, position);
        setAddOpen(false);
      }}
    />, document.body) : null}
  </>;
}

/** What an empty canvas shows: where to start, from a Template or the chat. */
export function PlayableEmptyCanvas({ presets, busy, onAdd }: {
  presets: readonly PlayablePresetSummary[];
  busy: boolean;
  onAdd: (presetId: string, position: { x: number; y: number }) => void;
}) {
  return <div className="playable-canvas-empty">
    <div>
      <strong>No Scenes yet</strong>
      <p>Start from a Template, or describe your story in the chat.</p>
      <PlayableAddControl presets={presets} busy={busy} onAdd={onAdd} className="playable-canvas-empty-add">
        {busy ? <LoaderCircle className="spin" size={14} /> : <Plus size={14} />}<span>Add a Scene</span>
      </PlayableAddControl>
    </div>
  </div>;
}

export function PlayableCanvasContextMenu({ menu, presets, canUndo, canRedo, canPaste, busy, isEntry, story, onClose, onUndo, onRedo, onPaste, onAdd, onOpen, onCopy, onDuplicate, onSetEntry, onStoryOption, onDelete }: {
  menu: CanvasContextMenuState;
  presets: readonly PlayablePresetSummary[];
  canUndo: boolean;
  canRedo: boolean;
  canPaste: boolean;
  busy: boolean;
  isEntry: boolean;
  /** How the Scene shows on the Story map. */
  story: { onMap: boolean; ending: boolean };
  onClose: () => void;
  onUndo: () => unknown;
  onRedo: () => unknown;
  onPaste: () => void;
  onAdd: (presetId: string) => void;
  onOpen: () => void;
  onCopy: () => void;
  onDuplicate: () => void;
  onSetEntry: () => void;
  onStoryOption: (option: "hidden" | "ending", value: boolean) => void;
  onDelete: () => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const run = (action: () => unknown) => { action(); onClose(); };

  return (
    <CanvasContextMenu screenPosition={menu.screenPosition} label={menu.kind === "pane" ? "Canvas actions" : "Scene actions"} onClose={onClose}>
      {menu.kind === "pane" ? <>
        <button type="button" role="menuitem" disabled={!canUndo} onClick={() => run(onUndo)}><Undo2 size={15} /><span>Undo</span></button>
        <button type="button" role="menuitem" disabled={!canRedo} onClick={() => run(onRedo)}><Redo2 size={15} /><span>Redo</span></button>
        <button type="button" role="menuitem" disabled={!canPaste} onClick={() => run(onPaste)}><Clipboard size={15} /><span>Paste</span></button>
        <div className="story-canvas-context-submenu-root" onPointerEnter={() => setAddOpen(true)}>
          <button type="button" role="menuitem" aria-haspopup="menu" aria-expanded={addOpen} onClick={() => setAddOpen(true)}><Plus size={15} /><span>Add Scene</span></button>
          {addOpen ? <div className="story-canvas-context-add-menu">
            <div className="story-canvas-context-submenu" role="menu" aria-label="Add Scene">
              {presets.map((preset) => <button
                type="button"
                role="menuitem"
                key={preset.id}
                disabled={busy}
                title={preset.summary}
                onClick={() => run(() => onAdd(preset.id))}
              ><Clapperboard size={15} /><span>{preset.label}</span></button>)}
            </div>
          </div> : null}
        </div>
      </> : <>
        <button type="button" role="menuitem" onClick={() => run(onOpen)}><Maximize size={15} /><span>Open</span></button>
        <button type="button" role="menuitem" disabled={busy} onClick={() => run(onCopy)}><Copy size={15} /><span>Copy Scene</span></button>
        <button type="button" role="menuitem" disabled={busy} onClick={() => run(onDuplicate)}><Plus size={15} /><span>Duplicate</span></button>
        <button type="button" role="menuitem" disabled={isEntry} onClick={() => run(onSetEntry)}><Flag size={15} /><span>{isEntry ? "Start Scene" : "Set as Start"}</span></button>
        <div className="playable-project-menu-separator" role="separator" />
        <button type="button" role="menuitemcheckbox" aria-checked={story.onMap} title="Players see this Scene on the Story map. Turn it off for menus and other Scenes that are not steps in the story." onClick={() => run(() => onStoryOption("hidden", story.onMap))}><Eye size={15} /><span>On Story map</span>{story.onMap ? <Check size={13} /> : null}</button>
        <button type="button" role="menuitemcheckbox" aria-checked={story.ending} title="The Story map counts this Scene as an ending" onClick={() => run(() => onStoryOption("ending", !story.ending))}><CircleStop size={15} /><span>Ending</span>{story.ending ? <Check size={13} /> : null}</button>
        <div className="playable-project-menu-separator" role="separator" />
        <button className="is-danger" type="button" role="menuitem" onClick={() => run(onDelete)}><Trash2 size={15} /><span>Delete</span></button>
      </>}
    </CanvasContextMenu>
  );
}
