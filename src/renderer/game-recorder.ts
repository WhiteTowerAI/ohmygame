import {
  canEncodeAudio,
  canEncodeVideo,
  MediaStreamAudioTrackSource,
  MediaStreamVideoTrackSource,
  Mp4OutputFormat,
  Output,
  StreamTarget,
  WebMOutputFormat,
} from "mediabunny";
import type { GameRecorderHostBridge, GameRecorderSettings, GameRecorderStarted } from "../shared/game-recording.js";

// The page in the hidden recorder window. The desktop aims its display capture
// at the game, so this page records the game's own frame, HTML included, and
// sends the file out piece by piece instead of holding it in memory.
const host = (window as unknown as { ohMyGameRecorder: GameRecorderHostBridge }).ohMyGameRecorder;
const AUDIO_BITRATE = 128_000;
const KEY_FRAME_SECONDS = 2;
const CHUNK_BYTES = 1024 * 1024;

/** H.264 plays everywhere, but not every machine can encode it. */
async function format(settings: GameRecorderSettings) {
  const size = { width: settings.maxEdge, height: settings.maxEdge, bitrate: settings.bitrate };
  if (await canEncodeVideo("avc", size) && await canEncodeAudio("aac", { bitrate: AUDIO_BITRATE })) {
    return {
      video: "avc", audio: "aac",
      output: new Mp4OutputFormat({ fastStart: "fragmented" }),
      started: { mediaType: "video/mp4", extension: "mp4" },
    } as const;
  }
  if (await canEncodeVideo("vp9", size) && await canEncodeAudio("opus", { bitrate: AUDIO_BITRATE })) {
    return {
      video: "vp9", audio: "opus",
      output: new WebMOutputFormat({ appendOnly: true }),
      started: { mediaType: "video/webm", extension: "webm" },
    } as const;
  }
  throw new Error("This computer can't encode video.");
}

let stop: (() => Promise<void>) | undefined;

async function startRecording(settings: GameRecorderSettings): Promise<GameRecorderStarted> {
  const chosen = await format(settings);
  const stream = await navigator.mediaDevices.getDisplayMedia({
    video: { frameRate: settings.frameRate, width: { max: settings.maxEdge }, height: { max: settings.maxEdge } },
    audio: true,
  });
  const release = () => { for (const track of stream.getTracks()) track.stop(); };
  try {
    const [video] = stream.getVideoTracks();
    if (!video) throw new Error("The game could not be captured.");
    const output = new Output({
      format: chosen.output,
      target: new StreamTarget(new WritableStream({ write: (chunk) => host.chunk(chunk.data) }), { chunked: true, chunkSize: CHUNK_BYTES }),
    });
    // The game can change size while it records, as when it moves to the Play
    // window. A file holds one size, so later frames fit inside the first one's.
    const videoSource = new MediaStreamVideoTrackSource(video, {
      codec: chosen.video,
      bitrate: settings.bitrate,
      keyFrameInterval: KEY_FRAME_SECONDS,
      sizeChangeBehavior: "contain",
    }, { frameRate: settings.frameRate });
    output.addVideoTrack(videoSource, { frameRate: settings.frameRate });
    const sources: { errorPromise: Promise<void> }[] = [videoSource];
    const [audio] = stream.getAudioTracks();
    if (audio) {
      const audioSource = new MediaStreamAudioTrackSource(audio, { codec: chosen.audio, bitrate: AUDIO_BITRATE });
      output.addAudioTrack(audioSource);
      sources.push(audioSource);
    }
    let startedAt = 0;
    const finish = stop = async () => {
      if (stop !== finish) return;
      stop = undefined;
      try {
        await output.finalize();
        host.finished((performance.now() - startedAt) / 1000);
      } catch (cause) {
        host.failed(message(cause));
      } finally {
        release();
      }
    };
    const fail = (cause: unknown) => {
      if (stop !== finish) return;
      stop = undefined;
      host.failed(message(cause));
      void output.cancel().catch(() => undefined);
      release();
    };
    for (const source of sources) source.errorPromise.catch(fail);
    // The game was closed or its process ended: keep what was recorded.
    video.addEventListener("ended", () => void finish());
    await output.start();
    startedAt = performance.now();
    return chosen.started;
  } catch (cause) {
    release();
    throw cause;
  }
}

function message(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

Object.assign(window, { startRecording, stopRecording: () => stop?.() });
