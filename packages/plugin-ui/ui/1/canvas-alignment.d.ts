// Types for canvas-alignment.js, which OhMyGame's canvases and <omg-canvas> share.

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

export declare const CANVAS_GRID_SIZE: 10;
export declare function snapCanvasPosition(position: { x: number; y: number }): { x: number; y: number };
export declare function findCanvasAlignmentGuides(
  active: CanvasAlignmentNode,
  candidates: readonly CanvasAlignmentNode[],
): CanvasAlignmentGuides | undefined;
