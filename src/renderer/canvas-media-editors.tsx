import { useEffect, useRef, useState, type ImgHTMLAttributes } from "react";
import { ChevronLeft, ChevronRight } from "./icons.js";
import { t } from "./i18n.js";
import { useWorkspaceAssetUrl } from "./use-workspace-asset-url.js";

export interface CanvasLayerSetting {
  assetId: string;
  x: number;
  y: number;
  scale: number;
  opacity: number;
  visible: boolean;
}

function LayerImage({
  assetId,
  onSize,
  ...imageProps
}: {
  assetId: string;
  onSize?: (width: number, height: number) => void;
} & Omit<ImgHTMLAttributes<HTMLImageElement>, "src" | "alt" | "onLoad">) {
  const preview = useWorkspaceAssetUrl(undefined, "", 0, assetId);
  return preview.url ? (
    <img
      {...imageProps}
      src={preview.url}
      alt=""
      onLoad={(event) =>
        onSize?.(
          event.currentTarget.naturalWidth,
          event.currentTarget.naturalHeight,
        )
      }
    />
  ) : null;
}

export function CanvasLayerEditor({
  layers,
  onChange,
  width,
  height,
  onFirstSize,
  disabled,
}: {
  layers: CanvasLayerSetting[];
  onChange: (layers: CanvasLayerSetting[]) => void;
  width: number;
  height: number;
  onFirstSize: (width: number, height: number) => void;
  disabled: boolean;
}) {
  const [sizes, setSizes] = useState<
    Record<string, { width: number; height: number }>
  >({});
  const stage = useRef<HTMLDivElement>(null);
  const dragging = useRef<
    | { index: number; clientX: number; clientY: number; x: number; y: number }
    | undefined
  >(undefined);
  const update = (index: number, patch: Partial<CanvasLayerSetting>) =>
    onChange(
      layers.map((layer, position) =>
        position === index ? { ...layer, ...patch } : layer,
      ),
    );
  const move = (index: number, target: number) => {
    const next = [...layers];
    [next[index], next[target]] = [next[target]!, next[index]!];
    onChange(next);
  };
  const setSize = (
    assetId: string,
    imageWidth: number,
    imageHeight: number,
  ) => {
    if (!imageWidth || !imageHeight) return;
    setSizes((current) =>
      current[assetId]?.width === imageWidth &&
      current[assetId]?.height === imageHeight
        ? current
        : { ...current, [assetId]: { width: imageWidth, height: imageHeight } },
    );
    if (assetId === layers[0]?.assetId) onFirstSize(imageWidth, imageHeight);
  };
  return (
    <div className="asset-layer-editor">
      <div
        ref={stage}
        className="asset-layer-stage"
        style={{
          aspectRatio: `${width || 1} / ${height || 1}`,
          maxWidth: Math.min(600, (360 * (width || 1)) / (height || 1)),
        }}
        aria-label={t("assetCanvas.mediaTools.layerPreview")}
      >
        {layers.map((layer, index) => (
          <LayerImage
            key={`${layer.assetId}-${index}`}
            assetId={layer.assetId}
            className="asset-layer-stage-image"
            onSize={(w, h) => setSize(layer.assetId, w, h)}
            style={{
              display: layer.visible ? undefined : "none",
              left: `${(layer.x / (width || 1)) * 100}%`,
              top: `${(layer.y / (height || 1)) * 100}%`,
              width: `${(((sizes[layer.assetId]?.width ?? 0) * layer.scale) / (width || 1)) * 100}%`,
              opacity: layer.opacity,
            }}
            onPointerDown={(event) => {
              if (disabled) return;
              event.currentTarget.setPointerCapture(event.pointerId);
              dragging.current = {
                index,
                clientX: event.clientX,
                clientY: event.clientY,
                x: layer.x,
                y: layer.y,
              };
            }}
            onPointerMove={(event) => {
              const drag = dragging.current;
              if (!drag || drag.index !== index || !stage.current) return;
              const bounds = stage.current.getBoundingClientRect();
              if (!bounds.width || !bounds.height) return;
              update(index, {
                x: Math.round(
                  drag.x +
                    ((event.clientX - drag.clientX) * width) / bounds.width,
                ),
                y: Math.round(
                  drag.y +
                    ((event.clientY - drag.clientY) * height) / bounds.height,
                ),
              });
            }}
            onPointerUp={() => {
              dragging.current = undefined;
            }}
            onLostPointerCapture={() => {
              dragging.current = undefined;
            }}
          />
        ))}
      </div>
      <ol className="asset-layer-list">
        {layers.map((layer, index) => (
          <li key={`${layer.assetId}-${index}`}>
            <div className="asset-layer-heading">
              <LayerImage
                assetId={layer.assetId}
                className="asset-layer-thumb"
                onSize={(w, h) => setSize(layer.assetId, w, h)}
              />
              <strong>
                {t("assetCanvas.mediaTools.layerNumber", { count: index + 1 })}
              </strong>
              <label className="asset-layer-visible">
                <input
                  type="checkbox"
                  checked={layer.visible}
                  disabled={disabled}
                  onChange={(event) =>
                    update(index, { visible: event.target.checked })
                  }
                />
                {t("assetCanvas.mediaTools.visible")}
              </label>
              <button
                type="button"
                title={t("assetCanvas.mediaTools.moveEarlier")}
                aria-label={t("assetCanvas.mediaTools.moveEarlier")}
                disabled={disabled || index === 0}
                onClick={() => move(index, index - 1)}
              >
                <ChevronLeft size={16} />
              </button>
              <button
                type="button"
                title={t("assetCanvas.mediaTools.moveLater")}
                aria-label={t("assetCanvas.mediaTools.moveLater")}
                disabled={disabled || index === layers.length - 1}
                onClick={() => move(index, index + 1)}
              >
                <ChevronRight size={16} />
              </button>
            </div>
            <div className="asset-layer-fields">
              {(["x", "y"] as const).map((axis) => (
                <label key={axis}>
                  <span>{axis.toUpperCase()}</span>
                  <input
                    type="number"
                    min={-16384}
                    max={16384}
                    value={layer[axis]}
                    disabled={disabled}
                    onChange={(event) =>
                      update(index, { [axis]: Number(event.target.value) })
                    }
                  />
                </label>
              ))}
              <label>
                <span>{t("assetCanvas.mediaTools.scale")}</span>
                <input
                  type="number"
                  min={5}
                  max={800}
                  value={Math.round(layer.scale * 100)}
                  disabled={disabled}
                  onChange={(event) =>
                    update(index, { scale: Number(event.target.value) / 100 })
                  }
                />
              </label>
              <label>
                <span>{t("assetCanvas.mediaTools.opacity")}</span>
                <input
                  type="number"
                  min={0}
                  max={100}
                  value={Math.round(layer.opacity * 100)}
                  disabled={disabled}
                  onChange={(event) =>
                    update(index, { opacity: Number(event.target.value) / 100 })
                  }
                />
              </label>
            </div>
          </li>
        ))}
      </ol>
    </div>
  );
}

