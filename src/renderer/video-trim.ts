import type { LibraryUploadMediaType } from "../shared/contracts.js";

/** The part of a video to keep, in seconds from the start of the file. */
export interface VideoTrim {
  start: number;
  end: number;
}

/** The shortest part of a video a trim keeps, in seconds. */
export const MIN_TRIM_SECONDS = 0.1;

/** Bounds, in bits per second, for the bitrate a trimmed video is encoded at. */
const MIN_BITRATE = 1_000_000;
const MAX_BITRATE = 20_000_000;
/** Packets read to estimate the source's bitrate. */
const BITRATE_SAMPLE_PACKETS = 300;

/**
 * The file a trimmed video is saved as. WebM stays WebM; anything else, such
 * as MP4 or QuickTime, becomes MP4, which plays everywhere a game runs.
 */
export function trimmedVideoType(contentType: string): {
  mediaType: Extract<LibraryUploadMediaType, "video/mp4" | "video/webm">;
  extension: "mp4" | "webm";
} {
  return contentType === "video/webm"
    ? { mediaType: "video/webm", extension: "webm" }
    : { mediaType: "video/mp4", extension: "mp4" };
}

/** Keeps a trim inside the video and at least `MIN_TRIM_SECONDS` long. */
export function clampVideoTrim(trim: VideoTrim, duration: number): VideoTrim {
  const end = Math.min(Math.max(trim.end, MIN_TRIM_SECONDS), duration);
  const start = Math.min(
    Math.max(trim.start, 0),
    Math.max(0, end - MIN_TRIM_SECONDS),
  );
  return { start, end };
}

/** Whether the trim keeps the whole video, so there is nothing to save. */
export function isWholeVideo(trim: VideoTrim, duration: number): boolean {
  return trim.start < 0.005 && trim.end > duration - 0.005;
}

/**
 * Encodes the trimmed part of a video as a new file, cut exactly where the
 * trim says: the video and audio are re-encoded rather than copied from the
 * nearest keyframes. Rejects with an AbortError when `signal` aborts.
 */
export async function trimVideo(
  source: Blob,
  trim: VideoTrim,
  options: {
    onProgress?: (progress: number) => void;
    signal?: AbortSignal;
  } = {},
): Promise<Blob> {
  const {
    ALL_FORMATS,
    BlobSource,
    BufferTarget,
    Conversion,
    ConversionCanceledError,
    Input,
    Mp4OutputFormat,
    Output,
    WebMOutputFormat,
  } = await import("mediabunny");
  const type = trimmedVideoType(source.type);
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(source),
  });
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video) throw new Error("The file has no video track.");
    const stats = await video.computePacketStats(BITRATE_SAMPLE_PACKETS);
    const bitrate = Math.round(
      Math.min(
        Math.max(stats.averageBitrate || MAX_BITRATE / 2, MIN_BITRATE),
        MAX_BITRATE,
      ),
    );
    const output = new Output({
      format:
        type.extension === "webm"
          ? new WebMOutputFormat()
          : new Mp4OutputFormat(),
      target: new BufferTarget(),
    });
    const conversion = await Conversion.init({
      input,
      output,
      trim,
      video: { forceTranscode: true, bitrate },
      audio: { forceTranscode: true },
    });
    if (!conversion.isValid) {
      throw new Error(
        `The video cannot be encoded here: ${conversion.discardedTracks.map((track) => track.reason).join(", ")}.`,
      );
    }
    const abort = () => void conversion.cancel();
    options.signal?.addEventListener("abort", abort, { once: true });
    if (options.onProgress) conversion.onProgress = options.onProgress;
    try {
      if (options.signal?.aborted) await conversion.cancel();
      await conversion.execute();
    } catch (cause) {
      if (cause instanceof ConversionCanceledError)
        throw new DOMException("The trim was cancelled.", "AbortError");
      throw cause;
    } finally {
      options.signal?.removeEventListener("abort", abort);
    }
    const buffer = output.target.buffer;
    if (!buffer) throw new Error("The trimmed video is empty.");
    return new Blob([buffer], { type: type.mediaType });
  } finally {
    input.dispose();
  }
}

/**
 * Small frames spread across a video, as JPEG data URLs in order, for the
 * strip under the trim handles. Frames that cannot be read are skipped.
 */
export async function videoFilmstrip(
  source: Blob,
  count: number,
  height: number,
): Promise<string[]> {
  const { ALL_FORMATS, BlobSource, CanvasSink, Input } =
    await import("mediabunny");
  const input = new Input({
    formats: ALL_FORMATS,
    source: new BlobSource(source),
  });
  try {
    const video = await input.getPrimaryVideoTrack();
    if (!video || !(await video.canDecode())) return [];
    const start = await video.getFirstTimestamp();
    const duration = (await video.computeDuration()) - start;
    const sink = new CanvasSink(video, {
      height,
      fit: "cover",
      width: Math.round((height * 16) / 9),
      poolSize: 1,
    });
    const timestamps = Array.from(
      { length: count },
      (_, index) => start + (duration * (index + 0.5)) / count,
    );
    const frames: string[] = [];
    for await (const frame of sink.canvasesAtTimestamps(timestamps)) {
      if (!frame) continue;
      const canvas = frame.canvas;
      frames.push(
        "toDataURL" in canvas
          ? canvas.toDataURL("image/jpeg", 0.7)
          : await blobDataUrl(
              await canvas.convertToBlob({ type: "image/jpeg", quality: 0.7 }),
            ),
      );
    }
    return frames;
  } finally {
    input.dispose();
  }
}

function blobDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(String(reader.result));
    reader.onerror = () => reject(reader.error);
    reader.readAsDataURL(blob);
  });
}
