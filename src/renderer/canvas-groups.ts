import type { AssetCanvasNode } from "../shared/contracts.js";
import { isResizableCanvasNodeType, RESIZABLE_CANVAS_NODE_SIZES } from "../shared/canvas-node-layout.js";

type Groupable = Pick<
  AssetCanvasNode,
  "id" | "type" | "position" | "parentId" | "width" | "height"
> & { measured?: { width?: number; height?: number } };

/** Only generation references impose execution order; frame nesting does not. */
export function canvasGroupExecutionPlan(
  nodes: readonly AssetCanvasNode[],
): { node: AssetCanvasNode; dependencies: string[] }[] | undefined {
  const ids = new Set(nodes.map((node) => node.id));
  const entries = new Map(
    nodes.map((node) => {
      const data = node.data;
      const references = [
        ...("images" in data ? data.images : []),
        ...("references" in data ? (data.references ?? []) : []),
        ...("promptSource" in data && data.promptSource
          ? [data.promptSource]
          : []),
        ...("source" in data && data.source ? [data.source] : []),
      ];
      return [
        node.id,
        {
          node,
          dependencies: [
            ...new Set(
              references.flatMap((reference) =>
                reference.type === "node" && ids.has(reference.nodeId)
                  ? [reference.nodeId]
                  : [],
              ),
            ),
          ],
        },
      ];
    }),
  );
  const ordered: { node: AssetCanvasNode; dependencies: string[] }[] = [];
  const visiting = new Set<string>(),
    visited = new Set<string>();
  const visit = (id: string): boolean => {
    if (visiting.has(id)) return false;
    if (visited.has(id)) return true;
    visiting.add(id);
    const entry = entries.get(id)!;
    if (!entry.dependencies.every(visit)) return false;
    visiting.delete(id);
    visited.add(id);
    ordered.push(entry);
    return true;
  };
  return nodes.every((node) => visit(node.id)) ? ordered : undefined;
}

export function canvasAbsolutePosition(
  node: Groupable,
  nodes: readonly Groupable[],
): { x: number; y: number } {
  const byId = new Map(nodes.map((item) => [item.id, item]));
  let x = node.position.x,
    y = node.position.y,
    parentId = node.parentId;
  const seen = new Set([node.id]);
  while (parentId) {
    if (seen.has(parentId)) break;
    seen.add(parentId);
    const parent = byId.get(parentId);
    if (!parent) break;
    x += parent.position.x;
    y += parent.position.y;
    parentId = parent.parentId;
  }
  return { x, y };
}

/** Clamp only edges moving inward; existing overflow must not block expansion. */
export function clampCanvasGroupResize(
  group: Groupable,
  nodes: readonly Groupable[],
  next: { x: number; y: number; width: number; height: number },
): { x: number; y: number; width: number; height: number } {
  const at = canvasAbsolutePosition(group, nodes);
  const parentX = at.x - group.position.x;
  const parentY = at.y - group.position.y;
  let left = parentX + next.x;
  let top = parentY + next.y;
  let right = left + next.width;
  let bottom = top + next.height;
  const currentRight = at.x + (group.width ?? group.measured?.width ?? 500);
  const currentBottom = at.y + (group.height ?? group.measured?.height ?? 400);
  const byParent = new Map<string, Groupable[]>();
  for (const node of nodes) {
    if (!node.parentId) continue;
    const children = byParent.get(node.parentId) ?? [];
    children.push(node);
    byParent.set(node.parentId, children);
  }
  const pending = (byParent.get(group.id) ?? []).map((node) => ({ node, x: at.x + node.position.x, y: at.y + node.position.y }));
  const seen = new Set([group.id]);
  let childLeft = Infinity, childTop = Infinity, childRight = -Infinity, childBottom = -Infinity;
  while (pending.length) {
    const { node, x, y } = pending.pop()!;
    if (seen.has(node.id)) continue;
    seen.add(node.id);
    const defaultSize = isResizableCanvasNodeType(node.type) ? RESIZABLE_CANVAS_NODE_SIZES[node.type] : undefined;
    const width = node.width ?? node.measured?.width ?? defaultSize?.width ?? 440;
    const height = node.height ?? node.measured?.height ?? defaultSize?.height ?? 320;
    childLeft = Math.min(childLeft, x);
    childTop = Math.min(childTop, y);
    childRight = Math.max(childRight, x + width);
    childBottom = Math.max(childBottom, y + height);
    for (const child of byParent.get(node.id) ?? []) pending.push({ node: child, x: x + child.position.x, y: y + child.position.y });
  }
  if (left > at.x) left = Math.min(left, Math.max(at.x, childLeft));
  if (top > at.y) top = Math.min(top, Math.max(at.y, childTop));
  if (right < currentRight) right = Math.max(right, Math.min(currentRight, childRight));
  if (bottom < currentBottom) bottom = Math.max(bottom, Math.min(currentBottom, childBottom));
  return { x: left - parentX, y: top - parentY, width: right - left, height: bottom - top };
}

