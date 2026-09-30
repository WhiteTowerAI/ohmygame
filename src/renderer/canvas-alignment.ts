export interface CanvasAlignmentNode {
  id: string;
  alignmentFrame?: { x: number; y: number; width: number; height: number };
}

interface GuideRange { from: number; to: number }
interface VerticalGuide extends GuideRange { x: number }
interface HorizontalGuide extends GuideRange { y: number }

export interface CanvasAlignmentGuides {
  vertical: VerticalGuide[];
  horizontal: HorizontalGuide[];
}

interface NodeBounds {
  left: number;
  centerX: number;
  right: number;
  top: number;
  centerY: number;
  bottom: number;
}

export const CANVAS_GRID_SIZE = 10;
const ALIGNMENT_THRESHOLD = CANVAS_GRID_SIZE / 2;
const VERTICAL_ANCHORS = ["left", "centerX", "right"] as const;
const HORIZONTAL_ANCHORS = ["top", "centerY", "bottom"] as const;
type VerticalAnchor = (typeof VERTICAL_ANCHORS)[number];
type HorizontalAnchor = (typeof HORIZONTAL_ANCHORS)[number];

interface AlignmentMatch<TGuide extends GuideRange> {
  guide: TGuide;
  alignmentDistance: number;
  nodeDistance: number;
}

export function findCanvasAlignmentGuides(
  active: CanvasAlignmentNode,
  candidates: readonly CanvasAlignmentNode[],
): CanvasAlignmentGuides | undefined {
  const activeBounds = nodeBounds(active);
  if (!activeBounds) return undefined;

  const verticalMatches = new Map<VerticalAnchor, AlignmentMatch<VerticalGuide>>();
  const horizontalMatches = new Map<HorizontalAnchor, AlignmentMatch<HorizontalGuide>>();

  for (const candidate of candidates) {
    if (candidate.id === active.id) continue;
    const candidateBounds = nodeBounds(candidate);
    if (!candidateBounds) continue;

    const nodeYDistance = Math.abs(activeBounds.centerY - candidateBounds.centerY);
    for (const key of VERTICAL_ANCHORS) {
      const alignmentDistance = Math.abs(activeBounds[key] - candidateBounds[key]);
      const current = verticalMatches.get(key);
      if (!isCloserMatch(current, alignmentDistance, nodeYDistance)) continue;
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
      const current = horizontalMatches.get(key);
      if (!isCloserMatch(current, alignmentDistance, nodeXDistance)) continue;
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

function isCloserMatch<TGuide extends GuideRange>(current: AlignmentMatch<TGuide> | undefined, alignmentDistance: number, nodeDistance: number): boolean {
  if (alignmentDistance > ALIGNMENT_THRESHOLD) return false;
  if (!current || alignmentDistance < current.alignmentDistance) return true;
  return alignmentDistance === current.alignmentDistance && nodeDistance < current.nodeDistance;
}

function mergeCoincidentGuides<T extends GuideRange>(guides: T[], coordinate: (guide: T) => number): T[] {
  const result: T[] = [];
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

function nodeBounds(node: CanvasAlignmentNode): NodeBounds | undefined {
  if (!node.alignmentFrame) return undefined;
  const { x, y, width, height } = node.alignmentFrame;
  if (!Number.isFinite(x) || !Number.isFinite(y) || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0) return undefined;
  return { left: x, centerX: x + width / 2, right: x + width, top: y, centerY: y + height / 2, bottom: y + height };
}