export function CanvasGridPreview({
  url,
  columns,
  rows,
}: {
  url?: string;
  columns: number;
  rows: number;
}) {
  if (
    !url ||
    !Number.isInteger(columns) ||
    !Number.isInteger(rows) ||
    columns < 1 ||
    rows < 1 ||
    columns * rows > 1000
  )
    return null;
  return (
    <div className="asset-media-source-preview">
      <img src={url} alt="" />
      {Array.from({ length: columns - 1 }, (_, index) => (
        <span
          key={`c${index}`}
          className="asset-media-grid-line is-column"
          style={{ left: `${((index + 1) * 100) / columns}%` }}
        />
      ))}
      {Array.from({ length: rows - 1 }, (_, index) => (
        <span
          key={`r${index}`}
          className="asset-media-grid-line is-row"
          style={{ top: `${((index + 1) * 100) / rows}%` }}
        />
      ))}
    </div>
  );
}

export function CanvasVideoFrameEditor({
  url,
  fps,
  startTime,
  duration,
  selected,
  onSelected,
  onPreviewUnavailable,
  disabled,
}: {
  url?: string;
  fps: number;
  startTime: number;
  duration?: number;
  selected: number[];
  onSelected: (selected: number[]) => void;
  onPreviewUnavailable: (unavailable: boolean) => void;
  disabled: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [videoDuration, setVideoDuration] = useState(0);
  const [active, setActive] = useState(0);
  const [page, setPage] = useState(0);
  const available = Math.max(
    0,
    Math.min(duration ?? videoDuration, videoDuration - startTime),
  );
  const count =
    Number.isFinite(fps) && fps > 0 && Number.isFinite(available)
      ? Math.min(1000, Math.ceil(available * fps))
      : 0;
  useEffect(() => {
    onSelected(Array.from({ length: count }, (_, index) => index));
    setPage(0);
  }, [count, onSelected]);
  const seek = (index: number) => {
    if (!video.current) return;
    video.current.pause();
    video.current.currentTime = startTime + index / fps;
    setActive(index);
  };
  const selectedSet = new Set(selected);
  const pageCount = Math.ceil(count / 40);
  return (
    <div className="asset-video-frame-editor">
      {url ? (
        <video
          ref={video}
          src={url}
          controls
          preload="metadata"
          aria-label={t("assetCanvas.mediaTools.animationPreview")}
          onLoadedMetadata={(event) => {
            const length = event.currentTarget.duration;
            onPreviewUnavailable(!Number.isFinite(length));
            setVideoDuration(Number.isFinite(length) ? length : 0);
          }}
          onError={() => onPreviewUnavailable(true)}
          onTimeUpdate={(event) =>
            setActive(
              Math.max(
                0,
                Math.min(
                  count - 1,
                  Math.floor(
                    (event.currentTarget.currentTime - startTime) * fps,
                  ),
                ),
              ),
            )
          }
        />
      ) : null}
      {count ? (
        <>
          <div className="asset-video-frame-actions">
            <span>
              {t("assetCanvas.mediaTools.selectedFrames", {
                count: selected.length,
              })}
            </span>
            <button
              type="button"
              disabled={disabled}
              onClick={() =>
                onSelected(Array.from({ length: count }, (_, index) => index))
              }
            >
              {t("assetCanvas.mediaTools.selectAll")}
            </button>
            <button
              type="button"
              disabled={disabled || !selected.length}
              onClick={() => onSelected([])}
            >
              {t("assetCanvas.mediaTools.clearSelection")}
            </button>
          </div>
          <div className="asset-video-frame-strip">
            {Array.from(
              { length: Math.min(40, count - page * 40) },
              (_, offset) => {
                const index = page * 40 + offset;
                return (
                  <button
                    key={index}
                    type="button"
                    aria-label={t("assetCanvas.mediaTools.frameNumber", {
                      count: index + 1,
                    })}
                    aria-pressed={selectedSet.has(index)}
                    className={index === active ? "is-active" : undefined}
                    disabled={disabled}
                    onClick={() => {
                      seek(index);
                      onSelected(
                        selectedSet.has(index)
                          ? selected.filter((frame) => frame !== index)
                          : [...selected, index].sort((a, b) => a - b),
                      );
                    }}
                  >
                    {index + 1}
                  </button>
                );
              },
            )}
          </div>
          {pageCount > 1 ? (
            <div className="asset-video-frame-pages">
              <button
                type="button"
                aria-label={t("assetCanvas.mediaTools.previousPage")}
                disabled={page === 0}
                onClick={() => setPage(page - 1)}
              >
                <ChevronLeft size={16} />
              </button>
              <span>
                {page + 1} / {pageCount}
              </span>
              <button
                type="button"
                aria-label={t("assetCanvas.mediaTools.nextPage")}
                disabled={page === pageCount - 1}
                onClick={() => setPage(page + 1)}
              >
                <ChevronRight size={16} />
              </button>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
