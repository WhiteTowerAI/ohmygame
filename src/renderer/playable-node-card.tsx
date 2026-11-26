import { Flag, InfoCircle } from "./icons.js";
import {
  createContext,
  useContext,
  useEffect,
  useRef,
  useState,
  type CSSProperties,
} from "react";
import { Handle, Position, type NodeProps, type NodeTypes } from "@xyflow/react";
import { type PlayableAssetDefinition, type PlayableNode, type PlayableSignal } from "../shared/playable-nodes.js";
import { useWorkspaceAssetUrl } from "./use-workspace-asset-url.js";
import type { PlayableFlowData, PlayableFlowNode } from "./playable-flow.js";
import { t } from "./i18n.js";

const CARD_STYLE = {
  "--story-media-width": "var(--story-canvas-stage-width, 440px)",
  "--story-media-height": "var(--story-canvas-stage-height, 248px)",
} as CSSProperties;

export const PlayableCanvasContext = createContext<{
  projectId: string;
  onRenameNode: (nodeId: string, title: string) => void;
} | undefined>(undefined);

export const PLAYABLE_NODE_TYPES: NodeTypes = { playable: PlayableNodeCard };

function PlayableNodeCard({ id, data, selected }: NodeProps<PlayableFlowNode>) {
  const canvas = useContext(PlayableCanvasContext);
  const { node, entry, issues, connected, failed, coverAsset } = data;
  return <div className={`story-node story-media-node story-presentation-node-card playable-node-card${selected ? " is-selected" : ""}`} style={CARD_STYLE}>
    <Handle className="story-media-input-handle" type="target" position={Position.Left} />
    <div className="story-media-node-label story-scene-node-label">
      <span><InlinePlayableTitle nodeId={id} value={node.title} onRename={canvas?.onRenameNode} /></span>
      <div className="playable-node-badges">
        {entry ? <span className="playable-node-badge is-entry" title={t("sceneCard.startTitle")}><Flag size={11} /><span>{t("sceneCard.start")}</span></span> : null}
      </div>
    </div>
    <div data-alignment-frame className={`story-media-stage playable-node-stage${failed ? " is-failed" : ""}`}>
      <PlayableNodePicture projectId={canvas?.projectId} node={node} coverAsset={coverAsset} />
      {issues.length ? <p className="playable-node-issue" role="alert"><InfoCircle size={13} /><span title={issues.join("\n")}>{issues[0]}</span></p> : null}
    </div>
    <PlayableSignalOutputs signals={node.signals} connected={connected} />
  </div>;
}

/**
 * What a Scene card shows: its first image Asset or the first frame of its
 * first video, else a neutral card with its title.
 */
function PlayableNodePicture({ projectId, node, coverAsset }: {
  projectId?: string;
  node: PlayableNode;
  coverAsset?: PlayableAssetDefinition;
}) {
  const source = coverAsset?.source;
  const { url } = useWorkspaceAssetUrl(
    source?.kind === "workspace" ? projectId : undefined,
    source?.kind === "workspace" ? source.path : "",
    0,
    source?.kind === "library" ? source.assetId : undefined,
  );
  if (url && coverAsset?.type === "video") {
    return <video
      className="playable-node-picture is-asset"
      src={url}
      muted
      playsInline
      preload="metadata"
      onLoadedMetadata={(event) => { event.currentTarget.currentTime = 0.01; }}
    />;
  }
  if (url) return <img className="playable-node-picture is-asset" src={url} alt="" draggable={false} />;
  return <div className="playable-node-summary">
    <strong>{node.title}</strong>
  </div>;
}

/**
 * A Scene card's Exits: only the port each connection leaves from, named when
 * hovered. A Scene without Exits, such as an ending or a look that goes back,
 * shows none.
 */
function PlayableSignalOutputs({ signals, connected }: {
  signals: readonly PlayableSignal[];
  connected: PlayableFlowData["connected"];
}) {
  if (!signals.length) return null;
  return <div className="story-node-outputs">{signals.map((signal) => {
    const name = signal.label || signal.id;
    return <div className={`story-node-output${connected[signal.id] ? "" : " is-unconnected"}`} key={signal.id}>
      <Handle className="story-node-output-handle" id={signal.id} type="source" position={Position.Right}
        title={connected[signal.id] ? name : t("sceneCard.unconnected", { name })} aria-label={name} />
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
    aria-label={t("sceneCard.title")}
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
