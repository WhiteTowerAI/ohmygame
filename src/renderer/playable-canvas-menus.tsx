import {
  ChevronDown,
  Clapperboard,
  Clipboard,
  Code2,
  Copy,
  Download,
  Flag,
  LoaderCircle,
  Maximize,
  Box,
  Monitor,
  Plus,
  Redo2,
  Settings,
  Trash2,
  Undo2,
  X,
} from "./icons.js";
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
} from "react";
import { createPortal } from "react-dom";
import { type Edge } from "@xyflow/react";
import { CanvasContextMenu, useCanvasCenter, type CanvasContextMenuState } from "./editor-canvas.js";
import { type NodeGraph, type PlayableNavigationMode } from "../shared/playable-nodes.js";
import { playableNodeById } from "../shared/playable-graph.js";
import { type PlayablePresetSummary } from "../shared/playable-editor.js";
import { PlayableTemplateDialog } from "./playable-template-dialog.js";

/**
 * An Exit's connection carries one decision: whether the player can come back
 * (the engine's `push`) or the next Scene takes over (`replace`). It also
 * shows whether the Exit is navigation, whose line the canvas does not draw.
 */
export function PlayableEdgeInspector({ edge, graph, onChangeMode, onChangeNavigation, onDelete, onClose }: {
  edge: Edge;
  graph: NodeGraph;
  onChangeMode: (mode: PlayableNavigationMode) => void;
  onChangeNavigation: (navigation: boolean) => void;
  onDelete: () => void;
  onClose: () => void;
}) {
  const titleOf = (nodeId: string) => graph.nodes.find((node) => node.id === nodeId)?.title ?? nodeId;
  const signal = playableNodeById(graph, edge.source)?.signals.find((candidate) => candidate.id === edge.sourceHandle);
  const mode: PlayableNavigationMode = edge.data?.mode === "push" ? "push" : "replace";
  return <aside className="playable-edge-inspector" aria-label="Exit">
    <header>
      <div>
        <strong>{signal?.label || edge.sourceHandle}</strong>
        <small>{titleOf(edge.source)} → {titleOf(edge.target)}</small>
      </div>
      <button type="button" aria-label="Close" onClick={onClose}><X size={14} /></button>
    </header>
    <label className="playable-edge-back">
      <input type="checkbox" checked={mode === "push"} onChange={(event) => onChangeMode(event.target.checked ? "push" : "replace")} />
      <span><strong>Allow Back</strong><small>The player can return to {titleOf(edge.source)} from {titleOf(edge.target)}.</small></span>
    </label>
    <label className="playable-edge-back">
      <input type="checkbox" checked={signal?.role === "navigation"} onChange={(event) => onChangeNavigation(event.target.checked)} />
      <span><strong>Navigation</strong><small>A way around the game, like Home. The canvas names {titleOf(edge.target)} on the Exit instead of drawing a line.</small></span>
    </label>
    <button className="playable-edge-delete" type="button" onClick={onDelete}><Trash2 size={13} /><span>Remove connection</span></button>
  </aside>;
}

/**
 * Project-wide things that are not on the canvas: screen size, the Variables, Export, and whether engine details show.
 */
