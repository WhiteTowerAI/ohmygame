import { describe, expect, it } from "vitest";
import { findCanvasAlignmentGuides, snapCanvasPosition } from "../src/renderer/canvas-alignment.js";

describe("canvas alignment guides", () => {
  it("snaps positions to the canvas grid", () => {
    expect(snapCanvasPosition({ x: 104, y: 196 })).toEqual({ x: 100, y: 200 });
  });

  it("reports exact center alignment without changing node positions", () => {
    const active = { id: "active", position: { x: 104, y: 80 }, alignmentFrame: { x: 104, y: 80, width: 80, height: 40 } };
    const candidate = { id: "candidate", position: { x: 64, y: 200 }, alignmentFrame: { x: 64, y: 200, width: 160, height: 40 } };

    expect(findCanvasAlignmentGuides(active, [candidate])).toEqual({
      vertical: [{ x: 144, from: 80, to: 240 }],
      horizontal: [],
    });
    expect(active.position).toEqual({ x: 104, y: 80 });
  });

  it("reports exact edge alignment on both axes", () => {
    const active = { id: "active", position: { x: 80, y: 120 }, alignmentFrame: { x: 80, y: 120, width: 120, height: 80 } };
    const candidate = { id: "candidate", position: { x: 80, y: 120 }, alignmentFrame: { x: 80, y: 120, width: 240, height: 160 } };

    expect(findCanvasAlignmentGuides(active, [candidate])).toEqual({
      vertical: [{ x: 80, from: 120, to: 280 }],
      horizontal: [{ y: 120, from: 80, to: 320 }],
    });
  });

  it("does not show a guide for merely nearby nodes", () => {
    const active = { id: "active", position: { x: 88, y: 128 }, alignmentFrame: { x: 88, y: 128, width: 120, height: 80 } };
    const candidate = { id: "candidate", position: { x: 80, y: 120 }, alignmentFrame: { x: 80, y: 120, width: 120, height: 80 } };

    expect(findCanvasAlignmentGuides(active, [candidate])).toBeUndefined();
  });

  it("uses the visual content frame instead of the full node wrapper", () => {
    const active = {
      id: "scene",
      position: { x: 80, y: 120 },
      alignmentFrame: { x: 100, y: 150, width: 200, height: 100 },
    };
    const candidate = {
      id: "choice",
      position: { x: 720, y: 360 },
      alignmentFrame: { x: 100, y: 400, width: 300, height: 100 },
    };

    expect(findCanvasAlignmentGuides(active, [candidate])).toEqual({
      vertical: [{ x: 100, from: 150, to: 500 }],
      horizontal: [],
    });
  });

  it("aligns a scene content frame with the complete Start frame", () => {
    const scene = {
      id: "scene",
      position: { x: 1_160, y: 210 },
      alignmentFrame: { x: 1_160, y: 240, width: 440, height: 248 },
    };
    const start = {
      id: "start",
      position: { x: 80, y: 240 },
      alignmentFrame: { x: 80, y: 240, width: 88, height: 40 },
    };

    expect(findCanvasAlignmentGuides(scene, [start])).toEqual({
      vertical: [],
      horizontal: [{ y: 240, from: 80, to: 1_600 }],
    });
  });

  it("reports top, center, and bottom guides when equal-sized frames align", () => {
    const active = { id: "scene", position: { x: 500, y: 200 }, alignmentFrame: { x: 500, y: 230, width: 440, height: 248 } };
    const candidate = { id: "open-ui", position: { x: 20, y: 200 }, alignmentFrame: { x: 20, y: 230, width: 440, height: 248 } };

    expect(findCanvasAlignmentGuides(active, [candidate])?.horizontal).toEqual([
      { y: 230, from: 20, to: 940 },
      { y: 354, from: 20, to: 940 },
      { y: 478, from: 20, to: 940 },
    ]);
  });

  it("shows center and bottom guides within half a grid step for dynamic-height nodes", () => {
    const active = { id: "state", position: { x: 500, y: 200 }, alignmentFrame: { x: 500, y: 200, width: 280, height: 64.5 } };
    const centerCandidate = { id: "center", position: { x: 20, y: 202.25 }, alignmentFrame: { x: 20, y: 202.25, width: 120, height: 60 } };
    const bottomCandidate = { id: "bottom", position: { x: 20, y: 204.5 }, alignmentFrame: { x: 20, y: 204.5, width: 120, height: 60 } };

    expect(findCanvasAlignmentGuides(active, [centerCandidate, bottomCandidate])?.horizontal).toEqual([
      { y: 202.25, from: 20, to: 780 },
      { y: 232.25, from: 20, to: 780 },
      { y: 264.5, from: 20, to: 780 },
    ]);
  });

  it("ignores nodes without an explicit visual content frame", () => {
    const active = { id: "active", position: { x: 80, y: 120 } };
    const candidate = { id: "candidate", position: { x: 80, y: 120 }, alignmentFrame: { x: 80, y: 120, width: 120, height: 80 } };

    expect(findCanvasAlignmentGuides(active, [candidate])).toBeUndefined();
    expect(findCanvasAlignmentGuides(candidate, [active])).toBeUndefined();
  });
});
