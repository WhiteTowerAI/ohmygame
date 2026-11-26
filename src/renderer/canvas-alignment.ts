// Grid snapping and alignment guides live with the page components, so the
// app's canvases and plugins' <omg-canvas> snap and align the same way.
export {
  CANVAS_GRID_SIZE,
  findCanvasAlignmentGuides,
  snapCanvasPosition,
  type CanvasAlignmentGuides,
  type CanvasAlignmentNode,
} from "../../packages/plugin-ui/ui/1/canvas-alignment.js";