export function PlayableProjectMenu({ disabled, screenSize, exporting, canExport, technical, variablesOpen, onScreenSize, onVariables, onExport, onTechnicalChange }: {
  disabled: boolean;
  screenSize: string;
  variablesOpen: boolean;
  onVariables: () => void;
  exporting: boolean;
  canExport: boolean;
  technical: boolean;
  onScreenSize: () => void;
  onExport: () => void;
  onTechnicalChange: (on: boolean) => void;
}) {
  const button = useRef<HTMLButtonElement>(null);
  const menu = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState<{ top: number; left: number }>();

  useLayoutEffect(() => {
    if (position) menu.current?.focus();
  }, [position]);

  useEffect(() => {
    if (!position) return;
    const close = () => setPosition(undefined);
    const closeOutside = (event: PointerEvent) => {
      const target = event.target as globalThis.Node;
      if (!menu.current?.contains(target) && !button.current?.contains(target)) close();
    };
    const closeOnKey = (event: KeyboardEvent) => { if (event.key === "Escape") close(); };
    document.addEventListener("pointerdown", closeOutside);
    window.addEventListener("keydown", closeOnKey);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", closeOutside);
      window.removeEventListener("keydown", closeOnKey);
      window.removeEventListener("resize", close);
    };
  }, [position]);

  const run = (action: () => void) => { setPosition(undefined); action(); };

  return <>
    <button
      ref={button}
      type="button"
      className={position || variablesOpen ? "is-active" : undefined}
      title="Project settings"
      aria-haspopup="menu"
      aria-expanded={Boolean(position)}
      disabled={disabled}
      onClick={() => {
        if (position) return setPosition(undefined);
        const bounds = button.current?.getBoundingClientRect();
        if (bounds) setPosition({ top: bounds.bottom + 4, left: bounds.left });
      }}
    ><Settings size={14} /><span>Project</span><ChevronDown size={12} /></button>
    {position ? createPortal(<div
      ref={menu}
      className="story-canvas-context-menu playable-project-menu"
      role="menu"
      aria-label="Project"
      tabIndex={-1}
      style={{ top: position.top, left: position.left }}
    >
      <button type="button" role="menuitem" onClick={() => run(onScreenSize)}><Monitor size={15} /><span>Screen size</span><small>{screenSize}</small></button>
      <button type="button" role="menuitemcheckbox" aria-checked={variablesOpen} title="What the game remembers between Scenes" onClick={() => run(onVariables)}><Box size={15} /><span>Variables</span></button>
      <div className="playable-project-menu-separator" role="separator" />
      <button type="button" role="menuitem" disabled={!canExport} onClick={() => run(onExport)}>
        {exporting ? <LoaderCircle className="spin" size={15} /> : <Download size={15} />}<span>{exporting ? "Exporting" : "Export"}</span>
      </button>
      <div className="playable-project-menu-separator" role="separator" />
      <button type="button" role="menuitemcheckbox" aria-checked={technical} title="Show IDs, file paths, types, and the Code view" onClick={() => onTechnicalChange(!technical)}>
        <Code2 size={15} /><span>Show technical details</span><small>{technical ? "✓" : ""}</small>
      </button>
    </div>, document.body) : null}
  </>;
}

export function PlayableAddControl({ presets, busy, onAdd }: {
  presets: readonly PlayablePresetSummary[];
  busy: boolean;
  onAdd: (presetId: string, position: { x: number; y: number }) => void;
}) {
  const [addOpen, setAddOpen] = useState(false);
  const canvasCenter = useCanvasCenter();
  const closeAdd = useCallback(() => setAddOpen(false), []);

  return <>
    <button className={addOpen ? "is-active" : undefined} type="button" title="Add Scene" aria-label="Add Scene" aria-haspopup="dialog" aria-expanded={addOpen} onClick={() => setAddOpen(true)}>
      {busy ? <LoaderCircle className="spin" size={18} /> : <Plus size={18} />}
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

export function PlayableCanvasContextMenu({ menu, presets, canUndo, canRedo, canPaste, busy, isEntry, onClose, onUndo, onRedo, onPaste, onAdd, onOpen, onCopy, onDuplicate, onSetEntry, onDelete }: {
  menu: CanvasContextMenuState;
  presets: readonly PlayablePresetSummary[];
  canUndo: boolean;
  canRedo: boolean;
  canPaste: boolean;
  busy: boolean;
  isEntry: boolean;
  onClose: () => void;
  onUndo: () => unknown;
  onRedo: () => unknown;
  onPaste: () => void;
  onAdd: (presetId: string) => void;
  onOpen: () => void;
  onCopy: () => void;
  onDuplicate: () => void;
  onSetEntry: () => void;
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
        <button className="is-danger" type="button" role="menuitem" onClick={() => run(onDelete)}><Trash2 size={15} /><span>Delete</span></button>
      </>}
    </CanvasContextMenu>
  );
}