export function canvasDescendantIds(
  nodes: readonly Groupable[],
  roots: ReadonlySet<string>,
): Set<string> {
  const ids = new Set(roots);
  let changed = true;
  while (changed) {
    changed = false;
    for (const node of nodes)
      if (node.parentId && ids.has(node.parentId) && !ids.has(node.id)) {
        ids.add(node.id);
        changed = true;
      }
  }
  return ids;
}

export function orderedCanvasNodes<T extends Groupable>(
  nodes: readonly T[],
): T[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const result: T[] = [],
    visited = new Set<string>();
  const visit = (node: T) => {
    if (visited.has(node.id)) return;
    visited.add(node.id);
    if (node.parentId) {
      const parent = byId.get(node.parentId);
      if (parent) visit(parent);
    }
    result.push(node);
  };
  nodes.forEach(visit);
  return result;
}

export function layoutPixelLevelGroups<T extends Groupable & { data: object }>(
  nodes: readonly T[],
): T[] {
  const groups = nodes
    .filter((node) => node.type === "group" && Boolean((node.data as { pixelStyle?: unknown }).pixelStyle) && !node.parentId)
    .sort((left, right) => left.position.x - right.position.x);
  if (groups.length < 2) return [...nodes];

  const positions = new Map<string, number>();
  let x = groups[0]!.position.x;
  for (const group of groups) {
    positions.set(group.id, x);
    x += (group.width ?? group.measured?.width ?? 560) + 40;
  }
  return nodes.map((node) => {
    const x = positions.get(node.id);
    return x === undefined ? node : { ...node, position: { ...node.position, x } };
  });
}

export function reparentCanvasNode<T extends Groupable>(
  node: T,
  parentId: string | undefined,
  nodes: readonly T[],
): T {
  const absolute = canvasAbsolutePosition(node, nodes);
  const parent = parentId && nodes.find((item) => item.id === parentId);
  const origin = parent
    ? canvasAbsolutePosition(parent, nodes)
    : { x: 0, y: 0 };
  return {
    ...node,
    parentId,
    position: { x: absolute.x - origin.x, y: absolute.y - origin.y },
  };
}

/** Grow frames around direct children, then propagate the new bounds through nested frames. */
/** Image and video nodes render up to a 28px label plus a 360px media stage before they are measured. */
const UNMEASURED_MEDIA_NODE_HEIGHT = 388;

function unmeasuredHeight(node: Groupable): number {
  return node.type === "image" || node.type === "video" ? UNMEASURED_MEDIA_NODE_HEIGHT : 320;
}

