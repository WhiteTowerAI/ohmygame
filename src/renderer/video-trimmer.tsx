import { useCallback, useEffect, useRef, useState } from "react";
import type { LibraryAsset } from "../shared/contracts.js";
import { uploadLibraryAsset } from "./api.js";
import { LoaderCircle, Scissors } from "./icons.js";
import { t } from "./i18n.js";
import { trimVideo, trimmedVideoType, type VideoTrim } from "./video-trim.js";
import { formatTime, VideoTrimEditor } from "./video-trim-editor.js";

export { formatTime } from "./video-trim-editor.js";

/** Asset Studio persistence wrapper: encoding and uploading never run in the shared editor. */
export function VideoTrimmer({
  url,
  label,
  loadSource,
  onSave,
}: {
  url: string;
  label: string;
  loadSource: () => Promise<Blob>;
  onSave: (video: Blob, trim: VideoTrim) => Promise<void>;
}) {
  const source = useRef<Promise<Blob> | undefined>(undefined);
  const pending = useRef(false);
  const [trim, setTrim] = useState<VideoTrim>();
  const [saving, setSaving] = useState<{
    progress: number;
    controller: AbortController;
    uploading?: boolean;
  }>();
  const [error, setError] = useState<string>();
  const file = useCallback(
    () => (source.current ??= loadSource()),
    [loadSource],
  );

  useEffect(() => () => saving?.controller.abort(), [saving?.controller]);

  const save = async (selected: VideoTrim, pause: () => void) => {
    if (pending.current) return;
    pending.current = true;
    const controller = new AbortController();
    pause();
    setError(undefined);
    setSaving({ progress: 0, controller });
    try {
      const video = await trimVideo(await file(), selected, {
        signal: controller.signal,
        onProgress: (progress) =>
          setSaving((current) =>
            current?.controller === controller
              ? { ...current, progress }
              : current,
          ),
      });
      if (controller.signal.aborted) return;
      // Upload is not cancellable. Do not offer a Cancel button that cannot stop it.
      setSaving((current) =>
        current ? { ...current, uploading: true } : current,
      );
      await onSave(video, selected);
      setTrim(undefined);
    } catch (cause) {
      if (!controller.signal.aborted)
        setError(
          t("videoTrim.failed", {
            error: cause instanceof Error ? cause.message : String(cause),
          }),
        );
    } finally {
      pending.current = false;
      setSaving((current) =>
        current?.controller === controller ? undefined : current,
      );
    }
  };

  return (
    <VideoTrimEditor
      url={url}
      label={label}
      loadSource={file}
      trim={trim}
      onTrimChange={setTrim}
      disabled={Boolean(saving)}
      renderFooter={({ trim: selected, changed, reset, pause }) => (
        <div className="video-trimmer-footer">
          <span className="video-trimmer-summary" aria-live="polite">
            {selected && changed
              ? t("videoTrim.kept", {
                  start: formatTime(selected.start),
                  end: formatTime(selected.end),
                  length: (selected.end - selected.start).toFixed(1),
                })
              : t("videoTrim.hint")}
          </span>
          {error ? (
            <span className="video-trimmer-error" role="alert">
              {error}
            </span>
          ) : null}
          {saving ? (
            <>
              <span
                className="video-trimmer-progress"
                role="progressbar"
                aria-label={t("videoTrim.saving")}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={Math.round(saving.progress * 100)}
              >
                <LoaderCircle className="spin" size={14} />
                {t("videoTrim.savingPercent", {
                  percent: Math.round(saving.progress * 100),
                })}
              </span>
              <button
                type="button"
                disabled={saving.uploading}
                onClick={() => saving.controller.abort()}
              >
                {t("common.cancel")}
              </button>
            </>
          ) : (
            <>
              {changed ? (
                <button type="button" onClick={reset}>
                  {t("videoTrim.reset")}
                </button>
              ) : null}
              <button
                type="button"
                className="video-trimmer-save"
                disabled={!changed}
                title={t("videoTrim.saveTitle")}
                onClick={() => selected && void save(selected, pause)}
              >
                <Scissors size={14} />
                {t("videoTrim.save")}
              </button>
            </>
          )}
        </div>
      )}
    />
  );
}

/**
 * Uploads a trimmed video to the Library under the original's name with a
 * trimmed suffix, recording where it was cut from when the original is a
 * Library asset.
 */
export async function saveTrimmedVideo(
  video: Blob,
  trim: VideoTrim,
  original: { name: string; libraryAssetId?: string },
): Promise<LibraryAsset> {
  const type = trimmedVideoType(video.type);
  const stem = original.name.replace(/\.[^./]+$/, "") || "video";
  const name = `${t("videoTrim.fileName", { name: stem }).slice(0, 190)}.${type.extension}`;
  const kept = {
    start: roundMilliseconds(trim.start),
    end: roundMilliseconds(trim.end),
  };
  return uploadLibraryAsset(
    new File([video], name, { type: type.mediaType }),
    type.mediaType,
    roundMilliseconds(kept.end - kept.start),
    undefined,
    original.libraryAssetId
      ? { assetId: original.libraryAssetId, trim: kept }
      : undefined,
  );
}

function roundMilliseconds(seconds: number): number {
  return Math.round(seconds * 1000) / 1000;
}
