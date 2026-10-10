import type { AssetCanvasNode, AssetCanvasNodeLayout } from "./contracts.js";

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