export function expandCanvasGroups<T extends Groupable>(
  nodes: readonly T[],
): T[] {
  let result = [...nodes];
  for (const group of orderedCanvasNodes(result).reverse()) {
    if (group.type !== "group") continue;
    const children = result.filter((node) => node.parentId === group.id);
    if (!children.length) continue;
    const width = group.width ?? 500,
      height = group.height ?? 400;
    const left = Math.min(0, ...children.map((node) => node.position.x - 16));
    const top = Math.min(0, ...children.map((node) => node.position.y - 36));
    const right = Math.max(
      width,
      ...children.map(
        (node) =>
          node.position.x + (node.width ?? node.measured?.width ?? 440) + 16,
      ),
    );
    const bottom = Math.max(
      height,
      ...children.map(
        (node) =>
          node.position.y + (node.height ?? node.measured?.height ?? unmeasuredHeight(node)) + 16,
      ),
    );
    const shiftX = right - left <= 4096 ? left : 0;
    const shiftY = bottom - top <= 4096 ? top : 0;
    const nextWidth = Math.min(4096, right - shiftX),
      nextHeight = Math.min(4096, bottom - shiftY);
    if (!shiftX && !shiftY && nextWidth === width && nextHeight === height)
      continue;
    result = result.map((node) =>
      node.id === group.id
        ? {
            ...node,
            position: {
              x: node.position.x + shiftX,
              y: node.position.y + shiftY,
            },
            width: nextWidth,
            height: nextHeight,
          }
        : node.parentId === group.id
          ? {
              ...node,
              position: {
                x: node.position.x - shiftX,
                y: node.position.y - shiftY,
              },
            }
          : node,
    );
  }
  return result;
}

/** Selected descendants move with their selected ancestor, even across unselected intermediate groups. */
export function canvasSelectionRoots<T extends Groupable>(
  nodes: readonly T[],
  ids: ReadonlySet<string>,
): T[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return nodes.filter((node) => {
    if (!ids.has(node.id)) return false;
    let parentId = node.parentId;
    const seen = new Set([node.id]);
    while (parentId && !seen.has(parentId)) {
      if (ids.has(parentId)) return false;
      seen.add(parentId);
      parentId = byId.get(parentId)?.parentId;
    }
    return true;
  });
}

export function canvasDropGroup(
  node: Groupable,
  nodes: readonly Groupable[],
  excluded: ReadonlySet<string> = new Set(),
): string | undefined {
  const blocked = canvasDescendantIds(nodes, new Set([node.id, ...excluded]));
  const point = canvasAbsolutePosition(node, nodes);
  const center = {
    x: point.x + (node.width ?? node.measured?.width ?? 440) / 2,
    y: point.y + (node.height ?? node.measured?.height ?? 320) / 2,
  };
  const byId = new Map(nodes.map((item) => [item.id, item]));
  const depth = (item: Groupable) => {
    let result = 0,
      parentId = item.parentId;
    const seen = new Set([item.id]);
    while (parentId && !seen.has(parentId)) {
      seen.add(parentId);
      result++;
      parentId = byId.get(parentId)?.parentId;
    }
    return result;
  };
  const target = nodes
    .filter(
      (candidate) => candidate.type === "group" && !blocked.has(candidate.id),
    )
    .reverse()
    .sort((a, b) => depth(b) - depth(a))
    .find((candidate) => {
      const at = canvasAbsolutePosition(candidate, nodes);
      return (
        center.x > at.x + 16 &&
        center.x < at.x + (candidate.width ?? 500) - 16 &&
        center.y > at.y + 36 &&
        center.y < at.y + (candidate.height ?? 400) - 16
      );
    });
  if (target) return target.id;
  const parent = node.parentId && byId.get(node.parentId);
  if (!parent || parent.type !== "group" || blocked.has(parent.id))
    return undefined;
  const at = canvasAbsolutePosition(parent, nodes);
  const width = node.width ?? node.measured?.width ?? 440;
  const height = node.height ?? node.measured?.height ?? 320;
  return point.x < at.x + (parent.width ?? 500) &&
    point.x + width > at.x &&
    point.y < at.y + (parent.height ?? 400) &&
    point.y + height > at.y
    ? parent.id
    : undefined;
}
