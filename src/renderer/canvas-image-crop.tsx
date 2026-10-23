import { useEffect, useRef, useState, type PointerEvent } from "react";
import { createPortal } from "react-dom";
import { NodeToolbar, Position } from "@xyflow/react";
import { Check, LoaderCircle, X } from "./icons.js";
import { t } from "./i18n.js";

type Point = { x: number; y: number };
type Crop = { left: number; top: number; width: number; height: number };
const clamp = (value: number, min: number, max: number) =>
  Math.max(min, Math.min(max, value));
const handles = ["nw", "n", "ne", "e", "se", "s", "sw", "w"] as const;

/** The overlay lives inside the source stage, so pan/zoom never changes crop coordinates. */
export function CanvasImageCrop({
  nodeId,
  busy,
  error,
  onClose,
  onSubmit,
}: {
  nodeId: string;
  busy: boolean;
  error?: string;
  onClose: () => void;
  onSubmit: (crop: Crop) => void;
}) {
  const [stage, setStage] = useState<HTMLElement>();
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [imageBounds, setImageBounds] = useState<Crop>();
  const [crop, setCrop] = useState<Crop>({
    left: 0,
    top: 0,
    width: 0,
    height: 0,
  });
  const [aspect, setAspect] = useState("free");
  const drag = useRef<{ start: Point; crop: Crop; handle: string } | undefined>(
    undefined,
  );
  useEffect(() => {
    const element = document.querySelector<HTMLElement>(
      `.react-flow__node[data-id="${CSS.escape(nodeId)}"] .story-media-stage`,
    );
    if (!element) return;
    setStage(element);
    const measureBounds = () => {
      const image = element.querySelector("img");
      if (!image?.naturalWidth || !image.naturalHeight) return;
      const scale = Math.min(
        element.clientWidth / image.naturalWidth,
        element.clientHeight / image.naturalHeight,
      );
      const width = image.naturalWidth * scale;
      const height = image.naturalHeight * scale;
      setImageBounds({
        left: (element.clientWidth - width) / 2,
        top: (element.clientHeight - height) / 2,
        width,
        height,
      });
    };
    const measure = () => {
      const image = element.querySelector("img");
      if (!image?.naturalWidth || !image.naturalHeight) return;
      setSize({ width: image.naturalWidth, height: image.naturalHeight });
      setCrop({
        left: 0,
        top: 0,
        width: image.naturalWidth,
        height: image.naturalHeight,
      });
      measureBounds();
    };
    measure();
    const observer = new ResizeObserver(measureBounds);
    observer.observe(element);
    element.addEventListener("load", measure, true);
    return () => {
      observer.disconnect();
      element.removeEventListener("load", measure, true);
    };
  }, [nodeId]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopImmediatePropagation();
        if (!busy) onClose();
      }
    };
    document.addEventListener("keydown", escape, true);
    return () => document.removeEventListener("keydown", escape, true);
  }, [busy, onClose]);
  const ratio =
    aspect === "original"
      ? size.width / size.height
      : aspect === "free"
        ? undefined
        : Number(aspect);
  function chooseAspect(value: string) {
    setAspect(value);
    if (value === "free") return;
    const nextRatio =
      value === "original" ? size.width / size.height : Number(value);
    const width = Math.min(size.width, size.height * nextRatio);
    const height = width / nextRatio;
    setCrop({
      left: (size.width - width) / 2,
      top: (size.height - height) / 2,
      width,
      height,
    });
  }
  function point(event: PointerEvent<SVGSVGElement>): Point {
    const bounds = event.currentTarget.getBoundingClientRect();
    return {
      x: clamp(
        ((event.clientX - bounds.left) / bounds.width) * size.width,
        0,
        size.width,
      ),
      y: clamp(
        ((event.clientY - bounds.top) / bounds.height) * size.height,
        0,
        size.height,
      ),
    };
  }
  function move(event: PointerEvent<SVGSVGElement>) {
    const current = drag.current;
    if (!current || busy) return;
    const next = point(event);
    const { crop: initial, start, handle } = current;
    if (handle === "move") {
      setCrop({
        ...initial,
        left: clamp(
          initial.left + next.x - start.x,
          0,
          size.width - initial.width,
        ),
        top: clamp(
          initial.top + next.y - start.y,
          0,
          size.height - initial.height,
        ),
      });
      return;
    }
    const anchorX =
      handle === "draw"
        ? start.x
        : handle.includes("w")
          ? initial.left + initial.width
          : initial.left;
    const anchorY =
      handle === "draw"
        ? start.y
        : handle.includes("n")
          ? initial.top + initial.height
          : initial.top;
    let x =
      handle === "n" || handle === "s" ? initial.left + initial.width : next.x;
    let y =
      handle === "e" || handle === "w" ? initial.top + initial.height : next.y;
    if (ratio) {
      const signX = x < anchorX ? -1 : 1;
      const signY = y < anchorY ? -1 : 1;
      let width = Math.abs(x - anchorX);
      let height = Math.abs(y - anchorY);
      if (handle === "n" || handle === "s" || height * ratio > width)
        width = height * ratio;
      else height = width / ratio;
      if (!width || !height) return;
      const scale = Math.min(
        1,
        (signX > 0 ? size.width - anchorX : anchorX) / width,
        (signY > 0 ? size.height - anchorY : anchorY) / height,
      );
      x = anchorX + signX * width * scale;
      y = anchorY + signY * height * scale;
    }
    setCrop({
      left: Math.min(anchorX, x),
      top: Math.min(anchorY, y),
      width: Math.abs(x - anchorX),
      height: Math.abs(y - anchorY),
    });
  }
  const integerCrop = {
    left: Math.floor(crop.left),
    top: Math.floor(crop.top),
    width: Math.min(size.width - Math.floor(crop.left), Math.round(crop.width)),
    height: Math.min(
      size.height - Math.floor(crop.top),
      Math.round(crop.height),
    ),
  };
  return (
    <>
      {stage && size.width
        ? createPortal(
            <svg
              className="asset-inline-crop nodrag nopan nokey"
              style={imageBounds}
              viewBox={`0 0 ${size.width} ${size.height}`}
              preserveAspectRatio="none"
              aria-label={t("assetCanvas.mediaTools.cropHint")}
              onDoubleClick={(event) => event.stopPropagation()}
              onPointerDown={(event) => {
                event.stopPropagation();
                if (busy || event.button !== 0) return;
                event.preventDefault();
                event.currentTarget.setPointerCapture(event.pointerId);
                const handle =
                  (event.target as SVGElement).getAttribute("data-handle") ??
                  "draw";
                drag.current = { start: point(event), crop, handle };
              }}
              onPointerMove={move}
              onPointerUp={() => {
                drag.current = undefined;
              }}
              onPointerCancel={() => {
                drag.current = undefined;
              }}
            >
              <path
                className="asset-inline-crop-shade"
                fillRule="evenodd"
                d={`M0 0H${size.width}V${size.height}H0Z M${crop.left} ${crop.top}v${crop.height}h${crop.width}v-${crop.height}Z`}
              />
              <rect
                className="asset-inline-crop-selection"
                data-handle="move"
                x={crop.left}
                y={crop.top}
                width={crop.width}
                height={crop.height}
              />
              {[1, 2].map((third) => (
                <g className="asset-inline-crop-guides" key={third}>
                  <line
                    x1={crop.left + (crop.width * third) / 3}
                    x2={crop.left + (crop.width * third) / 3}
                    y1={crop.top}
                    y2={crop.top + crop.height}
                  />
                  <line
                    y1={crop.top + (crop.height * third) / 3}
                    y2={crop.top + (crop.height * third) / 3}
                    x1={crop.left}
                    x2={crop.left + crop.width}
                  />
                </g>
              ))}
              {handles.map((handle) => (
                <svg
                  key={handle}
                  x={
                    crop.left +
                    crop.width *
                      (handle.includes("w")
                        ? 0
                        : handle.includes("e")
                          ? 1
                          : 0.5)
                  }
                  y={
                    crop.top +
                    crop.height *
                      (handle.includes("n")
                        ? 0
                        : handle.includes("s")
                          ? 1
                          : 0.5)
                  }
                  overflow="visible"
                >
                  <rect
                    className={`asset-inline-crop-handle is-${handle}`}
                    data-handle={handle}
                    x={-size.width / 80}
                    y={-size.height / 80}
                    width={size.width / 40}
                    height={size.height / 40}
                  />
                </svg>
              ))}
            </svg>,
            stage,
          )
        : null}
      <NodeToolbar
        nodeId={nodeId}
        isVisible
        position={Position.Bottom}
        offset={12}
        className="asset-crop-panel nodrag nopan nokey nowheel"
      >
        <div
          className="asset-crop-controls"
          role="group"
          aria-label={t("assetCanvas.mediaTools.crop-image")}
          onPointerDown={(event) => event.stopPropagation()}
          onKeyDown={(event) => event.stopPropagation()}
        >
          <select
            aria-label={t("assetCanvas.mediaTools.cropAspect")}
            value={aspect}
            disabled={busy || !size.width}
            onChange={(event) => chooseAspect(event.target.value)}
          >
            <option value="free">{t("assetCanvas.mediaTools.cropFree")}</option>
            <option value="original">
              {t("assetCanvas.mediaTools.cropOriginal")}
            </option>
            {[1, 4 / 3, 3 / 4, 16 / 9, 9 / 16].map((value, index) => (
              <option key={value} value={value}>
                {["1:1", "4:3", "3:4", "16:9", "9:16"][index]}
              </option>
            ))}
          </select>
          <span>
            {integerCrop.width} × {integerCrop.height}
          </span>
          <button
            type="button"
            disabled={busy}
            aria-label={t("common.cancel")}
            onClick={onClose}
          >
            <X size={16} />
          </button>
          <button
            type="button"
            className="asset-crop-confirm"
            disabled={busy || integerCrop.width < 1 || integerCrop.height < 1}
            onClick={() => onSubmit(integerCrop)}
          >
            {busy ? (
              <LoaderCircle size={16} className="spin" />
            ) : (
              <Check size={16} />
            )}
            {t("assetCanvas.mediaTools.cropConfirm")}
          </button>
        </div>
        {error ? (
          <p className="asset-media-tool-error" role="alert">
            {error}
          </p>
        ) : null}
      </NodeToolbar>
    </>
  );
}
