import type { AssetCanvasNode, AssetCanvasNodeLayout, AssetCanvasNodeType } from "./contracts.js";

/** Default sizes of the only node types whose size the user controls; other nodes size to their content. */
export const RESIZABLE_CANVAS_NODE_SIZES = {
  text: { width: 300, height: 190 },
  document: { width: 360, height: 330 },
  table: { width: 640, height: 360 },
} as const;

export function isResizableCanvasNodeType(type: AssetCanvasNodeType): type is keyof typeof RESIZABLE_CANVAS_NODE_SIZES {
  return Object.hasOwn(RESIZABLE_CANVAS_NODE_SIZES, type);
}

export function contentNodeSizeIssue(node: Pick<AssetCanvasNode, "id" | "type">): string {
  return `Node ${node.id}: ${node.type} nodes size to their content; remove width/height from its editor layout (only ${Object.keys(RESIZABLE_CANVAS_NODE_SIZES).join(", ")} nodes are resizable)`;
}

/**
 * Drops a stored size from a node that sizes to its content. Boards written before validation
 * rejected these sizes still load; the size is ignored instead of fixing the node frame.
 */
export function withoutContentNodeSize<T extends Pick<AssetCanvasNode, "type" | "width" | "height">>(node: T): T {
  if (isResizableCanvasNodeType(node.type) || (node.width === undefined && node.height === undefined)) return node;
  const { width: _width, height: _height, ...rest } = node;
  return rest as T;
}

export function canvasNodeLayout(
  node: Pick<AssetCanvasNode, "position" | "width" | "height">,
): AssetCanvasNodeLayout {
  return {
    ...node.position,
    ...(node.width !== undefined ? { width: node.width } : {}),
    ...(node.height !== undefined ? { height: node.height } : {}),
  };
}

export function canvasNodeContent({
  position: _position,
  width: _width,
  height: _height,
  ...node
}: AssetCanvasNode) {
  return node;
}

export function applyCanvasNodeLayout(
  node: AssetCanvasNode,
  layout: AssetCanvasNodeLayout,
): AssetCanvasNode {
  return {
    ...node,
    position: { x: layout.x, y: layout.y },
    ...(layout.width !== undefined ? { width: layout.width } : {}),
    ...(layout.height !== undefined ? { height: layout.height } : {}),
  };
}
