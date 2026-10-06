import { ArrowRight, Flag, InfoCircle } from "./icons.js";
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Handle, Position, type NodeProps, type NodeTypes } from "@xyflow/react";
import { type PlayableAssetDefinition, type PlayableNode, type PlayableSignal } from "../shared/playable-nodes.js";
import { getPlayableThumbnail } from "./api.js";
import { useWorkspaceAssetUrl } from "./use-workspace-asset-url.js";
import type { PlayableFlowData, PlayableFlowNode } from "./playable-flow.js";

const CARD_STYLE = {
  "--story-media-width": "var(--story-canvas-stage-width, 440px)",
  "--story-media-height": "var(--story-canvas-stage-height, 248px)",
} as CSSProperties;

export const PlayableCanvasContext = createContext<{
  projectId: string;
  technical: boolean;
  onRenameNode: (nodeId: string, title: string) => void;
  /** Selects a connection whose line is not drawn, such as a navigation Exit's. */
  onSelectEdge: (edgeId: string) => void;
} | undefined>(undefined);

export const PLAYABLE_NODE_TYPES: NodeTypes = { playable: PlayableNodeCard };

function PlayableNodeCard({ id, data, selected }: NodeProps<PlayableFlowNode>) {
  const canvas = useContext(PlayableCanvasContext);
  const { node, entry, ending, issues, connected, failed, thumbnail, coverAsset } = data;
  return <div className={`story-node story-media-node story-presentation-node-card playable-node-card${selected ? " is-selected" : ""}`} style={CARD_STYLE}>
    <Handle className="story-media-input-handle" type="target" position={Position.Left} />
    <div className="story-media-node-label story-scene-node-label">
      <span><InlinePlayableTitle nodeId={id} value={node.title} onRename={canvas?.onRenameNode} /></span>
      <div className="playable-node-badges">
        {entry ? <span className="playable-node-badge is-entry" title="The player starts here"><Flag size={11} /><span>Start</span></span> : null}
        {node.story?.hidden ? <span className="playable-node-badge" title="Not shown on the Story map, and the Scenes before and after it are joined there"><span>Off map</span></span> : ending ? <span className="playable-node-badge" title="Counted as an ending on the Story map"><span>Ending</span></span> : null}
      </div>
    </div>
    <div data-alignment-frame className={`story-media-stage playable-node-stage${failed ? " is-failed" : ""}`}>
      <PlayableNodePicture projectId={canvas?.projectId} technical={Boolean(canvas?.technical)} node={node} thumbnail={thumbnail} coverAsset={coverAsset} />
      {thumbnail?.stale && !failed ? <span className="playable-node-stale" title="The Scene changed since this picture was taken.">Stale</span> : null}
      {issues.length ? <p className="playable-node-issue" role="alert"><InfoCircle size={13} /><span title={issues.join("\n")}>{issues[0]}</span></p> : null}
    </div>
    <PlayableSignalOutputs signals={node.signals} connected={connected} technical={Boolean(canvas?.technical)} onSelectEdge={canvas?.onSelectEdge} />
  </div>;
}

/**
 * What a Node card shows: the Node's last thumbnail, else its first image
 * Asset, else a neutral card with its title.
 */
function PlayableNodePicture({ projectId, technical, node, thumbnail, coverAsset }: {
  projectId?: string;
  technical: boolean;
  node: PlayableNode;
  thumbnail?: { capturedAt: string };
  coverAsset?: PlayableAssetDefinition;
}) {
  const captured = usePlayableThumbnailUrl(thumbnail ? projectId : undefined, node.id, thumbnail?.capturedAt);
  const source = coverAsset?.source;
  const cover = useWorkspaceAssetUrl(
    !captured && source?.kind === "workspace" ? projectId : undefined,
    source?.kind === "workspace" ? source.path : "",
    0,
    !captured && source?.kind === "library" ? source.assetId : undefined,
  );
  const url = captured ?? cover.url;
  if (url) return <img className={`playable-node-picture${captured ? "" : " is-asset"}`} src={url} alt="" draggable={false} />;
  return <div className="playable-node-summary">
    <strong>{node.title}</strong>
    {technical ? <small>{node.id}</small> : null}
  </div>;
}

