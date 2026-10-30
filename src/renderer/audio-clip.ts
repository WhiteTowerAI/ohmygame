/** Encode an explicit source range as a self-contained PCM WAV reference. */
export function encodeAudioClip(
  channels: readonly Float32Array[],
  sampleRate: number,
  start: number,
  end: number,
): Blob {
  if (
    !channels.length ||
    channels.length > 2 ||
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start < 0 ||
    end <= start ||
    end > channels[0]!.length / sampleRate ||
    end - start > 30
  )
    throw new Error("Choose a clip of up to 30 seconds inside the audio");
  const first = Math.floor(start * sampleRate),
    count = Math.floor(end * sampleRate) - first;
  const buffer = new ArrayBuffer(44 + count * channels.length * 2),
    view = new DataView(buffer);
  const text = (offset: number, value: string) => {
    for (let i = 0; i < value.length; i++)
      view.setUint8(offset + i, value.charCodeAt(i));
  };
  text(0, "RIFF");
  view.setUint32(4, buffer.byteLength - 8, true);
  text(8, "WAVE");
  text(12, "fmt ");
  view.setUint32(16, 16, true);
  view.setUint16(20, 1, true);
  view.setUint16(22, channels.length, true);
  view.setUint32(24, sampleRate, true);
  view.setUint32(28, sampleRate * channels.length * 2, true);
  view.setUint16(32, channels.length * 2, true);
  view.setUint16(34, 16, true);
  text(36, "data");
  view.setUint32(40, buffer.byteLength - 44, true);
  let offset = 44;
  for (let i = 0; i < count; i++)
    for (const channel of channels) {
      const value = Math.max(-1, Math.min(1, channel[first + i] ?? 0));
      view.setInt16(
        offset,
        Math.round(value * (value < 0 ? 32768 : 32767)),
        true,
      );
      offset += 2;
    }
  return new Blob([buffer], { type: "audio/wav" });
}
