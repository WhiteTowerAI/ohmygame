import { useCallback, useEffect, useRef, useState } from "react";
import { Spinner, Scissors } from "./icons.js";
import { t } from "./i18n.js";
import { Button } from "./ui/index.js";
import { trimVideo, trimmedVideoType, type VideoTrim } from "./video-trim.js";
import { formatTime, VideoTrimEditor } from "./video-trim-editor.js";

export { formatTime } from "./video-trim-editor.js";

/**
 * Asset Studio persistence wrapper: encoding and uploading never run in the
 * shared editor. With `onCancel`, an unchanged trim offers Cancel beside Save.
 */
export function VideoTrimmer({
  url,
  label,
  loadSource,
  onSave,
  onCancel,
}: {
  url: string;
  label: string;
  loadSource: () => Promise<Blob>;
  onSave: (video: Blob, trim: VideoTrim) => Promise<void>;
  onCancel?: () => void;
}) {
  const { file, trim, setTrim, saving, error, save } = useVideoTrimSave(
    loadSource,
    onSave,
  );

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
            {trimSummary(selected, changed)}
          </span>
          {error ? (
            <span className="video-trimmer-error" role="alert">
              {error}
            </span>
          ) : null}
          {saving ? (
            <>
              <TrimProgress progress={saving.progress} />
              <Button
                disabled={saving.uploading}
                onClick={() => saving.controller.abort()}
              >
                {t("common.cancel")}
              </Button>
            </>
          ) : (
            <>
              {changed ? (
                <Button variant="ghost" onClick={reset}>
                  {t("videoTrim.reset")}
                </Button>
              ) : onCancel ? (
                <Button variant="ghost" onClick={onCancel}>
                  {t("common.cancel")}
                </Button>
              ) : null}
              <Button
                variant="primary"
                icon={<Scissors size="sm" />}
                disabled={!changed}
                title={t("videoTrim.saveTitle")}
                onClick={() => selected && void save(selected, pause)}
              >
                {t("videoTrim.save")}
              </Button>
            </>
          )}
        </div>
      )}
    />
  );
}

/**
 * The trim being edited and its save: encodes the kept part, then hands it to
 * `onSave`. Encoding can be cancelled through `saving.controller`; the upload
 * in `onSave` cannot, so `saving.uploading` marks when Cancel stops working.
 */
export function useVideoTrimSave(
  loadSource: () => Promise<Blob>,
  onSave: (video: Blob, trim: VideoTrim) => Promise<void>,
) {
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

  return { file, trim, setTrim, saving, error, save };
}

/** What the trim footer says: the kept range, or how to choose one. */
export function trimSummary(
  trim: VideoTrim | undefined,
  changed: boolean,
): string {
  return trim && changed
    ? t("videoTrim.kept", {
        start: formatTime(trim.start),
        end: formatTime(trim.end),
        length: (trim.end - trim.start).toFixed(1),
      })
    : t("videoTrim.hint");
}

export function TrimProgress({ progress }: { progress: number }) {
  return (
    <span
      className="video-trimmer-progress"
      role="progressbar"
      aria-label={t("videoTrim.saving")}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={Math.round(progress * 100)}
    >
      <Spinner size="sm" />
      {t("videoTrim.savingPercent", { percent: Math.round(progress * 100) })}
    </span>
  );
}

/** A trimmed video, named after the original with a trimmed suffix, for the caller to keep. */
export function trimmedVideoFile(video: Blob, originalName: string): { file: File; mediaType: ReturnType<typeof trimmedVideoType>["mediaType"] } {
  const type = trimmedVideoType(video.type);
  const stem = originalName.replace(/\.[^./]+$/, "") || "video";
  const name = `${t("videoTrim.fileName", { name: stem }).slice(0, 190)}.${type.extension}`;
  return { file: new File([video], name, { type: type.mediaType }), mediaType: type.mediaType };
}

