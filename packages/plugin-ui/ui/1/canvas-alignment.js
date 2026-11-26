// Grid snapping and alignment guides, shared by OhMyGame's own canvases
// (src/renderer/canvas-alignment.ts re-exports this module) and the
// `<omg-canvas>` page component, so both snap and align the same way.

export const CANVAS_GRID_SIZE = 10;

/** A position on the canvas grid. */
export function snapCanvasPosition(position) {
  return {
    x: Math.round(position.x / CANVAS_GRID_SIZE) * CANVAS_GRID_SIZE,
    y: Math.round(position.y / CANVAS_GRID_SIZE) * CANVAS_GRID_SIZE,
  };
}

const ALIGNMENT_THRESHOLD = CANVAS_GRID_SIZE / 2;
const VERTICAL_ANCHORS = ["left", "centerX", "right"];
const HORIZONTAL_ANCHORS = ["top", "centerY", "bottom"];

/**
 * The guides to show for a node being dragged: one for each of its edges and
 * centres within half a grid step of another node's, the nearest node
 * winning; undefined when nothing lines up.
 */
export function findCanvasAlignmentGuides(active, candidates) {
  const activeBounds = nodeBounds(active);
  if (!activeBounds) return undefined;

  const verticalMatches = new Map();
  const horizontalMatches = new Map();

  for (const candidate of candidates) {
    if (candidate.id === active.id) continue;
    const candidateBounds = nodeBounds(candidate);
    if (!candidateBounds) continue;

    const nodeYDistance = Math.abs(activeBounds.centerY - candidateBounds.centerY);
    for (const key of VERTICAL_ANCHORS) {
      const alignmentDistance = Math.abs(activeBounds[key] - candidateBounds[key]);
      if (!isCloserMatch(verticalMatches.get(key), alignmentDistance, nodeYDistance)) continue;
      verticalMatches.set(key, {
        alignmentDistance,
        nodeDistance: nodeYDistance,
        guide: {
          x: candidateBounds[key],
          from: Math.min(activeBounds.top, candidateBounds.top),
          to: Math.max(activeBounds.bottom, candidateBounds.bottom),
        },
      });
    }

    const nodeXDistance = Math.abs(activeBounds.centerX - candidateBounds.centerX);
    for (const key of HORIZONTAL_ANCHORS) {
      const alignmentDistance = Math.abs(activeBounds[key] - candidateBounds[key]);
      if (!isCloserMatch(horizontalMatches.get(key), alignmentDistance, nodeXDistance)) continue;
      horizontalMatches.set(key, {
        alignmentDistance,
        nodeDistance: nodeXDistance,
        guide: {
          y: candidateBounds[key],
          from: Math.min(activeBounds.left, candidateBounds.left),
          to: Math.max(activeBounds.right, candidateBounds.right),
        },
      });
    }
  }

  const vertical = mergeCoincidentGuides([...verticalMatches.values()].map(({ guide }) => guide), (guide) => guide.x);
  const horizontal = mergeCoincidentGuides([...horizontalMatches.values()].map(({ guide }) => guide), (guide) => guide.y);
  return vertical.length || horizontal.length ? { vertical, horizontal } : undefined;
}

function isCloserMatch(current, alignmentDistance, nodeDistance) {
  if (alignmentDistance > ALIGNMENT_THRESHOLD) return false;
  if (!current || alignmentDistance < current.alignmentDistance) return true;
  return alignmentDistance === current.alignmentDistance && nodeDistance < current.nodeDistance;
}

function mergeCoincidentGuides(guides, coordinate) {
  const result = [];
  for (const guide of guides) {
    const existing = result.find((candidate) => Math.abs(coordinate(candidate) - coordinate(guide)) <= 0.5);
    if (existing) {
      existing.from = Math.min(existing.from, guide.from);
      existing.to = Math.max(existing.to, guide.to);
    } else {
      result.push({ ...guide });
    }
  }
  return result;
}

function nodeBounds(node) {
  if (!node.alignmentFrame) return undefined;
  const { x, y, width, height } = node.alignmentFrame;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
  return { left: x, centerX: x + width / 2, right: x + width, top: y, centerY: y + height / 2, bottom: y + height };
}