/** Keeps showing the previous screenshot until a newer one has loaded. */
function usePlayableThumbnailUrl(projectId: string | undefined, nodeId: string, capturedAt: string | undefined): string | undefined {
  const [url, setUrl] = useState<string>();
  const current = useRef<string | undefined>(undefined);
  const show = useCallback((next: string | undefined) => {
    if (current.current) URL.revokeObjectURL(current.current);
    current.current = next;
    setUrl(next);
  }, []);
  useEffect(() => () => { if (current.current) URL.revokeObjectURL(current.current); }, []);
  useEffect(() => {
    if (!projectId || !capturedAt) {
      show(undefined);
      return;
    }
    let disposed = false;
    void getPlayableThumbnail(projectId, nodeId).then((blob) => {
      if (!disposed) show(blob ? URL.createObjectURL(blob) : undefined);
    }).catch(() => {});
    return () => { disposed = true; };
  }, [projectId, nodeId, capturedAt, show]);
  return url;
}

/**
 * A Scene card's Exits, each with the port its connection leaves from and,
 * when the Agent wrote one, the condition it is taken on. A navigation Exit's
 * line is not drawn; the row names its target instead, and clicking the name
 * selects the connection.
 */
function PlayableSignalOutputs({ signals, connected, technical, onSelectEdge }: {
  signals: readonly PlayableSignal[];
  connected: PlayableFlowData["connected"];
  technical: boolean;
  onSelectEdge?: (edgeId: string) => void;
}) {
  if (!signals.length) return <div className="story-node-outputs playable-node-outputs-empty"><span>No exits yet</span></div>;
  return <div className="story-node-outputs">{signals.map((signal) => {
    const route = connected[signal.id];
    const name = signal.label || signal.id;
    return <div className={`story-node-output${route ? "" : " is-unconnected"}`} key={signal.id}>
      <span className="story-node-output-label" title={route
        ? technical ? `${signal.label} (${signal.id})` : signal.label
        : `"${name}" doesn't go anywhere yet. Drag from here to a Scene.`}>{name}</span>
      {signal.when ? <span className="playable-node-output-when" title={`Taken ${signal.when}`}>{signal.when}</span> : null}
      <Handle className="story-node-output-handle" id={signal.id} type="source" position={Position.Right} />
      {route && signal.role === "navigation" ? <button
        type="button"
        className={`playable-node-output-target nodrag nopan${route.selected ? " is-selected" : ""}`}
        title={`"${name}" goes to ${route.target}`}
        onClick={(event) => {
          // The row is inside the card, so the click would also select the Scene.
          event.stopPropagation();
          onSelectEdge?.(route.edgeId);
        }}
      ><ArrowRight size={10} /><span>{route.target}</span></button> : null}
    </div>;
  })}</div>;
}

function InlinePlayableTitle({ nodeId, value, onRename }: {
  nodeId: string;
  value: string;
  onRename?: (nodeId: string, title: string) => void;
}) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  const input = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!editing) return;
    input.current?.focus();
    input.current?.select();
  }, [editing]);

  useEffect(() => {
    if (!editing) setDraft(value);
  }, [editing, value]);

  if (!editing || !onRename) return <strong onDoubleClick={(event) => {
    if (!onRename) return;
    event.stopPropagation();
    setDraft(value);
    setEditing(true);
  }}>{value}</strong>;

  const commit = () => {
    const next = draft.trim();
    if (next) onRename(nodeId, next);
    setEditing(false);
  };
  return <input
    ref={input}
    className="story-node-title-input"
    value={draft}
    maxLength={120}
    aria-label="Scene title"
    onChange={(event) => setDraft(event.target.value)}
    onBlur={commit}
    onPointerDown={(event) => event.stopPropagation()}
    onClick={(event) => event.stopPropagation()}
    onDoubleClick={(event) => event.stopPropagation()}
    onKeyDown={(event) => {
      event.stopPropagation();
      if (event.key === "Enter") commit();
      if (event.key === "Escape") { setDraft(value); setEditing(false); }
    }}
  />;
}
